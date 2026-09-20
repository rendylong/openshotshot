import { nanoid } from "nanoid";
import { create } from "zustand";

import { localForageStorage } from "@/lib/localforage-storage";
import { DEFAULT_REMOTE_TASK_TIMEOUT_MINUTES } from "@/stores/use-config-store";
import { isRemoteMediaTask, isTerminalRemoteMediaStatus, type CreateRemoteTaskInput, type RemoteMediaTask, type RemoteMediaTaskBase, type RemoteMediaTaskPatch, type RemoteMediaTaskStatus } from "@/types/remote-media-task";

const STORAGE_KEY = "shotshot:remote_media_tasks";
const STORAGE_VERSION = 1;
const ACTIVE_STATUSES = new Set<RemoteMediaTaskStatus>(["submitting", "pending", "waiting_network", "waiting_configuration"]);
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_PERSISTED_TASKS = 200;

// 终态任务清理（可靠性 spec §3）：终态且 updatedAt 距今 >24h 删除；总量超 200 从最旧终态删；
// 进行中任务永不清理。仅状态缓存，非生成产物，被清理的历史不可恢复。
function pruneTasks(tasks: RemoteMediaTask[], now: number): RemoteMediaTask[] {
    const kept = tasks.filter((task) => !isTerminalRemoteMediaStatus(task.status) || now - (task.lastPolledAt ?? task.submittedAt) < TERMINAL_RETENTION_MS);
    if (kept.length <= MAX_PERSISTED_TASKS) return kept;
    const removableIds = new Set(
        kept
            .filter((task) => isTerminalRemoteMediaStatus(task.status))
            .sort((a, b) => (a.lastPolledAt ?? a.submittedAt) - (b.lastPolledAt ?? b.submittedAt))
            .slice(0, kept.length - MAX_PERSISTED_TASKS)
            .map((task) => task.id),
    );
    return kept.filter((task) => !removableIds.has(task.id));
}

type RemoteMediaTaskStore = {
    hydrated: boolean;
    tasks: RemoteMediaTask[];
    createTask: (input: CreateRemoteTaskInput) => RemoteMediaTask;
    patchTask: (id: string, patch: RemoteMediaTaskPatch) => void;
    persistTaskPatches: (patches: Array<{ id: string; patch: RemoteMediaTaskPatch }>) => Promise<RemoteMediaTask[]>;
    interruptTasksForNode: (projectId: string, canvasId: string, nodeId: string) => void;
    activeCount: () => number;
    flush: () => Promise<void>;
    resetForTests: () => void;
};

type PersistedTasks = { version: number; state: { tasks: RemoteMediaTask[] } };
let writeQueue = Promise.resolve();
let hydrationPromise: Promise<void>;
let hydrationError: unknown;
let runtimeRevision = 0;

function serialize(tasks: RemoteMediaTask[]) {
    return JSON.stringify({ version: STORAGE_VERSION, state: { tasks } } satisfies PersistedTasks);
}

function readPersisted(value: string | null): { tasks: RemoteMediaTask[]; invalid: boolean } {
    if (!value) return { tasks: [], invalid: false };
    try {
        const parsed = JSON.parse(value) as Partial<PersistedTasks>;
        const tasks = parsed.state?.tasks;
        if (parsed.version !== STORAGE_VERSION || !Array.isArray(tasks) || !tasks.every(isRemoteMediaTask)) return { tasks: [], invalid: true };
        return { tasks, invalid: false };
    } catch {
        return { tasks: [], invalid: true };
    }
}

function mergeTasks(persisted: RemoteMediaTask[], runtime: RemoteMediaTask[]) {
    const tasks = new Map(persisted.map((task) => [task.id, task]));
    runtime.forEach((task) => tasks.set(task.id, task));
    return [...tasks.values()];
}

function queuePersist(tasks: RemoteMediaTask[]) {
    const snapshot = serialize(tasks);
    const write = writeQueue.catch(() => undefined).then(async () => {
        await hydrationPromise;
        await localForageStorage.setItem(STORAGE_KEY, snapshot);
    });
    writeQueue = write;
    void write.catch(() => undefined);
    return write;
}

