import { beforeEach, describe, expect, test, vi } from "vitest";

const uploadRemoteImage = vi.hoisted(() => vi.fn());
const deleteStoredImages = vi.hoisted(() => vi.fn());
const discardRemoteImage = vi.hoisted(() => vi.fn());
const releaseRemoteImageLease = vi.hoisted(() => vi.fn());
const getImageBlob = vi.hoisted(() => vi.fn());
const normalizePluginVideo = vi.hoisted(() => vi.fn());
const storeRemoteGeneratedVideo = vi.hoisted(() => vi.fn());
const normalizePluginAudio = vi.hoisted(() => vi.fn());
const storeRemoteGeneratedAudio = vi.hoisted(() => vi.fn());
const deleteStoredMedia = vi.hoisted(() => vi.fn());
const discardRemoteMedia = vi.hoisted(() => vi.fn());
const releaseRemoteMediaLease = vi.hoisted(() => vi.fn());
const getMediaBlob = vi.hoisted(() => vi.fn());
const storeCanvasImage = vi.hoisted(() => vi.fn());
const storeCanvasMedia = vi.hoisted(() => vi.fn());
const projectStorage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }));
const assetState = vi.hoisted(() => ({ assets: [] as unknown[] }));
const deleteStoredMediaKeys = vi.hoisted(() => vi.fn(async () => [] as string[]));

vi.mock("@/services/image-storage", () => ({ uploadRemoteImage, deleteStoredImages, discardRemoteImage, releaseRemoteImageLease, getImageBlob }));
vi.mock("@/services/file-storage", () => ({ deleteStoredMedia, discardRemoteMedia, releaseRemoteMediaLease, getMediaBlob }));
vi.mock("@/services/api/video", () => ({ normalizePluginVideo, storeRemoteGeneratedVideo }));
vi.mock("@/services/api/audio", () => ({ normalizePluginAudio, storeRemoteGeneratedAudio }));
vi.mock("@/services/project-asset-storage", () => ({ storeCanvasImage, storeCanvasMedia }));
vi.mock("@/services/stored-media-delete", () => ({ deleteStoredMediaKeys }));
vi.mock("@/lib/localforage-storage", () => ({ localForageStorage: projectStorage }));
vi.mock("@/stores/use-asset-store", () => ({ useAssetStore: { getState: () => assetState } }));

import {
    applyRemoteImageOutput,
    applyRemoteTaskEvent,
    applyRemoteTaskOutputToProject,
    applyRemoteTaskState,
    applyRemoteTaskStateToProject,
    deliverRemoteTaskResult,
    deliverRemoteTaskToProject,
    getEmbeddedRemoteTaskStatus,
    hasRemoteTaskTarget,
    reconcileTerminalRemoteTaskMetadata,
    reconcileTerminalRemoteTasksToProjects,
    subscribeRemoteCanvasTaskEvents,
    type RemoteCanvasTaskEvent,
    type RemoteTaskDeliveryOutput,
} from "@/lib/canvas/remote-media-task-result";
import { getCanvasPersistenceDiagnostics, useProjectStore } from "@/stores/canvas/use-project-store";
import { createRemoteMediaTaskRunner } from "@/services/remote-media-task-runner";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import type { Project } from "@/types/project";
import type { RemoteMediaCapability, RemoteMediaTask, RemoteMediaTaskPatch, RemoteMediaTaskStatus, RemoteMediaTaskTarget } from "@/types/remote-media-task";
import type { UploadedFile } from "@/services/file-storage";
import type { UploadedImage } from "@/services/image-storage";

function canvasNode(id: string, type: CanvasNodeType, metadata: CanvasNodeMetadata = {}): CanvasNodeData {
    return { id, type, title: id, position: { x: 10, y: 20 }, width: 340, height: 240, metadata };
}

