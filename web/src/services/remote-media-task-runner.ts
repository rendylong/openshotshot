import type { CanvasNodeData } from "@/types/canvas";
import { isRemoteResultRetry, isResultRecoverableImageAdapter, remoteTaskForNode } from "@/lib/canvas/remote-media-task-ui";
import { compileFalInput } from "@/lib/models/fal/input";
import { getFalProfile } from "@/lib/models/fal/profiles";
import { formatFalGenerationError } from "@/lib/models/fal/errors";
import i18n from "@/i18n";
import { applyRemoteTaskStatesToProject, applyRemoteTaskStateToProject } from "@/lib/canvas/remote-media-task-result";
import { planCanvasMediaGeneration } from "@/lib/canvas/canvas-media-generation-route";
import { getMediaAdapter } from "@/services/api/media-adapters/registry";
import type { MediaResult, MediaTaskQueryResult } from "@/services/api/media-adapters/types";
import { queryAdapterRemoteMediaTask, submitAdapterRemoteMediaTask, submitRemoteMediaTask } from "@/services/api/remote-media-task";
import { DEFAULT_REMOTE_TASK_TIMEOUT_MINUTES, DEFAULT_VIDEO_TASK_TIMEOUT_MINUTES, boolConfig, decodeChannelModel, resolveModelChannel, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { useRemoteMediaTaskStore } from "@/stores/use-remote-media-task-store";
import { prepareAutodlGenerationRequest } from "@/lib/canvas/autodl-generation-input";
import { buildAutodlVideoBody } from "@/services/api/media-adapters/autodl";
import type { MediaGenerateRequest } from "@/services/api/media-adapters/types";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import type { ReferenceImage } from "@/types/image";
import { isRemoteMediaTask, type CreateRemoteTaskInput, type RemoteMediaCapability, type RemoteMediaTask, type RemoteMediaTaskPatch, type RemoteMediaTaskRunnerDeps, type RemoteMediaTaskStatus, type RemoteMediaTaskTarget, type RemoteTaskDeliveryOutcome, type RemoteTaskScriptSource, type RemoteTaskSubmitResult, type RemoteTaskQueryResult } from "@/types/remote-media-task";

export type { RemoteMediaTaskRunnerDeps };

const ACTIVE_STATUSES = new Set<RemoteMediaTaskStatus>(["submitting", "pending", "waiting_network", "waiting_configuration"]);
const RECOVERABLE_STATUSES = new Set<RemoteMediaTaskStatus>(["pending", "waiting_network", "waiting_configuration"]);
const NETWORK_BACKOFF_MS = [3_000, 6_000, 12_000, 24_000, 30_000] as const;
const RETRYABLE_NETWORK_CODES = new Set(["ERR_NETWORK", "ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "ENETUNREACH", "EAI_AGAIN"]);
const TERMINAL_PERSIST_RETRY_MS = 3_000;
const SUBMIT_RETRY_ATTEMPTS = 3;
const NORMAL_POLL_MS = 15_000;

export type StartRemoteCanvasMediaTaskInput = {
    config: AiConfig;
    capability: RemoteMediaCapability;
    prompt: string;
    references?: ReferenceImage[];
    audioReferences?: ReferenceAudio[];
    videoReferences?: ReferenceVideo[];
    /** Prepared in memory by the canvas preflight; never included in task persistence. */
    preparedGeneration?: Pick<MediaGenerateRequest, "prompt" | "images" | "params">;
    preparedMedia?: Pick<MediaGenerateRequest, "images" | "audios" | "videos">;
    /** Script lineage from the dispatch site; persisted on the task so delivery composes the asset source. */
    scriptSource?: RemoteTaskScriptSource;
    target: RemoteMediaTaskTarget;
};

export type StartRemoteCanvasMediaTaskDeps = {
    createTask: (input: CreateRemoteTaskInput) => RemoteMediaTask;
    flush: () => Promise<void>;
    submit: typeof submitRemoteMediaTask;
    submitAdapter?: typeof submitAdapterRemoteMediaTask;
    patchTask: (id: string, patch: RemoteMediaTaskPatch) => void;
    getTask: (taskId: string) => RemoteMediaTask | undefined;
    applyTaskState: (task: RemoteMediaTask, context?: { signal: AbortSignal; isActive: () => boolean }) => Promise<RemoteTaskDeliveryOutcome>;
    wake: (taskId: string) => void;
    isTaskActive?: (taskId: string) => boolean;
};

export type RemoteMediaTaskRunner = {
    start(): Promise<void>;
    wake(taskId: string): void;
    retryResult(taskId: string, target: Pick<RemoteMediaTaskTarget, "projectId" | "canvasId" | "nodeId" | "itemId">): Promise<void>;
    retrySubmission(taskId: string): Promise<void>;
    abort(taskId: string): void;
    stop(taskId: string): Promise<void>;
    stopByTarget(projectId: string, canvasId: string, nodeId: string): Promise<void>;
    dispose(): void;
};

function errorMessage(error: unknown) {
    return formatFalGenerationError(error);
}

function isIdempotencyPending(error: unknown): error is { idempotencyPending: true; retryAfterMs: number } {
    return Boolean(error && typeof error === "object" && (error as { idempotencyPending?: unknown }).idempotencyPending === true);
}

function sleep(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

type SubmitRetryOutcome =
    | { kind: "submitted"; result: RemoteTaskSubmitResult }
    | { kind: "timeout" }
    | { kind: "inactive" }
    | { kind: "submission_unknown"; error: string }
    | { kind: "failed"; error: string };

/** Shared submit loop for start and manual resubmission. Network failures retry only when the
 * adapter is idempotency-safe; hiapi 409 (first request still processing) waits Retry-After
 * without consuming budget and always converges to a replay of the original taskId. */
async function submitWithRetry(input: {
    controller: AbortController;
    timeoutReason: DOMException;
    isActive: () => boolean;
    run: (signal: AbortSignal) => Promise<RemoteTaskSubmitResult>;
    idempotent: boolean;
    unknownCopy: string;
}): Promise<SubmitRetryOutcome> {
    const { controller, timeoutReason, isActive, run, idempotent, unknownCopy } = input;
    let budget = idempotent ? SUBMIT_RETRY_ATTEMPTS : 0;
    let backoffIndex = 0;
    for (;;) {
        try {
            return { kind: "submitted", result: await abortable(run(controller.signal), controller.signal) };
        } catch (error) {
            if (controller.signal.reason === timeoutReason) return { kind: "timeout" };
            if (!isActive()) return { kind: "inactive" };
            if (isIdempotencyPending(error)) {
                try {
                    await sleep(error.retryAfterMs, controller.signal);
                } catch {
                    return controller.signal.reason === timeoutReason ? { kind: "timeout" } : { kind: "inactive" };
                }
                continue;
            }
            if (!isNetworkError(error)) return { kind: "failed", error: errorMessage(error) };
            if (budget <= 0) return { kind: "submission_unknown", error: unknownCopy };
            budget -= 1;
            try {
                await sleep(NETWORK_BACKOFF_MS[Math.min(backoffIndex, NETWORK_BACKOFF_MS.length - 1)], controller.signal);
            } catch {
                return controller.signal.reason === timeoutReason ? { kind: "timeout" } : { kind: "inactive" };
            }
            backoffIndex += 1;
        }
    }
}

function remoteTaskParams(config: AiConfig, capability: "image" | "video" | "audio" | "text") {
    if (capability === "video") {
        return {
            seconds: config.videoSeconds,
            resolution: config.vquality,
            ratio: config.size,
            generateAudio: boolConfig(config.videoGenerateAudio, true),
            watermark: boolConfig(config.videoWatermark, false),
        };
    }
    if (capability === "audio") {
        return {
            voice: config.audioVoice,
            format: config.audioFormat,
            speed: config.audioSpeed,
            instructions: config.audioInstructions.trim(),
        };
    }
    // image 与 text：只记 image 请求真正消费的字段，全局视频配置不再渗入。
    return {
        count: 1,
        size: config.size,
        quality: config.quality,
        ...(config.background ? { background: config.background } : {}),
    };
}

const defaultStartDeps: StartRemoteCanvasMediaTaskDeps = {
    createTask: (input) => useRemoteMediaTaskStore.getState().createTask(input),
    flush: () => useRemoteMediaTaskStore.getState().flush(),
    submit: submitRemoteMediaTask,
    submitAdapter: submitAdapterRemoteMediaTask,
    patchTask: (id, patch) => useRemoteMediaTaskStore.getState().patchTask(id, patch),
    getTask: (id) => useRemoteMediaTaskStore.getState().tasks.find((task) => task.id === id),
    applyTaskState: applyRemoteTaskStateToProject,
    wake: wakeRemoteMediaTask,
    isTaskActive: (taskId) => {
        const task = useRemoteMediaTaskStore.getState().tasks.find((item) => item.id === taskId);
        return Boolean(task && ACTIVE_STATUSES.has(task.status));
    },
};

const submissionControllers = new Map<string, AbortController>();
type SubmissionRetryContext = { run: (signal: AbortSignal) => Promise<RemoteTaskSubmitResult>; idempotent: boolean };
const submissionRetries = new Map<string, SubmissionRetryContext>();
const retryingSubmissions = new Set<string>();
const terminalPersistencePendingIds = new Set<string>();

function isActiveTask(task: RemoteMediaTask | undefined) {
    return Boolean(task && ACTIVE_STATUSES.has(task.status));
}

export function remoteTaskApplyRequiresInterruption(outcome: RemoteTaskDeliveryOutcome) {
    return !outcome.applied && (outcome.reason === "missing_target" || outcome.reason === "inactive");
}

async function persistStartTerminal(taskId: string, patch: RemoteMediaTaskPatch, deps: StartRemoteCanvasMediaTaskDeps) {
    deps.patchTask(taskId, patch);
    await deps.flush();
    let task = deps.getTask(taskId);
    if (task) {
        const outcome = await deps.applyTaskState(task);
        if (remoteTaskApplyRequiresInterruption(outcome) && task.status !== "interrupted") {
            deps.patchTask(taskId, { status: "interrupted" });
            await deps.flush();
            task = deps.getTask(taskId);
        }
    }
    return task;
}

export async function startRemoteCanvasMediaTask(input: StartRemoteCanvasMediaTaskInput, deps: StartRemoteCanvasMediaTaskDeps = defaultStartDeps) {
    const execution = planCanvasMediaGeneration({ config: input.config, capability: input.capability, phase: "first" });
    if (execution.mode !== "remote_task") throw new Error(i18n.t("canvas.remoteTask.invalidScripts"));
    const adapterProtocol = "adapterId" in execution ? execution : undefined;
    const remote = "remote" in execution ? execution.remote : undefined;

    const requestConfig = resolveModelRequestConfig(input.config, input.config.model);
    const channel = resolveModelChannel(input.config, input.config.model);
    const protocol = adapterProtocol
        ? { adapterId: adapterProtocol.adapterId, adapterVersion: adapterProtocol.adapterVersion }
        : { queryScriptSnapshot: remote!.queryScript };
    const prepared = adapterProtocol?.adapterId === "autodl.video"
        ? input.preparedMedia || await prepareAutodlGenerationRequest(input.config, {
            prompt: input.prompt, referenceImages: input.references || [], referenceAudios: input.audioReferences || [], referenceVideos: input.videoReferences || [],
            textCount: 0, imageCount: input.references?.length || 0, audioCount: input.audioReferences?.length || 0, videoCount: input.videoReferences?.length || 0,
        })
        : undefined;
    if (prepared) buildAutodlVideoBody({ config: requestConfig, prompt: input.prompt, images: prepared.images, audios: prepared.audios, videos: prepared.videos, params: remoteTaskParams(input.config, "video") });
    if (adapterProtocol?.adapterId === "fal.image" || adapterProtocol?.adapterId === "fal.video") {
        const profile = getFalProfile(requestConfig.model);
        if (!profile || !input.preparedGeneration) throw new Error("fal_input_invalid");
        compileFalInput(profile, input.preparedGeneration);
    }
    const task = deps.createTask({
        capability: input.capability,
        target: input.target,
        channelId: decodeChannelModel(input.config.model)?.channelId || channel!.id,
        modelName: requestConfig.model,
        baseUrlSnapshot: requestConfig.baseUrl,
        ...protocol,
        outputFormat: input.capability === "audio" ? input.config.audioFormat : input.capability === "image" ? "png" : undefined,
        ...(input.scriptSource ? { scriptSource: input.scriptSource } : {}),
        timeoutMinutes: adapterProtocol ? adapterProtocol.timeoutMinutes : remote!.timeoutMinutes,
        ...(adapterProtocol && getMediaAdapter(adapterProtocol.adapterId)?.idempotentSubmit === true ? { idempotencyKey: crypto.randomUUID() } : {}),
    });
    const controller = new AbortController();
    submissionControllers.set(task.id, controller);
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const active = () => !controller.signal.aborted && (deps.isTaskActive ? deps.isTaskActive(task.id) : isActiveTask(deps.getTask(task.id)));
    const applyActive = async (current: RemoteMediaTask) => {
        const outcome = await deps.applyTaskState(current, { signal: controller.signal, isActive: active });
        if (remoteTaskApplyRequiresInterruption(outcome)) {
            await persistStartTerminal(task.id, { status: "interrupted", error: undefined }, deps);
            return false;
        }
        return active();
    };
    const fail = async (message: string) => {
        return persistStartTerminal(task.id, { status: "failed", error: message }, deps);
    };

    try {
        try {
            await deps.flush();
            if (!active()) return deps.getTask(task.id) || task;
            if (!await applyActive(task)) return deps.getTask(task.id) || task;
        } catch (error) {
            if (!active()) return deps.getTask(task.id) || task;
            return fail(i18n.t("canvas.remoteTask.initialPersistFailed", { message: errorMessage(error) }));
        }
        if (!active()) return deps.getTask(task.id) || task;

        const remaining = task.deadlineAt - Date.now();
        if (remaining <= 0) return persistStartTerminal(task.id, { status: "timed_out", error: i18n.t("canvas.remoteTask.submissionUnknown") }, deps);
        const timeoutReason = new DOMException("Remote media task submission timed out", "TimeoutError");
        deadlineTimer = setTimeout(() => controller.abort(timeoutReason), remaining);

        const idempotent = adapterProtocol ? getMediaAdapter(adapterProtocol.adapterId)?.idempotentSubmit === true : false;
        const runSubmit = (signal: AbortSignal): Promise<RemoteTaskSubmitResult> => {
            const request = {
                config: requestConfig,
                channelId: task.channelId,
                prompt: input.preparedGeneration?.prompt ?? input.prompt,
                images: input.preparedGeneration?.images ?? prepared?.images ?? (input.references || []).map((reference) => reference.dataUrl),
                ...(prepared ? { audios: prepared.audios, videos: prepared.videos } : {}),
                params: input.preparedGeneration?.params ?? remoteTaskParams(input.config, input.capability),
                ...(task.idempotencyKey && adapterProtocol ? { idempotencyKey: task.idempotencyKey } : {}),
                signal,
            };
            return adapterProtocol
                ? (deps.submitAdapter || submitAdapterRemoteMediaTask)({ ...request, adapterId: adapterProtocol.adapterId, adapterVersion: adapterProtocol.adapterVersion })
                : deps.submit({ ...request, capability: input.capability, submitScript: remote!.submitScript });
        };
        if (idempotent) submissionRetries.set(task.id, { run: runSubmit, idempotent });

        const outcome = await submitWithRetry({
            controller,
            timeoutReason,
            isActive: active,
            run: runSubmit,
            idempotent,
            unknownCopy: idempotent ? i18n.t("canvas.remoteTask.submissionUnknownRetryable") : i18n.t("canvas.remoteTask.submissionUnknown"),
        });
        if (outcome.kind !== "submission_unknown") submissionRetries.delete(task.id);
        if (outcome.kind === "timeout") return persistStartTerminal(task.id, { status: "timed_out", error: i18n.t("canvas.remoteTask.submissionUnknown") }, deps);
        if (outcome.kind === "inactive") return deps.getTask(task.id) || task;
        if (outcome.kind === "failed") return fail(outcome.error);
        if (outcome.kind === "submission_unknown") return persistStartTerminal(task.id, { status: "submission_unknown", error: outcome.error }, deps);

        const submitted = outcome.result;

        if (Date.now() >= task.deadlineAt) {
            return persistStartTerminal(task.id, { remoteTaskId: submitted.taskId, status: "timed_out", error: i18n.t("canvas.remoteTask.submissionUnknown") }, deps);
        }

        if (!active()) {
            deps.patchTask(task.id, { remoteTaskId: submitted.taskId });
            await deps.flush();
            return deps.getTask(task.id) || { ...task, remoteTaskId: submitted.taskId, status: "interrupted" as const };
        }

        const pending = { ...task, remoteTaskId: submitted.taskId, status: "pending" as const };
        deps.patchTask(task.id, { remoteTaskId: submitted.taskId, status: "pending", error: undefined });
        try {
            await deps.flush();
            if (!active()) return deps.getTask(task.id) || pending;
            if (!await applyActive(pending)) return deps.getTask(task.id) || pending;
        } catch (error) {
            if (!active()) return deps.getTask(task.id) || pending;
            return fail(i18n.t("canvas.remoteTask.remoteIdPersistFailed", { message: errorMessage(error) }));
        }
        if (!active()) return deps.getTask(task.id) || pending;
        deps.wake(task.id);
        return deps.getTask(task.id) || pending;
    } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        submissionControllers.delete(task.id);
    }
}

function isExpectedAbort(error: unknown, signal: AbortSignal) {
    return error === signal.reason || Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

function isNetworkError(error: unknown) {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
        const value = current as { code?: unknown; cause?: unknown; message?: unknown };
        if (typeof value.code === "string" && RETRYABLE_NETWORK_CODES.has(value.code)) return true;
        if (typeof value.message === "string" && /failed to fetch|network error|network request failed|load failed/i.test(value.message)) return true;
        current = value.cause;
    }
    return error instanceof TypeError && /fetch|network|load failed/i.test(error.message);
}

function queryConfig(task: RemoteMediaTask, config: AiConfig): AiConfig | null {
    // A submitted task keeps its original source so changing settings cannot
    // strand an in-flight request or accidentally send it to another provider.
    const channel = config.channels.find((item) => item.id === task.channelId);
    if (!channel?.apiKey.trim()) return null;
    return {
        ...config,
        channelMode: "remote",
        baseUrl: task.baseUrlSnapshot,
        apiKey: channel.apiKey,
        apiFormat: channel.apiFormat,
        model: task.modelName,
        ...(task.capability === "image" ? { imageModel: task.modelName } : {}),
        ...(task.capability === "video" ? { videoModel: task.modelName } : {}),
        ...(task.capability === "audio" ? { audioModel: task.modelName } : {}),
    };
}

function isAdapterTask(task: RemoteMediaTask): task is RemoteMediaTask & { adapterId: string; adapterVersion: 1 } {
    return typeof task.adapterId === "string" && Boolean(task.adapterId);
}

function adapterDeliveryValue(result: MediaResult): unknown {
    if (result.kind === "image") return result.sources;
    return result.source;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal, onLateRejection?: (error: unknown) => void): Promise<T> {
    const reportLateRejection = (error: unknown) => {
        try {
            onLateRejection?.(error);
        } catch (reportError) {
            console.error("[remote-media-task] late delivery error reporting failed", reportError);
        }
    };
    if (signal.aborted) {
        void promise.catch(reportLateRejection);
        return Promise.reject(signal.reason);
    }
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        let aborted = false;
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            callback();
        };
        const onAbort = () => {
            aborted = true;
            finish(() => reject(signal.reason));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => finish(() => resolve(value)),
            (error) => {
                if (settled) {
                    if (aborted) reportLateRejection(error);
                    return;
                }
                finish(() => reject(error));
            },
        );
    });
}

