import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createModelChannel, defaultConfig, type AiConfig } from "@/stores/use-config-store";
import type { CreateRemoteTaskInput, RemoteMediaTask, RemoteMediaTaskPatch, RemoteMediaTaskRunnerDeps, RemoteMediaTaskStatus, RemoteTaskDeliveryOutcome } from "@/types/remote-media-task";
import { createRemoteMediaTaskRunner, interruptRemoteTasksForTarget, registerRemoteMediaTaskRunner, remoteTaskApplyRequiresInterruption, startRemoteCanvasMediaTask, stopRemoteTasksForTarget, wakeRemoteMediaTask } from "./remote-media-task-runner";
import { useRemoteMediaTaskStore } from "@/stores/use-remote-media-task-store";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeImage } from "@/types/canvas";
import type { Canvas } from "@/types/project";
import { applyRemoteTaskStateToProject, getEmbeddedRemoteTaskStatus } from "@/lib/canvas/remote-media-task-result";

function completeTask(patch: RemoteMediaTaskPatch = {}): RemoteMediaTask {
    return {
        id: "local-1",
        remoteTaskId: "remote-1",
        capability: "image",
        target: { projectId: "project-1", canvasId: "canvas-1", nodeId: "node-1", sourceNodeId: "source-1" },
        channelId: "channel-1",
        modelName: "image-model",
        baseUrlSnapshot: "https://snapshot.example",
        queryScriptSnapshot: "return { status: 'pending' }",
        outputFormat: "png",
        status: "pending",
        submittedAt: 1_000,
        deadlineAt: 301_000,
        ...patch,
    };
}

function adapterTask(patch: Record<string, unknown> = {}): RemoteMediaTask {
    const { queryScriptSnapshot: _queryScriptSnapshot, ...task } = completeTask();
    return { ...task, adapterId: "zhipu.video", adapterVersion: 1, ...patch } as RemoteMediaTask;
}

function canvasImage(patch: Partial<CanvasNodeImage> = {}): CanvasNodeImage {
    return { id: "item-1", status: "loading", content: "", naturalWidth: 1, naturalHeight: 1, bytes: 0, mimeType: "image/png", ...patch };
}

function canvasFixture(nodes: CanvasNodeData[]): Canvas {
    return { id: "canvas-1", title: "Canvas", nodes, connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, createdAt: "now", updatedAt: "now" };
}

function configuredAiConfig(apiKey = "secret"): AiConfig {
    return {
        ...defaultConfig,
        channels: [{ id: "channel-1", name: "Original", baseUrl: "https://changed.example", apiKey, apiFormat: "openai", models: [] }],
    };
}

function fakeDeps(options: {
    task?: RemoteMediaTask;
    tasks?: RemoteMediaTask[];
    query?: RemoteMediaTaskRunnerDeps["queryLegacy"];
    queryAdapter?: RemoteMediaTaskRunnerDeps["queryAdapter"];
    deliver?: RemoteMediaTaskRunnerDeps["deliver"];
    reportLateDeliveryError?: RemoteMediaTaskRunnerDeps["reportLateDeliveryError"];
    config?: AiConfig;
} = {}) {
    let tasks = (options.tasks || [options.task || completeTask()]).map((task) => ({ ...task } as RemoteMediaTask));
    const patchTask = vi.fn((id: string, patch: RemoteMediaTaskPatch) => {
        tasks = tasks.map((task) => (task.id === id ? { ...task, ...patch } : task));
    });
    const deps: RemoteMediaTaskRunnerDeps = {
            getTasks: () => tasks,
            patchTask,
            flush: vi.fn().mockResolvedValue(undefined),
            applyTaskState: vi.fn().mockResolvedValue({ applied: true }),
            getConfig: () => options.config || configuredAiConfig(),
            queryLegacy: options.query || vi.fn().mockResolvedValue({ status: "pending" }),
            queryAdapter: options.queryAdapter,
            deliver: options.deliver || vi.fn().mockResolvedValue({ applied: true }),
            reportLateDeliveryError: options.reportLateDeliveryError,
            now: () => Date.now(),
        };
    return {
        deps,
        patchTask,
        task: () => tasks[0],
    };
}

function lastStatus(patchTask: ReturnType<typeof vi.fn>): RemoteMediaTaskStatus | undefined {
    return patchTask.mock.calls.at(-1)?.[1]?.status;
}

function remoteInput() {
    return {
        config: {
            ...configuredAiConfig(),
            model: "channel-1::image-model",
            channels: [{ ...configuredAiConfig().channels[0], models: [{ name: "image-model", capability: "image" as const, executionMode: "remote_task" as const, remoteTask: { timeoutMinutes: 5, submitScript: "return 'remote-1'", queryScript: "return { status: 'pending' }" } }] }],
        },
        capability: "image" as const,
        prompt: "draw it",
        references: [],
        target: { projectId: "project-1", canvasId: "canvas-1", nodeId: "node-1", itemId: "item-1", sourceNodeId: "source-1" },
    };
}

function adapterInput() {
    return {
        ...remoteInput(),
        config: {
            ...configuredAiConfig("secret-key"),
            model: "channel-1::cogvideox-3",
            channels: [{
                ...configuredAiConfig("secret-key").channels[0],
                provider: "zhipu" as const,
                baseUrl: "https://open.bigmodel.cn/api/paas/v4",
                models: [{ name: "cogvideox-3", capability: "video" as const }],
            }],
        },
        capability: "video" as const,
    };
}

function minimaxPresetAdapterInput() {
    const channel = createModelChannel({ id: "minimax-1", provider: "minimax-cn", apiKey: "secret-key" });
    return {
        ...remoteInput(),
        config: {
            ...configuredAiConfig("secret-key"),
            model: "minimax-1::MiniMax-Hailuo-2.3",
            channels: [channel],
        },
        capability: "video" as const,
    };
}

function hiapiAdapterInput() {
    return {
        ...remoteInput(),
        config: {
            ...configuredAiConfig("secret-key"),
            model: "channel-1::gpt-image-2/image-to-image",
            channels: [{
                ...configuredAiConfig("secret-key").channels[0],
                provider: "hiapi" as const,
                baseUrl: "https://api.hiapi.ai",
                models: [{ name: "gpt-image-2/image-to-image", capability: "image" as const }],
            }],
        },
        capability: "image" as const,
    };
}

function startDeps(overrides: Record<string, unknown> = {}) {
    const startedAt = Date.now();
    let task = completeTask({ status: "submitting", remoteTaskId: undefined, target: remoteInput().target, submittedAt: startedAt, deadlineAt: startedAt + 300_000 });
    const deps = {
        createTask: vi.fn((incoming: CreateRemoteTaskInput) => {
            task = { ...task, ...incoming, id: task.id } as unknown as RemoteMediaTask;
            return task;
        }),
        flush: vi.fn().mockResolvedValue(undefined),
        submit: vi.fn().mockResolvedValue({ taskId: "remote-1" }),
        submitAdapter: vi.fn().mockResolvedValue({ taskId: "remote-1" }),
        patchTask: vi.fn((id: string, patch: RemoteMediaTaskPatch) => {
            if (id === task.id) task = { ...task, ...patch };
        }),
        getTask: vi.fn((id: string) => id === task.id ? task : undefined),
        applyTaskState: vi.fn().mockResolvedValue({ applied: true }),
        wake: vi.fn(),
        ...overrides,
    };
    return deps;
}

