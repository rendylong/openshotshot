import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { RemoteMediaTask } from "@/types/remote-media-task";

const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }));
vi.mock("@/lib/localforage-storage", () => ({ localForageStorage: storage }));

const target = { projectId: "project", canvasId: "canvas", nodeId: "node", itemId: "item" };
const node = (status: "failed" | "timed_out" | "submission_unknown" = "failed"): CanvasNodeData => ({
    id: target.nodeId, type: CanvasNodeType.Image, title: "failed image", position: { x: 0, y: 0 }, width: 100, height: 100,
    metadata: { model: "edited-channel::edited-model", images: [{ id: "item", status: "error", content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "", remoteTask: { id: "local", status, submittedAt: 1 } }] },
});
// submittedAt 须落在终态清理（24h 保留窗口）之内，否则水合时记录会被 prune 掉。
const task = (adapterId = "fal.image") => ({
    id: "local", remoteTaskId: "original", capability: "image", adapterId, adapterVersion: 1,
    target, channelId: "original-channel", modelName: "fal-ai/flux-2-pro", baseUrlSnapshot: "https://queue.fal.run",
    status: "failed", submittedAt: Date.now() - 60_000, deadlineAt: Date.now() + 240_000,
} satisfies RemoteMediaTask);

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); storage.setItem.mockResolvedValue(undefined); });
afterEach(() => { vi.restoreAllMocks(); });

async function setup() {
    let hydrate!: (tasks: RemoteMediaTask[]) => void;
    const pending = new Promise<string>(resolve => { hydrate = tasks => resolve(JSON.stringify({ version: 1, state: { tasks } })); });
    storage.getItem.mockImplementation((key: string) => key === "shotshot:remote_media_tasks" ? pending : Promise.resolve(null));
    const { useRemoteMediaTaskStore: store } = await import("@/stores/use-remote-media-task-store");
    const { retryRemoteMediaNodeResult, registerRemoteMediaTaskRunner } = await import("./remote-media-task-runner");
    const retry = vi.fn().mockResolvedValue(undefined);
    const unregister = registerRemoteMediaTaskRunner({ start: vi.fn(), wake: vi.fn(), retryResult: retry, retrySubmission: async () => {}, abort: vi.fn(), stop: vi.fn(), stopByTarget: vi.fn(), dispose: vi.fn() });
    // Match project's continuation contract: only a false result permits fresh generation.
    const submit = vi.fn();
    const attempt = (value = node()) => retryRemoteMediaNodeResult(value, target).then(handled => { if (!handled) submit(); });
    return { store, hydrate, retry, unregister, submit, attempt, retryRemoteMediaNodeResult };
}

test.each(["failed", "timed_out"] as const)("%s image waits for delayed hydration and queries the original task without permitting submit", async status => {
    const h = await setup();
    try {
        const attempt = h.attempt(node(status));
        expect(h.store.getState().hydrated).toBe(false);
        expect(h.retry).not.toHaveBeenCalled(); expect(h.submit).not.toHaveBeenCalled();
        h.hydrate([task()]);
        await attempt;
        expect(h.retry).toHaveBeenCalledExactlyOnceWith("local", target);
        expect(h.submit).not.toHaveBeenCalled();
    } finally { h.unregister(); }
});

test.each(["hiapi.image", "fal.image"])("%s image queries its original task without permitting submit", async adapterId => {
    const h = await setup();
    try {
        const attempt = h.attempt(node("failed"));
        h.hydrate([task(adapterId)]);
        await attempt;
        expect(h.retry).toHaveBeenCalledExactlyOnceWith("local", target);
        expect(h.submit).not.toHaveBeenCalled();
    } finally { h.unregister(); }
});

test.each(["failed", "timed_out"] as const)("%s image with no durable record rejects before new generation", async status => {
    const h = await setup();
    try {
        const attempt = h.attempt(node(status));
        h.hydrate([]);
        await expect(attempt).rejects.toThrow("任务暂时无法重新查询");
        expect(h.retry).not.toHaveBeenCalled(); expect(h.submit).not.toHaveBeenCalled();
        await expect(h.attempt(node(status))).rejects.toThrow("任务暂时无法重新查询");
        expect(h.submit).not.toHaveBeenCalled();
    } finally { h.unregister(); }
});

test("recognized non-fal image records retain the existing new-generation route after hydration", async () => {
    const h = await setup();
    try {
        const attempt = h.attempt();
        h.hydrate([{ ...task(), adapterId: "other.image" }]);
        await attempt;
        expect(h.retry).not.toHaveBeenCalled(); expect(h.submit).toHaveBeenCalledOnce();
    } finally { h.unregister(); }
});

test("ordinary generation without embedded remote failure does not wait for task hydration", async () => {
    const h = await setup();
    try {
        await expect(h.retryRemoteMediaNodeResult({ ...node(), metadata: {} }, target)).resolves.toBe(false);
        expect(h.store.getState().hydrated).toBe(false);
        expect(h.retry).not.toHaveBeenCalled();
    } finally { h.hydrate([]); h.unregister(); }
});

test.each(["image", "video"] as const)("%s unknown submission waits for hydration and refuses missing remote IDs", async type => {
    const h = await setup();
    try {
        const unknown = node("submission_unknown");
        const value = type === "image" ? unknown : { ...unknown, type: CanvasNodeType.Video, metadata: { remoteTask: unknown.metadata!.images![0].remoteTask } };
        const before = structuredClone(value);
        const attempt = h.attempt(value);
        expect(h.store.getState().hydrated).toBe(false);
        h.hydrate([]);
        await expect(attempt).rejects.toThrow("提交结果未知");
        await expect(h.attempt(value)).rejects.toThrow("提交结果未知");
        h.store.setState({ tasks: [{ ...task(), status: "submission_unknown", remoteTaskId: undefined }] });
        await expect(h.attempt(value)).rejects.toThrow("提交结果未知");
        expect(value).toEqual(before);
        expect(h.retry).not.toHaveBeenCalled(); expect(h.submit).not.toHaveBeenCalled();
    } finally { h.hydrate([]); h.unregister(); }
});

test("unknown submission refusal selects the exact batch item without altering siblings", async () => {
    const h = await setup();
    try {
        const value = node();
        value.metadata!.images!.push({ ...value.metadata!.images![0], id: "unknown-item", remoteTask: { id: "unknown", status: "submission_unknown", submittedAt: 1 } });
        const before = structuredClone(value);
        const attempt = h.retryRemoteMediaNodeResult(value, target, "unknown-item").then(handled => { if (!handled) h.submit(); });
        h.hydrate([task()]);
        await expect(attempt).rejects.toThrow("提交结果未知");
        await expect(h.retryRemoteMediaNodeResult(value, target, "item")).resolves.toBe(true);
        expect(h.retry).toHaveBeenCalledExactlyOnceWith("local", target);
        expect(h.submit).not.toHaveBeenCalled(); expect(value).toEqual(before);
    } finally { h.hydrate([]); h.unregister(); }
});

test.each(["hiapi.image", "fal.image"])("%s unknown submission recovers the saved ID after hydration", async adapterId => {
    const h = await setup();
    try {
        const attempt = h.attempt(node("submission_unknown"));
        expect(h.retry).not.toHaveBeenCalled();
        h.hydrate([{ ...task(adapterId), status: "submission_unknown" }]);
        await attempt;
        expect(h.retry).toHaveBeenCalledExactlyOnceWith("local", target);
        expect(h.submit).not.toHaveBeenCalled();
    } finally { h.unregister(); }
});
