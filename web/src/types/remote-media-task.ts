import type { AiConfig } from "@/stores/use-config-store";
import type { ProjectAssetSource } from "@/lib/project-assets/project-asset-types";
import type { MediaTaskQueryResult } from "@/services/api/media-adapters/types";

export type RemoteMediaCapability = "image" | "video" | "audio";
export type RemoteTaskPhase = "queued" | "running" | "delivering" | "settling" | "downloading" | "saving";
export type RemoteTaskSubmitResult = { taskId: string };
export type RemoteTaskQueryResult =
    | { status: "pending"; phase?: RemoteTaskPhase; progress?: number }
    | { status: "succeeded"; result: unknown }
    | { status: "failed"; error: string };

type RemoteTaskScriptInput = {
    capability: RemoteMediaCapability;
    config: AiConfig;
    prompt?: string;
    images?: string[];
    messages?: unknown[];
    params?: Record<string, unknown>;
    signal?: AbortSignal;
};

export type RemoteTaskSubmitInput = RemoteTaskScriptInput & { submitScript: string };
export type RemoteTaskQueryInput = RemoteTaskScriptInput & { taskId: string; queryScript: string };
export type RemoteTaskTemplate = { label: string; submitScript: string; queryScript: string };

export type RemoteMediaTaskStatus =
    | "submitting"
    | "pending"
    | "waiting_network"
    | "waiting_configuration"
    | "succeeded"
    | "failed"
    | "timed_out"
    | "interrupted"
    | "submission_unknown";

export type RemoteMediaTaskTarget = {
    projectId: string;
    canvasId: string;
    nodeId: string;
    itemId?: string;
    sourceNodeId?: string;
};

type AdapterTaskProtocol = {
    adapterId: string;
    adapterVersion: 1;
    queryScriptSnapshot?: never;
};

type LegacyTaskProtocol = {
    adapterId?: never;
    adapterVersion?: never;
    queryScriptSnapshot: string;
};

/** Script-derived lineage stamped at dispatch; delivery composes it additively into the asset source. */
export type RemoteTaskScriptSource = Pick<ProjectAssetSource, "scriptNodeId" | "shotId" | "role" | "version">;

const SCRIPT_SOURCE_ROLES: readonly string[] = ["entity-reference", "storyboard", "video", "dialogue", "sfx"];

function isValidScriptSource(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const source = value as Record<string, unknown>;
    return typeof source.scriptNodeId === "string" && Boolean(source.scriptNodeId)
        && (source.shotId === undefined || typeof source.shotId === "string")
        && (source.role === undefined || SCRIPT_SOURCE_ROLES.includes(source.role as string))
        && (source.version === undefined || (typeof source.version === "number" && Number.isFinite(source.version)));
}

export type RemoteMediaTaskBase = {
    id: string;
    remoteTaskId?: string;
    capability: RemoteMediaCapability;
    target: RemoteMediaTaskTarget;
    channelId: string;
    modelName: string;
    baseUrlSnapshot: string;
    outputFormat?: string;
    status: RemoteMediaTaskStatus;
    phase?: RemoteTaskPhase;
    progress?: number;
    submittedAt: number;
    deadlineAt: number;
    lastPolledAt?: number;
    /** Explicit user-requested result lookup; never a new paid submission. */
    queryRetryStartedAt?: number;
    /** Additive v1 fields: old readers ignore them; missing fields mean normal polling. */
    recoveryRequested?: boolean;
    recoveryPhase?: "confirming" | "fetching";
    /** Stable submit idempotency key; present only on tasks whose adapter deduplicates resubmissions. */
    idempotencyKey?: string;
    /** Additive v1 lineage from the dispatch site; survives restart so recovered deliveries stay attributed. */
    scriptSource?: RemoteTaskScriptSource;
    error?: string;
};

export type RemoteMediaTask = RemoteMediaTaskBase & (AdapterTaskProtocol | LegacyTaskProtocol);
export type RemoteMediaTaskPatch = Partial<RemoteMediaTaskBase>;

const REMOTE_MEDIA_TASK_STATUSES: RemoteMediaTaskStatus[] = ["submitting", "pending", "waiting_network", "waiting_configuration", "succeeded", "failed", "timed_out", "interrupted", "submission_unknown"];

