import { beforeEach, describe, expect, it, test, vi } from "vitest";

const projectStorage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }));
vi.mock("@/lib/localforage-storage", () => ({ localForageStorage: projectStorage }));

import { UNCATEGORIZED_PROJECT_ID } from "@/lib/canvas/category";

import { useProjectStore } from "./use-project-store";

describe("useProjectStore", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        projectStorage.setItem.mockResolvedValue(undefined);
        useProjectStore.setState({ hydrated: true, hydrationStatus: "success", projects: [], pendingPrompt: null, pendingProjectId: null, pendingCanvasId: null });
    });

    it("createProject returns projectId and canvasId", () => {
        const ids = useProjectStore.getState().createProject("P1");
        expect(ids.projectId).toBeTruthy();
        expect(ids.canvasId).toBeTruthy();
        const { projects } = useProjectStore.getState();
        expect(projects).toHaveLength(1);
        expect(projects[0].canvases[0].id).toBe(ids.canvasId);
    });

    it("createCanvas appends a canvas", () => {
        const { projectId } = useProjectStore.getState().createProject("P1");
        const canvasId = useProjectStore.getState().createCanvas(projectId, "C2");
        const project = useProjectStore.getState().projects.find((p) => p.id === projectId)!;
        expect(project.canvases).toHaveLength(2);
        expect(project.canvases[1].id).toBe(canvasId);
    });

    it("deleteCanvas refuses last canvas", () => {
        const { projectId, canvasId } = useProjectStore.getState().createProject("P1");
        useProjectStore.getState().deleteCanvas(projectId, canvasId);
        expect(useProjectStore.getState().projects[0].canvases).toHaveLength(1);
    });

    it("deleteCanvas allows last canvas with allowLast", () => {
        const { projectId, canvasId } = useProjectStore.getState().createProject("P1");
        useProjectStore.getState().deleteCanvas(projectId, canvasId, { allowLast: true });
        expect(useProjectStore.getState().projects[0].canvases).toHaveLength(0);
    });

    it("updateCanvas patches the right canvas", () => {
        const { projectId, canvasId } = useProjectStore.getState().createProject("P1");
        useProjectStore.getState().updateCanvas(projectId, canvasId, { showImageInfo: true });
        expect(useProjectStore.getState().findCanvas(canvasId)?.canvas.showImageInfo).toBe(true);
    });

    it("touchCanvas bumps updatedAt without changing content and no-ops for a missing canvas", () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
            const { projectId, canvasId } = useProjectStore.getState().createProject("P1");
            useProjectStore.getState().updateCanvas(projectId, canvasId, { nodes: [{ id: "n1" } as never] });

            vi.setSystemTime(new Date("2026-09-02T00:00:00.000Z"));
            useProjectStore.getState().touchCanvas(projectId, canvasId);
            const project = useProjectStore.getState().projects.find((p) => p.id === projectId)!;
            expect(project.updatedAt).toBe("2026-09-02T00:00:00.000Z");
            expect(project.canvases[0].updatedAt).toBe("2026-09-02T00:00:00.000Z");
            // 触碰不改内容
            expect(project.canvases[0].nodes.map((n) => n.id)).toEqual(["n1"]);

            // 目标画布不存在：项目原对象原样返回（引用不变），updatedAt 不动
            useProjectStore.getState().touchCanvas(projectId, "missing-canvas");
            expect(useProjectStore.getState().projects.find((p) => p.id === projectId)).toBe(project);
        } finally {
            vi.useRealTimers();
        }
    });

    it("updates a project's name, icon, and theme color together", () => {
        const { projectId } = useProjectStore.getState().createProject("P1", { icon: "folder", color: "#6366f1" });
        useProjectStore.getState().updateProjectAppearance(projectId, { title: "Renamed", icon: "sparkles", color: "#ef4444" });
        const project = useProjectStore.getState().projects[0];
        expect(project).toMatchObject({ title: "Renamed", icon: "sparkles", color: "#ef4444" });
    });

    it("updateCanvasNodes atomically uses the latest nodes and ignores deleted canvases", () => {
        const { projectId, canvasId } = useProjectStore.getState().createProject("P1");
        useProjectStore.getState().updateCanvas(projectId, canvasId, { nodes: [{ id: "n1" } as never] });
        const applied = useProjectStore.getState().updateCanvasNodes(projectId, canvasId, (nodes) => [...nodes, { id: "n2" } as never]);
        expect(applied).toBe(true);
        expect(useProjectStore.getState().findCanvas(canvasId)?.canvas.nodes.map((node) => node.id)).toEqual(["n1", "n2"]);

        const projectsBeforeMissingUpdate = useProjectStore.getState().projects;
        const missing = useProjectStore.getState().updateCanvasNodes(projectId, "deleted", () => [{ id: "recreated" } as never]);
        expect(missing).toBe(false);
        expect(useProjectStore.getState().projects).toBe(projectsBeforeMissingUpdate);
        expect(useProjectStore.getState().projects[0].canvases).toHaveLength(1);
    });

    test("flush waits for the latest debounced project snapshot", async () => {
        let finish!: () => void;
        projectStorage.setItem.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
        const { projectId, canvasId } = useProjectStore.getState().createProject("P1");
        useProjectStore.getState().updateCanvasNodes(projectId, canvasId, () => [{ id: "persisted" } as never]);
        let flushed = false;
        const flushing = useProjectStore.getState().flush().then(() => { flushed = true; });
        await vi.waitFor(() => expect(projectStorage.setItem).toHaveBeenCalled());
        expect(flushed).toBe(false);
        finish();
        await flushing;
        expect(JSON.parse(projectStorage.setItem.mock.calls.at(-1)?.[1] as string).state.projects[0].canvases[0].nodes[0].id).toBe("persisted");
    });

    test("flush propagates a project persistence failure", async () => {
        projectStorage.setItem.mockRejectedValueOnce(new Error("project storage unavailable"));
        useProjectStore.getState().createProject("P1");
        await expect(useProjectStore.getState().flush()).rejects.toThrow("project storage unavailable");
    });

    it("submitPendingPrompt returns nav target to the canvas", () => {
        const ids = useProjectStore.getState().submitPendingPrompt("draw a cat", "Cat");
        expect(ids).toBeTruthy();
        const { pendingCanvasId } = useProjectStore.getState();
        expect(pendingCanvasId).toBe(ids!.canvasId);
    });

    test("submits a home prompt into the selected existing project", () => {
        const { projectId } = useProjectStore.getState().createProject("Brand Lab");

        const ids = useProjectStore.getState().submitPendingPrompt("draw a cat", "Cat", { projectId });

        const project = useProjectStore.getState().projects.find((item) => item.id === projectId)!;
        expect(ids?.projectId).toBe(projectId);
        expect(project.canvases).toHaveLength(2);
        expect(project.canvases[1]).toMatchObject({ id: ids?.canvasId, title: "Cat" });
        expect(useProjectStore.getState()).toMatchObject({ pendingProjectId: projectId, pendingCanvasId: ids?.canvasId });
    });

    test("reuses a newly-created project's initial canvas for its first home prompt", () => {
        const target = useProjectStore.getState().createProject("Brand Lab");

        const ids = useProjectStore.getState().submitPendingPrompt("draw a cat", "Cat", target);

        const project = useProjectStore.getState().projects.find((item) => item.id === target.projectId)!;
        expect(ids).toEqual(target);
        expect(project.canvases).toHaveLength(1);
        expect(project.canvases[0].title).toBe("Cat");
    });

    it("creates an uncategorized empty canvas without submitting a prompt", () => {
        useProjectStore.setState({ pendingPrompt: "other turn", pendingProjectId: "other-project", pendingCanvasId: "other-canvas" });
        const ids = useProjectStore.getState().createHomeCanvas();
        expect(ids).toMatchObject({ ok: true, projectId: UNCATEGORIZED_PROJECT_ID });
        if (!ids.ok) throw new Error(ids.reason);
        const found = useProjectStore.getState().findCanvas(ids.canvasId)!;
        expect(found.canvas.nodes).toEqual([]);
        expect(found.canvas.connections).toEqual([]);
        expect(useProjectStore.getState()).toMatchObject({ pendingPrompt: "other turn", pendingProjectId: "other-project", pendingCanvasId: "other-canvas" });
    });

    it("reuses only the selected new project's empty initial canvas", () => {
        const target = useProjectStore.getState().createProject("Brand Lab");
        expect(useProjectStore.getState().createHomeCanvas(target)).toEqual({ ok: true, ...target });
        useProjectStore.getState().updateCanvas(target.projectId, target.canvasId, { nodes: [{ id: "kept" } as never] });
        const originalCanvas = structuredClone(useProjectStore.getState().findCanvas(target.canvasId)!.canvas);
        const next = useProjectStore.getState().createHomeCanvas(target);
        expect(next.ok).toBe(true);
        if (!next.ok) throw new Error(next.reason);
        expect(next.canvasId).not.toBe(target.canvasId);
        expect(useProjectStore.getState().findCanvas(target.canvasId)!.canvas).toEqual(originalCanvas);
    });

    it.each(["pending", "degraded", "error"] as const)("refuses creation while hydration is %s", (hydrationStatus) => {
        useProjectStore.setState({ hydrationStatus });
        expect(useProjectStore.getState().createHomeCanvas()).toEqual({ ok: false, reason: "not-ready" });
        expect(useProjectStore.getState().projects).toEqual([]);
    });

    it("does not silently replace a deleted project with the inbox", () => {
        expect(useProjectStore.getState().createHomeCanvas({ projectId: "gone" })).toEqual({ ok: false, reason: "project-missing" });
        expect(useProjectStore.getState().projects).toEqual([]);
    });

    test.each([
        ["selected project without canvas id", (projectId: string) => ({ projectId }), true],
        ["stale canvas id", (projectId: string) => ({ projectId, canvasId: "gone" }), true],
    ] as const)("creates a new canvas for %s", (_case, targetFor, expectedOk) => {
        const project = useProjectStore.getState().createProject("Brand Lab");
        const before = useProjectStore.getState().projects[0];
        const result = useProjectStore.getState().createHomeCanvas(targetFor(project.projectId));
        expect(result.ok).toBe(expectedOk);
        if (!result.ok) throw new Error(result.reason);
        expect(result.projectId).toBe(project.projectId);
        expect(result.canvasId).not.toBe(project.canvasId);
        expect(useProjectStore.getState().projects[0].canvases).toHaveLength(2);
        expect(useProjectStore.getState().findCanvas(project.canvasId)!.canvas).toEqual(before.canvases[0]);
    });

    it("creates a new canvas when the selected initial canvas has connections", () => {
        const target = useProjectStore.getState().createProject("Brand Lab");
        useProjectStore.getState().updateCanvas(target.projectId, target.canvasId, { connections: [{ id: "connection" } as never] });
        const before = useProjectStore.getState().findCanvas(target.canvasId)!.canvas;
        const result = useProjectStore.getState().createHomeCanvas(target);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.reason);
        expect(result.canvasId).not.toBe(target.canvasId);
        expect(useProjectStore.getState().findCanvas(target.canvasId)!.canvas).toEqual(before);
    });

    it("adds a canvas to an existing uncategorized project", () => {
        const first = useProjectStore.getState().createHomeCanvas();
        expect(first.ok).toBe(true);
        if (!first.ok) throw new Error(first.reason);
        const second = useProjectStore.getState().createHomeCanvas();
        expect(second.ok).toBe(true);
        if (!second.ok) throw new Error(second.reason);
        expect(second.projectId).toBe(UNCATEGORIZED_PROJECT_ID);
        expect(second.canvasId).not.toBe(first.canvasId);
        expect(useProjectStore.getState().projects).toHaveLength(1);
        expect(useProjectStore.getState().projects[0].canvases).toHaveLength(2);
    });

    it("reuses an empty initial canvas without changing its title", () => {
        const target = useProjectStore.getState().createProject("Brand Lab");
        const before = useProjectStore.getState().findCanvas(target.canvasId)!.canvas;
        const result = useProjectStore.getState().createHomeCanvas(target);
        expect(result).toEqual({ ok: true, ...target });
        expect(useProjectStore.getState().findCanvas(target.canvasId)!.canvas).toEqual(before);
    });

    test.each([1, 8])("preserves providerOptions version %s through real import, JSON export, copy, flush and rehydrate", async version => {
        const providerOptions = { version, models: { "one::fal-ai/flux-2-pro": { provider: "fal", profileId: "fal-ai/flux-2-pro", profileVersion: 1, params: { seed: 7 } } } };
        const source = { id: "src", title: "Imported", category: "uncategorized", createdAt: "x", updatedAt: "x",
            canvases: [{ id: "c1", title: "C", createdAt: "x", updatedAt: "x", nodes: [{ id: "n1", type: "image", title: "Image", position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, metadata: { providerOptions } }, { id: "legacy", type: "image", title: "Legacy", position: { x: 0, y: 0 }, size: { width: 100, height: 100 } }], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } }] };
        const id = useProjectStore.getState().importProject(source as never);
        const imported = useProjectStore.getState().projects.find(project => project.id === id)!;
        const copy = JSON.parse(JSON.stringify(imported));
        const copiedId = useProjectStore.getState().importProject(copy);
        await useProjectStore.getState().flush();
        const persisted = projectStorage.setItem.mock.calls.at(-1)?.[1] as string;
        projectStorage.getItem.mockImplementation((key: string) => Promise.resolve(key.includes(":repair") ? null : persisted));
        await useProjectStore.persist.rehydrate();
        for (const projectId of [id, copiedId]) {
            const nodes = useProjectStore.getState().projects.find(project => project.id === projectId)!.canvases[0].nodes;
            expect(nodes[0].metadata?.providerOptions).toEqual(providerOptions);
            expect(nodes[1].metadata?.providerOptions).toBeUndefined();
        }
        expect(source.canvases[0].nodes[0].metadata?.providerOptions.version).toBe(version);
    });

    test("importProject regenerates canvas ids so re-importing the same project does not collide", () => {
        const source = { id: "src", title: "Imported", category: "uncategorized", createdAt: "x", updatedAt: "x",
            canvases: [{ id: "c1", title: "C", createdAt: "x", updatedAt: "x", nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } }] };
        const a = useProjectStore.getState().importProject(source as never);
        const b = useProjectStore.getState().importProject(source as never);
        const pa = useProjectStore.getState().projects.find((p) => p.id === a)!;
        const pb = useProjectStore.getState().projects.find((p) => p.id === b)!;
        expect(pa.canvases[0].id).not.toBe(pb.canvases[0].id);
    });

    test.each([
        ["degraded", () => Promise.resolve("{invalid")],
        ["error", () => Promise.reject(new Error("main unavailable"))],
    ] as const)("exposes %s hydration when the main snapshot fails without a valid repair", async (status, readMain) => {
        projectStorage.getItem.mockImplementation((key: string) => key.includes(":repair") ? Promise.resolve(null) : readMain());

        await useProjectStore.persist.rehydrate();

        expect(useProjectStore.getState()).toMatchObject({ hydrated: true, hydrationStatus: status, projects: [] });
    });

    test("returns to successful hydration after storage recovers", async () => {
        projectStorage.getItem.mockImplementation((key: string) => key.includes(":repair") ? Promise.resolve(null) : Promise.resolve("{invalid"));
        await useProjectStore.persist.rehydrate();
        expect(useProjectStore.getState().hydrationStatus).toBe("degraded");

        projectStorage.getItem.mockImplementation((key: string) => key.includes(":repair") ? Promise.resolve(null) : Promise.resolve(JSON.stringify({ state: { projects: [] }, version: 0, persistenceRevision: 0 })));
        await useProjectStore.persist.rehydrate();

        expect(useProjectStore.getState()).toMatchObject({ hydrated: true, hydrationStatus: "success", projects: [] });
    });

    test("reports successful hydration when a valid repair replaces an invalid main snapshot", async () => {
        projectStorage.getItem.mockImplementation((key: string) => Promise.resolve(key.includes(":repair")
            ? JSON.stringify({ version: 1, revision: 2, projects: [] })
            : "{invalid"));

        await useProjectStore.persist.rehydrate();

        expect(useProjectStore.getState()).toMatchObject({ hydrated: true, hydrationStatus: "success", projects: [] });
    });

    test.each([
        ["valid main and unreadable repair", "error", JSON.stringify({ state: { projects: [] }, version: 0, persistenceRevision: 4 }), () => Promise.reject(new Error("repair unavailable"))],
        ["absent main and unreadable repair", "error", null, () => Promise.reject(new Error("repair unavailable"))],
        ["valid main and invalid repair", "degraded", JSON.stringify({ state: { projects: [] }, version: 0, persistenceRevision: 4 }), () => Promise.resolve("{invalid")],
    ] as const)("classifies %s hydration as %s", async (_case, expected, main, readRepair) => {
        projectStorage.getItem.mockImplementation((key: string) => key.includes(":repair") ? readRepair() : Promise.resolve(main));

        await useProjectStore.persist.rehydrate();

        expect(useProjectStore.getState().hydrationStatus).toBe(expected);
    });

    test("applyCanvasAssetMigration patches nodes across canvases in one commit and ignores missing nodes", () => {
        const { projectId } = useProjectStore.getState().createProject("Migration");
        const c1 = useProjectStore.getState().projects.find((p) => p.id === projectId)!.canvases[0].id;
        const c2 = useProjectStore.getState().createCanvas(projectId, "C2");
        useProjectStore.getState().updateCanvasNodes(projectId, c1, () => [{ id: "n1", type: "image", title: "N1", position: { x: 0, y: 0 }, width: 10, height: 10, metadata: { prompt: "p" } } as never]);
        useProjectStore.getState().updateCanvasNodes(projectId, c2, () => [{ id: "n2", type: "image", title: "N2", position: { x: 0, y: 0 }, width: 10, height: 10, metadata: { prompt: "q" } } as never]);
        const ref = (assetId: string) => ({ backend: "project-file", assetId, projectId, relativePath: `assets/imported/${assetId}`, revision: 1 }) as const;
        const before = useProjectStore.getState().projects.find((p) => p.id === projectId)!;

        const applied = useProjectStore.getState().applyCanvasAssetMigration(projectId, [
            { canvasId: c1, nodeId: "n1", metadata: { prompt: "p", assetRef: ref("a1") } },
            { canvasId: c2, nodeId: "n2", metadata: { prompt: "q", assetRef: ref("a2") } },
            { canvasId: c2, nodeId: "gone", metadata: {} },
        ]);

        expect(applied).toBe(true);
        const after = useProjectStore.getState().projects.find((p) => p.id === projectId)!;
        expect(after.canvases.find((c) => c.id === c1)!.nodes[0].metadata?.assetRef).toEqual(ref("a1"));
        expect(after.canvases.find((c) => c.id === c2)!.nodes[0].metadata?.assetRef).toEqual(ref("a2"));
        expect(after.canvases.find((c) => c.id === c1)!.nodes[0].metadata?.prompt).toBe("p");
        expect(after.updatedAt >= before.updatedAt).toBe(true);

        const stable = useProjectStore.getState().projects;
        expect(useProjectStore.getState().applyCanvasAssetMigration(projectId, [{ canvasId: c1, nodeId: "gone", metadata: {} }])).toBe(false);
        expect(useProjectStore.getState().projects).toBe(stable);
    });

    it("setProjectWorkspacePath sets the path and touches updatedAt", () => {
        const { projectId } = useProjectStore.getState().createProject("测试项目");
        const before = useProjectStore.getState().projects.find((p) => p.id === projectId)!;
        useProjectStore.getState().setProjectWorkspacePath(projectId, "/Users/me/shotshot-workspace/x-12345678");
        const after = useProjectStore.getState().projects.find((p) => p.id === projectId)!;
        expect(after.workspacePath).toBe("/Users/me/shotshot-workspace/x-12345678");
        expect(after.updatedAt >= before.updatedAt).toBe(true);
    });

    it("createProject leaves workspacePath empty when no bridge is available", () => {
        // jsdom 环境没有 window.shotshot bridge，ensure 链路应整体 no-op。
        const { projectId } = useProjectStore.getState().createProject("无桥项目");
        expect(useProjectStore.getState().projects.find((p) => p.id === projectId)?.workspacePath).toBeUndefined();
    });

    test("accepts an older valid repair as healthy without replacing a newer valid main", async () => {
        projectStorage.getItem.mockImplementation((key: string) => Promise.resolve(key.includes(":repair")
            ? JSON.stringify({ version: 1, revision: 3, projects: [] })
            : JSON.stringify({ state: { projects: [] }, version: 0, persistenceRevision: 4 })));

        await useProjectStore.persist.rehydrate();

        expect(useProjectStore.getState().hydrationStatus).toBe("success");
        expect(projectStorage.removeItem).not.toHaveBeenCalled();
    });
    it("bumps and exposes agent ops revisions without persisting them", () => {
        const first = useProjectStore.getState().bumpAgentOpsRevision("canvas-rev");
        const second = useProjectStore.getState().bumpAgentOpsRevision("canvas-rev");
        expect(second).toBe(first + 1);
        expect(useProjectStore.getState().agentOpsRevisions["canvas-rev"]).toBe(second);
        // partialize 只持久化 projects，revision 天然不落盘（运行时态）
    });
});
