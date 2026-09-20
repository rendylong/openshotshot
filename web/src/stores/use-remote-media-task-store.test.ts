import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";

import type { CreateRemoteTaskInput } from "@/types/remote-media-task";
import { useRemoteMediaTaskStore } from "./use-remote-media-task-store";

function taskInput(patch: Record<string, unknown> = {}): CreateRemoteTaskInput {
    return {
        capability: "image",
        target: { projectId: "project-1", canvasId: "canvas-1", nodeId: "node-1", itemId: "item-1", sourceNodeId: "source-1" },
        channelId: "channel-1",
        modelName: "image-model",
        baseUrlSnapshot: "https://provider.example",
        queryScriptSnapshot: "return { status: 'pending' }",
        outputFormat: "png",
        now: 1_000,
        timeoutMinutes: 5,
        ...patch,
    } as CreateRemoteTaskInput;
}

describe("remote media task store", () => {
    beforeEach(() => useRemoteMediaTaskStore.getState().resetForTests());

    test("creates a submitting task with a five-minute wall-clock deadline", () => {
        const task = useRemoteMediaTaskStore.getState().createTask(taskInput());

        expect(task).toMatchObject({
            status: "submitting",
            submittedAt: 1_000,
            deadlineAt: 301_000,
            target: { projectId: "project-1", canvasId: "canvas-1", nodeId: "node-1", itemId: "item-1", sourceNodeId: "source-1" },
            baseUrlSnapshot: "https://provider.example",
            queryScriptSnapshot: "return { status: 'pending' }",
        });
    });

    test("uses five minutes when the caller omits the timeout", () => {
        const task = useRemoteMediaTaskStore.getState().createTask(taskInput({ timeoutMinutes: undefined }));

        expect(task.deadlineAt).toBe(301_000);
    });

    test("creates an adapter task without a legacy query script", () => {
        const task = useRemoteMediaTaskStore.getState().createTask(taskInput({
            queryScriptSnapshot: undefined,
            adapterId: "zhipu.video",
            adapterVersion: 1,
        }));

        expect(task).toMatchObject({ adapterId: "zhipu.video", adapterVersion: 1 });
        expect(task).not.toHaveProperty("queryScriptSnapshot");
    });

    test("honors the caller-provided timeout (video tasks use thirty minutes)", () => {
        const task = useRemoteMediaTaskStore.getState().createTask(taskInput({ timeoutMinutes: 30 }));

        expect(task.deadlineAt).toBe(1_801_000);
    });

    test("counts only active lifecycle states", () => {
        const statuses = ["submitting", "pending", "waiting_network", "waiting_configuration", "succeeded", "failed", "timed_out", "interrupted", "submission_unknown"] as const;
        const tasks = statuses.map((status, index) => {
            // 近期时间戳：终态清理按写入时刻 24h 内保留，这里只验证 active 计数
            const task = useRemoteMediaTaskStore.getState().createTask(taskInput({ now: Date.now() - index * 1000 }));
            useRemoteMediaTaskStore.getState().patchTask(task.id, { status, lastPolledAt: Date.now() });
            return task;
        });

        expect(useRemoteMediaTaskStore.getState().activeCount()).toBe(4);
        expect(useRemoteMediaTaskStore.getState().tasks).toHaveLength(tasks.length);
    });

    test("interrupts active tasks for either a node or its source node", () => {
        // 近期时间戳：interrupt 产生的终态任务在 24h 保留期内，不被清理
        const now = Date.now();
        const direct = useRemoteMediaTaskStore.getState().createTask(taskInput({ now, target: { projectId: "project-1", canvasId: "canvas-1", nodeId: "node-1" } }));
        const child = useRemoteMediaTaskStore.getState().createTask(taskInput({ now, target: { projectId: "project-1", canvasId: "canvas-1", nodeId: "child-1", sourceNodeId: "node-1" } }));
        const otherCanvas = useRemoteMediaTaskStore.getState().createTask(taskInput({ now, target: { projectId: "project-1", canvasId: "canvas-2", nodeId: "node-1" } }));
        useRemoteMediaTaskStore.getState().patchTask(direct.id, { status: "pending", remoteTaskId: "remote-1" });
        useRemoteMediaTaskStore.getState().patchTask(child.id, { status: "waiting_network", remoteTaskId: "remote-2" });

        useRemoteMediaTaskStore.getState().interruptTasksForNode("project-1", "canvas-1", "node-1");

        expect(useRemoteMediaTaskStore.getState().tasks.find((task) => task.id === direct.id)?.status).toBe("interrupted");
        expect(useRemoteMediaTaskStore.getState().tasks.find((task) => task.id === child.id)?.status).toBe("interrupted");
        expect(useRemoteMediaTaskStore.getState().tasks.find((task) => task.id === otherCanvas.id)?.status).toBe("submitting");
    });

    it("终态清理：转入终态且 updatedAt 距今 >24h 的任务在写入时被清理", () => {
        const store = useRemoteMediaTaskStore.getState();
        const old = Date.now() - 25 * 60 * 60 * 1000;
        const stale = store.createTask(taskInput({ now: old }));
        store.patchTask(stale.id, { status: "succeeded", lastPolledAt: old });
        expect(useRemoteMediaTaskStore.getState().tasks.some((task) => task.id === stale.id)).toBe(false);
    });

    it("总量超 200：从最旧终态删，运行中任务永不清理", () => {
        const store = useRemoteMediaTaskStore.getState();
        const old = Date.now() - 30 * 60 * 60 * 1000;
        const oldest = store.createTask(taskInput({ now: old }));
        store.patchTask(oldest.id, { status: "failed", lastPolledAt: old });
        const active = store.createTask(taskInput({ nodeId: "node-active", now: Date.now() - 1000 }));
        for (let i = 0; i < 205; i++) {
            const task = store.createTask(taskInput({ nodeId: `node-${i}`, now: Date.now() }));
            store.patchTask(task.id, { status: "succeeded", lastPolledAt: Date.now() });
        }
        const tasks = useRemoteMediaTaskStore.getState().tasks;
        expect(tasks.length).toBeLessThanOrEqual(200);
        expect(tasks.some((task) => task.id === oldest.id)).toBe(false);
        expect(tasks.some((task) => task.id === active.id)).toBe(true);
    });
});