describe("remote canvas media task submission", () => {
    test("persists adapter identity and never copies the API key or scripts", async () => {
        const deps = startDeps();

        await startRemoteCanvasMediaTask(adapterInput(), deps);

        expect(deps.createTask).toHaveBeenCalledWith(expect.objectContaining({ adapterId: "zhipu.video", adapterVersion: 1 }));
        expect(deps.submitAdapter).toHaveBeenCalledWith(expect.objectContaining({ channelId: "channel-1" }));
        const serialized = JSON.stringify(deps.createTask.mock.calls[0][0]);
        expect(serialized).not.toContain("secret-key");
        expect(serialized).not.toContain("Script");
        expect(deps.submitAdapter).toHaveBeenCalledOnce();
        expect(deps.submit).not.toHaveBeenCalled();
    });

    test("submits a built-in MiniMax Hailuo preset as a script-free adapter task", async () => {
        const deps = startDeps();

        await startRemoteCanvasMediaTask(minimaxPresetAdapterInput(), deps);

        const persisted = deps.createTask.mock.calls[0][0];
        expect(persisted).toMatchObject({ adapterId: "minimax.video", adapterVersion: 1 });
        expect(JSON.stringify(persisted)).not.toContain("secret-key");
        expect(persisted).not.toHaveProperty("queryScriptSnapshot");
        expect(deps.submitAdapter).toHaveBeenCalledOnce();
        expect(deps.submit).not.toHaveBeenCalled();
    });

    test("classifies unchanged as idempotent success and only missing/inactive as interruption", () => {
        expect(remoteTaskApplyRequiresInterruption({ applied: false, reason: "unchanged" })).toBe(false);
        expect(remoteTaskApplyRequiresInterruption({ applied: false, reason: "missing_target" })).toBe(true);
        expect(remoteTaskApplyRequiresInterruption({ applied: false, reason: "inactive" })).toBe(true);
        expect(remoteTaskApplyRequiresInterruption({ applied: true })).toBe(false);
    });
    test("rejects invalid remote scripts before creating a durable task", async () => {
        const input = remoteInput();
        input.config.channels[0].models[0].remoteTask!.submitScript = "";
        const deps = startDeps();

        await expect(startRemoteCanvasMediaTask(input, deps)).rejects.toThrow();

        expect(deps.createTask).not.toHaveBeenCalled();
        expect(deps.applyTaskState).not.toHaveBeenCalled();
    });

    test("persists before provider submission", async () => {
        const order: string[] = [];
        const deps = startDeps({
            createTask: vi.fn(() => {
                order.push("create");
                const now = Date.now();
                return completeTask({ status: "submitting", remoteTaskId: undefined, target: remoteInput().target, submittedAt: now, deadlineAt: now + 300_000 });
            }),
            flush: vi.fn(async () => { order.push("flush"); }),
            submit: vi.fn(async () => {
                order.push("submit");
                return { taskId: "remote-1" };
            }),
            patchTask: vi.fn(() => { order.push("remote-id"); }),
            wake: vi.fn(() => { order.push("wake"); }),
        });

        await startRemoteCanvasMediaTask(remoteInput(), deps);

        expect(order).toEqual(["create", "flush", "submit", "remote-id", "flush", "wake"]);
        expect(deps.patchTask).toHaveBeenCalledWith("local-1", expect.objectContaining({ remoteTaskId: "remote-1", status: "pending" }));
    });

    test("does not submit when the initial task flush fails", async () => {
        const deps = startDeps({ flush: vi.fn().mockRejectedValueOnce(new Error("persist failed")).mockResolvedValue(undefined) });

        await startRemoteCanvasMediaTask(remoteInput(), deps);

        expect(deps.submit).not.toHaveBeenCalled();
        expect(deps.wake).not.toHaveBeenCalled();
        expect(deps.applyTaskState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", error: expect.stringContaining("persist failed") }));
    });

    test("does not wake when persisting the remote task ID fails", async () => {
        const deps = startDeps({ flush: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("persist failed")).mockResolvedValue(undefined) });

        await startRemoteCanvasMediaTask(remoteInput(), deps);

        expect(deps.submit).toHaveBeenCalledOnce();
        expect(deps.wake).not.toHaveBeenCalled();
        expect(deps.applyTaskState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", remoteTaskId: "remote-1", error: expect.stringContaining("persist failed") }));
    });

    test("marks task and target failed after a definite submit error", async () => {
        const deps = startDeps({ submit: vi.fn().mockRejectedValue(new Error("denied")) });

        await startRemoteCanvasMediaTask(remoteInput(), deps);

        expect(deps.patchTask).toHaveBeenCalledWith("local-1", expect.objectContaining({ status: "failed", error: "denied" }));
        expect(deps.applyTaskState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", error: "denied" }));
        expect(deps.wake).not.toHaveBeenCalled();
    });

    test.each(["initial", "remote-id"])("treats applied:false during %s target transaction as interruption", async (phase) => {
        const applyTaskState = vi.fn()
            .mockResolvedValueOnce(phase === "initial" ? { applied: false, reason: "missing_target" } : { applied: true })
            .mockResolvedValueOnce({ applied: false, reason: "missing_target" });
        const deps = startDeps({ applyTaskState });

        await startRemoteCanvasMediaTask(remoteInput(), deps);

        if (phase === "initial") expect(deps.submit).not.toHaveBeenCalled();
        else expect(deps.submit).toHaveBeenCalledOnce();
        expect(deps.wake).not.toHaveBeenCalled();
        expect(deps.getTask("local-1")?.status).toBe("interrupted");
    });

    test("surfaces a failed target error transaction after durably flushing the task failure", async () => {
        const deps = startDeps({
            submit: vi.fn().mockRejectedValue(new Error("provider denied")),
            applyTaskState: vi.fn().mockResolvedValueOnce({ applied: true }).mockRejectedValueOnce(new Error("canvas persist failed")),
        });

        await expect(startRemoteCanvasMediaTask(remoteInput(), deps)).rejects.toThrow("canvas persist failed");

        expect(deps.flush).toHaveBeenCalledTimes(2);
        expect(deps.getTask("local-1")).toMatchObject({ status: "failed", error: "provider denied" });
    });

    test("cleans the submit deadline when terminal target persistence throws", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const deps = startDeps({
            submit: vi.fn().mockRejectedValue(new Error("provider denied")),
            applyTaskState: vi.fn().mockResolvedValueOnce({ applied: true }).mockRejectedValueOnce(new Error("canvas persist failed")),
        });

        await expect(startRemoteCanvasMediaTask(remoteInput(), deps)).rejects.toThrow("canvas persist failed");

        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });

    test("does not resurrect or wake a task stopped while provider submission is pending", async () => {
        let active = true;
        let finishSubmit!: (value: { taskId: string }) => void;
        const deps = startDeps({
            submit: vi.fn(() => new Promise<{ taskId: string }>((resolve) => { finishSubmit = resolve; })),
            isTaskActive: () => active,
        });
        const starting = startRemoteCanvasMediaTask(remoteInput(), deps);
        await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());

        active = false;
        finishSubmit({ taskId: "remote-1" });
        await starting;

        expect(deps.patchTask).not.toHaveBeenCalledWith("local-1", expect.objectContaining({ status: "pending" }));
        expect(deps.wake).not.toHaveBeenCalled();
    });

    test("times out a provider submit that never settles at the task's original deadline", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        let signal!: AbortSignal;
        const deps = startDeps({ submit: vi.fn((input) => {
            signal = input.signal;
            return new Promise<never>(() => {});
        }) });

        const starting = startRemoteCanvasMediaTask(remoteInput(), deps);
        await vi.advanceTimersByTimeAsync(300_000);
        await starting;

        expect(signal.aborted).toBe(true);
        expect(deps.getTask("local-1")).toMatchObject({ status: "timed_out", deadlineAt: 301_000, error: expect.stringContaining("避免重复计费") });
        expect(deps.applyTaskState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "timed_out" }));
        vi.useRealTimers();
    });

    test("does not reset the task deadline when submission starts later", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const deps = startDeps({ submit: vi.fn(() => new Promise<never>(() => {})) });
        vi.setSystemTime(101_000);

        const starting = startRemoteCanvasMediaTask(remoteInput(), deps);
        await vi.advanceTimersByTimeAsync(199_999);
        expect(deps.getTask("local-1")?.status).toBe("submitting");
        await vi.advanceTimersByTimeAsync(1);
        await starting;

        expect(deps.getTask("local-1")).toMatchObject({ status: "timed_out", deadlineAt: 301_000 });
        vi.useRealTimers();
    });

    test("does not accept a submit response that arrives at the wall-clock deadline", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        let resolve!: (value: { taskId: string }) => void;
        const deps = startDeps({ submit: vi.fn(() => new Promise<{ taskId: string }>((done) => { resolve = done; })) });
        const starting = startRemoteCanvasMediaTask(remoteInput(), deps);
        await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());

        vi.setSystemTime(301_000);
        resolve({ taskId: "remote-at-deadline" });
        await starting;

        expect(deps.getTask("local-1")).toMatchObject({ status: "timed_out", remoteTaskId: "remote-at-deadline" });
        expect(deps.wake).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    test("marks an ambiguous transport failure submission unknown instead of retrying", async () => {
        const deps = startDeps({ submit: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) });

        await startRemoteCanvasMediaTask(remoteInput(), deps);

        expect(deps.getTask("local-1")).toMatchObject({ status: "submission_unknown", error: expect.stringContaining("提交结果未知") });
        expect(deps.wake).not.toHaveBeenCalled();
    });

    test("retries an idempotent hiapi submission with the same key after a network failure", async () => {
        vi.useFakeTimers();
        const submitAdapter = vi.fn()
            .mockRejectedValueOnce(new TypeError("Network Error"))
            .mockResolvedValueOnce({ taskId: "remote-hiapi" });
        const deps = startDeps({ submitAdapter });
        const starting = startRemoteCanvasMediaTask(hiapiAdapterInput(), deps);
        await vi.advanceTimersByTimeAsync(3_000);
        await starting;

        expect(submitAdapter).toHaveBeenCalledTimes(2);
        const keys = submitAdapter.mock.calls.map((call) => (call[0] as { idempotencyKey?: string }).idempotencyKey);
        expect(keys[0]).toEqual(expect.any(String));
        expect(keys[1]).toBe(keys[0]);
        expect(deps.getTask("local-1")).toMatchObject({ status: "pending", remoteTaskId: "remote-hiapi", idempotencyKey: keys[0] });
        expect(deps.wake).toHaveBeenCalled();
        vi.useRealTimers();
    });

    test("exhausts idempotent retries into submission unknown with the retryable copy", async () => {
        vi.useFakeTimers();
        const submitAdapter = vi.fn().mockRejectedValue(new TypeError("Network Error"));
        const deps = startDeps({ submitAdapter });
        const starting = startRemoteCanvasMediaTask(hiapiAdapterInput(), deps);
        await vi.advanceTimersByTimeAsync(3_000 + 6_000 + 12_000);
        await starting;

        expect(submitAdapter).toHaveBeenCalledTimes(4);
        const keys = submitAdapter.mock.calls.map((call) => (call[0] as { idempotencyKey?: string }).idempotencyKey);
        expect(new Set(keys).size).toBe(1);
        expect(deps.getTask("local-1")).toMatchObject({ status: "submission_unknown", error: expect.stringContaining("安全重试") });
        expect(deps.wake).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    test("retries an idempotent submission on a transient network error", async () => {
        vi.useFakeTimers();
        const submitAdapter = vi.fn()
            .mockRejectedValueOnce(new TypeError("Network Error"))
            .mockResolvedValueOnce({ taskId: "remote-recovered" });
        const deps = startDeps({ submitAdapter });
        const starting = startRemoteCanvasMediaTask(hiapiAdapterInput(), deps);
        await vi.advanceTimersByTimeAsync(3_000);
        await starting;

        expect(submitAdapter).toHaveBeenCalledTimes(2);
        expect(deps.getTask("local-1")).toMatchObject({ status: "pending", remoteTaskId: "remote-recovered" });
        vi.useRealTimers();
    });

    test("waits out idempotency 409 without consuming the network retry budget", async () => {
        vi.useFakeTimers();
        const pending = Object.assign(new Error("idempotency key still processing"), { idempotencyPending: true as const, retryAfterMs: 1_000 });
        const submitAdapter = vi.fn()
            .mockRejectedValueOnce(pending)
            .mockRejectedValueOnce(new TypeError("Network Error"))
            .mockResolvedValueOnce({ taskId: "remote-409" });
        const deps = startDeps({ submitAdapter });
        const starting = startRemoteCanvasMediaTask(hiapiAdapterInput(), deps);
        await vi.advanceTimersByTimeAsync(1_000 + 3_000);
        await starting;

        expect(submitAdapter).toHaveBeenCalledTimes(3);
        expect(deps.getTask("local-1")).toMatchObject({ status: "pending", remoteTaskId: "remote-409" });
        vi.useRealTimers();
    });

    test("keeps non-idempotent submissions single-shot", async () => {
        vi.useFakeTimers();
        const submit = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
        const deps = startDeps({ submit });
        const starting = startRemoteCanvasMediaTask(remoteInput(), deps);
        await starting;

        expect(submit).toHaveBeenCalledTimes(1);
        expect(deps.getTask("local-1")).toMatchObject({ status: "submission_unknown", error: expect.stringContaining("提交结果未知") });
        vi.useRealTimers();
    });

    test("generates an idempotency key only for adapters that declare idempotentSubmit", async () => {
        const deps = startDeps();
        await startRemoteCanvasMediaTask(adapterInput(), deps);

        expect(deps.getTask("local-1")).not.toHaveProperty("idempotencyKey");
        expect(deps.submitAdapter).not.toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: expect.any(String) }));

        const hiapiDeps = startDeps();
        await startRemoteCanvasMediaTask(hiapiAdapterInput(), hiapiDeps);

        expect(hiapiDeps.getTask("local-1")!.idempotencyKey).toEqual(expect.any(String));
        expect(hiapiDeps.submitAdapter).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: expect.any(String) }));
    });

    test("records image task params without leaking the global video settings", async () => {
        const base = remoteInput();
        const input = { ...base, config: { ...base.config, vquality: "768p横", videoSeconds: "5", videoGenerateAudio: "true", videoWatermark: "true" } };
        const deps = startDeps();

        await startRemoteCanvasMediaTask(input, deps);

        const params = deps.submit.mock.calls[0][0].params;
        expect(params).toEqual({ count: 1, size: input.config.size, quality: input.config.quality });
        const serialized = JSON.stringify(params);
        expect(serialized).not.toContain("768p");
        expect(serialized).not.toContain("generateAudio");
    });

    test("records video task params without leaking the image-only fields", async () => {
        const channel = createModelChannel({ id: "autodl-1", provider: "autodl", apiKey: "test-token" });
        const input = { ...remoteInput(), capability: "video" as const, config: { ...configuredAiConfig(), channels: [channel], model: "autodl-1::minimax_h3_lightx2v_no_pic", background: "opaque", vquality: "768p横", videoSeconds: "5" }, preparedMedia: { images: [] } };
        const deps = startDeps();

        await startRemoteCanvasMediaTask(input, deps);

        const params = deps.submitAdapter.mock.calls[0][0].params;
        expect(params).toMatchObject({ resolution: "768p横", seconds: "5", generateAudio: true, watermark: false });
        expect(params).not.toHaveProperty("background");
        expect(params).not.toHaveProperty("quality");
    });
});

