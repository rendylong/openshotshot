import type { RemoteTaskPhase } from "@/types/remote-media-task";
import type { ResolvedModel } from "@/lib/models/model-adapter-types";
import type { AiConfig } from "@/stores/use-config-store";

export type MediaGenerateRequest = {
    /** Exact selected channel; runtime only, never inferred from credentials. */
    channelId?: string;
    /** Stable per-task idempotency key; adapters declaring idempotentSubmit send it as a request header. */
    idempotencyKey?: string;
    config: AiConfig;
    prompt: string;
    images: string[];
    audios?: string[];
    videos?: string[];
    params: Record<string, unknown>;
    signal?: AbortSignal;
    /** Await state persistence before beginning a local result transfer. */
    onPhase?: (phase: RemoteTaskPhase) => Promise<void>;
};

export type MediaResult =
    | { kind: "image"; sources: string[] }
    | { kind: "video"; source: Blob | string; mimeType?: string }
    | { kind: "audio"; source: Blob | string; mimeType?: string };

export type MediaTaskQueryResult =
    | { status: "pending"; phase?: RemoteTaskPhase; progress?: number; recoveryPhase?: "confirming" | "fetching" }
    | { status: "succeeded"; result: MediaResult }
    | { status: "failed"; error: string }
    | { status: "submission_unknown"; error: string };

export type MediaAdapter = {
    id: string;
    version: 1;
    modality: Exclude<ResolvedModel["modality"], "text" | "unknown">;
    execution: "direct" | "remote_task";
    /** Provider deduplicates resubmissions under one key (e.g. hiapi Idempotency-Key); gates runner auto-retry. */
    idempotentSubmit?: true;
    generate?: (request: MediaGenerateRequest) => Promise<MediaResult>;
    submit?: (request: MediaGenerateRequest) => Promise<{ taskId: string }>;
    recover?: (request: MediaGenerateRequest & { taskId: string }) => Promise<MediaTaskQueryResult>;
    query?: (request: MediaGenerateRequest & { taskId: string }) => Promise<MediaTaskQueryResult>;
};
