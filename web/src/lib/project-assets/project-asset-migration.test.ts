import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasNodeData, CanvasNodeImage, CanvasNodeMetadata } from "@/types/canvas";
import type { ScriptShot } from "@/types/script-node";
import { createEmptyScriptData } from "@/types/script-node";
import type { Project } from "@/types/project";
import type { CanvasAssetRef, ProjectAssetSource } from "@/lib/project-assets/project-asset-types";
import type { ProjectFileAssetRef } from "@/lib/project-assets/project-asset-types";
import type { ScriptEntity } from "@/stores/use-script-entity-store";

const localForageStorage = vi.hoisted(() => ({
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
}));
vi.mock("@/lib/localforage-storage", () => ({ localForageStorage }));

const uploadImage = vi.hoisted(() => vi.fn());
const resolveImageUrl = vi.hoisted(() => vi.fn());
const getImageBlob = vi.hoisted(() => vi.fn());
const loadImageMeta = vi.hoisted(() => vi.fn());
const uploadMediaFile = vi.hoisted(() => vi.fn());
const resolveMediaUrl = vi.hoisted(() => vi.fn());
const getMediaBlob = vi.hoisted(() => vi.fn());
const readVideoMeta = vi.hoisted(() => vi.fn());
const readAudioMeta = vi.hoisted(() => vi.fn());
vi.mock("@/services/image-storage", () => ({ uploadImage, resolveImageUrl, getImageBlob, loadImageMeta }));
vi.mock("@/services/file-storage", () => ({ uploadMediaFile, resolveMediaUrl, getMediaBlob, readVideoMeta, readAudioMeta }));

const deleteStoredMediaKeys = vi.hoisted(() => vi.fn(async (_keys: Iterable<string>) => [] as string[]));
vi.mock("@/services/stored-media-delete", () => ({ deleteStoredMediaKeys }));

import { applyLegacyAssetRefToMetadata, legacyTargetStillMatches, migrateProjectAssets, planLegacyAssetMigration, type LegacyCanvasAssetTarget } from "@/lib/project-assets/project-asset-migration";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { useScriptEntityStore } from "@/stores/use-script-entity-store";

const T = "2026-01-01T00:00:00.000Z";

const fileRef = (assetId: string, projectId = "p1"): ProjectFileAssetRef => ({
    backend: "project-file",
    assetId,
    projectId,
    relativePath: `assets/imported/${assetId}`,
    revision: 1,
});

const node = (id: string, type: string, metadata: CanvasNodeMetadata): CanvasNodeData => ({
    id, type, title: id, position: { x: 0, y: 0 }, width: 200, height: 200, metadata,
});

const canvas = (id: string, nodes: CanvasNodeData[]) => ({
    id, title: id, createdAt: T, updatedAt: T, nodes, connections: [], chatSessions: [], activeChatId: null,
    backgroundMode: "lines" as const, showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
});

const imageEntry = (id: string, storageKey?: string, assetRef?: CanvasAssetRef): CanvasNodeImage => ({
    id, status: "success", content: `data:image/png;base64,${id}`, storageKey, assetRef,
    naturalWidth: 10, naturalHeight: 10, bytes: 4, mimeType: "image/png",
});

const shot = (patch: Partial<ScriptShot>): ScriptShot => ({
    shotId: "s1", no: 1, origin: "manual", shotSize: "MS", angle: "eye", movement: "static",
    duration: 3, mood: "calm", descriptionRich: [], description: "", entityRefs: [], composed: false, ...patch,
});

const scriptData = {
    ...createEmptyScriptData(),
    output: {
        status: "done" as const,
        shots: [
            shot({
                dialogueAudio: { name: "dialogue-take.mp3", storageKey: "audio:dialogue", mimeType: "audio/mpeg" },
                sfxAudio: { name: "kept-sfx.mp3", storageKey: "audio:sfx-done", assetRef: fileRef("a7") },
            }),
        ],
    },
};