export function createRemoteMediaTaskRunner(deps: RemoteMediaTaskRunnerDeps): RemoteMediaTaskRunner {
    const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const deadlineTimers = new Map<string, { owner: symbol; timer: ReturnType<typeof setTimeout> }>();
    const inFlight = new Map<string, symbol>();
    const controllers = new Map<string, { owner: symbol; controller: AbortController }>();
    const networkAttempts = new Map<string, number>();
    const intermediateAttempts = new Map<string, number>();
    const pendingTransitions = new Map<string, RemoteMediaTaskPatch>();
    const terminalPatches = new Map<string, RemoteMediaTaskPatch>();
    const appliedStateSnapshots = new Map<string, string>();
    const now = deps.now || Date.now;
    const queryLegacy = deps.queryLegacy;
    // syncIntermediate already scheduled persistence recovery; stop this query without a terminal transition.
    const intermediatePhasePending = new Error("Remote task phase persistence pending");
    const queryAdapter = deps.queryAdapter || (async (task: RemoteMediaTask, signal: AbortSignal): Promise<MediaTaskQueryResult> => {
        if (!isAdapterTask(task) || !task.remoteTaskId) throw new Error("Remote media task adapter protocol is incomplete");
        const config = queryConfig(task, deps.getConfig());
        if (!config) throw new Error("Remote media task configuration is unavailable");
        return queryAdapterRemoteMediaTask({
            adapterId: task.adapterId,
            adapterVersion: task.adapterVersion,
            channelId: task.channelId,
            config,
            prompt: "",
            images: [],
            params: {},
            taskId: task.remoteTaskId,
            recover: task.recoveryRequested,
            onPhase: async (phase) => {
                const owner = inFlight.get(task.id);
                if (!owner || signal.aborted || disposed) return;
                const current = await syncIntermediate(task.id, { phase, recoveryPhase: undefined }, owner);
                if (!current) throw intermediatePhasePending;
                signal.throwIfAborted();
            },
            signal,
        });
    });
    const retryingResults = new Set<string>();
    let started = false;
    let disposed = false;

    const tasks = () => {
        const value = deps.getTasks();
        return Array.isArray(value) ? value.filter(isRemoteMediaTask) : [];
    };
    const findTask = (id: string) => tasks().find((task) => task.id === id);
    const clearPollTimer = (id: string) => {
        const timer = pollTimers.get(id);
        if (timer) clearTimeout(timer);
        pollTimers.delete(id);
    };
    const clearDeadlineTimer = (id: string, owner?: symbol) => {
        const entry = deadlineTimers.get(id);
        if (owner && entry?.owner !== owner) return;
        if (entry) clearTimeout(entry.timer);
        deadlineTimers.delete(id);
    };
    const clearLifecycle = (id: string) => {
        clearPollTimer(id);
        clearDeadlineTimer(id);
        networkAttempts.delete(id);
    };
    const abort = (taskId: string) => {
        const entry = controllers.get(taskId);
        clearLifecycle(taskId);
        entry?.controller.abort(new DOMException("Remote media task stopped", "AbortError"));
        controllers.delete(taskId);
        inFlight.delete(taskId);
    };
    const persistTaskPatch = async (taskId: string, patch: RemoteMediaTaskPatch) => {
        if (deps.persistTaskPatch) return deps.persistTaskPatch(taskId, patch);
        const previous = findTask(taskId);
        deps.patchTask(taskId, patch);
        try {
            await deps.flush();
        } catch (error) {
            if (!disposed && previous) deps.patchTask(taskId, { status: previous.status, phase: previous.phase, progress: previous.progress, error: previous.error });
            throw error;
        }
        return findTask(taskId);
    };
    const scheduleTerminalPersistence = (taskId: string) => {
        clearPollTimer(taskId);
        pollTimers.set(taskId, setTimeout(() => {
            void retryTerminalPersistence(taskId).catch((error) => console.error(`[remote-media-task] task ${taskId} terminal persistence failed`, error));
        }, TERMINAL_PERSIST_RETRY_MS));
    };
    const retryTerminalPersistence = async (taskId: string, patch?: RemoteMediaTaskPatch) => {
        if (patch) {
            terminalPatches.set(taskId, patch);
            terminalPersistencePendingIds.add(taskId);
        }
        const terminalPatch = terminalPatches.get(taskId);
        if (!terminalPatch || disposed) return;
        try {
            let current = await persistTaskPatch(taskId, terminalPatch);
            if (disposed) return;
            if (!current) {
                terminalPatches.delete(taskId);
                terminalPersistencePendingIds.delete(taskId);
                return;
            }
            const outcome = await deps.applyTaskState(current);
            if (disposed) return;
            if (remoteTaskApplyRequiresInterruption(outcome) && current.status !== "interrupted") {
                const interrupted = { status: "interrupted", error: undefined } as const;
                terminalPatches.set(taskId, interrupted);
                current = await persistTaskPatch(taskId, interrupted);
                if (disposed) return;
                if (current) {
                    await deps.applyTaskState(current);
                    if (disposed) return;
                }
            }
            terminalPatches.delete(taskId);
            terminalPersistencePendingIds.delete(taskId);
            pendingTransitions.delete(taskId);
            intermediateAttempts.delete(taskId);
            appliedStateSnapshots.delete(taskId);
            clearLifecycle(taskId);
        } catch (error) {
            if (disposed) return;
            const current = findTask(taskId);
            if (current && ACTIVE_STATUSES.has(current.status)) {
                deps.patchTask(taskId, { error: `任务终态保存失败：${errorMessage(error)}` });
            }
            scheduleTerminalPersistence(taskId);
            console.error(`[remote-media-task] task ${taskId} terminal persistence failed`, error);
        }
    };
    const finishTerminal = async (taskId: string, patch: RemoteMediaTaskPatch, shouldAbort = false) => {
        patch = { ...patch, recoveryRequested: undefined, recoveryPhase: undefined };
        clearLifecycle(taskId);
        if (shouldAbort) abort(taskId);
        await retryTerminalPersistence(taskId, patch);
    };
    const timeOut = (taskId: string) => void finishTerminal(taskId, { status: "timed_out", error: undefined }, true).catch((error) => console.error("[remote-media-task] timeout persistence failed", error));
    const isActive = (taskId: string, controller: AbortController, owner: symbol) => {
        const task = findTask(taskId);
        return inFlight.get(taskId) === owner && !disposed && !controller.signal.aborted && Boolean(task && ACTIVE_STATUSES.has(task.status) && now() < task.deadlineAt);
    };
    const ensureActive = (taskId: string, controller: AbortController, owner: symbol) => {
        const task = findTask(taskId);
        if (inFlight.get(taskId) !== owner || !task || !ACTIVE_STATUSES.has(task.status) || disposed || controller.signal.aborted) return false;
        if (now() >= task.deadlineAt) {
            timeOut(taskId);
            return false;
        }
        return true;
    };
    const armDeadline = (task: RemoteMediaTask, owner: symbol) => {
        clearDeadlineTimer(task.id);
        const remaining = task.deadlineAt - now();
        if (remaining <= 0) {
            timeOut(task.id);
            return false;
        }
        const timer = setTimeout(() => {
            if (inFlight.get(task.id) === owner) timeOut(task.id);
        }, remaining);
        deadlineTimers.set(task.id, { owner, timer });
        return true;
    };
    const schedule = (task: RemoteMediaTask, delay: number) => {
        clearPollTimer(task.id);
        const remaining = task.deadlineAt - now();
        if (remaining <= 0) {
            timeOut(task.id);
            return;
        }
        pollTimers.set(task.id, setTimeout(() => {
            void run(task.id).catch((error) => console.error(`[remote-media-task] task ${task.id} transition failed`, error));
        }, Math.min(delay, remaining)));
    };
    const stateSnapshot = (task: RemoteMediaTask) => JSON.stringify([task.status, task.phase, task.progress, task.error, task.recoveryPhase]);
    const syncIntermediate = async (taskId: string, patch: RemoteMediaTaskPatch = {}, owner?: symbol) => {
        const previous = findTask(taskId);
        if (!previous) return undefined;
        const transition = { ...pendingTransitions.get(taskId), ...patch };
        if (Object.keys(transition).length) pendingTransitions.set(taskId, transition);
        const changed = Object.entries(transition).some(([key, value]) => previous[key as keyof RemoteMediaTask] !== value);
        try {
            const current = changed ? await persistTaskPatch(taskId, transition) : previous;
            if (!current || disposed || (owner && inFlight.get(taskId) !== owner)) return undefined;
            const snapshot = stateSnapshot(current);
            if (appliedStateSnapshots.get(taskId) !== snapshot) {
                const outcome = await deps.applyTaskState(current);
                if (disposed || (owner && inFlight.get(taskId) !== owner)) return undefined;
                if (remoteTaskApplyRequiresInterruption(outcome)) {
                    await finishTerminal(taskId, { status: "interrupted", error: undefined });
                    return undefined;
                }
                appliedStateSnapshots.set(taskId, snapshot);
            }
            pendingTransitions.delete(taskId);
            intermediateAttempts.delete(taskId);
            return current;
        } catch (error) {
            const current = findTask(taskId);
            const attempt = intermediateAttempts.get(taskId) || 0;
            intermediateAttempts.set(taskId, attempt + 1);
            if (current && ACTIVE_STATUSES.has(current.status) && !disposed && (!owner || inFlight.get(taskId) === owner)) {
                schedule(current, NETWORK_BACKOFF_MS[Math.min(attempt, NETWORK_BACKOFF_MS.length - 1)]);
            }
            console.error(`[remote-media-task] task ${taskId} intermediate persistence failed`, error);
            return undefined;
        }
    };

    const run = async (taskId: string): Promise<void> => {
        if (disposed || inFlight.has(taskId)) return;
        const owner = Symbol(taskId);
        inFlight.set(taskId, owner);
        clearPollTimer(taskId);
        try {
            if (terminalPatches.has(taskId)) {
                await retryTerminalPersistence(taskId);
                return;
            }
            let task = findTask(taskId);
            if (!task || !ACTIVE_STATUSES.has(task.status)) return;
            if (now() >= task.deadlineAt) {
                timeOut(task.id);
                return;
            }
            if (!task.remoteTaskId) {
                await finishTerminal(task.id, { status: "submission_unknown", error: i18n.t(task.idempotencyKey && submissionRetries.has(task.id) ? "canvas.remoteTask.submissionUnknownRetryable" : "canvas.remoteTask.submissionUnknown") });
                return;
            }
            const synced = await syncIntermediate(task.id, {}, owner);
            if (!synced || inFlight.get(task.id) !== owner) return;
            task = synced;
            const remoteTaskId = task.remoteTaskId;
            if (!remoteTaskId) return;

            const adapter = isAdapterTask(task) ? getMediaAdapter(task.adapterId) : undefined;
            if (isAdapterTask(task) && (!adapter || adapter.execution !== "remote_task")) {
                const waiting = await syncIntermediate(task.id, { status: "waiting_configuration", error: `Remote media task adapter ${task.adapterId} is unavailable` }, owner);
                if (waiting && inFlight.get(task.id) === owner) schedule(waiting, NORMAL_POLL_MS);
                return;
            }
            if (isAdapterTask(task) && adapter!.version !== task.adapterVersion) {
                const waiting = await syncIntermediate(task.id, { status: "waiting_configuration", error: `Remote media task adapter version ${task.adapterVersion} is unavailable for ${task.adapterId}` }, owner);
                if (waiting && inFlight.get(task.id) === owner) schedule(waiting, NORMAL_POLL_MS);
                return;
            }

            const config = queryConfig(task, deps.getConfig());
            if (!config) {
                const waiting = await syncIntermediate(task.id, { status: "waiting_configuration", error: undefined }, owner);
                if (waiting && inFlight.get(task.id) === owner) schedule(waiting, NORMAL_POLL_MS);
                return;
            }

            const controller = new AbortController();
            controllers.set(task.id, { owner, controller });
            if (!armDeadline(task, owner)) return;
            deps.patchTask(task.id, { lastPolledAt: now() });
            task = findTask(task.id) || task;
            let delivering = false;
            try {
                const adapterTask = isAdapterTask(task);
                const result = await abortable<MediaTaskQueryResult | RemoteTaskQueryResult>(adapterTask
                    ? queryAdapter(task, controller.signal)
                    : (() => {
                        return queryLegacy({
                            capability: task.capability,
                            config,
                            taskId: remoteTaskId,
                            queryScript: task.queryScriptSnapshot!,
                            signal: controller.signal,
                        });
                    })(), controller.signal);
                if (!ensureActive(task.id, controller, owner)) return;
                task = findTask(task.id)!;

                if (result.status === "pending") {
                    networkAttempts.delete(task.id);
                    const pending = await syncIntermediate(task.id, { status: "pending", phase: result.phase, progress: result.progress, error: undefined, recoveryRequested: undefined, recoveryPhase: "recoveryPhase" in result ? result.recoveryPhase : undefined }, owner);
                    if (pending && inFlight.get(task.id) === owner) schedule(pending, NORMAL_POLL_MS);
                    return;
                }
                if (result.status === "failed" || result.status === "submission_unknown") {
                    await finishTerminal(task.id, { status: result.status, error: errorMessage(result.error) });
                    return;
                }

                delivering = true;
                const deliveryTask = task;
                const deliveryResult = adapterTask ? adapterDeliveryValue(result.result as MediaResult) : result.result;
                const delivered = await abortable(deps.deliver(task, deliveryResult, {
                    signal: controller.signal,
                    isActive: () => isActive(deliveryTask.id, controller, owner),
                }), controller.signal, (error) => {
                    if (isExpectedAbort(error, controller.signal)) return;
                    const current = findTask(deliveryTask.id);
                    if (!current) return;
                    const message = errorMessage(error);
                    deps.patchTask(deliveryTask.id, { error: message });
                    deps.reportLateDeliveryError?.(current, message);
                });
                if (!ensureActive(task.id, controller, owner)) return;
                await finishTerminal(task.id, remoteTaskApplyRequiresInterruption(delivered)
                    ? { status: "interrupted", error: undefined }
                    : { status: "succeeded", progress: 100, error: undefined });
            } catch (error) {
                if (error === intermediatePhasePending) return;
                if (!ensureActive(task.id, controller, owner)) return;
                if (delivering) {
                    await finishTerminal(task.id, { status: "failed", error: errorMessage(error) });
                    return;
                }
                if (!isNetworkError(error)) {
                    await finishTerminal(task.id, { status: "failed", error: errorMessage(error) });
                    return;
                }
                const attempt = networkAttempts.get(task.id) || 0;
                networkAttempts.set(task.id, attempt + 1);
                const waiting = await syncIntermediate(task.id, { status: "waiting_network", error: errorMessage(error) }, owner);
                if (waiting && inFlight.get(task.id) === owner) schedule(waiting, NETWORK_BACKOFF_MS[Math.min(attempt, NETWORK_BACKOFF_MS.length - 1)]);
            } finally {
                clearDeadlineTimer(taskId, owner);
                if (controllers.get(taskId)?.owner === owner) controllers.delete(taskId);
            }
        } finally {
            if (inFlight.get(taskId) === owner) {
                clearDeadlineTimer(taskId, owner);
                if (controllers.get(taskId)?.owner === owner) controllers.delete(taskId);
                inFlight.delete(taskId);
            }
        }
    };

    const stop = (taskId: string) => {
        if (terminalPatches.has(taskId)) return retryTerminalPersistence(taskId);
        if (!isActiveTask(findTask(taskId))) {
            abort(taskId);
            return Promise.resolve();
        }
        return finishTerminal(taskId, { status: "interrupted", error: undefined }, true);
    };

    return {
        async start() {
            if (started || disposed) return;
            started = true;
            await Promise.all(tasks().map(async (task) => {
                const embeddedStatus = deps.getEmbeddedTaskStatus?.(task);
                const retryOverridesOldFailure = task.queryRetryStartedAt !== undefined && (embeddedStatus === "failed" || embeddedStatus === "timed_out");
                if (ACTIVE_STATUSES.has(task.status) && embeddedStatus && !ACTIVE_STATUSES.has(embeddedStatus) && !retryOverridesOldFailure) {
                    await retryTerminalPersistence(task.id, {
                        status: embeddedStatus,
                        ...(embeddedStatus === "succeeded" ? { progress: 100, error: undefined } : {}),
                    });
                    return;
                }
                if (task.status === "submitting" && !task.remoteTaskId) {
                    await finishTerminal(task.id, { status: "submission_unknown", error: i18n.t(task.idempotencyKey && submissionRetries.has(task.id) ? "canvas.remoteTask.submissionUnknownRetryable" : "canvas.remoteTask.submissionUnknown") });
                    return;
                }
                if (task.status !== "submitting" && !RECOVERABLE_STATUSES.has(task.status)) return;
                if (!deps.getEmbeddedTaskStatus) appliedStateSnapshots.set(task.id, stateSnapshot(task));
                await run(task.id);
            }));
        },
        async retryResult(taskId, target) {
            if (!started || disposed) throw new Error(i18n.t("canvas.remoteTask.retryUnavailable"));
            if (retryingResults.has(taskId)) return;
            const task = findTask(taskId);
            const supportsResultRetry = task?.capability === "video" || (task?.capability === "image" && isResultRecoverableImageAdapter(task.adapterId));
            if (!task || !supportsResultRetry || !task.remoteTaskId || !["failed", "timed_out", "submission_unknown"].includes(task.status) || terminalPersistencePendingIds.has(taskId)
                || task.target.projectId !== target.projectId || task.target.canvasId !== target.canvasId || task.target.nodeId !== target.nodeId
                || (task.capability === "image" && task.target.itemId !== target.itemId)) {
                throw new Error(i18n.t("canvas.remoteTask.retryUnavailable"));
            }
            if (deps.getEmbeddedTaskStatus && !["failed", "timed_out", "submission_unknown"].includes(deps.getEmbeddedTaskStatus(task) || "")) {
                throw new Error(i18n.t("canvas.remoteTask.retryUnavailable"));
            }
            retryingResults.add(taskId);
            try {
                abort(taskId);
                const owner = Symbol("result-retry");
                inFlight.set(taskId, owner);
                appliedStateSnapshots.delete(taskId);
                const renewed = await syncIntermediate(taskId, {
                    status: "pending", error: undefined, phase: undefined, progress: undefined,
                    deadlineAt: now() + (task.capability === "video" ? DEFAULT_VIDEO_TASK_TIMEOUT_MINUTES : DEFAULT_REMOTE_TASK_TIMEOUT_MINUTES) * 60_000,
                    queryRetryStartedAt: now(),
                    recoveryRequested: Boolean(task.adapterId && getMediaAdapter(task.adapterId)?.recover),
                    recoveryPhase: "fetching",
                }, owner);
                if (inFlight.get(taskId) === owner) inFlight.delete(taskId);
                if (!renewed) throw new Error(i18n.t("canvas.remoteTask.retryUnavailable"));
                // Query the saved remote ID. This path never calls a submit adapter.
                void run(taskId);
            } finally { retryingResults.delete(taskId); }
        },
        async retrySubmission(taskId: string) {
            if (!started || disposed) throw new Error(i18n.t("canvas.remoteTask.retryUnavailable"));
            if (retryingSubmissions.has(taskId)) return;
            const context = submissionRetries.get(taskId);
            const task = findTask(taskId);
            if (!context || !task || task.status !== "submission_unknown" || !task.idempotencyKey) {
                throw new Error(i18n.t("canvas.remoteTask.submissionUnknown"));
            }
            retryingSubmissions.add(taskId);
            const controller = new AbortController();
            submissionControllers.set(taskId, controller);
            const startDeps: StartRemoteCanvasMediaTaskDeps = {
                createTask: () => { throw new Error("retrySubmission cannot create tasks"); },
                flush: deps.flush,
                submit: submitRemoteMediaTask,
                patchTask: deps.patchTask,
                getTask: (id) => findTask(id),
                applyTaskState: deps.applyTaskState,
                wake: wakeRemoteMediaTask,
            };
            const timeoutReason = new DOMException("Remote media task submission timed out", "TimeoutError");
            let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
            try {
                const deadlineAt = now() + (task.capability === "video" ? DEFAULT_VIDEO_TASK_TIMEOUT_MINUTES : DEFAULT_REMOTE_TASK_TIMEOUT_MINUTES) * 60_000;
                deps.patchTask(taskId, { status: "submitting", error: undefined, deadlineAt });
                await deps.flush();
                deadlineTimer = setTimeout(() => controller.abort(timeoutReason), deadlineAt - now());
                const isActive = () => {
                    const current = findTask(taskId);
                    return !controller.signal.aborted && Boolean(current && ACTIVE_STATUSES.has(current.status));
                };
                const outcome = await submitWithRetry({
                    controller,
                    timeoutReason,
                    isActive,
                    run: context.run,
                    idempotent: context.idempotent,
                    unknownCopy: i18n.t("canvas.remoteTask.submissionUnknownRetryable"),
                });
                if (outcome.kind !== "submission_unknown") submissionRetries.delete(taskId);
                if (outcome.kind === "submitted") {
                    deps.patchTask(taskId, { remoteTaskId: outcome.result.taskId, status: "pending", error: undefined });
                    try {
                        await deps.flush();
                        if (!isActive()) return;
                        const current = findTask(taskId);
                        if (current) await deps.applyTaskState(current);
                    } catch (error) {
                        if (!isActive()) return;
                        await persistStartTerminal(taskId, { status: "failed", error: i18n.t("canvas.remoteTask.remoteIdPersistFailed", { message: errorMessage(error) }) }, startDeps);
                        return;
                    }
                    wakeRemoteMediaTask(taskId);
                    return;
                }
                if (outcome.kind === "inactive") return;
                if (outcome.kind === "timeout") return void await persistStartTerminal(taskId, { status: "timed_out", error: i18n.t("canvas.remoteTask.submissionUnknown") }, startDeps);
                if (outcome.kind === "failed") return void await persistStartTerminal(taskId, { status: "failed", error: outcome.error }, startDeps);
                return void await persistStartTerminal(taskId, { status: "submission_unknown", error: outcome.error }, startDeps);
            } catch (error) {
                if (findTask(taskId)?.status === "submitting") {
                    await persistTaskPatch(taskId, { status: "submission_unknown", error: i18n.t("canvas.remoteTask.submissionUnknownRetryable") }).catch(() => undefined);
                }
                throw error;
            } finally {
                if (deadlineTimer) clearTimeout(deadlineTimer);
                submissionControllers.delete(taskId);
                retryingSubmissions.delete(taskId);
            }
        },
        wake(taskId) {
            if (!started || disposed) return;
            void run(taskId).catch((error) => console.error(`[remote-media-task] task ${taskId} transition failed`, error));
        },
        abort,
        stop,
        async stopByTarget(projectId, canvasId, nodeId) {
            await Promise.all(tasks()
                .filter((task) => (ACTIVE_STATUSES.has(task.status) || controllers.has(task.id)) && task.target.projectId === projectId && task.target.canvasId === canvasId && (task.target.nodeId === nodeId || task.target.sourceNodeId === nodeId))
                .map((task) => stop(task.id)));
        },
        dispose() {
            disposed = true;
            pollTimers.forEach(clearTimeout);
            deadlineTimers.forEach(({ timer }) => clearTimeout(timer));
            pollTimers.clear();
            deadlineTimers.clear();
            controllers.forEach(({ controller }) => controller.abort(new DOMException("Remote media task runner disposed", "AbortError")));
            controllers.clear();
            inFlight.clear();
            networkAttempts.clear();
            intermediateAttempts.clear();
            pendingTransitions.clear();
            appliedStateSnapshots.clear();
            terminalPatches.forEach((_patch, id) => terminalPersistencePendingIds.delete(id));
            terminalPatches.clear();
        },
    };
}

