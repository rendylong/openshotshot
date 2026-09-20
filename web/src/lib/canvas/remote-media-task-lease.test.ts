import { beforeEach, describe, expect, test, vi } from "vitest";

type MemoryStore = {
    values: Map<string, unknown>;
    setItem: ReturnType<typeof vi.fn>;
    removeItem: ReturnType<typeof vi.fn>;
    getItem: ReturnType<typeof vi.fn>;
    iterate: ReturnType<typeof vi.fn>;
};

const stores = vi.hoisted(() => new Map<string, MemoryStore>());
const projectStorage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }));
const nextStorageId = vi.hoisted(() => vi.fn(() => "lease-key"));

vi.mock("localforage", () => ({
    default: {
        createInstance: ({ storeName }: { storeName: string }) => {
            const store: MemoryStore = { values: new Map(), setItem: vi.fn(), removeItem: vi.fn(), getItem: vi.fn(), iterate: vi.fn() };
            stores.set(storeName, store);
            return store;
        },
    },
}));
vi.mock("nanoid", () => ({ nanoid: nextStorageId }));
vi.mock("@/lib/localforage-storage", () => ({ localForageStorage: projectStorage }));

import { applyRemoteTaskOutputToProject } from "@/lib/canvas/remote-media-task-result";
import { cleanupUnusedMedia, getMediaBlob, getMediaStorageBookkeeping, uploadRemoteMediaFile } from "@/services/file-storage";
import { cleanupUnusedImages, getImageBlob, getImageStorageBookkeeping, uploadRemoteImage } from "@/services/image-storage";
import { CanvasPersistenceTransactionError, useProjectStore } from "@/stores/canvas/use-project-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { Project } from "@/types/project";
import type { RemoteMediaCapability, RemoteMediaTask } from "@/types/remote-media-task";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