const projectFixture: Project = {
    id: "p1", title: "P", category: "uncategorized", icon: "", color: "", createdAt: T, updatedAt: T,
    workspacePath: "/ws/p1",
    canvases: [
        canvas("c1", [
            node("n-hero", "image", { storageKey: "image:hero", mimeType: "image/png", content: "blob:legacy-hero", naturalWidth: 10, naturalHeight: 10 }),
            node("n-multi", "image", { images: [imageEntry("img-a", "image:storyboard"), imageEntry("img-b")] }),
            node("n-model", "file", {
                model3d: {
                    name: "rig.glb", storageKey: "file:model", mimeType: "model/gltf-binary",
                    views: [{ id: "left", storageKey: "image:view-done", assetRef: fileRef("a8") }],
                    snapshot: { storageKey: "image:snapshot" },
                },
            }),
            node("n-shot", "video", { storageKey: "video:shot", mimeType: "video/mp4" }),
            node("n-script", "script", { script: scriptData }),
            node("n-url-only", "image", { content: "https://example.com/remote.png" }),
            node("n-raw", "image", { storageKey: "not-a-legacy-key" }),
        ]),
    ],
};

const alreadyMigratedProject: Project = {
    id: "p2", title: "Migrated", category: "uncategorized", icon: "", color: "", createdAt: T, updatedAt: T,
    workspacePath: "/ws/p2",
    canvases: [
        canvas("c1", [
            node("n-done", "image", { storageKey: "image:hero", assetRef: fileRef("a1"), mimeType: "image/png" }),
            node("n-file", "file", { assetRef: fileRef("a2") }),
            node("n-multi", "image", { images: [imageEntry("img-a", "image:storyboard", fileRef("a3"))] }),
        ]),
    ],
};

const entityFixture: ScriptEntity = {
    id: "e1", projectId: "p1", group: "character", name: "Cat",
    refs: [
        { id: "r1", label: "sheet", state: "ready", storageKey: "image:entity-ref" },
        { id: "r2", label: "portrait", state: "ready", storageKey: "image:entity-done", assetRef: fileRef("a9") },
    ],
    createdAt: T, updatedAt: T,
};

const imageBlobs: Record<string, Blob> = {};
const mediaBlobs: Record<string, Blob> = {};

const ensureProjectWorkspace = vi.fn();
let writeSeq = 0;
const projectAssetsBridge = {
    write: vi.fn(),
    importPath: vi.fn(),
    read: vi.fn(),
    stat: vi.fn(),
    restore: vi.fn(),
    watch: vi.fn(),
    unwatch: vi.fn(),
    onChanged: vi.fn(),
};
const projectWrite = projectAssetsBridge.write;

const bridgeWriteResult = (input: { projectId: string; name: string; mimeType: string; bytes: Uint8Array; source: ProjectAssetSource }, seq: number) => ({
    ok: true as const,
    value: {
        record: {
            backend: "project-file" as const, assetId: `a${seq}`, projectId: input.projectId,
            relativePath: `assets/imported/a${seq}`, revision: 1, originalName: input.name,
            kind: "image" as const, mimeType: input.mimeType, bytes: input.bytes.length, sha256: `sha-${seq}`,
            createdAt: T, updatedAt: T, source: input.source,
        },
        ref: fileRef(`a${seq}`, input.projectId),
    },
});

const findNode = (projectId: string, nodeId: string) => {
    const project = useProjectStore.getState().projects.find((item) => item.id === projectId);
    return project?.canvases.flatMap((item) => item.nodes).find((item) => item.id === nodeId);
};

const entityRef = (refId: string) => useScriptEntityStore.getState().entities.find((entity) => entity.id === "e1")!.refs.find((ref) => ref.id === refId)!;

