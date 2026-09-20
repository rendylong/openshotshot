import { afterEach, expect, test, vi } from "vitest";

const storage = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/localforage-storage", () => ({ localForageStorage: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: unknown) => { storage.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { storage.delete(key); }),
} }));
// The delivery transaction is real; replace only image decoding/physical storage.
vi.mock("@/services/image-storage", async () => {
    const { downloadRemoteMediaBlob } = await import("./remote-media-download");
    return {
        uploadRemoteImage: vi.fn(async (url: string, context: { signal: AbortSignal; isActive: () => boolean }) => {
            const blob = await downloadRemoteMediaBlob(url, context.signal);
            if (!context.isActive()) throw new DOMException("stopped", "AbortError");
            storage.set("image:fal-result", blob);
            return { storageKey: "image:fal-result", url: "blob:fal-result", width: 16, height: 16, bytes: blob.size, mimeType: blob.type };
        }),
        deleteStoredImages: vi.fn(async (keys: string[]) => keys.forEach(key => storage.delete(key))),
        discardRemoteImage: vi.fn(), releaseRemoteImageLease: vi.fn(),
    };
});

import { createRemoteMediaTaskRunner } from "./remote-media-task-runner";
import { applyRemoteTaskStateToProject, deliverRemoteTaskToProject, getEmbeddedRemoteTaskStatus } from "@/lib/canvas/remote-media-task-result";
import { createModelChannel, defaultConfig } from "@/stores/use-config-store";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { CanvasNodeType } from "@/types/canvas";
import type { RemoteMediaTask, RemoteMediaTaskPatch } from "@/types/remote-media-task";

const mediaUrl = "https://v3b.fal.media/files/result.png";
afterEach(() => { vi.unstubAllGlobals(); storage.clear(); });

test("fal queue result download failure retries the original image request and commits exactly one local result", async () => {
    const model = "fal-ai/flux-2-pro";
    const channel = createModelChannel({ id: "fal-1", provider: "fal", apiKey: "mock-channel-key", models: [{ name: model, capability: "image" }] });
    let task: RemoteMediaTask = {
        id: "local-fal", remoteTaskId: "original-request", capability: "image", adapterId: "fal.image", adapterVersion: 1,
        channelId: channel.id, modelName: model, baseUrlSnapshot: "https://queue.fal.run", status: "pending",
        submittedAt: Date.now(), deadlineAt: Date.now() + 300_000,
        target: { projectId: "fal-project", canvasId: "fal-canvas", nodeId: "image-1", itemId: "item-1" },
    };
    useProjectStore.setState({ projects: [{ id: "fal-project", title: "QA", category: "", icon: "", color: "", createdAt: "now", updatedAt: "now", canvases: [{
        id: "fal-canvas", title: "QA", createdAt: "now", updatedAt: "now", connections: [], chatSessions: [], activeChatId: null,
        backgroundMode: "dots", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
        nodes: [{ id: "image-1", type: CanvasNodeType.Image, title: "result", position: { x: 0, y: 0 }, width: 100, height: 100,
            metadata: { status: "loading", images: [{ id: "item-1", content: "", status: "loading", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" }] } }],
    }] }] });
    await applyRemoteTaskStateToProject(task);
    let downloads = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url === mediaUrl) {
            expect(new Headers(init?.headers).has("authorization")).toBe(false);
            if (++downloads < 3) return new Response("fixture download failure", { status: 503 });
            return new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } });
        }
        expect(init?.method).toBe("GET");
        expect(url).toContain("/requests/original-request");
        expect(new Headers(init?.headers).get("authorization")).toBe("Key mock-channel-key");
        return new Response(JSON.stringify(url.includes("/status") ? { status: "COMPLETED" } : { images: [{ url: mediaUrl }] }), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetcher);
    const deliver = vi.fn(deliverRemoteTaskToProject);
    const runner = createRemoteMediaTaskRunner({
        getTasks: () => [task], patchTask: (_id: string, patch: RemoteMediaTaskPatch) => { task = { ...task, ...patch } as RemoteMediaTask; },
        flush: async () => {}, getConfig: () => ({ ...defaultConfig, channels: [channel] }),
        applyTaskState: applyRemoteTaskStateToProject, getEmbeddedTaskStatus: getEmbeddedRemoteTaskStatus,
        queryLegacy: vi.fn(), deliver,
    });
    try {
        await runner.start();
        expect(task.status).toBe("failed");
        expect(task.remoteTaskId).toBe("original-request");
        expect(storage.has("image:fal-result")).toBe(false);
        await runner.retryResult(task.id, task.target);
        await vi.waitFor(() => expect(downloads).toBe(2));
        await vi.waitFor(() => expect(task.status).toBe("failed"));
        // A newly selected node model does not change this request's durable identity.
        useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata!.model = "other::edited";
        await Promise.all([runner.retryResult(task.id, task.target), runner.retryResult(task.id, task.target)]);
        await vi.waitFor(() => expect(task.status).toBe("succeeded"));
        const images = useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata!.images!;
        expect(images).toHaveLength(1);
        expect(images[0]).toMatchObject({ storageKey: "image:fal-result", remoteTask: { id: task.id, status: "succeeded" } });
        expect([...storage.keys()].filter(key => key.startsWith("image:"))).toEqual(["image:fal-result"]);
        expect(downloads).toBe(3);
        expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
        await expect(runner.retryResult(task.id, task.target)).rejects.toThrow();
        expect(downloads).toBe(3);
    } finally { runner.dispose(); }
});