export function isRemoteMediaTask(value: unknown): value is RemoteMediaTask {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const task = value as Record<string, unknown>;
    const target = task.target;
    if (!target || typeof target !== "object" || Array.isArray(target)) return false;
    const taskTarget = target as Record<string, unknown>;
    const adapterProtocol = typeof task.adapterId === "string" && Boolean(task.adapterId.trim())
        && typeof task.adapterVersion === "number" && Number.isInteger(task.adapterVersion) && task.adapterVersion > 0
        && task.queryScriptSnapshot === undefined;
    const legacyProtocol = task.adapterId === undefined && task.adapterVersion === undefined
        && typeof task.queryScriptSnapshot === "string" && Boolean(task.queryScriptSnapshot.trim());
    return typeof task.id === "string" && Boolean(task.id)
        && (task.remoteTaskId === undefined || typeof task.remoteTaskId === "string")
        && (task.capability === "image" || task.capability === "video" || task.capability === "audio")
        && typeof taskTarget.projectId === "string" && Boolean(taskTarget.projectId)
        && typeof taskTarget.canvasId === "string" && Boolean(taskTarget.canvasId)
        && typeof taskTarget.nodeId === "string" && Boolean(taskTarget.nodeId)
        && (taskTarget.itemId === undefined || typeof taskTarget.itemId === "string")
        && (taskTarget.sourceNodeId === undefined || typeof taskTarget.sourceNodeId === "string")
        && typeof task.channelId === "string" && Boolean(task.channelId)
        && typeof task.modelName === "string" && Boolean(task.modelName)
        && typeof task.baseUrlSnapshot === "string"
        && (adapterProtocol || legacyProtocol)
        && (task.outputFormat === undefined || typeof task.outputFormat === "string")
        && REMOTE_MEDIA_TASK_STATUSES.includes(task.status as RemoteMediaTaskStatus)
        && (task.phase === undefined || ["queued", "running", "delivering", "settling", "downloading", "saving"].includes(task.phase as string))
        && (task.progress === undefined || (typeof task.progress === "number" && Number.isFinite(task.progress)))
        && typeof task.submittedAt === "number" && Number.isFinite(task.submittedAt)
        && typeof task.deadlineAt === "number" && Number.isFinite(task.deadlineAt) && task.deadlineAt > task.submittedAt
        && (task.queryRetryStartedAt === undefined || (typeof task.queryRetryStartedAt === "number" && Number.isFinite(task.queryRetryStartedAt) && task.queryRetryStartedAt >= Number(task.submittedAt)))
        && (task.recoveryRequested === undefined || typeof task.recoveryRequested === "boolean")
        && (task.recoveryPhase === undefined || task.recoveryPhase === "confirming" || task.recoveryPhase === "fetching")
        && (task.lastPolledAt === undefined || (typeof task.lastPolledAt === "number" && Number.isFinite(task.lastPolledAt)))
        && (task.idempotencyKey === undefined || (typeof task.idempotencyKey === "string" && Boolean(task.idempotencyKey.trim())))
        && (task.scriptSource === undefined || isValidScriptSource(task.scriptSource))
        && (task.error === undefined || typeof task.error === "string");
}

const REMOTE_MEDIA_TERMINAL_STATUSES: readonly RemoteMediaTaskStatus[] = ["succeeded", "failed", "timed_out", "interrupted"];

export function isTerminalRemoteMediaStatus(status: RemoteMediaTaskStatus): boolean {
    return REMOTE_MEDIA_TERMINAL_STATUSES.includes(status);
}

export type CreateRemoteTaskInput = Omit<RemoteMediaTaskBase, "id" | "status" | "submittedAt" | "deadlineAt" | "remoteTaskId" | "phase" | "progress" | "lastPolledAt" | "error"> & (AdapterTaskProtocol | LegacyTaskProtocol) & {
    now?: number;
    timeoutMinutes?: number;
};

export type RemoteMediaTaskRunnerDeps = {
    getTasks: () => RemoteMediaTask[];
    patchTask: (id: string, patch: RemoteMediaTaskPatch) => void;
    persistTaskPatch?: (id: string, patch: RemoteMediaTaskPatch) => Promise<RemoteMediaTask | undefined>;
    flush: () => Promise<void>;
    applyTaskState: (task: RemoteMediaTask) => Promise<RemoteTaskDeliveryOutcome>;
    getEmbeddedTaskStatus?: (task: RemoteMediaTask) => RemoteMediaTaskStatus | undefined;
    getConfig: () => AiConfig;
    queryLegacy: (input: RemoteTaskQueryInput) => Promise<RemoteTaskQueryResult>;
    queryAdapter?: (task: RemoteMediaTask, signal: AbortSignal) => Promise<MediaTaskQueryResult>;
    deliver: (task: RemoteMediaTask, result: unknown, context: { signal: AbortSignal; isActive: () => boolean }) => Promise<RemoteTaskDeliveryOutcome>;
    reportLateDeliveryError?: (task: RemoteMediaTask, error: string) => void;
    now?: () => number;
};

export type RemoteTaskDeliveryOutcome =
    | { applied: true }
    | { applied: false; reason?: "inactive" | "missing_target" | "unchanged" };