function imageBatchNode(id: string, imageIds: string[]): CanvasNodeData {
    return canvasNode(id, CanvasNodeType.Image, {
        status: "loading",
        images: imageIds.map((imageId) => ({ id: imageId, status: "loading", content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" })),
    });
}

function taskTarget(nodeId: string, itemId?: string, sourceNodeId?: string): RemoteMediaTaskTarget {
    return { projectId: "project-1", canvasId: "canvas-1", nodeId, itemId, sourceNodeId };
}

function taskFor(nodeId: string, patch: RemoteMediaTaskPatch = {}): RemoteMediaTask {
    const capability: RemoteMediaCapability = patch.capability || "image";
    return {
        id: "task-1",
        remoteTaskId: "remote-1",
        capability,
        target: taskTarget(nodeId, capability === "image" ? "i1" : undefined, patch.target?.sourceNodeId),
        channelId: "channel-1",
        modelName: `${capability}-model`,
        baseUrlSnapshot: "https://example.test/v1",
        queryScriptSnapshot: "return { status: 'pending' }",
        outputFormat: capability === "audio" ? "mp3" : undefined,
        status: "pending",
        phase: "running",
        progress: 40,
        submittedAt: 1,
        deadlineAt: 301_000,
        ...patch,
    };
}

function uploadedImage(storageKey = "image:1"): UploadedImage {
    return { url: "blob:image-1", storageKey, width: 1024, height: 768, bytes: 128, mimeType: "image/png" };
}

function uploadedFile(storageKey: string, mimeType: string): UploadedFile {
    return { url: `blob:${storageKey}`, storageKey, width: 1280, height: 720, durationMs: 2_000, bytes: 256, mimeType };
}

function imageOutput(storageKey = "image:1"): RemoteTaskDeliveryOutput {
    return { capability: "image", value: uploadedImage(storageKey) };
}

function projectWith(nodes: CanvasNodeData[], projectId = "project-1", canvasId = "canvas-1"): Project {
    return {
        id: projectId,
        title: "Project",
        category: "uncategorized",
        icon: "box",
        color: "#000000",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        canvases: [{
            id: canvasId,
            title: "Canvas",
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
            nodes,
            connections: [],
            chatSessions: [],
            activeChatId: null,
            backgroundMode: "lines",
            showImageInfo: false,
            viewport: { x: 0, y: 0, k: 1 },
        }],
    };
}

function deliveryContext(options: { aborted?: boolean; active?: boolean } = {}) {
    const controller = new AbortController();
    if (options.aborted) controller.abort(new DOMException("stopped", "AbortError"));
    return { signal: controller.signal, isActive: vi.fn(() => options.active ?? !options.aborted) };
}

function projectAssetRef(assetId: string) {
    return { backend: "project-file" as const, assetId, projectId: "project-1", relativePath: `assets/generated/${assetId}`, revision: 1 };
}

function projectStoredImage(assetId: string): UploadedImage {
    return { url: `blob:project-${assetId}`, assetRef: projectAssetRef(assetId), width: 1024, height: 768, bytes: 128, mimeType: "image/png" };
}

function projectStoredMedia(assetId: string, mimeType: string) {
    return { url: `blob:project-${assetId}`, assetRef: projectAssetRef(assetId), bytes: 256, mimeType, width: 1280, height: 720, durationMs: 2_000 };
}

function contextWithWorkspace(nodeId = "video-1") {
    return {
        ...deliveryContext(),
        assetWriteContext: {
            projectId: "project-1",
            projectTitle: "Project",
            workspacePath: "/workspaces/project-1",
            canvasId: "canvas-1",
            nodeId,
            source: { type: "generated" as const, canvasId: "canvas-1" },
        },
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

const PROJECT_STORE_KEY = "shotshot:canvas_store";
const PROJECT_REPAIR_KEY = "shotshot:canvas_store:repair";

beforeEach(async () => {
    projectStorage.getItem.mockResolvedValue(null);
    projectStorage.setItem.mockResolvedValue(undefined);
    projectStorage.removeItem.mockResolvedValue(undefined);
    await useProjectStore.getState().flush().catch(() => undefined);
    vi.clearAllMocks();
    projectStorage.getItem.mockResolvedValue(null);
    projectStorage.setItem.mockResolvedValue(undefined);
    projectStorage.removeItem.mockResolvedValue(undefined);
    useProjectStore.setState({ projects: [], pendingPrompt: null, pendingProjectId: null, pendingCanvasId: null });
    assetState.assets = [];
    uploadRemoteImage.mockResolvedValue(uploadedImage());
    deleteStoredImages.mockResolvedValue(undefined);
    deleteStoredMedia.mockResolvedValue(undefined);
    discardRemoteImage.mockResolvedValue(undefined);
    discardRemoteMedia.mockResolvedValue(undefined);
    normalizePluginVideo.mockReturnValue({ url: "https://example.test/video.mp4", mimeType: "video/mp4" });
    storeRemoteGeneratedVideo.mockResolvedValue(uploadedFile("video:1", "video/mp4"));
    normalizePluginAudio.mockResolvedValue(new Blob(["audio"], { type: "audio/mpeg" }));
    storeRemoteGeneratedAudio.mockResolvedValue(uploadedFile("audio:1", "audio/mpeg"));
    getImageBlob.mockResolvedValue(new Blob(["image-bytes"], { type: "image/png" }));
    getMediaBlob.mockResolvedValue(new Blob(["media-bytes"], { type: "video/mp4" }));
    storeCanvasImage.mockImplementation(async (_blob: Blob, context: { source: { nodeId?: string } }) => projectStoredImage(`asset-${context.source.nodeId || "image"}`));
    storeCanvasMedia.mockImplementation(async (_blob: Blob, context: { source: { nodeId?: string } }) => projectStoredMedia(`asset-${context.source.nodeId || "media"}`, "video/mp4"));
});

describe("remote media node reducers", () => {
    test("reconciles terminal durable tasks only when the embedded active task ID matches", () => {
        const active = taskFor("n1", { status: "pending" });
        const failed = { ...active, status: "failed" as const, error: "provider denied" };
        const embedded = applyRemoteTaskState([imageBatchNode("n1", ["i1"])], active);

        expect(reconcileTerminalRemoteTaskMetadata(embedded, [failed])[0].metadata?.images?.[0]).toMatchObject({ status: "error", errorDetails: "provider denied", remoteTask: { status: "failed" } });

        const newer = applyRemoteTaskState([imageBatchNode("n1", ["i1"])], { ...active, id: "task-new" });
        expect(reconcileTerminalRemoteTaskMetadata(newer, [failed])).toBe(newer);
    });
    test("updates one batch image item and promotes first success", () => {
        const next = applyRemoteImageOutput([imageBatchNode("n1", ["i1", "i2"])], taskTarget("n1", "i1"), uploadedImage());
        expect(next[0].metadata?.images?.[0]).toMatchObject({ id: "i1", status: "success", storageKey: "image:1" });
        expect(next[0].metadata?.primaryImageId).toBe("i1");
        expect(next[0].metadata?.status).toBe("success");
    });

    test("does not recreate deleted targets or deleted image items", () => {
        const empty: CanvasNodeData[] = [];
        expect(applyRemoteImageOutput(empty, taskTarget("missing", "i1"), uploadedImage())).toBe(empty);
        const nodes = [imageBatchNode("n1", ["i2"])];
        expect(applyRemoteImageOutput(nodes, taskTarget("n1", "i1"), uploadedImage())).toBe(nodes);
    });

    test("updates video and audio nodes with stored media metadata", () => {
        const videoTask = taskFor("video-1", { capability: "video", target: taskTarget("video-1") });
        const audioTask = taskFor("audio-1", { capability: "audio", target: taskTarget("audio-1") });
        const nodes = [canvasNode("video-1", CanvasNodeType.Video, { status: "loading" }), canvasNode("audio-1", CanvasNodeType.Audio, { status: "loading" })];
        const afterVideo = applyRemoteTaskEvent(nodes, { projectId: "project-1", canvasId: "canvas-1", task: videoTask, output: { capability: "video", value: uploadedFile("video:1", "video/mp4") } });
        const next = applyRemoteTaskEvent(afterVideo, { projectId: "project-1", canvasId: "canvas-1", task: audioTask, output: { capability: "audio", value: uploadedFile("audio:1", "audio/mpeg") } });
        expect(next[0].metadata).toMatchObject({ status: "success", storageKey: "video:1", mimeType: "video/mp4" });
        expect(next[1].metadata).toMatchObject({ status: "success", storageKey: "audio:1", mimeType: "audio/mpeg" });
    });

    test("marks only the failed batch item and fails the root after every item terminates", () => {
        const nodes = [imageBatchNode("n1", ["i1", "i2"])];
        const first = applyRemoteTaskState(nodes, taskFor("n1", { status: "failed", error: "first", target: taskTarget("n1", "i1") }));
        expect(first[0].metadata?.status).toBe("loading");
        expect(first[0].metadata?.images?.[0]).toMatchObject({ status: "error", errorDetails: "first" });
        const second = applyRemoteTaskState(first, taskFor("n1", { id: "task-2", status: "timed_out", target: taskTarget("n1", "i2") }));
        expect(second[0].metadata?.status).toBe("error");
        expect(second[0].metadata?.images?.[1]).toMatchObject({ status: "error" });
    });

    test("stores recoverable task phase and progress on the target node", () => {
        const next = applyRemoteTaskState([imageBatchNode("n1", ["i1"])], taskFor("n1", { status: "waiting_network", phase: "queued", progress: 15 }));
        expect(next[0].metadata?.images?.[0].remoteTask).toEqual({ id: "task-1", status: "waiting_network", phase: "queued", progress: 15, submittedAt: 1 });
        expect(next[0].metadata?.remoteTask).toBeUndefined();
        expect(next[0].metadata?.status).toBe("loading");
    });

    test("keeps one failed and one recoverable image task distinct across reload cleanup", () => {
        const failed = applyRemoteTaskState([imageBatchNode("n1", ["i1", "i2"])], taskFor("n1", { status: "failed", error: "first", target: taskTarget("n1", "i1") }));
        const mixed = applyRemoteTaskState(failed, taskFor("n1", { id: "task-2", status: "pending", target: taskTarget("n1", "i2") }));
        expect(mixed[0].metadata?.images?.map((image) => image.remoteTask?.status)).toEqual(["failed", "pending"]);
        expect(mixed[0].metadata?.status).toBe("loading");
    });

    test("promotes a configuration source after one child succeeds and only fails it after all image items fail", () => {
        const nodes = [canvasNode("config-1", CanvasNodeType.Config, { status: "loading" }), imageBatchNode("n1", ["i1", "i2"])];
        const target = taskTarget("n1", "i1", "config-1");
        const succeeded = applyRemoteTaskEvent(nodes, { projectId: "project-1", canvasId: "canvas-1", task: taskFor("n1", { target }), output: imageOutput() });
        expect(succeeded[0].metadata?.status).toBe("success");

        const firstFailure = applyRemoteTaskState(nodes, taskFor("n1", { status: "failed", error: "first", target }));
        expect(firstFailure[0].metadata?.status).toBe("loading");
        const allFailed = applyRemoteTaskState(firstFailure, taskFor("n1", { id: "task-2", status: "failed", error: "second", target: taskTarget("n1", "i2", "config-1") }));
        expect(allFailed[0].metadata?.status).toBe("error");
    });
});

describe("guarded result persistence", () => {
    test("keeps the durable task succeeded when delivery already made terminal apply unchanged", async () => {
        const initial = taskFor("n1", { status: "pending" });
        let tasks = [initial];
        useProjectStore.setState({ projects: [projectWith(applyRemoteTaskState([imageBatchNode("n1", ["i1"])], initial))] });
        uploadRemoteImage.mockResolvedValue(uploadedImage("image:succeeded"));
        const runner = createRemoteMediaTaskRunner({
            getTasks: () => tasks,
            patchTask: (id, patch) => { tasks = tasks.map((task) => task.id === id ? { ...task, ...patch } : task); },
            flush: vi.fn().mockResolvedValue(undefined),
            applyTaskState: applyRemoteTaskStateToProject,
            getConfig: () => ({ ...defaultConfig, channels: [{ id: "channel-1", name: "Provider", baseUrl: "https://example.test", apiKey: "secret", apiFormat: "openai", models: [] }] }),
            queryLegacy: vi.fn().mockResolvedValue({ status: "succeeded", result: "data:image/png;base64,OK" }),
            deliver: deliverRemoteTaskToProject,
            now: () => 1_000,
        });

        await runner.start();

        expect(tasks[0].status).toBe("succeeded");
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.images?.[0]).toMatchObject({ status: "success", remoteTask: { status: "succeeded" } });
    });
    test("exports a startup reconciliation transaction for Task6 hydration recovery", async () => {
        const active = taskFor("n1", { status: "pending" });
        const terminal = { ...active, status: "failed" as const, error: "provider denied" };
        useProjectStore.setState({ projects: [projectWith(applyRemoteTaskState([imageBatchNode("n1", ["i1"])], active))] });

        const outcomes = await reconcileTerminalRemoteTasksToProjects([terminal]);

        expect(outcomes).toEqual([{ taskId: terminal.id, outcome: { applied: true } }]);
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.images?.[0]).toMatchObject({ status: "error", errorDetails: "provider denied" });
    });
    test("converges a restarted active task from a real embedded success without querying or delivering again", async () => {
        const active = taskFor("n1", { status: "pending" });
        const embedded = applyRemoteTaskEvent(applyRemoteTaskState([imageBatchNode("n1", ["i1"])], active), {
            projectId: "project-1",
            canvasId: "canvas-1",
            task: active,
            output: imageOutput("image:restart-success"),
        });
        useProjectStore.setState({ projects: [projectWith(embedded)] });
        let tasks = [active];
        const query = vi.fn();
        const deliver = vi.fn();
        const runner = createRemoteMediaTaskRunner({
            getTasks: () => tasks,
            patchTask: (id, patch) => { tasks = tasks.map((task) => task.id === id ? { ...task, ...patch } : task); },
            persistTaskPatch: async (id, patch) => {
                tasks = tasks.map((task) => task.id === id ? { ...task, ...patch } : task);
                return tasks.find((task) => task.id === id);
            },
            flush: vi.fn().mockResolvedValue(undefined),
            applyTaskState: applyRemoteTaskStateToProject,
            getEmbeddedTaskStatus: getEmbeddedRemoteTaskStatus,
            getConfig: () => defaultConfig,
            queryLegacy: query,
            deliver,
            now: () => 1_000,
        });

        await runner.start();

        expect(tasks[0].status).toBe("succeeded");
        expect(query).not.toHaveBeenCalled();
        expect(deliver).not.toHaveBeenCalled();
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.images?.[0]).toMatchObject({ status: "success", remoteTask: { status: "succeeded" } });
    });
    test("does not perform an irreversible delivery write after stop or timeout", async () => {
        const context = deliveryContext({ aborted: true, active: false });
        await expect(deliverRemoteTaskResult(taskFor("n1"), "data:image/png;base64,OK", context)).rejects.toHaveProperty("name", "AbortError");
        expect(uploadRemoteImage).not.toHaveBeenCalled();
    });

    test("rechecks activity after asynchronous audio normalization before storage", async () => {
        const normalization = deferred<Blob>();
        let active = true;
        normalizePluginAudio.mockReturnValue(normalization.promise);
        const context = { signal: new AbortController().signal, isActive: () => active };
        const delivering = deliverRemoteTaskResult(taskFor("audio-1", { capability: "audio", target: taskTarget("audio-1") }), { url: "https://example.test/audio.mp3" }, context);
        active = false;
        normalization.resolve(new Blob(["audio"], { type: "audio/mpeg" }));
        await expect(delivering).rejects.toHaveProperty("name", "AbortError");
        expect(storeRemoteGeneratedAudio).not.toHaveBeenCalled();
    });

    test("rejects an empty image result before upload", async () => {
        await expect(deliverRemoteTaskResult(taskFor("n1"), {}, deliveryContext())).rejects.toThrow();
        expect(uploadRemoteImage).not.toHaveBeenCalled();
    });

    test("protects cleanup keys referenced by either projects or assets", async () => {
        useProjectStore.setState({ projects: [projectWith([canvasNode("owned", CanvasNodeType.Image, { storageKey: "image:project" })])] });
        assetState.assets = [{ kind: "image", data: { storageKey: "image:asset" } }];
        uploadRemoteImage.mockImplementationOnce(async (_source, context) => {
            expect(context.isStorageKeyReferenced("image:project")).toBe(true);
            expect(context.isStorageKeyReferenced("image:asset")).toBe(true);
            return uploadedImage();
        });

        await expect(deliverRemoteTaskResult(taskFor("n1"), "data:image/png;base64,OK", deliveryContext())).resolves.toMatchObject({ capability: "image" });
    });

    test("does not update a project after delivery becomes inactive", async () => {
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"])])] });
        const context = deliveryContext();
        context.isActive.mockReturnValueOnce(true).mockReturnValueOnce(false);
        await expect(applyRemoteTaskOutputToProject(taskFor("n1"), imageOutput(), context)).resolves.toEqual({ applied: false, reason: "inactive" });
        expect(context.isActive).toHaveBeenCalledTimes(2);
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.status).toBe("loading");
    });

    test("reports a missing project, canvas, node, or batch item so the runner can interrupt it", async () => {
        await expect(applyRemoteTaskOutputToProject(taskFor("missing"), imageOutput())).resolves.toEqual({ applied: false, reason: "missing_target" });
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i2"])])] });
        await expect(applyRemoteTaskOutputToProject(taskFor("n1"), imageOutput())).resolves.toEqual({ applied: false, reason: "missing_target" });
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.images).toHaveLength(1);
    });

    test("atomically updates a closed canvas and emits the same event for an open canvas", async () => {
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"])])] });
        const events: RemoteCanvasTaskEvent[] = [];
        const unsubscribe = subscribeRemoteCanvasTaskEvents((event) => events.push(event));
        const result = await applyRemoteTaskOutputToProject(taskFor("n1"), imageOutput());
        unsubscribe();

        expect(result).toEqual({ applied: true });
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.storageKey).toBe("image:1");
        expect(events).toHaveLength(1);
        expect(applyRemoteTaskEvent([imageBatchNode("n1", ["i1"])], events[0])[0].metadata?.storageKey).toBe("image:1");
    });

    test("keeps a successful project write when an open-canvas event subscriber throws", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"])])] });
        const unsubscribe = subscribeRemoteCanvasTaskEvents(() => { throw new Error("open canvas failed"); });
        await expect(applyRemoteTaskOutputToProject(taskFor("n1"), imageOutput())).resolves.toEqual({ applied: true });
        unsubscribe();
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.storageKey).toBe("image:1");
        errorSpy.mockRestore();
    });

    test("does not emit or report applied until the exact project snapshot is durable", async () => {
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"])])] });
        const persistence = deferred<void>();
        projectStorage.setItem.mockReturnValueOnce(persistence.promise);
        const events: RemoteCanvasTaskEvent[] = [];
        const unsubscribe = subscribeRemoteCanvasTaskEvents((event) => events.push(event));
        let settled = false;
        const applying = applyRemoteTaskOutputToProject(taskFor("n1"), imageOutput()).then((result) => { settled = true; return result; });
        await vi.waitFor(() => expect(projectStorage.setItem).toHaveBeenCalled());
        expect(settled).toBe(false);
        expect(events).toEqual([]);
        persistence.resolve();
        await expect(applying).resolves.toEqual({ applied: true });
        expect(events).toHaveLength(1);
        unsubscribe();
    });

    test("propagates project persistence failure without emitting success and cleans the new media", async () => {
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"])])] });
        projectStorage.setItem.mockRejectedValueOnce(new Error("project write failed"));
        const events: RemoteCanvasTaskEvent[] = [];
        const unsubscribe = subscribeRemoteCanvasTaskEvents((event) => events.push(event));
        await expect(applyRemoteTaskOutputToProject(taskFor("n1"), imageOutput())).rejects.toThrow("project write failed");
        expect(events).toEqual([]);
        expect(deleteStoredImages).toHaveBeenCalledWith(["image:1"]);
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.status).toBe("loading");
        unsubscribe();
    });

    test("persists a deletion that happens while the result snapshot is being written", async () => {
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"])])] });
        const persistence = deferred<void>();
        projectStorage.setItem.mockReturnValueOnce(persistence.promise).mockResolvedValue(undefined);
        const events: RemoteCanvasTaskEvent[] = [];
        const unsubscribe = subscribeRemoteCanvasTaskEvents((event) => events.push(event));
        const applying = applyRemoteTaskOutputToProject(taskFor("n1"), imageOutput());
        await vi.waitFor(() => expect(projectStorage.setItem).toHaveBeenCalledTimes(1));
        useProjectStore.getState().updateCanvasNodes("project-1", "canvas-1", () => []);
        persistence.resolve();
        await expect(applying).resolves.toEqual({ applied: false, reason: "missing_target" });
        expect(projectStorage.setItem).toHaveBeenCalledTimes(2);
        expect(JSON.parse(projectStorage.setItem.mock.calls[1][1] as string).state.projects[0].canvases[0].nodes).toEqual([]);
        expect(deleteStoredImages).toHaveBeenCalledWith(["image:1"]);
        expect(events).toEqual([]);
        unsubscribe();
    });

    test("applies and emits state updates once, while isolating projects", async () => {
        const first = projectWith([imageBatchNode("n1", ["i1"])], "project-1", "canvas-1");
        const second = projectWith([imageBatchNode("n2", ["i2"])], "project-2", "canvas-2");
        useProjectStore.setState({ projects: [first, second] });
        const task = taskFor("n2", { id: "task-2", target: { projectId: "project-2", canvasId: "canvas-2", nodeId: "n2", itemId: "i2" }, status: "waiting_network" });
        const events: RemoteCanvasTaskEvent[] = [];
        const unsubscribe = subscribeRemoteCanvasTaskEvents((event) => events.push(event));
        await expect(applyRemoteTaskStateToProject(task)).resolves.toEqual({ applied: true });
        await expect(applyRemoteTaskStateToProject(task)).resolves.toEqual({ applied: false, reason: "unchanged" });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ projectId: "project-2", canvasId: "canvas-2" });
        expect(useProjectStore.getState().projects[0]).toBe(first);
        expect(useProjectStore.getState().projects[1].canvases[0].nodes[0].metadata?.images?.[0].remoteTask?.id).toBe("task-2");
        unsubscribe();
    });

    test("preflights a deleted target before any remote media storage", async () => {
        await expect(deliverRemoteTaskToProject(taskFor("missing"), "data:image/png;base64,OK", deliveryContext())).resolves.toEqual({ applied: false, reason: "missing_target" });
        expect(uploadRemoteImage).not.toHaveBeenCalled();
    });

    test("cleans a stored result when the target is deleted before final apply", async () => {
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"])])] });
        const storing = deferred<UploadedImage>();
        uploadRemoteImage.mockReturnValueOnce(storing.promise);
        const delivering = deliverRemoteTaskToProject(taskFor("n1"), "data:image/png;base64,OK", deliveryContext());
        await vi.waitFor(() => expect(uploadRemoteImage).toHaveBeenCalled());
        useProjectStore.getState().updateCanvasNodes("project-1", "canvas-1", () => []);
        storing.resolve(uploadedImage());
        await expect(delivering).resolves.toEqual({ applied: false, reason: "missing_target" });
        expect(deleteStoredImages).toHaveBeenCalledWith(["image:1"]);
        expect(useProjectStore.getState().projects[0].canvases[0].nodes).toEqual([]);
    });

    test("cleans media completed by a storage boundary after the task stops", async () => {
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"])])] });
        const storing = deferred<UploadedImage>();
        let active = true;
        uploadRemoteImage.mockReturnValueOnce(storing.promise);
        const context = { signal: new AbortController().signal, isActive: () => active };
        const delivering = deliverRemoteTaskToProject(taskFor("n1"), "data:image/png;base64,OK", context);
        await vi.waitFor(() => expect(uploadRemoteImage).toHaveBeenCalled());
        active = false;
        storing.resolve(uploadedImage());
        await expect(delivering).rejects.toHaveProperty("name", "AbortError");
        expect(deleteStoredImages).toHaveBeenCalledWith(["image:1"]);
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.status).toBe("loading");
    });

    test("rejects remote results that did not receive a real local storage key", async () => {
        uploadRemoteImage.mockResolvedValueOnce(uploadedImage(""));
        await expect(deliverRemoteTaskResult(taskFor("n1"), "https://example.test/image.png", deliveryContext())).rejects.toThrow("storageKey");
    });

    test("serializes concurrent deliveries so a failed A snapshot cannot leak into successful B", async () => {
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1", "i2"])])] });
        projectStorage.setItem.mockRejectedValueOnce(new Error("A persist failed")).mockResolvedValue(undefined);
        const taskA = taskFor("n1", { id: "task-a", target: taskTarget("n1", "i1") });
        const taskB = taskFor("n1", { id: "task-b", target: taskTarget("n1", "i2") });
        const [a, b] = await Promise.allSettled([
            applyRemoteTaskOutputToProject(taskA, imageOutput("image:a")),
            applyRemoteTaskOutputToProject(taskB, imageOutput("image:b")),
        ]);
        expect(a.status).toBe("rejected");
        expect(b).toEqual({ status: "fulfilled", value: { applied: true } });
        const images = useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.images || [];
        expect(images.map((image) => [image.id, image.status, image.storageKey])).toEqual([["i1", "loading", undefined], ["i2", "success", "image:b"]]);
        const disk = JSON.parse(projectStorage.setItem.mock.calls.at(-1)?.[1] as string).state.projects[0].canvases[0].nodes[0].metadata.images;
        expect(disk.map((image: { id: string; storageKey?: string }) => [image.id, image.storageKey])).toEqual([["i1", undefined], ["i2", "image:b"]]);
        expect(deleteStoredImages).toHaveBeenCalledWith(["image:a"]);
        expect(deleteStoredImages).not.toHaveBeenCalledWith(["image:b"]);
    });

    test("serializes B after A aborts post-write and durably rolls A back", async () => {
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1", "i2"])])] });
        const firstWrite = deferred<void>();
        projectStorage.setItem.mockReturnValueOnce(firstWrite.promise).mockResolvedValue(undefined);
        let activeA = true;
        const contextA = { signal: new AbortController().signal, isActive: () => activeA };
        const taskA = taskFor("n1", { id: "task-a", target: taskTarget("n1", "i1") });
        const taskB = taskFor("n1", { id: "task-b", target: taskTarget("n1", "i2") });
        const deliveringA = applyRemoteTaskOutputToProject(taskA, imageOutput("image:a"), contextA);
        const deliveringB = applyRemoteTaskOutputToProject(taskB, imageOutput("image:b"));
        await vi.waitFor(() => expect(projectStorage.setItem).toHaveBeenCalledTimes(1));
        activeA = false;
        firstWrite.resolve();
        await expect(deliveringA).rejects.toHaveProperty("name", "AbortError");
        await expect(deliveringB).resolves.toEqual({ applied: true });
        const images = useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.images || [];
        expect(images.map((image) => [image.id, image.storageKey])).toEqual([["i1", undefined], ["i2", "image:b"]]);
        const disk = JSON.parse(projectStorage.setItem.mock.calls.at(-1)?.[1] as string).state.projects[0].canvases[0].nodes[0].metadata.images;
        expect(disk.map((image: { id: string; storageKey?: string }) => [image.id, image.storageKey])).toEqual([["i1", undefined], ["i2", "image:b"]]);
    });

    test("preserves media and reports both errors when post-write abort rollback fails", async () => {
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"])])] });
        const firstWrite = deferred<void>();
        projectStorage.setItem.mockReturnValueOnce(firstWrite.promise).mockRejectedValueOnce(new Error("rollback unavailable"));
        let active = true;
        const context = { signal: new AbortController().signal, isActive: () => active };
        const applying = applyRemoteTaskOutputToProject(taskFor("n1"), imageOutput("image:a"), context);
        await vi.waitFor(() => expect(projectStorage.setItem).toHaveBeenCalledTimes(1));
        active = false;
        firstWrite.resolve();
        await expect(applying).rejects.toThrow(/Remote media task stopped.*rollback unavailable|rollback unavailable.*Remote media task stopped/);
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.storageKey).toBe("image:a");
        const disk = JSON.parse(projectStorage.setItem.mock.calls[0][1] as string).state.projects[0].canvases[0].nodes[0].metadata.storageKey;
        expect(disk).toBe("image:a");
        expect(deleteStoredImages).not.toHaveBeenCalledWith(["image:a"]);
    });

    test("rebases remote output over concurrent node, viewport, and other-project edits", async () => {
        const otherNode = canvasNode("other", CanvasNodeType.Text, { content: "draft" });
        const second = projectWith([], "project-2", "canvas-2");
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"]), otherNode]), second] });
        const firstWrite = deferred<void>();
        projectStorage.setItem.mockReturnValueOnce(firstWrite.promise).mockResolvedValue(undefined);
        const applying = applyRemoteTaskOutputToProject(taskFor("n1"), imageOutput("image:rebased"));
        await vi.waitFor(() => expect(projectStorage.setItem).toHaveBeenCalledTimes(1));
        useProjectStore.getState().updateCanvasNodes("project-1", "canvas-1", (nodes) => nodes.map((node) => node.id === "other" ? { ...node, position: { x: 99, y: 101 } } : node));
        useProjectStore.getState().updateCanvas("project-1", "canvas-1", { viewport: { x: 7, y: 8, k: 1.5 } });
        useProjectStore.getState().renameProject("project-2", "Updated elsewhere");
        firstWrite.resolve();

        await expect(applying).resolves.toEqual({ applied: true });
        const state = useProjectStore.getState().projects;
        expect(state[0].canvases[0].nodes.find((node) => node.id === "n1")?.metadata?.storageKey).toBe("image:rebased");
        expect(state[0].canvases[0]).toMatchObject({ viewport: { x: 7, y: 8, k: 1.5 } });
        expect(state[0].canvases[0].nodes.find((node) => node.id === "other")?.position).toEqual({ x: 99, y: 101 });
        expect(state[1].title).toBe("Updated elsewhere");
        const disk = JSON.parse(projectStorage.setItem.mock.calls.at(-1)?.[1] as string).state.projects;
        expect(disk[0].canvases[0].nodes.find((node: CanvasNodeData) => node.id === "n1").metadata.storageKey).toBe("image:rebased");
        expect(disk[0].canvases[0].viewport).toEqual({ x: 7, y: 8, k: 1.5 });
        expect(disk[1].title).toBe("Updated elsewhere");
    });

    test("requeues a pending autosave when the remote candidate write fails", async () => {
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"])])] });
        useProjectStore.getState().updateCanvas("project-1", "canvas-1", { viewport: { x: 12, y: 13, k: 2 } });
        projectStorage.setItem.mockRejectedValueOnce(new Error("candidate unavailable")).mockResolvedValue(undefined);

        await expect(applyRemoteTaskOutputToProject(taskFor("n1"), imageOutput())).rejects.toThrow("candidate unavailable");
        await useProjectStore.getState().flush();

        const disk = JSON.parse(projectStorage.setItem.mock.calls.at(-1)?.[1] as string).state.projects[0].canvases[0];
        expect(disk.viewport).toEqual({ x: 12, y: 13, k: 2 });
        expect(disk.nodes[0].metadata.storageKey).toBeUndefined();
    });

    test("rolls back an aborted candidate onto the latest concurrent user edit", async () => {
        const otherNode = canvasNode("other", CanvasNodeType.Text, { content: "draft" });
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"]), otherNode])] });
        const firstWrite = deferred<void>();
        projectStorage.setItem.mockReturnValueOnce(firstWrite.promise).mockResolvedValue(undefined);
        let active = true;
        const applying = applyRemoteTaskOutputToProject(taskFor("n1"), imageOutput("image:aborted"), { signal: new AbortController().signal, isActive: () => active });
        await vi.waitFor(() => expect(projectStorage.setItem).toHaveBeenCalledTimes(1));
        useProjectStore.getState().updateCanvasNodes("project-1", "canvas-1", (nodes) => nodes.map((node) => node.id === "other" ? { ...node, position: { x: 77, y: 88 } } : node));
        active = false;
        firstWrite.resolve();

        await expect(applying).rejects.toHaveProperty("name", "AbortError");
        const nodes = useProjectStore.getState().projects[0].canvases[0].nodes;
        expect(nodes.find((node) => node.id === "other")?.position).toEqual({ x: 77, y: 88 });
        expect(nodes.find((node) => node.id === "n1")?.metadata?.storageKey).toBeUndefined();
        const disk = JSON.parse(projectStorage.setItem.mock.calls.at(-1)?.[1] as string).state.projects[0].canvases[0].nodes;
        expect(disk.find((node: CanvasNodeData) => node.id === "other").position).toEqual({ x: 77, y: 88 });
        expect(disk.find((node: CanvasNodeData) => node.id === "n1").metadata.storageKey).toBeUndefined();
    });

    test("returns missing_target when an item is deleted while its transaction is queued", async () => {
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1", "i2"])])] });
        const firstWrite = deferred<void>();
        projectStorage.setItem.mockReturnValueOnce(firstWrite.promise).mockResolvedValue(undefined);
        const first = applyRemoteTaskOutputToProject(taskFor("n1", { id: "task-a", target: taskTarget("n1", "i1") }), imageOutput("image:a"));
        const queued = applyRemoteTaskOutputToProject(taskFor("n1", { id: "task-b", target: taskTarget("n1", "i2") }), imageOutput("image:b"));
        await vi.waitFor(() => expect(projectStorage.setItem).toHaveBeenCalledTimes(1));
        useProjectStore.getState().updateCanvasNodes("project-1", "canvas-1", (nodes) => nodes.map((node) => node.id === "n1" ? { ...node, metadata: { ...node.metadata, images: node.metadata?.images?.filter((image) => image.id !== "i2") } } : node));
        firstWrite.resolve();

        await expect(first).resolves.toEqual({ applied: true });
        await expect(queued).resolves.toEqual({ applied: false, reason: "missing_target" });
        expect(deleteStoredImages).toHaveBeenCalledWith(["image:b"]);
    });

    test.each([
        ["project", () => useProjectStore.getState().deleteProjects(["project-target"])],
        ["canvas", () => useProjectStore.getState().replaceProjects(useProjectStore.getState().projects.map((project) => project.id === "project-target" ? { ...project, canvases: project.canvases.filter((canvas) => canvas.id !== "canvas-target") } : project))],
        ["node", () => useProjectStore.getState().updateCanvasNodes("project-target", "canvas-target", () => [])],
        ["item", () => useProjectStore.getState().updateCanvasNodes("project-target", "canvas-target", (nodes) => nodes.map((node) => ({ ...node, metadata: { ...node.metadata, images: [] } })))],
    ] as const)("returns missing_target when the queued %s target is deleted", async (_scope, removeTarget) => {
        const blocker = projectWith([imageBatchNode("node-blocker", ["item-blocker"])], "project-blocker", "canvas-blocker");
        const target = projectWith([imageBatchNode("node-target", ["item-target"])], "project-target", "canvas-target");
        useProjectStore.setState({ projects: [blocker, target] });
        const firstWrite = deferred<void>();
        projectStorage.setItem.mockReturnValueOnce(firstWrite.promise).mockResolvedValue(undefined);
        const blockerTask = taskFor("node-blocker", { id: "task-blocker", target: { projectId: "project-blocker", canvasId: "canvas-blocker", nodeId: "node-blocker", itemId: "item-blocker" } });
        const targetTask = taskFor("node-target", { id: "task-target", target: { projectId: "project-target", canvasId: "canvas-target", nodeId: "node-target", itemId: "item-target" } });
        const first = applyRemoteTaskOutputToProject(blockerTask, imageOutput("image:blocker"));
        const queued = applyRemoteTaskOutputToProject(targetTask, imageOutput("image:target"));
        await vi.waitFor(() => expect(projectStorage.setItem).toHaveBeenCalledTimes(1));
        removeTarget();
        firstWrite.resolve();

        await expect(first).resolves.toEqual({ applied: true });
        await expect(queued).resolves.toEqual({ applied: false, reason: "missing_target" });
        expect(deleteStoredImages).toHaveBeenCalledWith(["image:target"]);
    });

    test("retains and emits the rebased candidate when abort rollback fails, then autosaves that outcome", async () => {
        const otherNode = canvasNode("other", CanvasNodeType.Text, { content: "draft" });
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"]), otherNode])] });
        const firstWrite = deferred<void>();
        projectStorage.setItem.mockReturnValueOnce(firstWrite.promise).mockRejectedValueOnce(new Error("rollback unavailable")).mockResolvedValue(undefined);
        let active = true;
        const events: RemoteCanvasTaskEvent[] = [];
        const unsubscribe = subscribeRemoteCanvasTaskEvents((event) => events.push(event));
        const output = imageOutput("image:retained");
        output.value.provisionalLease = { storageKey: "image:retained", generation: 7 };
        const applying = applyRemoteTaskOutputToProject(taskFor("n1"), output, { signal: new AbortController().signal, isActive: () => active });
        await vi.waitFor(() => expect(projectStorage.setItem).toHaveBeenCalledTimes(1));
        useProjectStore.getState().updateCanvasNodes("project-1", "canvas-1", (nodes) => nodes.map((node) => node.id === "other" ? { ...node, position: { x: 55, y: 66 } } : node));
        active = false;
        firstWrite.resolve();

        await expect(applying).rejects.toThrow(/Remote media task stopped.*rollback unavailable|rollback unavailable.*Remote media task stopped/);
        expect(events).toHaveLength(1);
        const memoryNodes = useProjectStore.getState().projects[0].canvases[0].nodes;
        expect(memoryNodes.find((node) => node.id === "n1")?.metadata?.storageKey).toBe("image:retained");
        expect(memoryNodes.find((node) => node.id === "other")?.position).toEqual({ x: 55, y: 66 });
        await useProjectStore.getState().flush();
        const diskNodes = JSON.parse(projectStorage.setItem.mock.calls.at(-1)?.[1] as string).state.projects[0].canvases[0].nodes;
        expect(diskNodes.find((node: CanvasNodeData) => node.id === "n1").metadata.storageKey).toBe("image:retained");
        expect(diskNodes.find((node: CanvasNodeData) => node.id === "other").position).toEqual({ x: 55, y: 66 });
        expect(releaseRemoteImageLease).toHaveBeenCalledWith(output.value);
        expect(discardRemoteImage).not.toHaveBeenCalled();
        unsubscribe();
    });

    test("combines a missing-target cleanup failure with the delivery error", async () => {
        deleteStoredImages.mockRejectedValueOnce(new Error("image remove unavailable"));
        await expect(applyRemoteTaskOutputToProject(taskFor("missing"), imageOutput())).rejects.toThrow(/missing.*image remove unavailable|image remove unavailable.*missing/i);
    });

    test("combines a persistence error with a failed uncommitted-media cleanup", async () => {
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"])])] });
        projectStorage.setItem.mockRejectedValueOnce(new Error("project unavailable"));
        deleteStoredImages.mockRejectedValueOnce(new Error("image remove unavailable"));
        await expect(applyRemoteTaskOutputToProject(taskFor("n1"), imageOutput())).rejects.toThrow(/project unavailable.*image remove unavailable|image remove unavailable.*project unavailable/);
    });

    test("recovers a journaled retained result and concurrent edit on reload without a manual flush", async () => {
        const disk = new Map<string, string>();
        const firstWrite = deferred<void>();
        let mainWrites = 0;
        projectStorage.getItem.mockImplementation(async (key: string) => disk.get(key) || null);
        projectStorage.setItem.mockImplementation(async (key: string, value: string) => {
            if (key === PROJECT_STORE_KEY) {
                mainWrites += 1;
                if (mainWrites === 1) await firstWrite.promise;
                else if (mainWrites === 2) throw new Error("rollback unavailable");
            }
            disk.set(key, value);
        });
        projectStorage.removeItem.mockImplementation(async (key: string) => { disk.delete(key); });
        const otherNode = canvasNode("other", CanvasNodeType.Text, { content: "draft" });
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"]), otherNode])] });
        let active = true;
        const events: RemoteCanvasTaskEvent[] = [];
        const unsubscribe = subscribeRemoteCanvasTaskEvents((event) => events.push(event));
        const applying = applyRemoteTaskOutputToProject(taskFor("n1"), imageOutput("image:journaled"), { signal: new AbortController().signal, isActive: () => active });
        await vi.waitFor(() => expect(projectStorage.setItem).toHaveBeenCalledTimes(1));
        useProjectStore.getState().updateCanvasNodes("project-1", "canvas-1", (nodes) => nodes.map((node) => node.id === "other" ? { ...node, position: { x: 41, y: 42 } } : node));
        active = false;
        firstWrite.resolve();

        await expect(applying).rejects.toThrow("rollback unavailable");
        expect(events).toHaveLength(1);
        expect(disk.has(PROJECT_REPAIR_KEY)).toBe(true);
        useProjectStore.setState({ projects: [] });
        await useProjectStore.persist.rehydrate();

        const nodes = useProjectStore.getState().projects[0].canvases[0].nodes;
        expect(nodes.find((node) => node.id === "n1")?.metadata?.storageKey).toBe("image:journaled");
        expect(nodes.find((node) => node.id === "other")?.position).toEqual({ x: 41, y: 42 });
        expect(disk.has(PROJECT_REPAIR_KEY)).toBe(false);
        expect(events).toHaveLength(1);
        unsubscribe();
    });

    test.each([
        ["project", (task: RemoteMediaTask) => useProjectStore.getState().deleteProjects([task.target.projectId])],
        ["canvas", (task: RemoteMediaTask) => useProjectStore.getState().replaceProjects(useProjectStore.getState().projects.map((project) => project.id === task.target.projectId ? { ...project, canvases: project.canvases.filter((canvas) => canvas.id !== task.target.canvasId) } : project))],
        ["node", (task: RemoteMediaTask) => useProjectStore.getState().updateCanvasNodes(task.target.projectId, task.target.canvasId, () => [])],
        ["item", (task: RemoteMediaTask) => useProjectStore.getState().updateCanvasNodes(task.target.projectId, task.target.canvasId, (nodes) => nodes.map((node) => ({ ...node, metadata: { ...node.metadata, images: [] } })))],
    ] as const)("recovers a journaled %s tombstone on reload", async (_scope, removeTarget) => {
        const disk = new Map<string, string>();
        const firstWrite = deferred<void>();
        let mainWrites = 0;
        projectStorage.getItem.mockImplementation(async (key: string) => disk.get(key) || null);
        projectStorage.setItem.mockImplementation(async (key: string, value: string) => {
            if (key === PROJECT_STORE_KEY) {
                mainWrites += 1;
                if (mainWrites === 1) await firstWrite.promise;
                else if (mainWrites === 2) throw new Error("reconciliation unavailable");
            }
            disk.set(key, value);
        });
        projectStorage.removeItem.mockImplementation(async (key: string) => { disk.delete(key); });
        const task = taskFor("n1");
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"])])] });
        const events: RemoteCanvasTaskEvent[] = [];
        const unsubscribe = subscribeRemoteCanvasTaskEvents((event) => events.push(event));
        const output = imageOutput("image:tombstone");
        output.value.provisionalLease = { storageKey: "image:tombstone", generation: 9 };
        const applying = applyRemoteTaskOutputToProject(task, output);
        await vi.waitFor(() => expect(projectStorage.setItem).toHaveBeenCalledTimes(1));
        removeTarget(task);
        firstWrite.resolve();

        await expect(applying).rejects.toThrow("reconciliation unavailable");
        expect(events).toEqual([]);
        expect(discardRemoteImage).toHaveBeenCalledWith(output.value);
        expect(deleteStoredImages).not.toHaveBeenCalledWith(["image:tombstone"]);
        expect(disk.has(PROJECT_REPAIR_KEY)).toBe(true);
        useProjectStore.setState({ projects: [] });
        await useProjectStore.persist.rehydrate();

        expect(hasRemoteTaskTarget(task)).toBe(false);
        expect(disk.has(PROJECT_REPAIR_KEY)).toBe(false);
        unsubscribe();
    });

    test("combines a durable tombstone reconciliation error with failed media cleanup", async () => {
        const firstWrite = deferred<void>();
        let mainWrites = 0;
        projectStorage.setItem.mockImplementation(async (key: string) => {
            if (key === PROJECT_STORE_KEY) {
                mainWrites += 1;
                if (mainWrites === 1) await firstWrite.promise;
                else throw new Error("reconciliation unavailable");
            }
        });
        deleteStoredImages.mockRejectedValueOnce(new Error("cleanup unavailable"));
        const task = taskFor("n1");
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"])])] });
        const applying = applyRemoteTaskOutputToProject(task, imageOutput("image:tombstone-cleanup"));
        await vi.waitFor(() => expect(projectStorage.setItem).toHaveBeenCalledTimes(1));
        useProjectStore.getState().updateCanvasNodes(task.target.projectId, task.target.canvasId, () => []);
        firstWrite.resolve();

        await expect(applying).rejects.toThrow(/reconciliation unavailable.*cleanup unavailable|cleanup unavailable.*reconciliation unavailable/);
        expect(deleteStoredImages).toHaveBeenCalledWith(["image:tombstone-cleanup"]);
        expect(useProjectStore.getState().projects[0].canvases[0].nodes).toEqual([]);
    });

    test.each([
        null,
        { version: 1 },
        { version: 2, revision: 20, projects: [] },
        { version: 1, revision: -1, projects: [] },
        { version: 1, revision: 1.5, projects: [] },
        { version: 1, revision: Number.NaN, projects: [] },
        { version: 1, revision: 20 },
        { version: 1, revision: 20, projects: [null] },
        { version: 1, revision: 20, projects: [{ id: "bad-project", canvases: [{ id: "bad-canvas", nodes: [{}] }] }] },
    ])("ignores malformed repair journal %# and preserves a valid main snapshot", async (invalidJournal) => {
        const mainProject = projectWith([imageBatchNode("main-node", ["main-item"])], "main-project", "main-canvas");
        projectStorage.getItem.mockImplementation(async (key: string) => key === PROJECT_STORE_KEY
            ? JSON.stringify({ state: { projects: [mainProject] }, version: 0, persistenceRevision: 0 })
            : JSON.stringify(invalidJournal));
        useProjectStore.setState({ projects: [] });

        await expect(useProjectStore.persist.rehydrate()).resolves.toBeUndefined();
        expect(useProjectStore.getState().projects[0]?.id).toBe("main-project");
        useProjectStore.getState().renameProject("main-project", "still valid");
        await useProjectStore.getState().flush();
        const persisted = JSON.parse(projectStorage.setItem.mock.calls.at(-1)?.[1] as string);
        expect(Number.isFinite(persisted.persistenceRevision)).toBe(true);
        expect(projectStorage.removeItem).not.toHaveBeenCalledWith(PROJECT_REPAIR_KEY);
        expect(getCanvasPersistenceDiagnostics().some((item) => item.source === "repair")).toBe(true);
    });

    test.each([
        {},
        { state: {}, version: 0 },
        { state: { projects: [null] }, version: 0, persistenceRevision: 3 },
        { state: { projects: [{ id: "bad", canvases: null }] }, version: 0, persistenceRevision: "bad" },
    ])("isolates malformed main snapshot %# without breaking rehydrate", async (invalidMain) => {
        projectStorage.getItem.mockImplementation(async (key: string) => key === PROJECT_STORE_KEY ? JSON.stringify(invalidMain) : null);
        useProjectStore.setState({ projects: [] });

        await expect(useProjectStore.persist.rehydrate()).resolves.toBeUndefined();
        expect(useProjectStore.getState().projects).toEqual([]);
        expect(getCanvasPersistenceDiagnostics().some((item) => item.source === "main")).toBe(true);
    });

    test("recovers a valid journal independently from a malformed main snapshot without poisoning revisions", async () => {
        const repairedProject = projectWith([imageBatchNode("repaired-node", ["repaired-item"])], "repaired-project", "repaired-canvas");
        projectStorage.getItem.mockImplementation(async (key: string) => key === PROJECT_STORE_KEY
            ? JSON.stringify({ state: { projects: [null] }, version: 0, persistenceRevision: "bad" })
            : JSON.stringify({ version: 1, revision: 6, projects: [repairedProject] }));
        useProjectStore.setState({ projects: [] });

        await useProjectStore.persist.rehydrate();
        expect(useProjectStore.getState().projects[0]?.id).toBe("repaired-project");
        useProjectStore.getState().renameProject("repaired-project", "recovered");
        await useProjectStore.getState().flush();
        const persisted = JSON.parse(projectStorage.setItem.mock.calls.at(-1)?.[1] as string);
        expect(Number.isFinite(persisted.persistenceRevision)).toBe(true);
    });

    test.each(["invalid", "read_error"] as const)("does not overwrite a raw %s main snapshot during hydration-only updates", async (failure) => {
        await useProjectStore.getState().flush();
        vi.clearAllMocks();
        const raw = JSON.stringify({ state: { projects: [null] }, version: 0, persistenceRevision: 4 });
        const disk = new Map([[PROJECT_STORE_KEY, raw]]);
        projectStorage.getItem.mockImplementation(async (key: string) => {
            if (key === PROJECT_STORE_KEY && failure === "read_error") throw new Error("main read unavailable");
            return disk.get(key) || null;
        });
        projectStorage.setItem.mockImplementation(async (key: string, value: string) => { disk.set(key, value); });
        projectStorage.removeItem.mockImplementation(async (key: string) => { disk.delete(key); });
        vi.useFakeTimers();
        try {
            await expect(useProjectStore.persist.rehydrate()).resolves.toBeUndefined();
            await vi.advanceTimersByTimeAsync(450);
            expect(disk.get(PROJECT_STORE_KEY)).toBe(raw);

            useProjectStore.getState().replaceProjects([projectWith([], "user-project", "user-canvas")]);
            await vi.advanceTimersByTimeAsync(450);
            expect(JSON.parse(disk.get(PROJECT_STORE_KEY)!).state.projects[0].id).toBe("user-project");
        } finally {
            vi.useRealTimers();
        }
    });

    test.each(["main", "clear"] as const)("keeps a pending repair when rehydrate %s fails, then flushes after recovery", async (failure) => {
        const disk = new Map<string, string>();
        const oldProject = projectWith([], "old-project", "old-canvas");
        const repairedProject = projectWith([imageBatchNode("repaired-node", ["repaired-item"])], "repaired-project", "repaired-canvas");
        disk.set(PROJECT_STORE_KEY, JSON.stringify({ state: { projects: [oldProject] }, version: 0, persistenceRevision: 4 }));
        disk.set(PROJECT_REPAIR_KEY, JSON.stringify({ version: 1, revision: 5, projects: [repairedProject] }));
        let storageAvailable = false;
        projectStorage.getItem.mockImplementation(async (key: string) => disk.get(key) || null);
        projectStorage.setItem.mockImplementation(async (key: string, value: string) => {
            if (failure === "main" && key === PROJECT_STORE_KEY && !storageAvailable) throw new Error("main repair unavailable");
            disk.set(key, value);
        });
        projectStorage.removeItem.mockImplementation(async (key: string) => {
            if (failure === "clear" && key === PROJECT_REPAIR_KEY && !storageAvailable) throw new Error("repair clear unavailable");
            disk.delete(key);
        });
        useProjectStore.setState({ projects: [] });

        await useProjectStore.persist.rehydrate();
        expect(useProjectStore.getState().projects[0]?.id).toBe("repaired-project");
        await expect(useProjectStore.getState().flush()).rejects.toThrow(failure === "main" ? "main repair unavailable" : "repair clear unavailable");
        expect(disk.has(PROJECT_REPAIR_KEY)).toBe(true);
        storageAvailable = true;
        await expect(useProjectStore.getState().flush()).resolves.toBeUndefined();
        expect(disk.has(PROJECT_REPAIR_KEY)).toBe(false);
        expect(JSON.parse(disk.get(PROJECT_STORE_KEY)!).state.projects[0].id).toBe("repaired-project");
    });

    test("keeps a failed journal repair observable and does not emit an undurable retained result", async () => {
        const firstWrite = deferred<void>();
        let mainWrites = 0;
        projectStorage.setItem.mockImplementation(async (key: string) => {
            if (key === PROJECT_STORE_KEY) {
                mainWrites += 1;
                if (mainWrites === 1) await firstWrite.promise;
                else throw new Error("rollback unavailable");
            }
            if (key === PROJECT_REPAIR_KEY) throw new Error("repair journal unavailable");
        });
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"])])] });
        let active = true;
        const events: RemoteCanvasTaskEvent[] = [];
        const unsubscribe = subscribeRemoteCanvasTaskEvents((event) => events.push(event));
        const applying = applyRemoteTaskOutputToProject(taskFor("n1"), imageOutput("image:undurable"), { signal: new AbortController().signal, isActive: () => active });
        await vi.waitFor(() => expect(projectStorage.setItem).toHaveBeenCalledTimes(1));
        active = false;
        firstWrite.resolve();

        await expect(applying).rejects.toThrow(/rollback unavailable.*repair journal unavailable|repair journal unavailable.*rollback unavailable/);
        expect(events).toEqual([]);
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.storageKey).toBeUndefined();
        await expect(useProjectStore.getState().flush()).rejects.toThrow("repair journal unavailable");
        unsubscribe();
    });

    test("captures rollback snapshot and revision only when its queued write actually starts", async () => {
        const firstWrite = deferred<void>();
        const queuedAutosave = deferred<void>();
        projectStorage.setItem.mockReturnValueOnce(firstWrite.promise).mockReturnValueOnce(queuedAutosave.promise).mockResolvedValue(undefined);
        const otherNode = canvasNode("other", CanvasNodeType.Text, { content: "draft" });
        const second = projectWith([], "project-2", "canvas-2");
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"]), otherNode]), second] });
        let active = true;
        const applying = applyRemoteTaskOutputToProject(taskFor("n1"), imageOutput("image:aborted"), { signal: new AbortController().signal, isActive: () => active });
        await vi.waitFor(() => expect(projectStorage.setItem).toHaveBeenCalledTimes(1));
        useProjectStore.getState().updateCanvas("project-1", "canvas-1", { viewport: { x: 1, y: 2, k: 1 } });
        const saving = useProjectStore.getState().flush();
        active = false;
        firstWrite.resolve();
        await vi.waitFor(() => expect(projectStorage.setItem).toHaveBeenCalledTimes(2));
        useProjectStore.getState().updateCanvas("project-1", "canvas-1", { viewport: { x: 8, y: 9, k: 2 } });
        useProjectStore.getState().updateCanvasNodes("project-1", "canvas-1", (nodes) => nodes.map((node) => node.id === "other" ? { ...node, position: { x: 70, y: 80 } } : node));
        useProjectStore.getState().renameProject("project-2", "Latest other project");
        queuedAutosave.resolve();

        await saving;
        await expect(applying).rejects.toHaveProperty("name", "AbortError");
        const disk = JSON.parse(projectStorage.setItem.mock.calls.at(-1)?.[1] as string).state.projects;
        expect(disk[0].canvases[0].viewport).toEqual({ x: 8, y: 9, k: 2 });
        expect(disk[0].canvases[0].nodes.find((node: CanvasNodeData) => node.id === "other").position).toEqual({ x: 70, y: 80 });
        expect(disk[1].title).toBe("Latest other project");
        expect(disk[0].canvases[0].nodes.find((node: CanvasNodeData) => node.id === "n1").metadata.storageKey).toBeUndefined();
    });
});