beforeEach(() => {
    vi.resetAllMocks();
    deleteStoredMediaKeys.mockResolvedValue([]);
    writeSeq = 0;
    projectAssetsBridge.onChanged.mockImplementation(() => () => {});
    localForageStorage.getItem.mockResolvedValue(null);
    localForageStorage.setItem.mockResolvedValue(undefined);
    localForageStorage.removeItem.mockResolvedValue(undefined);
    loadImageMeta.mockResolvedValue({ width: 10, height: 10 });
    readVideoMeta.mockResolvedValue({ width: 1280, height: 720, durationMs: 1000 });
    readAudioMeta.mockResolvedValue({ durationMs: 1000 });
    for (const key of Object.keys(imageBlobs)) delete imageBlobs[key];
    for (const key of Object.keys(mediaBlobs)) delete mediaBlobs[key];
    imageBlobs["image:hero"] = new Blob(["hero"], { type: "image/png" });
    imageBlobs["image:storyboard"] = new Blob(["story"], { type: "image/png" });
    imageBlobs["image:entity-ref"] = new Blob(["entity"], { type: "image/png" });
    mediaBlobs["file:model"] = new Blob(["glb-bytes"], { type: "model/gltf-binary" });
    mediaBlobs["video:shot"] = new Blob(["video-bytes"], { type: "video/mp4" });
    mediaBlobs["audio:dialogue"] = new Blob(["audio-bytes"], { type: "audio/mpeg" });
    getImageBlob.mockImplementation(async (key: string) => imageBlobs[key] ?? null);
    getMediaBlob.mockImplementation(async (key: string) => mediaBlobs[key] ?? null);
    projectWrite.mockImplementation(async (input: { projectId: string; name: string; mimeType: string; bytes: Uint8Array; source: ProjectAssetSource }) => {
        writeSeq += 1;
        return bridgeWriteResult(input, writeSeq);
    });
    window.shotshot = { agent: { ensureProjectWorkspace }, projectAssets: projectAssetsBridge, platform: "darwin" } as unknown as typeof window.shotshot;
    let urlCount = 0;
    // 类形式保持 URL 可构造：resetModules 后动态 import 的模块解析内部会 new URL。
    const UrlStub = class extends URL {};
    UrlStub.createObjectURL = vi.fn(() => `blob:url-${(urlCount += 1)}`);
    UrlStub.revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", UrlStub);
    useProjectStore.setState({ hydrated: true, hydrationStatus: "success", projects: [projectFixture], pendingPrompt: null, pendingProjectId: null, pendingCanvasId: null });
    useScriptEntityStore.setState({ entities: [entityFixture], hydrated: true });
});

afterEach(() => {
    vi.unstubAllGlobals();
    delete window.shotshot;
});

describe("planLegacyAssetMigration", () => {
    it("finds top-level, multi-image, model, and Script audio legacy keys once", () => {
        const candidates = planLegacyAssetMigration(projectFixture);
        expect(candidates.map((item) => item.storageKey).sort()).toEqual([
            "audio:dialogue", "file:model", "image:hero", "image:storyboard", "video:shot",
        ]);
    });

    it("does not plan project-file or already migrated refs", () => {
        expect(planLegacyAssetMigration(alreadyMigratedProject)).toEqual([]);
    });

    it("derives candidate identity from the first owner location", () => {
        const byKey = new Map(planLegacyAssetMigration(projectFixture).map((item) => [item.storageKey, item]));
        expect(byKey.get("image:hero")!.source).toEqual({ type: "legacy-migration", canvasId: "c1", nodeId: "n-hero" });
        expect(byKey.get("image:hero")!.originalName).toBe("hero.png");
        expect(byKey.get("image:hero")!.kind).toBe("image");
        expect(byKey.get("image:storyboard")!.locations).toEqual([
            { store: "canvas", canvasId: "c1", nodeId: "n-multi", target: { part: "image", imageId: "img-a" } },
        ]);
        expect(byKey.get("file:model")).toMatchObject({ originalName: "rig.glb", kind: "model3d" });
        expect(byKey.get("video:shot")).toMatchObject({ originalName: "shot.mp4", kind: "video" });
        expect(byKey.get("audio:dialogue")!.source).toEqual({
            type: "legacy-migration", canvasId: "c1", nodeId: "n-script", scriptNodeId: "n-script", shotId: "s1", role: "dialogue",
        });
        expect(byKey.get("audio:dialogue")).toMatchObject({ originalName: "dialogue-take.mp3", kind: "audio" });
    });

    it("deduplicates identical storage keys while preserving every patch location", () => {
        const project: Project = {
            ...projectFixture,
            id: "p3",
            canvases: [
                canvas("c1", [node("n1", "image", { storageKey: "image:dup", mimeType: "image/png" }), node("n2", "image", { storageKey: "image:dup", mimeType: "image/png" })]),
                canvas("c2", [node("n3", "image", { storageKey: "image:dup", mimeType: "image/png" })]),
            ],
        };
        const candidates = planLegacyAssetMigration(project);
        expect(candidates).toHaveLength(1);
        expect(candidates[0].storageKey).toBe("image:dup");
        expect(candidates[0].locations).toEqual([
            { store: "canvas", canvasId: "c1", nodeId: "n1", target: { part: "metadata" } },
            { store: "canvas", canvasId: "c1", nodeId: "n2", target: { part: "metadata" } },
            { store: "canvas", canvasId: "c2", nodeId: "n3", target: { part: "metadata" } },
        ]);
    });

    it("plans Script entity reference slots and skips project-file slots", () => {
        const candidates = planLegacyAssetMigration({ ...projectFixture, id: "p4", canvases: [] }, [entityFixture]);
        expect(candidates.map((item) => item.storageKey)).toEqual(["image:entity-ref"]);
        expect(candidates[0].locations).toEqual([{ store: "script-entity", entityId: "e1", refId: "r1" }]);
        expect(candidates[0].kind).toBe("image");
        expect(candidates[0].source).toEqual({ type: "legacy-migration", role: "entity-reference" });
    });
});