let activeRunner: { runner: RemoteMediaTaskRunner; token: symbol } | null = null;

export function registerRemoteMediaTaskRunner(runner: RemoteMediaTaskRunner) {
    const token = Symbol("remote-media-task-runner");
    activeRunner = { runner, token };
    return () => {
        if (activeRunner?.token === token) activeRunner = null;
    };
}

/** Resolve an embedded failure before project generation preflight can permit a new submit. */
export async function retryRemoteMediaNodeResult(node: CanvasNodeData, scope: Pick<RemoteMediaTaskTarget, "projectId" | "canvasId">, imageId?: string): Promise<boolean> {
    const embedded = remoteTaskForNode(node, imageId);
    let state = useRemoteMediaTaskStore.getState();
    if (!embedded || !isRemoteResultRetry(node, state.tasks, imageId)) return false;
    // Existing flush waits for task-store hydration and reports storage errors; no second waiter/timer.
    if (!state.hydrated) {
        await state.flush();
        state = useRemoteMediaTaskStore.getState();
    }
    const saved = state.tasks.find(task => task.id === embedded.id);
    // Prefer querying the original task, even when its last observed state was unknown.
    // Only use the existing idempotent submission handle when no remote ID was received.
    if (embedded.status === "submission_unknown" && !saved?.remoteTaskId) {
        if (saved?.idempotencyKey && submissionRetries.has(embedded.id)
            && saved.target.projectId === scope.projectId && saved.target.canvasId === scope.canvasId
            && saved.target.nodeId === node.id
            && (node.type !== "image" || saved.target.itemId === (imageId || node.metadata?.primaryImageId || node.metadata?.images?.[0]?.id))) {
            await retryRemoteMediaSubmission(embedded.id);
            return true;
        }
        throw new Error(i18n.t("canvas.remoteTask.submissionUnknown"));
    }
    // Hydration may identify an adapter whose existing retry action is fresh generation.
    if (!isRemoteResultRetry(node, state.tasks, imageId)) return false;
    if (node.type === "image" && (!saved || saved.capability !== "image")) {
        throw new Error(i18n.t("canvas.remoteTask.retryUnavailable"));
    }
    const itemId = imageId || node.metadata?.primaryImageId || node.metadata?.images?.[0]?.id;
    await retryRemoteMediaTaskResult(embedded.id, { ...scope, nodeId: node.id, itemId: node.type === "image" ? itemId : undefined });
    return true;
}