describe("project asset adoption before node success", () => {
    function videoNode(status: "loading" | "error" = "loading"): CanvasNodeData {
        return canvasNode("video-1", CanvasNodeType.Video, { status });
    }

    function videoTask(): RemoteMediaTask {
        return taskFor("video-1", { capability: "video", target: taskTarget("video-1") });
    }

    function findNode(nodeId: string): CanvasNodeData | undefined {
        return useProjectStore.getState().projects[0]?.canvases[0]?.nodes.find((node) => node.id === nodeId);
    }

    test("persists a remote generated video before marking its node successful", async () => {
        const projectVideo = projectStoredMedia("asset-video-1", "video/mp4");
        storeCanvasMedia.mockResolvedValue(projectVideo);
        const delivered = await deliverRemoteTaskResult(videoTask(), { url: "https://example.test/video.mp4" }, contextWithWorkspace());
        expect(storeCanvasMedia).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({
            source: expect.objectContaining({ type: "generated", nodeId: videoTask().target.nodeId }),
        }));
        expect(delivered.value.assetRef).toEqual(projectVideo.assetRef);
    });

    test("composes script lineage from the task record into the delivered project asset source", async () => {
        const task = taskFor("video-1", { capability: "video", target: taskTarget("video-1"), scriptSource: { scriptNodeId: "script-1", shotId: "shot-1", role: "video", version: 2 } });
        await deliverRemoteTaskResult(task, { url: "https://example.test/video.mp4" }, contextWithWorkspace());
        expect(storeCanvasMedia).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({
            projectId: "project-1",
            source: { type: "generated", canvasId: "canvas-1", nodeId: "video-1", scriptNodeId: "script-1", shotId: "shot-1", role: "video", version: 2 },
        }));
    });

    test("keeps task-record lineage on the fallback delivery source without a caller context", async () => {
        useProjectStore.setState({ projects: [projectWith([videoNode()])] });
        (window as unknown as { shotshot?: unknown }).shotshot = { projectAssets: {} };
        try {
            const task = taskFor("video-1", { capability: "video", target: taskTarget("video-1"), scriptSource: { scriptNodeId: "script-1", shotId: "shot-1", role: "video", version: 3 } });
            await deliverRemoteTaskResult(task, { url: "https://example.test/video.mp4" }, deliveryContext());
            expect(storeCanvasMedia).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({
                projectId: "project-1",
                source: { type: "generated", canvasId: "canvas-1", nodeId: "video-1", scriptNodeId: "script-1", shotId: "shot-1", role: "video", version: 3 },
            }));
        } finally {
            delete (window as unknown as { shotshot?: unknown }).shotshot;
        }
    });

    test("omits lineage fields when the task record has no script source", async () => {
        await deliverRemoteTaskResult(videoTask(), { url: "https://example.test/video.mp4" }, contextWithWorkspace());
        expect(storeCanvasMedia).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({
            source: { type: "generated", canvasId: "canvas-1", nodeId: "video-1" },
        }));
    });

    test("does not commit success when project storage fails", async () => {
        useProjectStore.setState({ projects: [projectWith([videoNode()])] });
        storeCanvasMedia.mockRejectedValue(new Error("disk full"));
        await expect(deliverRemoteTaskToProject(videoTask(), { url: "https://example.test/video.mp4" }, contextWithWorkspace())).rejects.toThrow("disk full");
        const node = findNode("video-1");
        expect(node?.metadata?.status).toBe("error");
        expect(node?.metadata?.storageKey).toBeUndefined();
        expect(node?.metadata?.remoteTask).toMatchObject({ id: "task-1", status: "failed" });
    });

    test("writes the project asset before the success transaction reaches project storage", async () => {
        useProjectStore.setState({ projects: [projectWith([videoNode()])] });
        const storing = deferred<ReturnType<typeof projectStoredMedia>>();
        storeCanvasMedia.mockReturnValueOnce(storing.promise);
        const delivering = deliverRemoteTaskToProject(videoTask(), { url: "https://example.test/video.mp4" }, contextWithWorkspace());
        await vi.waitFor(() => expect(storeCanvasMedia).toHaveBeenCalledOnce());
        expect(projectStorage.setItem).not.toHaveBeenCalled();
        storing.resolve(projectStoredMedia("asset-video-1", "video/mp4"));
        await expect(delivering).resolves.toEqual({ applied: true });
        expect(projectStorage.setItem).toHaveBeenCalled();
    });

    test("adopts the project image asset while keeping the strict local copy fields", async () => {
        const projectImage = projectStoredImage("asset-image-1");
        storeCanvasImage.mockResolvedValue(projectImage);
        const delivered = await deliverRemoteTaskResult(taskFor("n1"), "data:image/png;base64,OK", contextWithWorkspace("n1"));
        expect(storeCanvasImage).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({
            source: expect.objectContaining({ type: "generated", nodeId: "n1" }),
        }));
        expect(delivered.value.assetRef).toEqual(projectImage.assetRef);
        expect(delivered.value.url).toBe(projectImage.url);
        expect(delivered.value.storageKey).toBe("image:1");
    });

    test("keeps workbench deliveries on the existing IndexedDB backend without a project context", async () => {
        const delivered = await deliverRemoteTaskResult(taskFor("n1"), "data:image/png;base64,OK", deliveryContext());
        expect(storeCanvasImage).not.toHaveBeenCalled();
        expect(storeCanvasMedia).not.toHaveBeenCalled();
        expect(delivered.value.assetRef).toBeUndefined();
        expect(delivered.value.storageKey).toBe("image:1");
    });

    test("gives every batch image its own project asset ref", async () => {
        storeCanvasImage
            .mockResolvedValueOnce(projectStoredImage("asset-a"))
            .mockResolvedValueOnce(projectStoredImage("asset-b"));
        const first = await deliverRemoteTaskResult(taskFor("n1", { id: "task-a", target: taskTarget("n1", "i1") }), "data:image/png;base64,A", contextWithWorkspace("n1"));
        const second = await deliverRemoteTaskResult(taskFor("n1", { id: "task-b", target: taskTarget("n1", "i2") }), "data:image/png;base64,B", contextWithWorkspace("n1"));
        expect(storeCanvasImage).toHaveBeenCalledTimes(2);
        expect(first.value.assetRef).toMatchObject({ assetId: "asset-a" });
        expect(second.value.assetRef).toMatchObject({ assetId: "asset-b" });
    });

    test("cleans the strict local copy when the project write fails", async () => {
        storeCanvasMedia.mockRejectedValue(new Error("disk full"));
        await expect(deliverRemoteTaskResult(videoTask(), { url: "https://example.test/video.mp4" }, contextWithWorkspace())).rejects.toThrow("disk full");
        expect(deleteStoredMedia).toHaveBeenCalledWith(["video:1"]);
        expect(deleteStoredImages).not.toHaveBeenCalled();
    });

    test("does not surface a local persistence error after the delivery stopped", async () => {
        useProjectStore.setState({ projects: [projectWith([videoNode()])] });
        const failing = deferred<never>();
        storeCanvasMedia.mockReturnValueOnce(failing.promise);
        let active = true;
        const context = { signal: new AbortController().signal, isActive: () => active, assetWriteContext: contextWithWorkspace().assetWriteContext };
        const delivering = deliverRemoteTaskToProject(videoTask(), { url: "https://example.test/video.mp4" }, context);
        await vi.waitFor(() => expect(storeCanvasMedia).toHaveBeenCalledOnce());
        active = false;
        failing.reject(new Error("disk full"));
        await expect(delivering).rejects.toThrow("disk full");
        expect(findNode("video-1")?.metadata?.status).toBe("loading");
    });

    const adoptedImageRef = { backend: "project-file" as const, projectId: "project-1", assetId: "a1", revision: 1, relativePath: "assets/generated/images/a1.png" };

    test("CRITICAL：桌面采纳 applied 后删除 IDB 暂存键，节点为 assetRef-only", async () => {
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"])])] });
        uploadRemoteImage.mockResolvedValueOnce(uploadedImage("image:staging"));
        storeCanvasImage.mockResolvedValueOnce({ url: "blob:stored-1", assetRef: adoptedImageRef, width: 1024, height: 768, bytes: 128, mimeType: "image/png" });
        await expect(deliverRemoteTaskToProject(taskFor("n1"), "data:image/png;base64,OK", contextWithWorkspace())).resolves.toEqual({ applied: true });
        expect(deleteStoredMediaKeys).toHaveBeenCalledWith(["image:staging"]);
        const image = useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.images?.[0];
        expect(image?.assetRef).toEqual(adoptedImageRef);
        expect(image?.storageKey).toBeUndefined();
    });

    // deliverRemoteTaskToProject 在上传前预检目标（见 "preflights a deleted target..."），故沿用
    // "cleans a stored result when the target is deleted before final apply" 的模式：目标在上传期间被删。
    test("CRITICAL：置空语义下失败路径仍清理暂存键（目标缺失）", async () => {
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"])])] });
        const storing = deferred<UploadedImage>();
        uploadRemoteImage.mockReturnValueOnce(storing.promise);
        const delivering = deliverRemoteTaskToProject(taskFor("n1"), "data:image/png;base64,OK", deliveryContext());
        await vi.waitFor(() => expect(uploadRemoteImage).toHaveBeenCalled());
        useProjectStore.getState().updateCanvasNodes("project-1", "canvas-1", () => []);
        storing.resolve(uploadedImage("image:staging"));
        await expect(delivering).resolves.toEqual({ applied: false, reason: "missing_target" });
        expect(deleteStoredImages).toHaveBeenCalledWith(["image:staging"]);
    });

    test("Web（无 assetRef）applied 后绝不删暂存键", async () => {
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"])])] });
        uploadRemoteImage.mockResolvedValueOnce(uploadedImage("image:web"));
        await expect(deliverRemoteTaskToProject(taskFor("n1"), "data:image/png;base64,OK", deliveryContext())).resolves.toEqual({ applied: true });
        expect(deleteStoredMediaKeys).not.toHaveBeenCalled();
        const image = useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.images?.[0];
        expect(image?.storageKey).toBe("image:web");
    });

    test("视频同理：applied 后删除暂存键且元数据 assetRef-only", async () => {
        useProjectStore.setState({ projects: [projectWith([canvasNode("video-1", CanvasNodeType.Video, { status: "loading" })])] });
        storeRemoteGeneratedVideo.mockResolvedValueOnce(uploadedFile("video:staging", "video/mp4"));
        storeCanvasMedia.mockResolvedValueOnce({ url: "blob:stored-video", assetRef: adoptedImageRef, bytes: 256, mimeType: "video/mp4", width: 1280, height: 720 });
        await expect(deliverRemoteTaskToProject(videoTask(), { url: "https://example.test/video.mp4" }, contextWithWorkspace())).resolves.toEqual({ applied: true });
        expect(deleteStoredMediaKeys).toHaveBeenCalledWith(["video:staging"]);
        const metadata = useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata;
        expect(metadata?.assetRef).toEqual(adoptedImageRef);
        expect(metadata?.storageKey).toBeUndefined();
    });

    // 终审 I3 如实化：sameDeliveredOutput 的 assetRef 分支只在「同一 output 对象会话内重放」可达——
    // 恢复重交付经 seedAssetUrl/writeBytes 会产生新 URL 与新 assetId，content 比较先行失败。
    // 本用例的稳定 mock URL/assetRef 恰是会话内重放场景，不证明恢复重交付去重（spec §1 该句与实现有偏差）。
    test("会话内事件重放幂等：同一 output 重放命中幂等比较，不重复应用", async () => {
        useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", ["i1"])])] });
        uploadRemoteImage.mockResolvedValue(uploadedImage("image:staging"));
        storeCanvasImage.mockResolvedValue({ url: "blob:stored-1", assetRef: adoptedImageRef, width: 1024, height: 768, bytes: 128, mimeType: "image/png" });
        await deliverRemoteTaskToProject(taskFor("n1"), "data:image/png;base64,OK", contextWithWorkspace());
        const nodesBefore = useProjectStore.getState().projects[0].canvases[0].nodes;
        await deliverRemoteTaskToProject(taskFor("n1"), "data:image/png;base64,OK", contextWithWorkspace());
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.images?.[0]).toBe(nodesBefore[0].metadata?.images?.[0]);
    });
});

test.each(["inactive", "missing_canvas", "missing_item"])("fal image provisional result cannot escape the %s delivery guard", async condition => {
    const { queryScriptSnapshot: _legacy, ...base } = taskFor("n1");
    const task: RemoteMediaTask = { ...base, adapterId: "fal.image", adapterVersion: 1, modelName: "fal-ai/flux-2-pro" };
    const output = imageOutput();
    if (output.capability !== "image") throw new Error("fixture");
    output.value.provisionalLease = { storageKey: "image:1", generation: 1 };
    useProjectStore.setState({ projects: [projectWith([imageBatchNode("n1", condition === "missing_item" ? ["other"] : ["i1"])])] });
    if (condition === "missing_canvas") task.target.canvasId = "different-canvas";
    const result = await applyRemoteTaskOutputToProject(task, output, deliveryContext({ active: condition !== "inactive" }));
    expect(result.applied).toBe(false);
    expect(discardRemoteImage).toHaveBeenCalledWith(output.value);
    expect(releaseRemoteImageLease).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.storageKey).toBeUndefined();
});