describe("migrateProjectAssets", () => {
    it("copies, verifies, and repoints every candidate in one commit", async () => {
        const result = await migrateProjectAssets("p1");
        expect(result).toEqual({ migrated: 6, missing: [] });
        const calls = projectWrite.mock.calls;
        expect(calls).toHaveLength(6);
        expect(calls.map((call) => call[0].name).sort()).toEqual([
            "dialogue-take.mp3", "entity-ref.png", "hero.png", "rig.glb", "shot.mp4", "storyboard.png",
        ]);
        expect(calls.every((call) => call[0].source.type === "legacy-migration")).toBe(true);
        const audioCall = calls.find((call) => call[0].name === "dialogue-take.mp3")!;
        expect(audioCall[0].source).toMatchObject({ canvasId: "c1", nodeId: "n-script", scriptNodeId: "n-script", shotId: "s1", role: "dialogue" });
        expect(audioCall[0].workspacePath).toBe("/ws/p1");

        expect(findNode("p1", "n-hero")!.metadata!.assetRef).toMatchObject({ backend: "project-file" });
        expect("storageKey" in findNode("p1", "n-hero")!.metadata!).toBe(false);
        const multi = findNode("p1", "n-multi")!.metadata!;
        expect(multi.images![0].assetRef).toMatchObject({ backend: "project-file" });
        expect(multi.images![1].assetRef).toBeUndefined();
        const model = findNode("p1", "n-model")!.metadata!.model3d!;
        expect(model.assetRef).toMatchObject({ backend: "project-file" });
        expect(model.views![0].assetRef).toEqual(fileRef("a8"));
        expect(model.snapshot).toEqual({ storageKey: "image:snapshot" });
        const audio = findNode("p1", "n-script")!.metadata!.script!.output.shots[0];
        expect(audio.dialogueAudio!.assetRef).toMatchObject({ backend: "project-file" });
        expect("storageKey" in audio.dialogueAudio!).toBe(false);
        expect(audio.sfxAudio!.assetRef).toEqual(fileRef("a7"));
        expect(findNode("p1", "n-shot")!.metadata!.assetRef).toMatchObject({ backend: "project-file" });
        expect(findNode("p1", "n-url-only")!.metadata!.assetRef).toBeUndefined();

        expect(entityRef("r1").assetRef).toMatchObject({ backend: "project-file" });
        expect("storageKey" in entityRef("r1")).toBe(false);
        expect(entityRef("r2").assetRef).toEqual(fileRef("a9"));
        // 一次性提交后落盘
        expect(localForageStorage.setItem).toHaveBeenCalled();
    });

    it("reports missing legacy blobs without writing or repointing them", async () => {
        delete mediaBlobs["video:shot"];
        const result = await migrateProjectAssets("p1");
        expect(result).toEqual({ migrated: 5, missing: ["video:shot"] });
        expect(projectWrite).toHaveBeenCalledTimes(5);
        expect(findNode("p1", "n-shot")!.metadata!.assetRef).toBeUndefined();
        expect(findNode("p1", "n-hero")!.metadata!.assetRef).toMatchObject({ backend: "project-file" });
    });

    it("does not mutate project state when the second project write fails", async () => {
        const beforeProjects = useProjectStore.getState().projects;
        const beforeEntities = useScriptEntityStore.getState().entities;
        projectWrite.mockReset();
        projectWrite
            .mockResolvedValueOnce({ ok: true, value: { record: { backend: "project-file", assetId: "a1", projectId: "p1", relativePath: "assets/imported/a1", revision: 1, originalName: "hero.png", kind: "image", mimeType: "image/png", bytes: 4, sha256: "sha", createdAt: T, updatedAt: T, source: { type: "legacy-migration" } }, ref: fileRef("a1") } })
            .mockRejectedValueOnce(new Error("disk full"));
        await expect(migrateProjectAssets("p1")).rejects.toThrow("disk full");
        expect(projectWrite).toHaveBeenCalledTimes(2);
        expect(useProjectStore.getState().projects).toEqual(beforeProjects);
        expect(useScriptEntityStore.getState().entities).toEqual(beforeEntities);
    });

    it("rejects when returned bytes do not verify against the legacy blob", async () => {
        const beforeProjects = useProjectStore.getState().projects;
        projectWrite.mockReset();
        projectWrite.mockImplementation(async (input: { projectId: string; name: string; mimeType: string; bytes: Uint8Array; source: ProjectAssetSource }) => {
            writeSeq += 1;
            const result = bridgeWriteResult(input, writeSeq);
            result.value.record.bytes += 5;
            return result;
        });
        await expect(migrateProjectAssets("p1")).rejects.toThrow(/verification failed/);
        expect(useProjectStore.getState().projects).toEqual(beforeProjects);
    });

    it("is idempotent after a completed migration", async () => {
        const candidateCount = planLegacyAssetMigration(projectFixture, [entityFixture]).length;
        await migrateProjectAssets("p1");
        const second = await migrateProjectAssets("p1");
        expect(second).toEqual({ migrated: 0, missing: [] });
        expect(projectWrite).toHaveBeenCalledTimes(candidateCount);
    });

    it("fails clearly without half-running when no desktop bridge exists", async () => {
        delete window.shotshot;
        const beforeProjects = useProjectStore.getState().projects;
        await expect(migrateProjectAssets("p1")).rejects.toThrow(/workspace/i);
        expect(getImageBlob).not.toHaveBeenCalled();
        expect(getMediaBlob).not.toHaveBeenCalled();
        expect(useProjectStore.getState().projects).toEqual(beforeProjects);
    });

    it("rejects for an unknown project", async () => {
        await expect(migrateProjectAssets("gone")).rejects.toThrow(/not found/i);
        expect(projectWrite).not.toHaveBeenCalled();
    });

    it("ensures a missing workspace through the facade before any write", async () => {
        useProjectStore.setState({ projects: [{ ...projectFixture, id: "p9", workspacePath: undefined }] });
        ensureProjectWorkspace.mockResolvedValue({ ok: true, path: "/ws/ensured" });
        const result = await migrateProjectAssets("p9");
        expect(result).toEqual({ migrated: 5, missing: [] });
        expect(ensureProjectWorkspace).toHaveBeenCalledWith("p9", "P");
        expect(useProjectStore.getState().projects.find((item) => item.id === "p9")?.workspacePath).toBe("/ws/ensured");
        expect(projectWrite.mock.calls.every((call) => call[0].workspacePath === "/ws/ensured")).toBe(true);
    });

    it("surfaces workspace ensure failure without any writes", async () => {
        useProjectStore.setState({ projects: [{ ...projectFixture, id: "p10", workspacePath: undefined }] });
        ensureProjectWorkspace.mockResolvedValue({ ok: false, error: "disk error" });
        await expect(migrateProjectAssets("p10")).rejects.toThrow("disk error");
        expect(projectWrite).not.toHaveBeenCalled();
        expect(getImageBlob).not.toHaveBeenCalled();
    });

    it("提交成功后按候选键删除 IDB 源（move 语义）", async () => {
        await migrateProjectAssets("p1");
        expect(deleteStoredMediaKeys).toHaveBeenCalledTimes(1);
        const keys = deleteStoredMediaKeys.mock.calls[0][0] as string[];
        expect(keys).toEqual(expect.arrayContaining(["image:hero", "image:storyboard", "image:entity-ref", "video:shot", "audio:dialogue", "file:model"]));
    });

    it("commit 前校验目标键未变：copy-verify 窗口内重生成的节点被跳过，其余正常迁移（终审 I1）", async () => {
        let mutated = false;
        getImageBlob.mockImplementation(async (key: string) => {
            if (key === "image:hero" && !mutated) {
                mutated = true;
                // 模拟迁移 await 窗口内的用户重生成：整体替换该位置 storageKey（新内容、新键）
                useProjectStore.getState().updateCanvasNodes("p1", "c1", (nodes) =>
                    nodes.map((item) => (item.id === "n-hero" ? { ...item, metadata: { ...item.metadata!, storageKey: "image:hero-v2" } } : item)),
                );
            }
            return imageBlobs[key] ?? null;
        });
        const result = await migrateProjectAssets("p1");
        expect(result.migrated).toBe(6);
        // 被替换位置的旧键补丁丢弃：新键保留、无 assetRef（下次打开按新键自然重试）
        const hero = findNode("p1", "n-hero")!.metadata!;
        expect(hero.storageKey).toBe("image:hero-v2");
        expect(hero.assetRef).toBeUndefined();
        // 其余节点正常迁移
        expect(findNode("p1", "n-shot")!.metadata!.assetRef).toMatchObject({ backend: "project-file" });
        expect(findNode("p1", "n-multi")!.metadata!.images![0].assetRef).toMatchObject({ backend: "project-file" });
        expect(entityRef("r1").assetRef).toMatchObject({ backend: "project-file" });
    });

    it("删除返回失败键时不抛出、结果仍返回 migrated", async () => {
        deleteStoredMediaKeys.mockResolvedValueOnce(["image:hero"]);
        await expect(migrateProjectAssets("p1")).resolves.toMatchObject({ migrated: expect.any(Number) });
    });
});