describe("remote canvas media task stop transaction", () => {
    function prepareRealTarget() {
        useRemoteMediaTaskStore.getState().resetForTests();
        useProjectStore.setState({ projects: [{
            id: "project-1", title: "Project", category: "uncategorized", icon: "box", color: "#000", createdAt: "now", updatedAt: "now",
            canvases: [canvasFixture([{ id: "node-1", type: CanvasNodeType.Image, title: "Image", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { status: "loading", images: [canvasImage()] } }])],
        }] });
    }

    function realStartDeps(overrides: Record<string, unknown> = {}) {
        return {
            createTask: (input: CreateRemoteTaskInput) => useRemoteMediaTaskStore.getState().createTask(input),
            patchTask: (id: string, patch: RemoteMediaTaskPatch) => useRemoteMediaTaskStore.getState().patchTask(id, patch),
            getTask: (id: string) => useRemoteMediaTaskStore.getState().tasks.find((task) => task.id === id),
            flush: () => useRemoteMediaTaskStore.getState().flush(),
            applyTaskState: (task: RemoteMediaTask, context?: { signal: AbortSignal; isActive: () => boolean }) => import("@/lib/canvas/remote-media-task-result").then(({ applyRemoteTaskStateToProject }) => applyRemoteTaskStateToProject(task, context)),
            submit: vi.fn().mockResolvedValue({ taskId: "remote-1" }),
            wake: vi.fn(),
            isTaskActive: (id: string) => ["submitting", "pending", "waiting_network", "waiting_configuration"].includes(useRemoteMediaTaskStore.getState().tasks.find((task) => task.id === id)?.status || ""),
            ...overrides,
        };
    }

    test("captures only currently active IDs and durably applies interruption to the real project store", async () => {
        useRemoteMediaTaskStore.getState().resetForTests();
        const target = remoteInput().target;
        const active = useRemoteMediaTaskStore.getState().createTask({ capability: "image", target, channelId: "channel-1", modelName: "image-model", baseUrlSnapshot: "https://example.test", queryScriptSnapshot: "return {}", timeoutMinutes: 5 });
        const historical = useRemoteMediaTaskStore.getState().createTask({ capability: "image", target: { ...target, itemId: "old-item" }, channelId: "channel-1", modelName: "image-model", baseUrlSnapshot: "https://example.test", queryScriptSnapshot: "return {}", timeoutMinutes: 5 });
        useRemoteMediaTaskStore.getState().patchTask(active.id, { status: "pending", remoteTaskId: "remote-1" });
        useRemoteMediaTaskStore.getState().patchTask(historical.id, { status: "interrupted", remoteTaskId: "remote-old" });
        useProjectStore.setState({ projects: [{
            id: "project-1", title: "Project", category: "uncategorized", icon: "box", color: "#000", createdAt: "now", updatedAt: "now",
            canvases: [canvasFixture([{ id: "node-1", type: CanvasNodeType.Image, title: "Image", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { status: "loading", images: [
                canvasImage({ remoteTask: { id: active.id, status: "pending", submittedAt: active.submittedAt } }),
                canvasImage({ id: "old-item", remoteTask: { id: historical.id, status: "pending", submittedAt: historical.submittedAt } }),
            ] } }])],
        }] });

        const stopped = await interruptRemoteTasksForTarget("project-1", "canvas-1", "node-1");

        expect(stopped.map((task) => task.id)).toEqual([active.id]);
        const images = useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.images;
        expect(images?.find((image) => image.id === "item-1")?.status).toBe("error");
        expect(images?.find((image) => image.id === "old-item")?.status).toBe("loading");
    });

    test.each(["initial-apply", "initial-flush", "submit", "remote-id-apply", "remote-id-flush"] as const)("stop during %s aborts or invalidates the late submission stage", async (stage) => {
        prepareRealTarget();
        let release!: () => void;
        let providerSignal: AbortSignal | undefined;
        let applyCalls = 0;
        let flushCalls = 0;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const deps = realStartDeps({
            applyTaskState: async (task: RemoteMediaTask, context?: { signal: AbortSignal; isActive: () => boolean }) => {
                applyCalls += 1;
                if ((stage === "initial-apply" && applyCalls === 1) || (stage === "remote-id-apply" && applyCalls === 2)) {
                    await Promise.race([gate, new Promise<void>((resolve) => context?.signal.addEventListener("abort", () => resolve(), { once: true }))]);
                    if (context?.signal.aborted || !context?.isActive()) return { applied: false, reason: "inactive" as const };
                }
                const { applyRemoteTaskStateToProject } = await import("@/lib/canvas/remote-media-task-result");
                return applyRemoteTaskStateToProject(task, context);
            },
            flush: async () => {
                flushCalls += 1;
                if ((stage === "initial-flush" && flushCalls === 1) || (stage === "remote-id-flush" && flushCalls === 2)) await gate;
                return useRemoteMediaTaskStore.getState().flush();
            },
            submit: vi.fn(async (input: { signal?: AbortSignal }) => {
                providerSignal = input.signal;
                if (stage === "submit") await new Promise<void>((resolve) => input.signal?.addEventListener("abort", () => resolve(), { once: true }));
                return { taskId: "remote-1" };
            }),
        });
        const starting = startRemoteCanvasMediaTask(remoteInput(), deps);
        await vi.waitFor(() => {
            const task = useRemoteMediaTaskStore.getState().tasks[0];
            expect(task).toBeTruthy();
            if (stage === "initial-apply") expect(applyCalls).toBe(1);
            if (stage === "initial-flush") expect(flushCalls).toBe(1);
            if (stage === "submit") expect(deps.submit).toHaveBeenCalled();
            if (stage === "remote-id-apply") expect(applyCalls).toBe(2);
            if (stage === "remote-id-flush") expect(flushCalls).toBe(2);
        });

        await interruptRemoteTasksForTarget("project-1", "canvas-1", "node-1");
        release();
        await starting;

        expect(useRemoteMediaTaskStore.getState().tasks[0].status).toBe("interrupted");
        expect(deps.wake).not.toHaveBeenCalled();
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.images?.[0].status).toBe("error");
        if (stage === "submit") expect(providerSignal?.aborted).toBe(true);
    });

    test("closes a real-store initial flush rejection as a durable failed task and target", async () => {
        prepareRealTarget();
        let calls = 0;
        const deps = realStartDeps({
            flush: async () => {
                calls += 1;
                if (calls === 1) throw new Error("indexeddb unavailable");
                await useRemoteMediaTaskStore.getState().flush();
            },
        });

        await startRemoteCanvasMediaTask(remoteInput(), deps);

        expect(useRemoteMediaTaskStore.getState().tasks[0]).toMatchObject({ status: "failed", error: expect.stringContaining("indexeddb unavailable") });
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.images?.[0]).toMatchObject({ status: "error", errorDetails: expect.stringContaining("indexeddb unavailable") });
        expect(deps.submit).not.toHaveBeenCalled();
    });

    test("treats a real missing-target transaction as interruption before provider submission", async () => {
        prepareRealTarget();
        useProjectStore.setState({ projects: useProjectStore.getState().projects.map((project) => ({ ...project, canvases: project.canvases.map((canvas) => ({ ...canvas, nodes: [] })) })) });
        const deps = realStartDeps();

        await startRemoteCanvasMediaTask(remoteInput(), deps);

        expect(useRemoteMediaTaskStore.getState().tasks[0].status).toBe("interrupted");
        expect(deps.submit).not.toHaveBeenCalled();
    });

    test("keeps an active task and loading target stoppable when stop flush rejects", async () => {
        prepareRealTarget();
        const task = useRemoteMediaTaskStore.getState().createTask({ capability: "image", target: remoteInput().target, channelId: "channel-1", modelName: "image-model", baseUrlSnapshot: "https://example.test", queryScriptSnapshot: "return {}", timeoutMinutes: 5 });
        useRemoteMediaTaskStore.getState().patchTask(task.id, { status: "pending", remoteTaskId: "remote-1" });
        const originalTransition = useRemoteMediaTaskStore.getState().persistTaskPatches;
        useRemoteMediaTaskStore.setState({ persistTaskPatches: vi.fn(async (): Promise<RemoteMediaTask[]> => { throw new Error("task storage unavailable"); }) });

        await expect(interruptRemoteTasksForTarget("project-1", "canvas-1", "node-1")).rejects.toThrow("task storage unavailable");

        expect(useRemoteMediaTaskStore.getState().tasks[0]).toMatchObject({ status: "pending", error: expect.stringContaining("task storage unavailable") });
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.images?.[0].status).toBe("loading");
        useRemoteMediaTaskStore.setState({ persistTaskPatches: originalTransition });
    });

    test("keeps the stop control active while the interruption snapshot is still flushing", async () => {
        prepareRealTarget();
        const task = useRemoteMediaTaskStore.getState().createTask({ capability: "image", target: remoteInput().target, channelId: "channel-1", modelName: "image-model", baseUrlSnapshot: "https://example.test", queryScriptSnapshot: "return {}", timeoutMinutes: 5 });
        useRemoteMediaTaskStore.getState().patchTask(task.id, { status: "pending", remoteTaskId: "remote-1" });
        let finish!: () => void;
        const original = useRemoteMediaTaskStore.getState().persistTaskPatches;
        useRemoteMediaTaskStore.setState({ persistTaskPatches: vi.fn(() => new Promise<RemoteMediaTask[]>((resolve) => { finish = () => resolve([]); })) });

        const stopping = interruptRemoteTasksForTarget("project-1", "canvas-1", "node-1");
        await vi.waitFor(() => expect(useRemoteMediaTaskStore.getState().persistTaskPatches).toHaveBeenCalled());
        expect(useRemoteMediaTaskStore.getState().tasks[0].status).toBe("pending");

        finish();
        await stopping;
        useRemoteMediaTaskStore.setState({ persistTaskPatches: original });
    });

    test("restores an active stoppable task when the stop target transaction rejects", async () => {
        prepareRealTarget();
        const task = useRemoteMediaTaskStore.getState().createTask({ capability: "image", target: remoteInput().target, channelId: "channel-1", modelName: "image-model", baseUrlSnapshot: "https://example.test", queryScriptSnapshot: "return {}", timeoutMinutes: 5 });
        useRemoteMediaTaskStore.getState().patchTask(task.id, { status: "pending", remoteTaskId: "remote-1" });
        const transactCanvasNodes = useProjectStore.getState().transactCanvasNodes;
        useProjectStore.setState({ transactCanvasNodes: vi.fn().mockRejectedValue(new Error("project storage unavailable")) });

        await expect(interruptRemoteTasksForTarget("project-1", "canvas-1", "node-1")).rejects.toThrow("project storage unavailable");

        expect(useRemoteMediaTaskStore.getState().tasks[0]).toMatchObject({ status: "pending", error: expect.stringContaining("project storage unavailable") });
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.images?.[0].status).toBe("loading");
        useProjectStore.setState({ transactCanvasNodes });
    });

    function prepareTwoActiveItems() {
        useRemoteMediaTaskStore.getState().resetForTests();
        const baseTarget = remoteInput().target;
        const tasks = ["item-1", "item-2"].map((itemId) => {
            const task = useRemoteMediaTaskStore.getState().createTask({ capability: "image", target: { ...baseTarget, itemId }, channelId: "channel-1", modelName: "image-model", baseUrlSnapshot: "https://example.test", queryScriptSnapshot: "return {}", timeoutMinutes: 5 });
            useRemoteMediaTaskStore.getState().patchTask(task.id, { status: "pending", remoteTaskId: `remote-${itemId}` });
            return useRemoteMediaTaskStore.getState().tasks.find((item) => item.id === task.id)!;
        });
        useProjectStore.setState({ projects: [{
            id: "project-1", title: "Project", category: "uncategorized", icon: "box", color: "#000", createdAt: "now", updatedAt: "now",
            canvases: [canvasFixture([{ id: "node-1", type: CanvasNodeType.Image, title: "Image", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { status: "loading", images: tasks.map((task) => canvasImage({ id: task.target.itemId!, remoteTask: { id: task.id, status: task.status, submittedAt: task.submittedAt } })) } }])],
        }] });
        return tasks;
    }

    test("does not partially update either batch item when durable task interruption fails", async () => {
        prepareTwoActiveItems();
        const originalTransition = useRemoteMediaTaskStore.getState().persistTaskPatches;
        const transactCanvasNodes = useProjectStore.getState().transactCanvasNodes;
        const transactSpy = vi.fn(transactCanvasNodes);
        useRemoteMediaTaskStore.setState({ persistTaskPatches: vi.fn(async (): Promise<RemoteMediaTask[]> => { throw new Error("second task path failed"); }) });
        useProjectStore.setState({ transactCanvasNodes: transactSpy });

        await expect(interruptRemoteTasksForTarget("project-1", "canvas-1", "node-1")).rejects.toThrow("second task path failed");

        expect(transactSpy).not.toHaveBeenCalled();
        expect(useRemoteMediaTaskStore.getState().tasks.map((task) => task.status)).toEqual(["pending", "pending"]);
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.images?.map((image) => image.status)).toEqual(["loading", "loading"]);
        useRemoteMediaTaskStore.setState({ persistTaskPatches: originalTransition });
        useProjectStore.setState({ transactCanvasNodes });
    });

    test("stops two image items with one atomic project transaction", async () => {
        prepareTwoActiveItems();
        const transactCanvasNodes = useProjectStore.getState().transactCanvasNodes;
        const transactSpy = vi.fn(transactCanvasNodes);
        useProjectStore.setState({ transactCanvasNodes: transactSpy });

        await interruptRemoteTasksForTarget("project-1", "canvas-1", "node-1");

        expect(transactSpy).toHaveBeenCalledOnce();
        expect(useRemoteMediaTaskStore.getState().tasks.map((task) => task.status)).toEqual(["interrupted", "interrupted"]);
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.images?.map((image) => image.status)).toEqual(["error", "error"]);
        useProjectStore.setState({ transactCanvasNodes });
    });

    test("uses one project transaction and restores every task when an atomic batch stop rejects", async () => {
        prepareTwoActiveItems();
        const persistTaskPatches = useRemoteMediaTaskStore.getState().persistTaskPatches;
        const persistSpy = vi.fn(persistTaskPatches);
        useRemoteMediaTaskStore.setState({ persistTaskPatches: persistSpy });
        const transactCanvasNodes = useProjectStore.getState().transactCanvasNodes;
        const transactSpy = vi.fn().mockRejectedValue(new Error("project transaction failed"));
        useProjectStore.setState({ transactCanvasNodes: transactSpy });

        await expect(interruptRemoteTasksForTarget("project-1", "canvas-1", "node-1")).rejects.toThrow("project transaction failed");

        expect(transactSpy).toHaveBeenCalledOnce();
        expect(persistSpy).toHaveBeenCalledTimes(2);
        expect(persistSpy.mock.calls[1][0]).toHaveLength(2);
        expect(persistSpy.mock.calls[1][0].map(({ patch }) => patch.status)).toEqual(["pending", "pending"]);
        expect(useRemoteMediaTaskStore.getState().tasks.map((task) => task.status)).toEqual(["pending", "pending"]);
        expect(useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.images?.map((image) => image.status)).toEqual(["loading", "loading"]);
        useRemoteMediaTaskStore.setState({ persistTaskPatches });
        useProjectStore.setState({ transactCanvasNodes });
    });

    test("re-wakes a pending query after a failed stop transaction rolls it back active", async () => {
        prepareRealTarget();
        const task = useRemoteMediaTaskStore.getState().createTask({ capability: "image", target: remoteInput().target, channelId: "channel-1", modelName: "image-model", baseUrlSnapshot: "https://example.test", queryScriptSnapshot: "return {}", timeoutMinutes: 5 });
        useRemoteMediaTaskStore.getState().patchTask(task.id, { status: "pending", remoteTaskId: "remote-1" });
        const current = useProjectStore.getState().projects[0];
        current.canvases[0].nodes[0].metadata!.images![0].remoteTask = { id: task.id, status: "pending", submittedAt: task.submittedAt };
        const transactCanvasNodes = useProjectStore.getState().transactCanvasNodes;
        useProjectStore.setState({ transactCanvasNodes: vi.fn().mockRejectedValue(new Error("project transaction failed")) });
        const runner = { start: vi.fn(), retryResult: vi.fn(), retrySubmission: async () => {}, wake: vi.fn(), abort: vi.fn(), stop: vi.fn(), stopByTarget: vi.fn(), dispose: vi.fn() };
        const release = registerRemoteMediaTaskRunner(runner);

        await expect(interruptRemoteTasksForTarget("project-1", "canvas-1", "node-1")).rejects.toThrow("project transaction failed");

        expect(useRemoteMediaTaskStore.getState().tasks[0].status).toBe("pending");
        expect(runner.abort).toHaveBeenCalledWith(task.id);
        expect(runner.wake).toHaveBeenCalledWith(task.id);
        release();
        useProjectStore.setState({ transactCanvasNodes });
    });

    test("does not resubmit after a failed stop transaction aborts provider submission", async () => {
        prepareRealTarget();
        const deps = realStartDeps({ submit: vi.fn(() => new Promise<never>(() => {})) });
        const starting = startRemoteCanvasMediaTask(remoteInput(), deps);
        await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
        const transactCanvasNodes = useProjectStore.getState().transactCanvasNodes;
        useProjectStore.setState({ transactCanvasNodes: vi.fn().mockRejectedValue(new Error("project transaction failed")) });
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

        await expect(interruptRemoteTasksForTarget("project-1", "canvas-1", "node-1")).rejects.toThrow("project transaction failed");
        await starting;

        expect(useRemoteMediaTaskStore.getState().tasks[0]).toMatchObject({ status: "submission_unknown", error: expect.stringContaining("避免重复计费") });
        expect(useRemoteMediaTaskStore.getState().activeCount()).toBe(0);
        expect(deps.submit).toHaveBeenCalledOnce();
        expect(deps.wake).not.toHaveBeenCalled();
        consoleError.mockRestore();
        useProjectStore.setState({ transactCanvasNodes });
    });
});

