import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentFileContent } from "@/lib/agent/pi-agent-types";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-op-types";
import { useAgentSessionStore } from "@/stores/use-agent-session-store";
import { useProjectStore, type Project } from "@/stores/canvas/use-project-store";
import { useScriptEntityStore } from "@/stores/use-script-entity-store";
import { useAgentStore, type AgentCanvasContext } from "@/stores/use-agent-store";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { uploadImage } from "@/services/image-storage";
import { createAgentOpRouter, type AgentOpRouterDeps } from "./agent-op-router";

vi.mock("@/services/image-storage", () => ({ uploadImage: vi.fn() }));
vi.mock("@/services/file-storage", () => ({ uploadMediaFile: vi.fn() }));

function backgroundNodes() {
    return [{ id: "node-a", type: "text", title: "A", position: { x: 0, y: 0 }, width: 200, height: 60, metadata: {} } as never];
}

function backgroundSnapshot(canvasId = "canvas-bg"): CanvasAgentSnapshot {
    return {
        projectId: "project-1",
        canvasId,
        title: "画布",
        nodes: backgroundNodes(),
        connections: [],
        selectedNodeIds: [],
        viewport: { x: 0, y: 0, k: 1 },
        viewportSize: { width: 800, height: 600 },
    };
}

function projectWithCanvases(): Project {
    const now = new Date(0).toISOString();
    const canvas = (id: string) => ({ id, title: id, createdAt: now, updatedAt: now, nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines" as const, showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } });
    return { id: "project-1", title: "项目", category: "uncategorized", icon: "sparkles", color: "#f5f5f4", createdAt: now, updatedAt: now, canvases: [canvas("canvas-active"), canvas("canvas-bg")] } as unknown as Project;
}

function attachmentPayload(handle: string): AgentFileContent {
    return { handle, name: "a.png", kind: "image", mimeType: "image/png", size: 1, dataUrl: "data:image/png;base64,aGk=" };
}

function sessionSummary(sessionId: string, canvasId: string) {
    return { sessionId, title: sessionId, scope: { projectId: "project-1", canvasId }, createdAt: 0, updatedAt: 0, status: "running" as const, hasUnfinishedOperation: true };
}

function createContext(canvasId: string, overrides: Partial<Pick<AgentCanvasContext, "importAttachment">> = {}): AgentCanvasContext {
    const snapshot = backgroundSnapshot(canvasId);
    return {
        snapshot,
        applyOps: vi.fn(async (ops?: CanvasAgentOp[]) => ({ ...snapshot, receipts: (ops ?? []).map((op, index) => ({ opIndex: index, opType: op.type, status: "applied" as const })) })),
        undoOps: () => null,
        canUndo: false,
        ...overrides,
    };
}

function createTestRouter(overrides: Partial<AgentOpRouterDeps> = {}) {
    const receipts: Array<{ sessionId: string; requestId: string; receipts: unknown }> = [];
    const appliedByPage: CanvasAgentOp[][] = [];
    const importErrors: Array<{ error: unknown; scope: { projectId: string; canvasId: string } }> = [];
    const deps: AgentOpRouterDeps = {
        getContext: () => useAgentStore.getState().canvasContext,
        getSessionScope: (sessionId) => useAgentSessionStore.getState().sessions.find((item) => item.sessionId === sessionId)?.scope ?? null,
        refreshSessions: async () => undefined,
        setCanvasSnapshot: vi.fn(),
        sendReceipts: async (sessionId, requestId, receiptList) => {
            receipts.push({ sessionId, requestId, receipts: receiptList });
        },
        applyOpsOnPage: async (canvasId, ops) => {
            appliedByPage.push(ops);
            const context = useAgentStore.getState().canvasContext;
            return (await context?.applyOps(ops))?.receipts ?? [];
        },
        listProjects: () => useProjectStore.getState().projects,
        onImportError: (error, scope) => {
            importErrors.push({ error, scope });
        },
        ...overrides,
    };
    return { router: createAgentOpRouter(deps), receipts, appliedByPage, importErrors, deps };
}

describe("agent op router", () => {
    beforeEach(() => {
        useProjectStore.setState({ projects: [projectWithCanvases()], hydrated: true, hydrationStatus: "success" } as never);
        useAgentSessionStore.setState({ sessions: [sessionSummary("session-bg", "canvas-bg")], activeSessionId: "session-active", unreadableSessions: [], pendingUserInputs: {}, pendingApprovals: {} });
        useAgentStore.setState({ canvasContext: null });
        useConfigStore.setState({ config: defaultConfig });
        useScriptEntityStore.setState({ entities: [] });
    });

    it("routes ops to the page path when the target canvas is active", async () => {
        useAgentStore.setState({ canvasContext: createContext("canvas-bg") });
        const { router, receipts, appliedByPage } = createTestRouter();

        await router.routeOps("session-bg", [{ type: "add_node", nodeType: "text", title: "n" }], "req-1");

        await vi.waitFor(() => expect(receipts).toHaveLength(1));
        expect(appliedByPage).toHaveLength(1);
        expect(receipts[0]).toMatchObject({ sessionId: "session-bg", requestId: "req-1" });
        expect(receipts[0].receipts).toEqual([{ opIndex: 0, opType: "add_node", status: "applied" }]);
    });

    it("applies persistent and entity ops at store level and skips page-only ops for background canvases", async () => {
        useProjectStore.setState((state) => ({
            projects: state.projects.map((project) => ({
                ...project,
                canvases: project.canvases.map((canvas) => (canvas.id === "canvas-bg" ? { ...canvas, nodes: backgroundNodes() } : canvas)),
            })),
        }));
        const { router, receipts, deps } = createTestRouter();

        await router.routeOps("session-bg", [
            { type: "update_node", id: "node-a", patch: { title: "renamed" } },
            { type: "script_entity_upsert", entity: { projectId: "project-1", group: "character", name: "主角" } },
            { type: "run_generation", nodeId: "node-a", mode: "image" },
            { type: "select_nodes", ids: ["node-a"] },
        ], "req-2");

        await vi.waitFor(() => expect(receipts).toHaveLength(1));
        const list = receipts[0].receipts as Array<{ opIndex: number; status: string; reason?: string }>;
        expect(list).toHaveLength(4);
        expect(list[0]).toMatchObject({ opIndex: 0, status: "applied" });
        expect(list[1]).toMatchObject({ opIndex: 1, status: "applied" });
        expect(list[2]).toMatchObject({ opIndex: 2, status: "skipped" });
        expect(String(list[2].reason)).toContain("目标白板未打开");
        expect(list[3]).toMatchObject({ opIndex: 3, status: "skipped" });
        const canvas = useProjectStore.getState().projects[0].canvases.find((item) => item.id === "canvas-bg");
        expect((canvas?.nodes[0] as { title: string }).title).toBe("renamed");
        expect(useScriptEntityStore.getState().entities).toHaveLength(1);
        expect(deps.setCanvasSnapshot).toHaveBeenCalledWith({ projectId: "project-1", canvasId: "canvas-bg" }, expect.objectContaining({ canvasId: "canvas-bg" }));
    });

    it("takes the store-level path when no canvas context is mounted at apply time", async () => {
        const { router, receipts, appliedByPage } = createTestRouter();

        await router.routeOps("session-bg", [{ type: "add_node", nodeType: "text", title: "背景新建" }], "req-3");

        await vi.waitFor(() => expect(receipts).toHaveLength(1));
        expect(appliedByPage).toHaveLength(0);
        const canvas = useProjectStore.getState().projects[0].canvases.find((item) => item.id === "canvas-bg");
        expect(canvas?.nodes).toHaveLength(1);
        expect(receipts[0].receipts).toEqual([{ opIndex: 0, opType: "add_node", status: "applied", nodeIds: [expect.any(String)] }]);
    });

    it("replays buffered attachments in order when the canvas mounts", async () => {
        const { router } = createTestRouter();
        router.routeAttachmentImport("session-bg", attachmentPayload("h1"));
        router.routeAttachmentImport("session-bg", { ...attachmentPayload("h2"), name: "b.png" });
        // 让 routeAttachmentImport 的异步续体先落地（此时无 context → 走缓冲）
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        const imported: string[] = [];
        useAgentStore.setState({ canvasContext: createContext("canvas-bg", { importAttachment: async (item) => { imported.push(item.handle); return null; } }) });
        router.notifyCanvasMounted("canvas-bg");
        await vi.waitFor(() => expect(imported).toEqual(["h1", "h2"]));
    });

    it("drops buffered attachments beyond the per-canvas cap", async () => {
        const { router } = createTestRouter();
        for (let index = 0; index < 25; index += 1) router.routeAttachmentImport("session-bg", attachmentPayload(`h${index}`));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        const imported: string[] = [];
        useAgentStore.setState({ canvasContext: createContext("canvas-bg", { importAttachment: async (item) => { imported.push(item.handle); return null; } }) });
        router.notifyCanvasMounted("canvas-bg");
        await vi.waitFor(() => expect(imported).toHaveLength(20));
        expect(imported[0]).toBe("h0");
    });

    it("computes attachment placement from the live snapshot and uploads when no page importer exists", async () => {
        vi.mocked(uploadImage).mockResolvedValue({ url: "blob:image-1", width: 320, height: 240, bytes: 12, mimeType: "image/png", storageKey: "img-1" });
        const snapshot = { ...backgroundSnapshot("canvas-bg"), nodes: [...backgroundNodes(), ...backgroundNodes()], viewport: { x: 100, y: 200, k: 1 } };
        const applyOps = vi.fn(async (_ops?: CanvasAgentOp[]) => ({ ...snapshot, receipts: [] }));
        useAgentStore.setState({ canvasContext: { snapshot, applyOps, undoOps: () => null, canUndo: false } });
        const { router } = createTestRouter();

        router.routeAttachmentImport("session-bg", attachmentPayload("h1"));
        await vi.waitFor(() => expect(applyOps).toHaveBeenCalledTimes(1));

        expect(applyOps.mock.calls[0]?.[0]?.[0]).toMatchObject({
            type: "add_node",
            position: { x: 100 + 2 * 48 - 160, y: 200 + 2 * 48 - 120 },
        });
    });

    it("surfaces attachment import failures as errors", async () => {
        useAgentStore.setState({ canvasContext: createContext("canvas-bg", { importAttachment: async () => { throw new Error("upload failed"); } }) });
        const { router, importErrors } = createTestRouter();

        router.routeAttachmentImport("session-bg", attachmentPayload("h1"));
        await vi.waitFor(() => expect(importErrors).toHaveLength(1));
        expect(String(importErrors[0].error)).toContain("upload failed");
        expect(importErrors[0].scope).toEqual({ projectId: "project-1", canvasId: "canvas-bg" });
    });

    it("rejects an import whose canvas scope changed while queued", async () => {
        const importAttachment = vi.fn(async () => null);
        let releasePageOps!: () => void;
        const pageOpsGate = new Promise<void>((done) => { releasePageOps = done; });
        let pageOpsEntered = false;
        const { router, importErrors } = createTestRouter({
            applyOpsOnPage: async (canvasId, ops) => {
                void canvasId;
                void ops;
                pageOpsEntered = true;
                await pageOpsGate;
                return [];
            },
        });
        useAgentStore.setState({ canvasContext: createContext("canvas-bg", { importAttachment }) });

        // 先让一个 ops 批次占住队列（挂起在页面 applyOps 门上）
        void router.routeOps("session-bg", [{ type: "add_node", nodeType: "text" }], "gate-ops");
        await vi.waitFor(() => expect(pageOpsEntered).toBe(true));

        // 入队时 context 仍匹配 → 走直通路径，排在 ops 之后
        router.routeAttachmentImport("session-bg", attachmentPayload("h1"));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        // 队列悬挂期间画布切走
        useAgentStore.setState({ canvasContext: { snapshot: { ...backgroundSnapshot("canvas-bg"), projectId: "project-2" }, applyOps: vi.fn(), undoOps: () => null, canUndo: false, importAttachment } });
        releasePageOps();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(importAttachment).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(importErrors).toHaveLength(1));
        expect(String(importErrors[0].error)).toContain("画布已切换");
    });

    it("falls back to refreshSessions when the session scope lookup misses, then skips unknown sessions", async () => {
        const refreshSessions = vi.fn(async () => {
            useAgentSessionStore.setState({ sessions: [sessionSummary("session-late", "canvas-bg")] });
        });
        useProjectStore.setState((state) => ({
            projects: state.projects.map((project) => ({
                ...project,
                canvases: project.canvases.map((canvas) => (canvas.id === "canvas-bg" ? { ...canvas, nodes: backgroundNodes() } : canvas)),
            })),
        }));
        const { router, receipts } = createTestRouter({ refreshSessions });

        await router.routeOps("session-late", [{ type: "update_node", id: "node-a", patch: { title: "late" } }], "req-4");
        await vi.waitFor(() => expect(receipts).toHaveLength(1));
        expect(refreshSessions).toHaveBeenCalledTimes(1);
        expect(receipts[0].receipts).toEqual([{ opIndex: 0, opType: "update_node", status: "applied", nodeIds: ["node-a"] }]);

        await router.routeOps("session-unknown", [{ type: "add_node", nodeType: "text" }], "req-5");
        await vi.waitFor(() => expect(receipts).toHaveLength(2));
        expect(receipts[1].receipts).toEqual([{ opIndex: 0, opType: "add_node", status: "skipped", reason: "无法定位会话画布" }]);
    });
});