function node(id: string, type: CanvasNodeType): CanvasNodeData {
    return {
        id,
        type,
        title: id,
        position: { x: 0, y: 0 },
        width: 320,
        height: 240,
        metadata: type === CanvasNodeType.Image
            ? { status: "loading", images: [{ id: "item-1", status: "loading", content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" }] }
            : { status: "loading" },
    };
}

function projectWith(target: CanvasNodeData): Project {
    return {
        id: "project-1",
        title: "Project",
        category: "uncategorized",
        icon: "box",
        color: "#000000",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        canvases: [{
            id: "canvas-1",
            title: "Canvas",
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
            nodes: [target],
            connections: [],
            chatSessions: [],
            activeChatId: null,
            backgroundMode: "lines",
            showImageInfo: false,
            viewport: { x: 0, y: 0, k: 1 },
        }],
    };
}

function task(capability: RemoteMediaCapability): RemoteMediaTask {
    return {
        id: `task-${capability}`,
        remoteTaskId: `remote-${capability}`,
        capability,
        target: { projectId: "project-1", canvasId: "canvas-1", nodeId: `${capability}-node`, ...(capability === "image" ? { itemId: "item-1" } : {}) },
        channelId: "channel-1",
        modelName: `${capability}-model`,
        baseUrlSnapshot: "https://example.test/v1",
        queryScriptSnapshot: "return { status: 'pending' }",
        status: "pending",
        phase: "running",
        progress: 80,
        submittedAt: 1,
        deadlineAt: 301_000,
    };
}

function storageContext() {
    const signal = new AbortController().signal;
    return { signal, isActive: () => true };
}

beforeEach(async () => {
    await useProjectStore.getState().flush().catch(() => undefined);
    stores.forEach((store) => {
        store.values.clear();
        store.setItem.mockReset().mockImplementation(async (key: string, value: unknown) => { store.values.set(key, value); });
        store.removeItem.mockReset().mockImplementation(async (key: string) => { store.values.delete(key); });
        store.getItem.mockReset().mockImplementation(async (key: string) => store.values.get(key));
        store.iterate.mockReset().mockImplementation(async (visitor: (value: unknown, key: string) => void) => {
            store.values.forEach((value, key) => visitor(value, key));
        });
    });
    projectStorage.getItem.mockReset().mockResolvedValue(null);
    projectStorage.setItem.mockReset().mockResolvedValue(undefined);
    projectStorage.removeItem.mockReset().mockResolvedValue(undefined);
    nextStorageId.mockReset().mockReturnValue("lease-key");
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:lease"), revokeObjectURL: vi.fn() });
    vi.stubGlobal("Image", class {
        naturalWidth = 640;
        naturalHeight = 480;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });
    useProjectStore.setState({ projects: [], pendingPrompt: null, pendingProjectId: null, pendingCanvasId: null });
});

describe("remote media provisional leases", () => {
    test("keeps a strict image while its durable project snapshot is blocked", async () => {
        const imageTask = task("image");
        useProjectStore.setState({ projects: [projectWith(node("image-node", CanvasNodeType.Image))] });
        const image = await uploadRemoteImage(new Blob(["image"], { type: "image/png" }), storageContext());
        const snapshot = deferred<void>();
        projectStorage.setItem.mockReturnValueOnce(snapshot.promise).mockResolvedValue(undefined);

        const applying = applyRemoteTaskOutputToProject(imageTask, { capability: "image", value: image }, storageContext());
        await vi.waitFor(() => expect(projectStorage.setItem).toHaveBeenCalledTimes(1));
        await cleanupUnusedImages({}, () => ({}));
        const blobBeforeCommit = await getImageBlob(image.storageKey);
        snapshot.resolve();
        await expect(applying).resolves.toEqual({ applied: true });
        expect(blobBeforeCommit).toBeInstanceOf(Blob);
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.storageKey).toBe(image.storageKey);
        expect(await getImageBlob(image.storageKey)).toBeInstanceOf(Blob);
        expect(getImageStorageBookkeeping().leases).toBe(0);
    });

    test("keeps strict video media while its durable project snapshot is blocked", async () => {
        const videoTask = task("video");
        useProjectStore.setState({ projects: [projectWith(node("video-node", CanvasNodeType.Video))] });
        const video = await uploadRemoteMediaFile(new Blob(["video"], { type: "application/octet-stream" }), "video", storageContext());
        const snapshot = deferred<void>();
        projectStorage.setItem.mockReturnValueOnce(snapshot.promise).mockResolvedValue(undefined);

        const applying = applyRemoteTaskOutputToProject(videoTask, { capability: "video", value: video }, storageContext());
        await vi.waitFor(() => expect(projectStorage.setItem).toHaveBeenCalledTimes(1));
        await cleanupUnusedMedia({}, () => ({}));
        const blobBeforeCommit = await getMediaBlob(video.storageKey);
        snapshot.resolve();
        await expect(applying).resolves.toEqual({ applied: true });
        expect(blobBeforeCommit).toBeInstanceOf(Blob);
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.storageKey).toBe(video.storageKey);
        expect(await getMediaBlob(video.storageKey)).toBeInstanceOf(Blob);
        expect(getMediaStorageBookkeeping().leases).toBe(0);
    });

    test("drops the lease and registers pending cleanup when a failed project transaction cannot remove the image", async () => {
        const imageTask = task("image");
        useProjectStore.setState({ projects: [projectWith(node("image-node", CanvasNodeType.Image))] });
        const image = await uploadRemoteImage(new Blob(["image"], { type: "image/png" }), storageContext());
        projectStorage.setItem.mockRejectedValueOnce(new Error("project unavailable"));
        stores.get("image_files")!.removeItem.mockRejectedValueOnce(new Error("cleanup unavailable"));

        await expect(applyRemoteTaskOutputToProject(imageTask, { capability: "image", value: image }, storageContext())).rejects.toThrow(/project unavailable.*cleanup unavailable|cleanup unavailable.*project unavailable/);
        expect(getImageStorageBookkeeping()).toMatchObject({ leases: 0, pending: 1 });
    });

    test("keeps an image leased after journal failure until retained repair publishes its reference", async () => {
        const imageTask = task("image");
        nextStorageId.mockReturnValue("repair-image");
        useProjectStore.setState({ projects: [projectWith(node("image-node", CanvasNodeType.Image))] });
        const image = await uploadRemoteImage(new Blob(["image"], { type: "image/png" }), storageContext());
        expect(getImageStorageBookkeeping().leases).toBe(1);
        await useProjectStore.getState().flush();
        expect(getImageStorageBookkeeping().leases).toBe(1);
        projectStorage.setItem.mockClear();
        const candidate = deferred<void>();
        let mainWrites = 0;
        let repairAvailable = false;
        projectStorage.setItem.mockImplementation(async (key: string) => {
            if (key === "shotshot:canvas_store") {
                mainWrites += 1;
                if (mainWrites === 1) await candidate.promise;
                else if (mainWrites === 2) throw new Error("rollback unavailable");
            }
            if (key === "shotshot:canvas_store:repair" && !repairAvailable) throw new Error("journal unavailable");
        });
        let active = true;
        const context = { signal: new AbortController().signal, isActive: () => active };
        const applying = applyRemoteTaskOutputToProject(imageTask, { capability: "image", value: image }, context);
        await vi.waitFor(() => expect(projectStorage.setItem).toHaveBeenCalledTimes(1));
        active = false;
        candidate.resolve();
        const repairError = await applying.catch((error) => error);
        expect(repairError).toBeInstanceOf(CanvasPersistenceTransactionError);
        expect(repairError.pendingMediaDisposition).toBeInstanceOf(Promise);

        expect(getImageStorageBookkeeping().leases).toBe(1);
        expect(await getImageBlob(image.storageKey)).toBeInstanceOf(Blob);
        await cleanupUnusedImages({}, () => ({}));
        const blobWhileRepairPending = await getImageBlob(image.storageKey);
        repairAvailable = true;
        await useProjectStore.getState().flush();
        await vi.waitFor(() => expect(getImageStorageBookkeeping().leases).toBe(0));

        expect(blobWhileRepairPending).toBeInstanceOf(Blob);
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.storageKey).toBe(image.storageKey);
        expect(await getImageBlob(image.storageKey)).toBeInstanceOf(Blob);
    });

    test("keeps media leased after journal failure and discards it after tombstone repair", async () => {
        const videoTask = task("video");
        nextStorageId.mockReturnValue("repair-video");
        useProjectStore.setState({ projects: [projectWith(node("video-node", CanvasNodeType.Video))] });
        const video = await uploadRemoteMediaFile(new Blob(["video"], { type: "application/octet-stream" }), "video", storageContext());
        await useProjectStore.getState().flush();
        projectStorage.setItem.mockClear();
        const candidate = deferred<void>();
        let mainWrites = 0;
        let repairAvailable = false;
        projectStorage.setItem.mockImplementation(async (key: string) => {
            if (key === "shotshot:canvas_store") {
                mainWrites += 1;
                if (mainWrites === 1) await candidate.promise;
                else if (mainWrites === 2) throw new Error("rollback unavailable");
            }
            if (key === "shotshot:canvas_store:repair" && !repairAvailable) throw new Error("journal unavailable");
        });
        let active = true;
        const context = { signal: new AbortController().signal, isActive: () => active };
        const applying = applyRemoteTaskOutputToProject(videoTask, { capability: "video", value: video }, context);
        await vi.waitFor(() => expect(projectStorage.setItem).toHaveBeenCalledTimes(1));
        useProjectStore.getState().updateCanvasNodes("project-1", "canvas-1", () => []);
        active = false;
        candidate.resolve();
        const repairError = await applying.catch((error) => error);
        expect(repairError).toBeInstanceOf(CanvasPersistenceTransactionError);
        expect(repairError.pendingMediaDisposition).toBeInstanceOf(Promise);

        expect(getMediaStorageBookkeeping().leases).toBe(1);
        expect(await getMediaBlob(video.storageKey)).toBeInstanceOf(Blob);
        await cleanupUnusedMedia({}, () => ({}));
        const blobWhileRepairPending = await getMediaBlob(video.storageKey);
        repairAvailable = true;
        await useProjectStore.getState().flush();
        await vi.waitFor(() => expect(getMediaStorageBookkeeping().leases).toBe(0));

        expect(blobWhileRepairPending).toBeInstanceOf(Blob);
        expect(useProjectStore.getState().projects[0].canvases[0].nodes).toEqual([]);
        expect(await getMediaBlob(video.storageKey)).toBeUndefined();
    });
});