describe("remote media task runner", () => {
    let releaseRegisteredRunner: (() => void) | undefined;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
    });

    afterEach(() => {
        releaseRegisteredRunner?.();
        releaseRegisteredRunner = undefined;
        vi.useRealTimers();
    });

    test("recovers fal network failures using the existing runner and original queue identity", async () => {
        const fetcher = vi.fn<typeof fetch>()
            .mockRejectedValueOnce(new TypeError("Failed to fetch fixture-key"))
            .mockResolvedValueOnce(Response.json({ status: "COMPLETED" }))
            .mockResolvedValueOnce(Response.json({ images: [{ url: "https://cdn.example/out.png" }] }));
        vi.stubGlobal("fetch", fetcher);
        const config = configuredAiConfig("fixture-key");
        config.model = "a-new-node-model";
        const { deps, task } = fakeDeps({ config, task: adapterTask({ adapterId: "fal.image", modelName: "fal-ai/flux-2-pro", baseUrlSnapshot: "https://original.example/queue" }) });
        const runner = createRemoteMediaTaskRunner(deps);
        try {
            await runner.start();
            expect(task().status).toBe("waiting_network");
            expect(JSON.stringify(task())).not.toContain("fixture-key");
            expect(fetcher).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(15_000);
            expect(task().status).toBe("succeeded");
            expect(fetcher).toHaveBeenCalledTimes(3);
            expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
                "https://original.example/queue/fal-ai/flux-2-pro/requests/remote-1/status?logs=0",
                "https://original.example/queue/fal-ai/flux-2-pro/requests/remote-1/status?logs=0",
                "https://original.example/queue/fal-ai/flux-2-pro/requests/remote-1",
            ]);
            expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
        } finally { runner.dispose(); vi.unstubAllGlobals(); }
    });
    test("queries recovered tasks immediately then every 15 seconds", async () => {
        const query = vi.fn().mockResolvedValueOnce({ status: "pending" }).mockResolvedValueOnce({ status: "succeeded", result: "data:image/png;base64,OK" });
        const deliver = vi.fn().mockResolvedValue({ applied: true });
        const { deps, task } = fakeDeps({ query, deliver });
        const runner = createRemoteMediaTaskRunner(deps);

        await runner.start();
        expect(query).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(15_000);

        expect(query).toHaveBeenCalledTimes(2);
        expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ id: "local-1" }), "data:image/png;base64,OK", expect.objectContaining({ signal: expect.any(AbortSignal), isActive: expect.any(Function) }));
        expect(task().status).toBe("succeeded");
    });

    test("restores a legacy task through its saved query script", async () => {
        const queryLegacy = vi.fn().mockResolvedValue({ status: "pending" });
        const { deps } = fakeDeps();
        deps.queryLegacy = queryLegacy;

        await createRemoteMediaTaskRunner(deps).start();

        expect(queryLegacy).toHaveBeenCalledWith(expect.objectContaining({ taskId: "remote-1", queryScript: "return { status: 'pending' }" }));
    });

    test("does not query with a mismatched adapter version", async () => {
        const queryAdapter = vi.fn().mockResolvedValue({ status: "pending" });
        const { deps, task } = fakeDeps({ task: adapterTask({ adapterVersion: 99 }), queryAdapter });
        deps.getConfig = vi.fn(() => configuredAiConfig("secret-key"));

        await createRemoteMediaTaskRunner(deps).start();

        expect(task()).toMatchObject({ status: "waiting_configuration", error: expect.stringContaining("adapter version") });
        expect(queryAdapter).not.toHaveBeenCalled();
        expect(deps.getConfig).not.toHaveBeenCalled();
        expect(JSON.stringify(task())).not.toContain("secret-key");
    });

    test("does not query when the persisted adapter is no longer registered", async () => {
        const queryAdapter = vi.fn().mockResolvedValue({ status: "pending" });
        const { deps, task } = fakeDeps({ task: adapterTask({ adapterId: "missing.video" }), queryAdapter });
        deps.getConfig = vi.fn(() => configuredAiConfig("secret-key"));

        await createRemoteMediaTaskRunner(deps).start();

        expect(task()).toMatchObject({ status: "waiting_configuration", error: expect.stringContaining("missing.video") });
        expect(queryAdapter).not.toHaveBeenCalled();
        expect(deps.getConfig).not.toHaveBeenCalled();
        expect(JSON.stringify(task())).not.toContain("secret-key");
    });

    test("delivers an adapter image result through the existing raw-media delivery contract", async () => {
        const deliver = vi.fn().mockResolvedValue({ applied: true });
        const { deps, task } = fakeDeps({
            task: adapterTask({ capability: "image", adapterId: "zhipu.image" }),
            queryAdapter: vi.fn().mockResolvedValue({ status: "succeeded", result: { kind: "image", sources: ["https://cdn.example/output.png"] } }),
            deliver,
        });

        await createRemoteMediaTaskRunner(deps).start();

        expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ id: "local-1" }), ["https://cdn.example/output.png"], expect.any(Object));
        expect(task().status).toBe("succeeded");
    });

    test("durably mirrors provider phase and progress into real project metadata", async () => {
        useRemoteMediaTaskStore.getState().resetForTests();
        const created = useRemoteMediaTaskStore.getState().createTask({ capability: "image", target: remoteInput().target, channelId: "channel-1", modelName: "image-model", baseUrlSnapshot: "https://snapshot.example", queryScriptSnapshot: "return {}", now: 1_000 });
        useRemoteMediaTaskStore.getState().patchTask(created.id, { status: "pending", remoteTaskId: "remote-1", phase: "queued", progress: 0 });
        useProjectStore.setState({ projects: [{
            id: "project-1", title: "Project", category: "uncategorized", icon: "box", color: "#000", createdAt: "now", updatedAt: "now",
            canvases: [canvasFixture([{ id: "node-1", type: CanvasNodeType.Image, title: "Image", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { status: "loading", images: [canvasImage({ remoteTask: { id: created.id, status: "pending", phase: "queued", progress: 0, submittedAt: 1_000 } })] } }])],
        }] });
        const runner = createRemoteMediaTaskRunner({
            getTasks: () => useRemoteMediaTaskStore.getState().tasks,
            patchTask: (id, patch) => useRemoteMediaTaskStore.getState().patchTask(id, patch),
            persistTaskPatch: async (id, patch) => (await useRemoteMediaTaskStore.getState().persistTaskPatches([{ id, patch }]))[0],
            flush: () => useRemoteMediaTaskStore.getState().flush(),
            applyTaskState: applyRemoteTaskStateToProject,
            getEmbeddedTaskStatus: getEmbeddedRemoteTaskStatus,
            getConfig: configuredAiConfig,
            queryLegacy: vi.fn().mockResolvedValue({ status: "pending", phase: "running", progress: 42 }),
            deliver: vi.fn(),
            now: () => Date.now(),
        });

        await runner.start();

        const metadata = useProjectStore.getState().projects[0].canvases[0].nodes[0].metadata?.images?.[0].remoteTask;
        expect(useRemoteMediaTaskStore.getState().tasks[0]).toMatchObject({ status: "pending", phase: "running", progress: 42 });
        expect(metadata).toMatchObject({ status: "pending", phase: "running", progress: 42 });
        runner.dispose();
    });

    test("does not rewrite the target when repeated provider state is unchanged", async () => {
        const query = vi.fn().mockResolvedValue({ status: "pending", phase: "running", progress: 42 });
        const { deps } = fakeDeps({ query });
        await createRemoteMediaTaskRunner(deps).start();
        await vi.advanceTimersByTimeAsync(15_000);

        expect(deps.applyTaskState).toHaveBeenCalledOnce();
    });

    test("takes the single-flight lock before a deferred intermediate sync", async () => {
        let release!: (value: RemoteTaskDeliveryOutcome) => void;
        const applyTaskState = vi.fn(() => new Promise<RemoteTaskDeliveryOutcome>((resolve) => { release = resolve; }));
        const query = vi.fn().mockResolvedValue({ status: "pending" });
        const { deps } = fakeDeps({ query });
        deps.applyTaskState = applyTaskState;
        deps.getEmbeddedTaskStatus = () => "pending";
        const runner = createRemoteMediaTaskRunner(deps);

        const starting = runner.start();
        await vi.waitFor(() => expect(applyTaskState).toHaveBeenCalledOnce());
        runner.wake("local-1");
        expect(applyTaskState).toHaveBeenCalledOnce();
        expect(query).not.toHaveBeenCalled();

        release({ applied: true });
        await starting;
        expect(query).toHaveBeenCalledOnce();
    });

    test("retries a durable pending transition before the next provider query", async () => {
        const query = vi.fn().mockResolvedValue({ status: "pending", phase: "running", progress: 37 });
        const applyTaskState = vi.fn().mockRejectedValueOnce(new Error("project storage unavailable")).mockResolvedValue({ applied: true });
        const { deps, task } = fakeDeps({ query });
        deps.applyTaskState = applyTaskState;
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const runner = createRemoteMediaTaskRunner(deps);

        await runner.start();
        expect(query).toHaveBeenCalledOnce();
        expect(task()).toMatchObject({ status: "pending", phase: "running", progress: 37 });

        await vi.advanceTimersByTimeAsync(15_000);
        expect(applyTaskState).toHaveBeenCalledTimes(2);
        expect(query).toHaveBeenCalledTimes(2);
        consoleError.mockRestore();
    });

    test("backs off repeated intermediate sync failures without querying the provider again", async () => {
        const query = vi.fn().mockResolvedValue({ status: "pending", phase: "running", progress: 37 });
        const applyTaskState = vi.fn().mockRejectedValue(new Error("project storage unavailable"));
        const { deps } = fakeDeps({ query });
        deps.applyTaskState = applyTaskState;
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const runner = createRemoteMediaTaskRunner(deps);

        await runner.start();
        await vi.advanceTimersByTimeAsync(3_000);
        await vi.advanceTimersByTimeAsync(6_000);

        expect(applyTaskState).toHaveBeenCalledTimes(3);
        expect(query).toHaveBeenCalledOnce();
        consoleError.mockRestore();
    });

    test("marks stale submitting records submission unknown without querying", async () => {
        const query = vi.fn();
        const { deps, task } = fakeDeps({ query, task: completeTask({ status: "submitting", remoteTaskId: undefined }) });

        await createRemoteMediaTaskRunner(deps).start();

        expect(task().status).toBe("submission_unknown");
        expect(query).not.toHaveBeenCalled();
    });

    test("restores only recoverable states", async () => {
        const terminal = ["succeeded", "failed", "timed_out", "interrupted", "submission_unknown"] as const;
        const tasks = [completeTask(), ...terminal.map((status, index) => completeTask({ id: `terminal-${index}`, status }))];
        const query = vi.fn().mockResolvedValue({ status: "pending" });
        const { deps } = fakeDeps({ tasks, query });

        await createRemoteMediaTaskRunner(deps).start();

        expect(query).toHaveBeenCalledOnce();
        expect(query).toHaveBeenCalledWith(expect.objectContaining({ taskId: "remote-1" }));
    });

    test("marks an expired recovered task timed out before querying", async () => {
        vi.setSystemTime(301_000);
        const query = vi.fn();
        const { deps, task } = fakeDeps({ query });

        await createRemoteMediaTaskRunner(deps).start();

        expect(task().status).toBe("timed_out");
        expect(query).not.toHaveBeenCalled();
    });

    test("keeps polling a task parked in downloading until the deadline times it out", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const query = vi.fn().mockResolvedValue({ status: "pending", phase: "downloading" });
        const { deps, task } = fakeDeps({ query });

        await createRemoteMediaTaskRunner(deps).start();
        await vi.advanceTimersByTimeAsync(45_000);
        expect(query.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(task().status).toBe("pending");

        vi.setSystemTime(301_000);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(task().status).toBe("timed_out");
        vi.useRealTimers();
    });

    test("does not deliver a query response that arrives at the wall-clock deadline", async () => {
        let resolve!: (value: { status: "succeeded"; result: string }) => void;
        const query = vi.fn(() => new Promise<{ status: "succeeded"; result: string }>((done) => { resolve = done; }));
        const deliver = vi.fn().mockResolvedValue({ applied: true });
        const { deps, task } = fakeDeps({ query, deliver, task: completeTask({ deadlineAt: 2_000 }) });
        const starting = createRemoteMediaTaskRunner(deps).start();

        await vi.advanceTimersByTimeAsync(1_000);
        resolve({ status: "succeeded", result: "out" });
        await starting;

        expect(task().status).toBe("timed_out");
        expect(deliver).not.toHaveBeenCalled();
    });

    test("aborts a permanently hanging query exactly at the deadline", async () => {
        let signal!: AbortSignal;
        const query = vi.fn((input) => {
            signal = input.signal as AbortSignal;
            return new Promise<never>(() => {});
        });
        const { deps, task } = fakeDeps({ query, task: completeTask({ deadlineAt: 2_000 }) });
        const starting = createRemoteMediaTaskRunner(deps).start();

        await vi.advanceTimersByTimeAsync(1_000);
        await starting;

        expect(task().status).toBe("timed_out");
        expect(signal.aborted).toBe(true);
    });

    test("stop aborts an in-flight query even when the dependency ignores abort", async () => {
        let signal!: AbortSignal;
        const query = vi.fn((input) => {
            signal = input.signal as AbortSignal;
            return new Promise<never>(() => {});
        });
        const { deps, task } = fakeDeps({ query });
        const runner = createRemoteMediaTaskRunner(deps);
        const starting = runner.start();
        await vi.advanceTimersByTimeAsync(0);

        runner.stop("local-1");
        await starting;

        expect(task().status).toBe("interrupted");
        expect(signal.aborted).toBe(true);
    });

    test("a rolled-back active task can resume its request and poll timer after abort", async () => {
        const query = vi.fn()
            .mockImplementationOnce(() => new Promise<never>(() => {}))
            .mockResolvedValue({ status: "pending" });
        const { deps } = fakeDeps({ query });
        const runner = createRemoteMediaTaskRunner(deps);
        const starting = runner.start();
        await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());

        runner.abort("local-1");
        deps.patchTask("local-1", { status: "pending" });
        runner.wake("local-1");
        await vi.advanceTimersByTimeAsync(0);
        await starting;
        expect(query).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(15_000);
        expect(query).toHaveBeenCalledTimes(3);
    });

    test("stopByTarget cleans a hanging query after the store already marked it interrupted", async () => {
        let signal!: AbortSignal;
        const query = vi.fn((input) => {
            signal = input.signal as AbortSignal;
            return new Promise<never>(() => {});
        });
        const { deps } = fakeDeps({ query });
        const runner = createRemoteMediaTaskRunner(deps);
        const starting = runner.start();
        await vi.advanceTimersByTimeAsync(0);

        deps.patchTask("local-1", { status: "interrupted" });
        runner.stopByTarget("project-1", "canvas-1", "node-1");

        expect(signal.aborted).toBe(true);
        await starting;
        expect(vi.getTimerCount()).toBe(0);
    });

    test("deadline aborts delivery and invalidates its final-write guard", async () => {
        let context!: Parameters<RemoteMediaTaskRunnerDeps["deliver"]>[2];
        const deliver = vi.fn((_task, _result, nextContext) => {
            context = nextContext;
            return new Promise<RemoteTaskDeliveryOutcome>(() => {});
        });
        const { deps, task } = fakeDeps({ query: vi.fn().mockResolvedValue({ status: "succeeded", result: "out" }), deliver, task: completeTask({ deadlineAt: 2_000 }) });
        const starting = createRemoteMediaTaskRunner(deps).start();
        await vi.advanceTimersByTimeAsync(0);
        expect(context.isActive()).toBe(true);

        await vi.advanceTimersByTimeAsync(1_000);
        await starting;

        expect(task().status).toBe("timed_out");
        expect(context.signal.aborted).toBe(true);
        expect(context.isActive()).toBe(false);
    });

    test("clears the deadline watchdog after delivery succeeds", async () => {
        const { deps, task } = fakeDeps({
            task: completeTask({ deadlineAt: 2_000 }),
            query: vi.fn().mockResolvedValue({ status: "succeeded", result: "out" }),
            deliver: vi.fn().mockResolvedValue({ applied: true }),
        });

        await createRemoteMediaTaskRunner(deps).start();
        expect(task().status).toBe("succeeded");
        await vi.advanceTimersByTimeAsync(1_000);

        expect(task().status).toBe("succeeded");
    });

    test("stop aborts delivery and prevents a late applied result from changing interruption", async () => {
        let context!: Parameters<RemoteMediaTaskRunnerDeps["deliver"]>[2];
        let finishDelivery!: (value: RemoteTaskDeliveryOutcome) => void;
        const deliver = vi.fn((_task, _result, nextContext) => {
            context = nextContext;
            return new Promise<RemoteTaskDeliveryOutcome>((resolve) => { finishDelivery = resolve; });
        });
        const { deps, task } = fakeDeps({ query: vi.fn().mockResolvedValue({ status: "succeeded", result: "out" }), deliver });
        const runner = createRemoteMediaTaskRunner(deps);
        const starting = runner.start();
        await vi.advanceTimersByTimeAsync(0);

        runner.stop("local-1");
        await starting;
        finishDelivery({ applied: true });
        await Promise.resolve();

        expect(task().status).toBe("interrupted");
        expect(context.signal.aborted).toBe(true);
        expect(context.isActive()).toBe(false);
    });

    test("records and reports a delivery error that arrives after stop wins the abort race", async () => {
        let rejectDelivery!: (error: Error) => void;
        const lateError = vi.fn();
        const deliver = vi.fn(() => new Promise<RemoteTaskDeliveryOutcome>((_resolve, reject) => { rejectDelivery = reject; }));
        const { deps, task } = fakeDeps({ query: vi.fn().mockResolvedValue({ status: "succeeded", result: "out" }), deliver, reportLateDeliveryError: lateError });
        const runner = createRemoteMediaTaskRunner(deps);
        const starting = runner.start();
        await vi.advanceTimersByTimeAsync(0);
        runner.stop("local-1");
        await starting;

        rejectDelivery(new Error("stop rollback failed; cleanup failed"));
        await Promise.resolve();

        expect(task()).toMatchObject({ status: "interrupted", error: "stop rollback failed; cleanup failed" });
        expect(lateError).toHaveBeenCalledWith(expect.objectContaining({ id: "local-1" }), "stop rollback failed; cleanup failed");
    });

    test("ignores the normal delivery AbortError that arrives after stop", async () => {
        let context!: Parameters<RemoteMediaTaskRunnerDeps["deliver"]>[2];
        let rejectDelivery!: (error: unknown) => void;
        const lateError = vi.fn();
        const deliver = vi.fn((_task, _result, nextContext) => {
            context = nextContext;
            return new Promise<RemoteTaskDeliveryOutcome>((_resolve, reject) => { rejectDelivery = reject; });
        });
        const { deps, task } = fakeDeps({ query: vi.fn().mockResolvedValue({ status: "succeeded", result: "out" }), deliver, reportLateDeliveryError: lateError });
        const runner = createRemoteMediaTaskRunner(deps);
        const starting = runner.start();
        await vi.advanceTimersByTimeAsync(0);
        runner.stop("local-1");
        await starting;

        rejectDelivery(new DOMException("downstream aborted", "AbortError"));
        await Promise.resolve();

        expect(task()).toMatchObject({ status: "interrupted", error: undefined });
        expect(lateError).not.toHaveBeenCalled();
    });

    test("stopByTarget cleans a hanging delivery after the store already marked it interrupted", async () => {
        let context!: Parameters<RemoteMediaTaskRunnerDeps["deliver"]>[2];
        const deliver = vi.fn((_task, _result, nextContext) => {
            context = nextContext;
            return new Promise<RemoteTaskDeliveryOutcome>(() => {});
        });
        const { deps } = fakeDeps({ query: vi.fn().mockResolvedValue({ status: "succeeded", result: "out" }), deliver });
        const runner = createRemoteMediaTaskRunner(deps);
        const starting = runner.start();
        await vi.advanceTimersByTimeAsync(0);

        deps.patchTask("local-1", { status: "interrupted" });
        runner.stopByTarget("project-1", "canvas-1", "node-1");

        expect(context.signal.aborted).toBe(true);
        await starting;
        expect(vi.getTimerCount()).toBe(0);
    });

    test("uses approved network backoff and lets the deadline cap the final wait", async () => {
        const query = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
        const { deps, patchTask, task } = fakeDeps({ query, task: completeTask({ deadlineAt: 101_000 }) });
        const runner = createRemoteMediaTaskRunner(deps);

        await runner.start();
        expect(query).toHaveBeenCalledTimes(1);
        for (const [index, delay] of [3_000, 6_000, 12_000, 24_000, 30_000].entries()) {
            await vi.advanceTimersByTimeAsync(delay);
            expect(query).toHaveBeenCalledTimes(index + 2);
            expect(task().status).toBe("waiting_network");
        }
        await vi.advanceTimersByTimeAsync(25_000);

        expect(lastStatus(patchTask)).toBe("timed_out");
        expect(query).toHaveBeenCalledTimes(6);
    });

    test("keeps retrying on the thirty-second backoff plateau", async () => {
        const query = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
        const { deps } = fakeDeps({ query });
        await createRemoteMediaTaskRunner(deps).start();

        for (const delay of [3_000, 6_000, 12_000, 24_000, 30_000, 30_000, 30_000]) await vi.advanceTimersByTimeAsync(delay);

        expect(query).toHaveBeenCalledTimes(8);
    });

    test("retries production-shaped transport timeout errors", async () => {
        const cause = Object.assign(new Error("timeout of 30000ms exceeded"), { code: "ECONNABORTED", isAxiosError: true, response: undefined });
        const error = Object.assign(new Error("脚本执行失败", { cause }), { code: "ECONNABORTED" });
        const query = vi.fn().mockRejectedValue(error);
        const { deps, task } = fakeDeps({ query });

        await createRemoteMediaTaskRunner(deps).start();
        expect(task().status).toBe("waiting_network");
        expect(deps.flush).toHaveBeenCalled();
        expect(deps.applyTaskState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "waiting_network" }));
        await vi.advanceTimersByTimeAsync(3_000);

        expect(query).toHaveBeenCalledTimes(2);
    });

    test("resets network backoff after a successful pending query", async () => {
        const query = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue({ status: "pending" });
        const { deps } = fakeDeps({ query });

        await createRemoteMediaTaskRunner(deps).start();
        await vi.advanceTimersByTimeAsync(3_000);
        await vi.advanceTimersByTimeAsync(15_000);

        expect(query).toHaveBeenCalledTimes(3);
    });

    test("waits for the original channel configuration without falling back", async () => {
        const query = vi.fn();
        const config = { ...configuredAiConfig(), apiKey: "fallback-secret", channels: [{ ...configuredAiConfig().channels[0], apiKey: "" }] };
        const { deps, task } = fakeDeps({ query, config });

        await createRemoteMediaTaskRunner(deps).start();

        expect(task().status).toBe("waiting_configuration");
        expect(query).not.toHaveBeenCalled();
        expect(deps.flush).toHaveBeenCalled();
        expect(deps.applyTaskState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "waiting_configuration" }));
    });

    test("combines the current key with persisted base URL, model, and query script", async () => {
        const query = vi.fn().mockResolvedValue({ status: "failed", error: "denied" });
        const { deps } = fakeDeps({ query });

        await createRemoteMediaTaskRunner(deps).start();

        expect(query).toHaveBeenCalledWith(expect.objectContaining({
            capability: "image",
            taskId: "remote-1",
            queryScript: "return { status: 'pending' }",
            config: expect.objectContaining({ baseUrl: "https://snapshot.example", apiKey: "secret", model: "image-model" }),
        }));
    });

    test("treats explicit provider failure as terminal", async () => {
        const { deps, task } = fakeDeps({ query: vi.fn().mockResolvedValue({ status: "failed", error: "provider denied" }) });

        await createRemoteMediaTaskRunner(deps).start();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(task()).toMatchObject({ status: "failed", error: "provider denied" });
        expect(deps.flush).toHaveBeenCalled();
        expect(deps.applyTaskState).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error: "provider denied" }));
    });

    test.each(["wake", "timer"])("keeps terminal persistence rejection observable without an unhandled %s rejection", async (entry) => {
        const query = vi.fn().mockResolvedValueOnce({ status: "pending" }).mockResolvedValue({ status: "failed", error: "provider denied" });
        const { deps, task } = fakeDeps({ query });
        deps.flush = vi.fn().mockRejectedValue(new Error("task storage unavailable"));
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const runner = createRemoteMediaTaskRunner(deps);
        await runner.start();

        if (entry === "wake") runner.wake("local-1");
        else await vi.advanceTimersByTimeAsync(15_000);
        if (entry === "timer") await vi.advanceTimersByTimeAsync(3_000);
        await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());

        expect(task()).toMatchObject({ status: "pending", error: expect.stringContaining("task storage unavailable") });
        consoleError.mockRestore();
    });

    test("keeps a durably terminal task while retrying a rejected target transaction", async () => {
        const query = vi.fn().mockResolvedValueOnce({ status: "pending" }).mockResolvedValue({ status: "failed", error: "provider denied" });
        const { deps, task } = fakeDeps({ query });
        deps.applyTaskState = vi.fn().mockRejectedValue(new Error("project storage unavailable"));
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const runner = createRemoteMediaTaskRunner(deps);
        await runner.start();

        runner.wake("local-1");
        await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());

        expect(task()).toMatchObject({ status: "failed", error: "provider denied" });
        consoleError.mockRestore();
    });

    test("keeps the runner task active until its terminal snapshot is durable", async () => {
        const query = vi.fn().mockResolvedValueOnce({ status: "pending" }).mockResolvedValue({ status: "failed", error: "provider denied" });
        const { deps, task } = fakeDeps({ query });
        let finish!: () => void;
        const gate = new Promise<void>((resolve) => { finish = resolve; });
        deps.persistTaskPatch = vi.fn(async (id, patch) => {
            await gate;
            deps.patchTask(id, patch);
            return deps.getTasks().find((item) => item.id === id);
        });
        const runner = createRemoteMediaTaskRunner(deps);
        await runner.start();

        runner.wake("local-1");
        await vi.waitFor(() => expect(deps.persistTaskPatch).toHaveBeenCalled());
        expect(task().status).toBe("pending");

        finish();
        await vi.waitFor(() => expect(task().status).toBe("failed"));
    });

    test("settles startup without applying or retrying terminal persistence after dispose", async () => {
        const { deps } = fakeDeps({ query: vi.fn().mockResolvedValue({ status: "failed", error: "provider denied" }) });
        let finishPersist!: () => void;
        const persistGate = new Promise<void>((resolve) => { finishPersist = resolve; });
        deps.persistTaskPatch = vi.fn(async (id, patch) => {
            await persistGate;
            deps.patchTask(id, patch);
            return deps.getTasks().find((task) => task.id === id);
        });
        const runner = createRemoteMediaTaskRunner(deps);

        const starting = runner.start();
        await vi.waitFor(() => expect(deps.persistTaskPatch).toHaveBeenCalledOnce());
        runner.dispose();
        finishPersist();

        await expect(starting).resolves.toBeUndefined();
        expect(deps.applyTaskState).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    test("retries only terminal persistence after successful delivery without querying or delivering twice", async () => {
        const query = vi.fn().mockResolvedValue({ status: "succeeded", result: "output" });
        const deliver = vi.fn().mockResolvedValue({ applied: true });
        const { deps, task } = fakeDeps({ query, deliver });
        let attempts = 0;
        deps.persistTaskPatch = vi.fn(async (id, patch) => {
            attempts += 1;
            if (attempts === 1) throw new Error("task storage unavailable");
            deps.patchTask(id, patch);
            return deps.getTasks().find((item) => item.id === id);
        });
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const runner = createRemoteMediaTaskRunner(deps);

        await runner.start();
        expect(task().status).toBe("pending");
        expect(query).toHaveBeenCalledOnce();
        expect(deliver).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(3_000);
        expect(task().status).toBe("succeeded");
        expect(query).toHaveBeenCalledOnce();
        expect(deliver).toHaveBeenCalledOnce();
        consoleError.mockRestore();
    });

    test("does not replace a delivered success with interruption while its terminal snapshot is pending", async () => {
        const query = vi.fn().mockResolvedValue({ status: "succeeded", result: "output" });
        const deliver = vi.fn().mockResolvedValue({ applied: true });
        const { deps, task } = fakeDeps({ query, deliver });
        let attempts = 0;
        deps.persistTaskPatch = vi.fn(async (id, patch) => {
            attempts += 1;
            if (attempts === 1) throw new Error("task storage unavailable");
            deps.patchTask(id, patch);
            return deps.getTasks().find((item) => item.id === id);
        });
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const runner = createRemoteMediaTaskRunner(deps);

        await runner.start();
        await runner.stop("local-1");

        expect(task().status).toBe("succeeded");
        expect(query).toHaveBeenCalledOnce();
        expect(deliver).toHaveBeenCalledOnce();
        consoleError.mockRestore();
    });

    test("converges an active task with matching embedded success on restart without delivery", async () => {
        const query = vi.fn();
        const deliver = vi.fn();
        const { deps, task } = fakeDeps({ query, deliver });
        deps.getEmbeddedTaskStatus = vi.fn().mockReturnValue("succeeded");
        deps.persistTaskPatch = vi.fn(async (id, patch) => {
            deps.patchTask(id, patch);
            return deps.getTasks().find((item) => item.id === id);
        });

        await createRemoteMediaTaskRunner(deps).start();

        expect(task().status).toBe("succeeded");
        expect(query).not.toHaveBeenCalled();
        expect(deliver).not.toHaveBeenCalled();
    });

    test("treats non-network query exceptions as terminal protocol failures", async () => {
        const { deps, task } = fakeDeps({ query: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token")) });

        await createRemoteMediaTaskRunner(deps).start();

        expect(task()).toMatchObject({ status: "failed", error: "Unexpected token" });
    });

    test("backs off and retries when the query answers a transient network error", async () => {
        const query = vi.fn()
            .mockRejectedValueOnce(new TypeError("Network Error"))
            .mockResolvedValueOnce({ status: "succeeded", result: "data:image/png;base64,OK" });
        const { deps, task } = fakeDeps({ query });
        const runner = createRemoteMediaTaskRunner(deps);

        await runner.start();
        expect(task().status).toBe("waiting_network");
        await vi.advanceTimersByTimeAsync(3_000);

        expect(query).toHaveBeenCalledTimes(2);
        expect(task().status).toBe("succeeded");
    });

    test("interrupts when a successful result target no longer exists", async () => {
        const deliver = vi.fn().mockResolvedValue({ applied: false, reason: "missing_target" });
        const { deps, task } = fakeDeps({ query: vi.fn().mockResolvedValue({ status: "succeeded", result: ["out"] }), deliver });

        await createRemoteMediaTaskRunner(deps).start();

        expect(task().status).toBe("interrupted");
    });

    test("treats unchanged delivery as an idempotent success", async () => {
        const deliver = vi.fn().mockResolvedValue({ applied: false, reason: "unchanged" });
        const { deps, task } = fakeDeps({ query: vi.fn().mockResolvedValue({ status: "succeeded", result: ["out"] }), deliver });

        await createRemoteMediaTaskRunner(deps).start();

        expect(task().status).toBe("succeeded");
    });

    test("records local delivery errors while retaining the remote task ID", async () => {
        const { deps, task } = fakeDeps({
            query: vi.fn().mockResolvedValue({ status: "succeeded", result: ["out"] }),
            deliver: vi.fn().mockRejectedValue(new Error("disk full")),
        });

        await createRemoteMediaTaskRunner(deps).start();

        expect(task()).toMatchObject({ status: "failed", remoteTaskId: "remote-1", error: "disk full" });
    });

    test("clears network backoff after a terminal result before the task is explicitly retried", async () => {
        const query = vi.fn()
            .mockRejectedValueOnce(new TypeError("Failed to fetch"))
            .mockResolvedValueOnce({ status: "failed", error: "denied" })
            .mockRejectedValue(new TypeError("Failed to fetch"));
        const { deps, task } = fakeDeps({ query });
        const runner = createRemoteMediaTaskRunner(deps);
        await runner.start();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(task().status).toBe("failed");

        deps.patchTask("local-1", { status: "pending" });
        runner.wake("local-1");
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(3_000);

        expect(query).toHaveBeenCalledTimes(4);
    });

    test("ignores malformed task records instead of querying or scheduling them", async () => {
        const query = vi.fn().mockResolvedValue({ status: "failed", error: "should not run" });
        const malformed = { ...completeTask(), deadlineAt: undefined } as unknown as RemoteMediaTask;
        const { deps } = fakeDeps({ task: malformed, query });

        await expect(createRemoteMediaTaskRunner(deps).start()).resolves.toBeUndefined();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(query).not.toHaveBeenCalled();
    });

    test.each(["failed", "timed_out"] as const)("manual %s video retry queries the original task with a fresh thirty-minute window", async status => {
        vi.setSystemTime(900_000);
        const query = vi.fn().mockResolvedValue({ status: "succeeded", result: { url: "https://example.com/result.mp4" } });
        const { deps, task } = fakeDeps({ task: completeTask({ capability: "video", status, error: "download failed" }), query });
        const runner = createRemoteMediaTaskRunner(deps);
        await runner.start(); expect(query).not.toHaveBeenCalled();
        await Promise.all([runner.retryResult("local-1", completeTask().target), runner.retryResult("local-1", completeTask().target)]);
        await vi.waitFor(() => expect(task().status).toBe("succeeded"));
        expect(query).toHaveBeenCalledOnce();
        expect(query.mock.calls[0][0].taskId).toBe("remote-1");
        expect(task()).toMatchObject({ id: "local-1", remoteTaskId: "remote-1", submittedAt: 1000, deadlineAt: 2_700_000 });
        expect(deps.deliver).toHaveBeenCalledOnce(); runner.dispose();
    });

    test("a delivery storage failure keeps the remote id and the result retry re-queries the original result", async () => {
        const query = vi.fn().mockResolvedValue({ status: "succeeded", result: { url: "https://example.com/result.mp4" } });
        const deliver = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue({ applied: true });
        const { deps, task } = fakeDeps({ task: completeTask({ capability: "video" }), query, deliver });
        const runner = createRemoteMediaTaskRunner(deps);

        await runner.start();
        await vi.waitFor(() => expect(task().status).toBe("failed"));
        expect(task()).toMatchObject({ status: "failed", remoteTaskId: "remote-1", error: "disk full" });
        expect(deps.applyTaskState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", error: "disk full" }));
        expect(deliver).toHaveBeenCalledOnce();

        await runner.retryResult("local-1", task().target);
        await vi.waitFor(() => expect(task().status).toBe("succeeded"));

        expect(query).toHaveBeenCalledTimes(2);
        expect(query.mock.calls[1][0].taskId).toBe("remote-1");
        expect(deliver).toHaveBeenCalledTimes(2);
        expect(task()).toMatchObject({ status: "succeeded", remoteTaskId: "remote-1" });
        runner.dispose();
    });

    test("fal five-minute timeout result retry only queries the original queue task", async () => {
        const model = "fal-ai/veo3.1";
        const channel = createModelChannel({ id: "channel-1", provider: "fal", apiKey: "fixture-key", models: [{ name: model, capability: "video" }] });
        const queryAdapter = vi.fn().mockResolvedValue({ status: "pending" });
        const { deps, task } = fakeDeps({ task: adapterTask({ capability: "video", adapterId: "fal.video", modelName: model }), config: { ...defaultConfig, channels: [channel] }, queryAdapter });
        const runner = createRemoteMediaTaskRunner(deps);
        await runner.start();
        await vi.advanceTimersByTimeAsync(300_000);
        expect(task().status).toBe("timed_out");
        queryAdapter.mockClear().mockResolvedValue({ status: "succeeded", result: { kind: "video", source: "https://example.com/result.mp4" } });
        await runner.retryResult("local-1", task().target);
        await vi.waitFor(() => expect(task().status).toBe("succeeded"));
        expect(queryAdapter).toHaveBeenCalledOnce();
        expect(queryAdapter.mock.calls[0][0]).toMatchObject({ remoteTaskId: "remote-1", modelName: model, adapterId: "fal.video" });
        expect(task()).toMatchObject({ id: "local-1", remoteTaskId: "remote-1" });
        runner.dispose();
    });

    test.each(["failed", "timed_out"] as const)("fal image %s retry retains original identity and deduplicates concurrent recovery", async status => {
        const model = "fal-ai/flux-2-pro";
        const channel = createModelChannel({ id: "channel-1", provider: "fal", apiKey: "fixture-key", models: [{ name: "edited-model", capability: "image" }] });
        const queryAdapter = vi.fn().mockResolvedValue({ status: "succeeded", result: { kind: "image", source: "https://fal.media/result.png" } });
        const { deps, task } = fakeDeps({ task: adapterTask({ capability: "image", adapterId: "fal.image", modelName: model, status }), config: { ...defaultConfig, channels: [channel] }, queryAdapter });
        const runner = createRemoteMediaTaskRunner(deps); await runner.start();
        await Promise.all([runner.retryResult("local-1", task().target), runner.retryResult("local-1", task().target)]);
        await vi.waitFor(() => expect(task().status).toBe("succeeded"));
        expect(queryAdapter).toHaveBeenCalledOnce();
        expect(queryAdapter.mock.calls[0][0]).toMatchObject({ remoteTaskId: "remote-1", modelName: model, adapterId: "fal.image" });
        expect(deps.deliver).toHaveBeenCalledOnce(); runner.dispose();
    });

    test.each(["failed", "timed_out", "submission_unknown"] as const)("hiapi image %s retry queries and delivers the original task", async status => {
        const queryAdapter = vi.fn().mockResolvedValue({ status: "succeeded", result: { kind: "image", sources: ["https://example.com/result.png"] } });
        const { deps, task } = fakeDeps({ task: adapterTask({ adapterId: "hiapi.image", status }), queryAdapter });
        deps.getEmbeddedTaskStatus = (value) => value.status;
        const runner = createRemoteMediaTaskRunner(deps); await runner.start();
        await Promise.all([runner.retryResult("local-1", task().target), runner.retryResult("local-1", task().target)]);
        await vi.waitFor(() => expect(task().status).toBe("succeeded"));
        expect(queryAdapter).toHaveBeenCalledOnce();
        expect(queryAdapter.mock.calls[0][0]).toMatchObject({ remoteTaskId: "remote-1", adapterId: "hiapi.image" });
        expect(deps.deliver).toHaveBeenCalledOnce(); runner.dispose();
    });

    test("retries failed download-phase persistence without turning the original task into a terminal failure", async () => {
        const api = await import("./api/remote-media-task");
        const query = vi.spyOn(api, "queryAdapterRemoteMediaTask").mockImplementation(async input => {
            await input.onPhase?.("downloading");
            return { status: "succeeded", result: { kind: "video", source: new Blob(["fixture"], { type: "video/mp4" }) } };
        });
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const { deps, task } = fakeDeps({ task: adapterTask({ capability: "video", adapterId: "openai.video" }) });
        let firstDownload = true;
        deps.persistTaskPatch = vi.fn(async (id, patch) => {
            if (patch.phase === "downloading" && firstDownload) { firstDownload = false; throw new Error("storage unavailable"); }
            deps.patchTask(id, patch);
            return task();
        });
        const runner = createRemoteMediaTaskRunner(deps);
        try {
            await runner.start();
            expect(task()).toMatchObject({ status: "pending", remoteTaskId: "remote-1" });
            expect(deps.deliver).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(3_000);
            expect(task()).toMatchObject({ status: "succeeded", remoteTaskId: "remote-1" });
            expect(query).toHaveBeenCalledTimes(2);
            expect(deps.deliver).toHaveBeenCalledOnce();
        } finally { runner.dispose(); query.mockRestore(); log.mockRestore(); }
    });


    test.each([undefined, ""])("fal image result retry refuses missing original ID %s", async remoteTaskId => {
        const queryAdapter = vi.fn();
        const { deps, task } = fakeDeps({ task: adapterTask({ adapterId: "fal.image", status: "failed", remoteTaskId }), queryAdapter });
        const runner = createRemoteMediaTaskRunner(deps); await runner.start();
        await expect(runner.retryResult("local-1", task().target)).rejects.toThrow();
        expect(queryAdapter).not.toHaveBeenCalled(); runner.dispose();
    });

    test("parks image adapter unknown submissions with the original ID and stops polling", async () => {
        const queryAdapter = vi.fn().mockResolvedValue({ status: "submission_unknown", error: "提交结果未知" });
        const { deps, task } = fakeDeps({ task: adapterTask({ adapterId: "hiapi.image" }), queryAdapter });
        const runner = createRemoteMediaTaskRunner(deps); await runner.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(task()).toMatchObject({ status: "submission_unknown", remoteTaskId: "remote-1", error: "提交结果未知" });
        await vi.advanceTimersByTimeAsync(600_000);
        expect(queryAdapter).toHaveBeenCalledOnce();
        expect(deps.deliver).not.toHaveBeenCalled();
        runner.dispose();
    });

    test("localizes queue-result failures before recording user-visible task state", async () => {
        const queryAdapter = vi.fn().mockResolvedValue({ status: "failed", error: "fal_http_422" });
        const { deps, task } = fakeDeps({ task: adapterTask(), queryAdapter });
        const runner = createRemoteMediaTaskRunner(deps); await runner.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(task().error).toContain("fal.ai 返回 HTTP 422");
        expect(task().error).toContain("fal_http_422");
        runner.dispose();
    });

    test("rejects copied task metadata when the clicked video is not the saved target", async () => {
        const query = vi.fn();
        const { deps, task } = fakeDeps({ task: completeTask({ capability: "video", status: "failed" }), query });
        const runner = createRemoteMediaTaskRunner(deps); await runner.start();
        await expect(runner.retryResult("local-1", { ...completeTask().target, nodeId: "duplicate" })).rejects.toThrow();
        expect(query).not.toHaveBeenCalled(); expect(task().status).toBe("failed"); runner.dispose();
    });

    test("rejects retry when the target node now belongs to a newer task", async () => {
        const query = vi.fn(); const { deps } = fakeDeps({ task: completeTask({ capability: "video", status: "failed" }), query });
        deps.getEmbeddedTaskStatus = () => undefined;
        const runner = createRemoteMediaTaskRunner(deps); await runner.start();
        await expect(runner.retryResult("local-1", completeTask().target)).rejects.toThrow();
        expect(query).not.toHaveBeenCalled(); runner.dispose();
    });

    test.each(["failed", "timed_out"] as const)("recovers durable user retry when embedded %s state has not been updated yet", async oldStatus => {
        vi.setSystemTime(900_000);
        const query = vi.fn().mockResolvedValue({ status: "pending" });
        const { deps, task } = fakeDeps({ task: completeTask({ capability: "video", status: "pending", queryRetryStartedAt: 899_000, deadlineAt: 1_199_000 }), query });
        deps.getEmbeddedTaskStatus = () => oldStatus;
        const runner = createRemoteMediaTaskRunner(deps); await runner.start();
        expect(query).toHaveBeenCalledOnce(); expect(task().status).toBe("pending"); runner.dispose();
    });

    test("retry marker does not override an already materialized successful video", async () => {
        const query = vi.fn(); const { deps, task } = fakeDeps({ task: completeTask({ capability: "video", status: "pending", queryRetryStartedAt: 1_000 }), query });
        deps.getEmbeddedTaskStatus = () => "succeeded";
        const runner = createRemoteMediaTaskRunner(deps); await runner.start();
        expect(query).not.toHaveBeenCalled(); expect(task().status).toBe("succeeded"); runner.dispose();
    });

    test("manual result retry never turns an unknown submission into another generation", async () => {
        const query = vi.fn();
        const { deps } = fakeDeps({ task: completeTask({ capability: "video", status: "submission_unknown", remoteTaskId: undefined }), query });
        const runner = createRemoteMediaTaskRunner(deps); await runner.start();
        await expect(runner.retryResult("local-1", completeTask().target)).rejects.toThrow();
        expect(query).not.toHaveBeenCalled(); runner.dispose();
    });

    test("allows only one in-flight query per task", async () => {
        let resolve!: (value: { status: "pending" }) => void;
        const query = vi.fn(() => new Promise<{ status: "pending" }>((done) => { resolve = done; }));
        const { deps } = fakeDeps({ query });
        const runner = createRemoteMediaTaskRunner(deps);

        const starting = runner.start();
        await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
        runner.wake("local-1");
        expect(query).toHaveBeenCalledOnce();
        resolve({ status: "pending" });
        await starting;
    });

    test("stop and stopByTarget abort local tracking and persist interruption", async () => {
        const first = completeTask();
        const second = completeTask({ id: "local-2", target: { ...completeTask().target, nodeId: "child", sourceNodeId: "node-1" } });
        const { deps } = fakeDeps({ tasks: [first, second] });
        const runner = createRemoteMediaTaskRunner(deps);
        releaseRegisteredRunner = registerRemoteMediaTaskRunner(runner);

        runner.stop("local-1");
        stopRemoteTasksForTarget("project-1", "canvas-1", "node-1");

        expect(deps.getTasks().map((task) => task.status)).toEqual(["interrupted", "interrupted"]);
    });

    test("the registry wakes the active runner", () => {
        const runner = { start: vi.fn(), retryResult: vi.fn(), retrySubmission: async () => {}, wake: vi.fn(), abort: vi.fn(), stop: vi.fn(), stopByTarget: vi.fn(), dispose: vi.fn() };
        releaseRegisteredRunner = registerRemoteMediaTaskRunner(runner);

        wakeRemoteMediaTask("local-1");

        expect(runner.wake).toHaveBeenCalledWith("local-1");
    });

    test("an older registry disposer cannot clear a newer runner", () => {
        const first = { start: vi.fn(), retryResult: vi.fn(), retrySubmission: async () => {}, wake: vi.fn(), abort: vi.fn(), stop: vi.fn(), stopByTarget: vi.fn(), dispose: vi.fn() };
        const second = { start: vi.fn(), retryResult: vi.fn(), retrySubmission: async () => {}, wake: vi.fn(), abort: vi.fn(), stop: vi.fn(), stopByTarget: vi.fn(), dispose: vi.fn() };
        const releaseFirst = registerRemoteMediaTaskRunner(first);
        const releaseSecond = registerRemoteMediaTaskRunner(second);
        releaseRegisteredRunner = releaseSecond;

        releaseFirst();
        wakeRemoteMediaTask("task-new");

        expect(first.wake).not.toHaveBeenCalled();
        expect(second.wake).toHaveBeenCalledWith("task-new");
        releaseSecond();
        wakeRemoteMediaTask("after-release");
        expect(second.wake).toHaveBeenCalledOnce();
    });
});

describe("AutoDL multimodal task submission", () => {
    test("forwards audio/video in memory and persists no credentials or media payload", async () => {
        const channel = createModelChannel({ id: "autodl-1", provider: "autodl", apiKey: "private-autodl-token" });
        const input = {
            ...remoteInput(), capability: "video" as const,
            config: { ...configuredAiConfig(), channels: [channel], model: "autodl-1::minimax_h3_image_audio_to_video_v2", videoSeconds: "5", vquality: "480p横" },
            preparedMedia: { images: ["data:image/png;base64,AAAA"], audios: ["data:audio/wav;base64,BBBB"], videos: [] },
        };
        const deps = startDeps();
        await startRemoteCanvasMediaTask(input, deps);
        expect(deps.submitAdapter).toHaveBeenCalledWith(expect.objectContaining({ adapterId: "autodl.video", images: input.preparedMedia.images, audios: input.preparedMedia.audios, videos: [] }));
        const persisted = JSON.stringify([deps.createTask.mock.calls, deps.patchTask.mock.calls]);
        expect(persisted).not.toContain("private-autodl-token"); expect(persisted).not.toContain("base64");
    });
    test("invalid input fails before creating a task or submitting", async () => {
        const channel = createModelChannel({ id: "autodl-1", provider: "autodl", apiKey: "test-token" });
        const input = { ...remoteInput(), capability: "video" as const, config: { ...configuredAiConfig(), channels: [channel], model: "autodl-1::minimax_h3_lightx2v_no_pic", videoSeconds: "16", vquality: "480p横" }, preparedMedia: { images: [] } };
        const deps = startDeps();
        await expect(startRemoteCanvasMediaTask(input, deps)).rejects.toThrow();
        expect(deps.createTask).not.toHaveBeenCalled(); expect(deps.submitAdapter).not.toHaveBeenCalled();
    });
});

describe("fal prepared submissions", () => {
    test("forwards prepared prompt/images/params and exact identity without persistence payload", async () => {
        const model = "fal-ai/flux-2-pro/edit";
        const channel = createModelChannel({ id: "channel-1", provider: "fal", apiKey: "fixture-key", models: [{ name: model, capability: "image" }] });
        const input = { ...remoteInput(), config: { ...configuredAiConfig(), channels: [channel], model: `channel-1::${model}` }, preparedGeneration: { prompt: "prepared marker prompt", images: ["data:image/png;base64,bWFya2Vy"], params: { providerParams: { seed: 7 } } } };
        const deps = startDeps();
        await startRemoteCanvasMediaTask(input, deps);
        expect(deps.submitAdapter).toHaveBeenCalledWith(expect.objectContaining({ channelId: "channel-1", adapterId: "fal.image", ...input.preparedGeneration }));
        const persisted = JSON.stringify([deps.createTask.mock.calls, deps.patchTask.mock.calls, deps.getTask("local-1")]);
        for (const marker of ["fixture-key", "data:image", "bWFya2Vy", "prepared marker prompt", "providerParams"]) expect(persisted).not.toContain(marker);
        expect(deps.createTask.mock.invocationCallOrder[0]).toBeLessThan(deps.flush.mock.invocationCallOrder[0]);
        expect(deps.flush.mock.invocationCallOrder[0]).toBeLessThan(deps.submitAdapter.mock.invocationCallOrder[0]);
    });
});


test("fal prepared validation refuses invalid input before creating or submitting a task", async () => {
    const model = "fal-ai/flux-2-pro/edit";
    const channel = createModelChannel({ id: "channel-1", provider: "fal", apiKey: "fixture-key", models: [{ name: model, capability: "image" }] });
    const input = { ...remoteInput(), config: { ...configuredAiConfig(), channels: [channel], model: `channel-1::${model}` }, preparedGeneration: { prompt: "image", images: [], params: { providerParams: { seed: 7 } } } };
    const deps = startDeps();
    await expect(startRemoteCanvasMediaTask(input, deps)).rejects.toThrow("fal_missing_reference");
    expect(deps.createTask).not.toHaveBeenCalled(); expect(deps.submitAdapter).not.toHaveBeenCalled();
});

test.each(["projectId", "canvasId", "nodeId", "itemId"] as const)("fal image retry rejects a copied original task on another %s", async key => {
    const target = { ...completeTask().target, itemId: "original-item" };
    const queryAdapter = vi.fn();
    const { deps } = fakeDeps({ task: adapterTask({ adapterId: "fal.image", status: "failed", target }), queryAdapter });
    const runner = createRemoteMediaTaskRunner(deps); await runner.start();
    await expect(runner.retryResult("local-1", { ...target, [key]: "copied-target" })).rejects.toThrow();
    expect(queryAdapter).not.toHaveBeenCalled();runner.dispose();
});

describe("remote media task safe resubmission", () => {
    test("refuses resubmission without the in-memory handle (app restarted)", async () => {
        const { deps } = fakeDeps({ task: adapterTask({ id: "local-1", status: "submission_unknown", idempotencyKey: "key-x" } as RemoteMediaTaskPatch) });
        const runner = createRemoteMediaTaskRunner(deps);
        await runner.start();
        await expect(runner.retrySubmission("local-1")).rejects.toThrow("提交结果未知");
    });

    test("resubmits via the stored handle with the same key and resumes polling", async () => {
        vi.useFakeTimers();
        let calls = 0;
        const submitAdapter = vi.fn(async (_request: { idempotencyKey?: string }) => {
            calls += 1;
            if (calls <= 4) throw new TypeError("Network Error");
            return { taskId: "remote-resub" };
        });
        const startDepsObj = startDeps({ submitAdapter });
        const starting = startRemoteCanvasMediaTask(hiapiAdapterInput(), startDepsObj);
        await vi.advanceTimersByTimeAsync(3_000 + 6_000 + 12_000);
        await starting;
        const key = submitAdapter.mock.calls[0]![0].idempotencyKey as string;
        expect(startDepsObj.getTask("local-1")).toMatchObject({ status: "submission_unknown" });

        const query = vi.fn().mockResolvedValue({ status: "pending", phase: "running" });
        const { deps, task } = fakeDeps({
            queryAdapter: query,
            task: adapterTask({ id: "local-1", status: "submission_unknown", adapterId: "hiapi.image", idempotencyKey: key, modelName: "gpt-image-2/image-to-image" }),
        });
        const runner = createRemoteMediaTaskRunner(deps);
        const unregister = registerRemoteMediaTaskRunner(runner);
        await runner.start();
        try {
            const resubmitting = runner.retrySubmission("local-1");
            await vi.advanceTimersByTimeAsync(0);
            await resubmitting;

            expect(calls).toBe(5);
            expect((submitAdapter.mock.calls[4]![0] as { idempotencyKey?: string }).idempotencyKey).toBe(key);
            expect(task()).toMatchObject({ status: "pending", remoteTaskId: "remote-resub" });
            expect(deps.applyTaskState).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
            await vi.advanceTimersByTimeAsync(0);
            expect(query).toHaveBeenCalledTimes(1);
        } finally {
            unregister();
            vi.useRealTimers();
        }
    });
});