describe("迁移身份剥离与规划器扩展（P2 spec §1/§3）", () => {
    it("plan 收集 glb: 前缀与 metadata.references 旧前缀字符串", () => {
        const project = {
            id: "p1", title: "P", category: "uncategorized", icon: "", color: "", createdAt: T, updatedAt: T,
            canvases: [canvas("c1", [
                node("n-glb", "file", { model3d: { name: "rig.glb", storageKey: "glb:legacy", mimeType: "model/gltf-binary" } }),
                node("n-ref", "image", { generationType: "edit", references: ["image:edit-ref", "data:image/png;base64,AA"], storageKey: "image:x", mimeType: "image/png" }),
            ])],
        } as unknown as Project;
        const keys = planLegacyAssetMigration(project).map((candidate) => candidate.storageKey).sort();
        expect(keys).toEqual(["glb:legacy", "image:edit-ref", "image:x"]);
    });

    it("applier 挂 assetRef 时剥离各位置 storageKey（metadata/images/model3d/views/shot-audio/reference），snapshot 不动", () => {
        const metadata: CanvasNodeMetadata = {
            storageKey: "image:top",
            mimeType: "image/png",
            references: ["image:edit-ref", "keep:data"],
            model3d: { storageKey: "glb:legacy", name: "rig.glb", snapshot: { storageKey: "image:snapshot" }, views: [{ id: "left" as never, storageKey: "image:view", assetRef: undefined }] },
            script: { ...createEmptyScriptData(), output: { status: "done" as never, shots: [shot({ dialogueAudio: { name: "d.mp3", storageKey: "audio:d", mimeType: "audio/mpeg" } })] } } as never,
        };
        const ref = fileRef("a9");
        const targetAll: LegacyCanvasAssetTarget[] = [
            { part: "metadata" }, { part: "model3d" }, { part: "model3d-view", viewId: "left" },
            { part: "shot-audio", shotId: "s1", slot: "dialogue" }, { part: "reference", index: 0 },
        ];
        const next = applyLegacyAssetRefToMetadata(metadata, targetAll, ref);
        expect("storageKey" in next).toBe(false);
        expect("storageKey" in (next.model3d || {})).toBe(false);
        expect(next.model3d?.snapshot?.storageKey).toBe("image:snapshot"); // T6-B：快照不剥
        expect(next.model3d?.views?.[0]).toEqual({ id: "left", assetRef: ref });
        expect(next.script?.output.shots[0].dialogueAudio).toEqual({ name: "d.mp3", mimeType: "audio/mpeg", assetRef: ref });
        expect(next.references?.[0]).toBe("pfile:p1:a9:1:assets%2Fimported%2Fa9");
        expect(next.references?.[1]).toBe("keep:data");
    });

    it("applyEntityAssetMigration 支持 clearStorageKey 显式剥离", () => {
        useScriptEntityStore.getState().applyEntityAssetMigration([{ entityId: "e1", refId: "r1", assetRef: fileRef("a9"), clearStorageKey: true }]);
        expect(entityRef("r1").assetRef).toEqual(fileRef("a9"));
        expect("storageKey" in entityRef("r1")).toBe(false);
    });

    it("legacyTargetStillMatches 按 part 分派读当前键：未变 true，重生成替换/位置消失 false", () => {
        const metadata: CanvasNodeMetadata = {
            storageKey: "image:top",
            images: [imageEntry("img-a", "image:multi")],
            model3d: { storageKey: "glb:model", name: "rig.glb", views: [{ id: "left" as never, storageKey: "image:view" }] },
            references: ["image:edit-ref"],
            script: { ...createEmptyScriptData(), output: { status: "done" as never, shots: [shot({ dialogueAudio: { name: "d.mp3", storageKey: "audio:d", mimeType: "audio/mpeg" } })] } } as never,
        };
        expect(legacyTargetStillMatches(metadata, { part: "metadata" }, "image:top")).toBe(true);
        expect(legacyTargetStillMatches(metadata, { part: "image", imageId: "img-a" }, "image:multi")).toBe(true);
        expect(legacyTargetStillMatches(metadata, { part: "model3d" }, "glb:model")).toBe(true);
        expect(legacyTargetStillMatches(metadata, { part: "model3d-view", viewId: "left" }, "image:view")).toBe(true);
        expect(legacyTargetStillMatches(metadata, { part: "reference", index: 0 }, "image:edit-ref")).toBe(true);
        expect(legacyTargetStillMatches(metadata, { part: "shot-audio", shotId: "s1", slot: "dialogue" }, "audio:d")).toBe(true);
        // 键已被替换（重生成）→ false
        expect(legacyTargetStillMatches(metadata, { part: "metadata" }, "image:old")).toBe(false);
        expect(legacyTargetStillMatches(metadata, { part: "image", imageId: "img-a" }, "image:gone")).toBe(false);
        // 位置消失（图片/视图/镜头音频被删）→ false
        expect(legacyTargetStillMatches(metadata, { part: "image", imageId: "img-x" }, "image:multi")).toBe(false);
        expect(legacyTargetStillMatches(metadata, { part: "model3d-view", viewId: "right" }, "image:view")).toBe(false);
        expect(legacyTargetStillMatches(metadata, { part: "shot-audio", shotId: "s1", slot: "sfx" }, "audio:s")).toBe(false);
    });
});