function persistedTask(patch: Record<string, unknown> = {}) {
    return {
        id: "persisted-1",
        remoteTaskId: "remote-1",
        capability: "image",
        target: { projectId: "project-1", canvasId: "canvas-1", nodeId: "node-1" },
        channelId: "channel-1",
        modelName: "image-model",
        baseUrlSnapshot: "https://provider.example",
        queryScriptSnapshot: "return { status: 'pending' }",
        status: "pending",
        submittedAt: 1_000,
        deadlineAt: 301_000,
        ...patch,
    };
}

async function loadStore(storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> }) {
    vi.resetModules();
    vi.doMock("@/lib/localforage-storage", () => ({ localForageStorage: storage }));
    const module = await import("./use-remote-media-task-store");
    if (!module.useRemoteMediaTaskStore.getState().hydrated) {
        await new Promise<void>((resolve) => {
            const unsubscribe = module.useRemoteMediaTaskStore.subscribe((state) => {
                if (!state.hydrated) return;
                unsubscribe();
                resolve();
            });
        });
    }
    return module.useRemoteMediaTaskStore;
}

describe("remote media task persistence", () => {
    afterEach(() => {
        vi.doUnmock("@/lib/localforage-storage");
        vi.resetModules();
    });

    test("flush waits until a critical localforage write completes", async () => {
        let finishWrite!: () => void;
        const storage = {
            getItem: vi.fn().mockResolvedValue(null),
            setItem: vi.fn(() => new Promise<void>((resolve) => { finishWrite = resolve; })),
            removeItem: vi.fn().mockResolvedValue(undefined),
        };
        const store = await loadStore(storage);
        store.getState().createTask(taskInput());
        let flushed = false;

        const flushing = store.getState().flush().then(() => { flushed = true; });
        await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalled());
        expect(flushed).toBe(false);
        finishWrite();
        await flushing;

        expect(flushed).toBe(true);
    });

    test("flush persists a remote task ID and rejects failed writes", async () => {
        const values: string[] = [];
        let fail = false;
        const storage = {
            getItem: vi.fn().mockResolvedValue(null),
            setItem: vi.fn(async (_key: string, value: string) => {
                if (fail) throw new Error("indexeddb unavailable");
                values.push(value);
            }),
            removeItem: vi.fn().mockResolvedValue(undefined),
        };
        const store = await loadStore(storage);
        const task = store.getState().createTask(taskInput());
        await store.getState().flush();
        store.getState().patchTask(task.id, { status: "pending", remoteTaskId: "remote-9" });
        await store.getState().flush();

        expect(JSON.parse(values.at(-1) || "").state.tasks[0]).toMatchObject({ status: "pending", remoteTaskId: "remote-9" });
        fail = true;
        store.getState().patchTask(task.id, { progress: 50 });
        await expect(store.getState().flush()).rejects.toThrow("indexeddb unavailable");
    });

    test("publishes a task transition only after its terminal snapshot is durable", async () => {
        let holdTransition = false;
        let finishTransition!: () => void;
        const storage = {
            getItem: vi.fn().mockResolvedValue(null),
            setItem: vi.fn(async () => {
                if (holdTransition) await new Promise<void>((resolve) => { finishTransition = resolve; });
            }),
            removeItem: vi.fn().mockResolvedValue(undefined),
        };
        const store = await loadStore(storage);
        // 近期时间戳：转入终态的任务须在 24h 保留期内，不被清理（本用例验证的是 staged/final 持久化时序）
        const task = store.getState().createTask(taskInput({ now: Date.now() }));
        store.getState().patchTask(task.id, { status: "pending", remoteTaskId: "remote-1" });
        await store.getState().flush();
        holdTransition = true;

        const transitioning = store.getState().persistTaskPatches([{ id: task.id, patch: { status: "interrupted" } }]);
        await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledTimes(3));
        expect(store.getState().tasks[0].status).toBe("pending");

        holdTransition = false;
        finishTransition();
        await transitioning;
        expect(store.getState().tasks[0].status).toBe("interrupted");
    });

    test("flush rejects when hydration cannot read persisted tasks", async () => {
        const storage = {
            getItem: vi.fn().mockRejectedValue(new Error("indexeddb read failed")),
            setItem: vi.fn().mockResolvedValue(undefined),
            removeItem: vi.fn().mockResolvedValue(undefined),
        };
        const store = await loadStore(storage);

        await expect(store.getState().flush()).rejects.toThrow("indexeddb read failed");
    });

    test("rehydration merges pre-hydration writes by ID with runtime state winning", async () => {
        let finishRead!: (value: string) => void;
        const storage = {
            getItem: vi.fn(() => new Promise<string>((resolve) => { finishRead = resolve; })),
            setItem: vi.fn().mockResolvedValue(undefined),
            removeItem: vi.fn().mockResolvedValue(undefined),
        };
        vi.resetModules();
        vi.doMock("@/lib/localforage-storage", () => ({ localForageStorage: storage }));
        const { useRemoteMediaTaskStore: store } = await import("./use-remote-media-task-store");
        const created = store.getState().createTask(taskInput());
        store.getState().patchTask(created.id, { status: "pending", remoteTaskId: "runtime-remote" });
        finishRead(JSON.stringify({ version: 1, state: { tasks: [persistedTask(), { ...persistedTask(), id: created.id, status: "failed", remoteTaskId: "stale" }] } }));
        await store.getState().flush();

        expect(store.getState().tasks.map((task) => task.id).sort()).toEqual([created.id, "persisted-1"].sort());
        expect(store.getState().tasks.find((task) => task.id === created.id)).toMatchObject({ status: "pending", remoteTaskId: "runtime-remote" });
    });

    test("rehydrates both adapter tasks and unchanged legacy query-script tasks", async () => {
        const { queryScriptSnapshot: _queryScriptSnapshot, ...base } = persistedTask();
        const adapter = { ...base, id: "adapter-1", adapterId: "zhipu.video", adapterVersion: 1 };
        const storage = {
            getItem: vi.fn().mockResolvedValue(JSON.stringify({ version: 1, state: { tasks: [persistedTask(), adapter] } })),
            setItem: vi.fn().mockResolvedValue(undefined),
            removeItem: vi.fn().mockResolvedValue(undefined),
        };

        const store = await loadStore(storage);

        expect(store.getState().tasks).toEqual([persistedTask(), adapter]);
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    test.each([
        ["both protocols", persistedTask({ adapterId: "zhipu.video", adapterVersion: 1 })],
        ["adapter without version", persistedTask({ queryScriptSnapshot: undefined, adapterId: "zhipu.video" })],
        ["legacy protocol with an empty script", persistedTask({ queryScriptSnapshot: "" })],
    ])("rejects persisted tasks with %s", async (_name, task) => {
        const storage = {
            getItem: vi.fn().mockResolvedValue(JSON.stringify({ version: 1, state: { tasks: [task] } })),
            setItem: vi.fn().mockResolvedValue(undefined),
            removeItem: vi.fn().mockResolvedValue(undefined),
        };

        const store = await loadStore(storage);

        expect(store.getState().tasks).toEqual([]);
    });

    test.each([
        ["null tasks", { version: 1, state: { tasks: null } }],
        ["missing deadline", { version: 1, state: { tasks: [persistedTask({ deadlineAt: undefined })] } }],
        ["invalid status", { version: 1, state: { tasks: [persistedTask({ status: "mystery" })] } }],
        ["unknown version", { version: 0, state: { tasks: [persistedTask()] } }],
    ])("discards %s instead of exposing corrupt tasks", async (_name, persisted) => {
        const storage = {
            getItem: vi.fn().mockResolvedValue(JSON.stringify(persisted)),
            setItem: vi.fn().mockResolvedValue(undefined),
            removeItem: vi.fn().mockResolvedValue(undefined),
        };
        const store = await loadStore(storage);

        expect(store.getState().tasks).toEqual([]);
        expect(() => store.getState().activeCount()).not.toThrow();
    });
});