export async function retryRemoteMediaTaskResult(taskId: string, target: Pick<RemoteMediaTaskTarget, "projectId" | "canvasId" | "nodeId" | "itemId">) {
    if (!activeRunner) throw new Error(i18n.t("canvas.remoteTask.retryUnavailable"));
    await activeRunner.runner.retryResult(taskId, target);
}

export async function retryRemoteMediaSubmission(taskId: string) {
    if (!activeRunner) throw new Error(i18n.t("canvas.remoteTask.retryUnavailable"));
    await activeRunner.runner.retrySubmission(taskId);
}

export function wakeRemoteMediaTask(taskId: string) {
    activeRunner?.runner.wake(taskId);
}

export async function interruptRemoteTasksForTarget(projectId: string, canvasId: string, nodeId: string) {
    const store = useRemoteMediaTaskStore.getState();
    const tasks = store.tasks.filter((task) => ACTIVE_STATUSES.has(task.status) && !terminalPersistencePendingIds.has(task.id) && task.target.projectId === projectId && task.target.canvasId === canvasId && (task.target.nodeId === nodeId || task.target.sourceNodeId === nodeId));
    tasks.forEach((task) => {
        submissionControllers.get(task.id)?.abort(new DOMException("Remote media task stopped", "AbortError"));
        activeRunner?.runner.abort(task.id);
    });
    const restoreActive = async (error: unknown) => {
        const patches = tasks.map((task) => ({
            id: task.id,
            patch: task.status === "submitting" && !task.remoteTaskId
                ? { status: "submission_unknown" as const, error: i18n.t(task.idempotencyKey && submissionRetries.has(task.id) ? "canvas.remoteTask.submissionUnknownRetryable" : "canvas.remoteTask.submissionUnknown") }
                : { status: task.status, phase: task.phase, progress: task.progress, error: `停止状态保存失败：${errorMessage(error)}` },
        }));
        try {
            await store.persistTaskPatches(patches);
        } catch {
            patches.forEach(({ id, patch }) => store.patchTask(id, patch));
        }
        const restored = store.tasks.filter((task) => patches.some((item) => item.id === task.id));
        const uncertain = restored.filter((task) => task.status === "submission_unknown");
        if (uncertain.length) {
            try {
                await applyRemoteTaskStatesToProject(uncertain);
            } catch (applyError) {
                console.error("[remote-media-task] restored stop state could not be applied to target", applyError);
            }
        }
        restored.filter((task) => ACTIVE_STATUSES.has(task.status)).forEach((task) => activeRunner?.runner.wake(task.id));
    };
    try {
        const interrupted = await store.persistTaskPatches(tasks.map((task) => ({ id: task.id, patch: { status: "interrupted", error: undefined } })));
        interrupted.forEach((task) => submissionRetries.delete(task.id));
        const outcome = await applyRemoteTaskStatesToProject(interrupted);
        if (!outcome.applied && outcome.reason !== "unchanged" && outcome.reason !== "missing_target") throw new Error("Remote task interruption was not applied");
        return interrupted;
    } catch (error) {
        await restoreActive(error);
        throw error;
    }
}

export function stopRemoteTasksForTarget(projectId: string, canvasId: string, nodeId: string) {
    return activeRunner?.runner.stopByTarget(projectId, canvasId, nodeId) || Promise.resolve();
}