export const useRemoteMediaTaskStore = create<RemoteMediaTaskStore>((set, get) => ({
    hydrated: false,
    tasks: [],
    createTask: (input) => {
        const submittedAt = input.now ?? Date.now();
        const taskBase: RemoteMediaTaskBase = {
            id: nanoid(),
            capability: input.capability,
            target: input.target,
            channelId: input.channelId,
            modelName: input.modelName,
            baseUrlSnapshot: input.baseUrlSnapshot,
            outputFormat: input.outputFormat,
            idempotencyKey: input.idempotencyKey,
            ...(input.scriptSource ? { scriptSource: input.scriptSource } : {}),
            status: "submitting",
            submittedAt,
            // timeoutMinutes 由生成计划层算好传入（视频=30 分钟）；渠道遗留自定义超时已在 config 归一化时钳为默认值，这里不再二次钳制。
            deadlineAt: submittedAt + (input.timeoutMinutes ?? DEFAULT_REMOTE_TASK_TIMEOUT_MINUTES) * 60_000,
        };
        const task: RemoteMediaTask = typeof input.adapterId === "string"
            ? { ...taskBase, adapterId: input.adapterId, adapterVersion: input.adapterVersion! }
            : { ...taskBase, queryScriptSnapshot: input.queryScriptSnapshot! };
        runtimeRevision += 1;
        set((state) => {
            const tasks = pruneTasks([...state.tasks, task], Date.now());
            void queuePersist(tasks);
            return { tasks };
        });
        return task;
    },
    patchTask: (id, patch) => {
        runtimeRevision += 1;
        set((state) => {
            const tasks: RemoteMediaTask[] = pruneTasks(state.tasks.map((task) => (task.id === id ? { ...task, ...patch, id: task.id } : task)), Date.now());
            void queuePersist(tasks);
            return { tasks };
        });
    },
    persistTaskPatches: async (patches) => {
        if (!patches.length) return [];
        const now = Date.now();
        const patchById = new Map(patches.map((item) => [item.id, item.patch]));
        const staged: RemoteMediaTask[] = pruneTasks(get().tasks.map((task) => patchById.has(task.id) ? { ...task, ...patchById.get(task.id), id: task.id } : task), now);
        await queuePersist(staged);
        runtimeRevision += 1;
        set((state) => ({ tasks: pruneTasks(state.tasks.map((task) => patchById.has(task.id) ? { ...task, ...patchById.get(task.id), id: task.id } : task) as RemoteMediaTask[], now) }));
        await queuePersist(get().tasks);
        return get().tasks.filter((task) => patchById.has(task.id));
    },
    interruptTasksForNode: (projectId, canvasId, nodeId) => {
        runtimeRevision += 1;
        set((state) => {
            const tasks = pruneTasks(state.tasks.map((task) =>
                task.target.projectId === projectId
                && task.target.canvasId === canvasId
                && (task.target.nodeId === nodeId || task.target.sourceNodeId === nodeId)
                && ACTIVE_STATUSES.has(task.status)
                    ? { ...task, status: "interrupted" as const }
                    : task,
            ), Date.now());
            void queuePersist(tasks);
            return { tasks };
        });
    },
    activeCount: () => get().tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length,
    flush: async () => {
        await hydrationPromise;
        if (hydrationError) throw hydrationError;
        await writeQueue;
    },
    resetForTests: () => {
        runtimeRevision += 1;
        set({ tasks: [], hydrated: true });
        void queuePersist([]);
    },
}));

hydrationPromise = (async () => {
    let persisted: { tasks: RemoteMediaTask[]; invalid: boolean } = { tasks: [], invalid: false };
    try {
        persisted = readPersisted(await localForageStorage.getItem(STORAGE_KEY));
    } catch (error) {
        hydrationError = error;
    }
    const tasks = pruneTasks(mergeTasks(persisted.tasks, useRemoteMediaTaskStore.getState().tasks), Date.now());
    useRemoteMediaTaskStore.setState({ tasks, hydrated: true });
    if (runtimeRevision > 0 || persisted.invalid) void queuePersist(tasks);
})();
