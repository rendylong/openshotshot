import type { ManagedModelDescriptor, ManagedModelRequest, ManagedRequestBody } from "@/lib/desktop/managed-model-types";
import { ensureManagedCatalog, managedCatalogSnapshot } from "@/lib/desktop/managed-catalog-cache";
import { credentialModeFor, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

type ModelResponseType = "json" | "text" | "blob";

export type ModelTransportRequest<T> = {
    config: AiConfig;
    capability?: ModelCapability;
    timeoutClass: ManagedModelRequest["timeoutClass"];
    path: string;
    method?: ManagedModelRequest["method"];
    headers?: Record<string, string>;
    body?: Record<string, unknown> | FormData | string | Uint8Array;
    responseType: ModelResponseType;
    signal?: AbortSignal;
    byok: () => Promise<{ data: T }>;
};

let lastUsageRefreshAt = Number.NEGATIVE_INFINITY;

function managedBridge() {
    const bridge = typeof window === "undefined" ? undefined : window.shotshot?.managedModels;
    if (!bridge) throw new Error("managed_desktop_required");
    return bridge;
}

async function encodeBody(body: ModelTransportRequest<unknown>["body"]): Promise<ManagedRequestBody | undefined> {
    if (body === undefined) return undefined;
    if (typeof body === "string") return { kind: "text", value: body };
    if (body instanceof Uint8Array) return { kind: "bytes", value: body, contentType: "application/octet-stream" };
    if (typeof FormData !== "undefined" && body instanceof FormData) {
        const fields: Extract<ManagedRequestBody, { kind: "multipart" }>["fields"] = [];
        for (const [name, value] of body.entries()) {
            if (typeof value === "string") fields.push({ name, kind: "text", value });
            else fields.push({ name, kind: "bytes", value: new Uint8Array(await value.arrayBuffer()), filename: value.name || "upload", contentType: value.type || "application/octet-stream" });
        }
        return { kind: "multipart", fields };
    }
    return { kind: "json", value: JSON.stringify(body) };
}

/** Managed gateway HTTP failures keep their status so callers can retry transient server errors (5xx/429). */
export class ManagedRequestError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
        this.name = "ManagedRequestError";
    }
}

export function managedErrorStatus(error: unknown): number | undefined {
    return error instanceof ManagedRequestError ? error.status : undefined;
}

function responseError(status: number, value: string): Error {
    let message: string;
    try {
        const parsed = JSON.parse(value) as { error?: { message?: unknown } | string; message?: unknown };
        message = typeof parsed.error === "string" ? parsed.error : typeof parsed.error?.message === "string" ? parsed.error.message : typeof parsed.message === "string" ? parsed.message : "";
    } catch {
        message = value;
    }
    return new ManagedRequestError(status, message || `managed_request_failed_${status}`);
}

function scheduleUsageRefresh(now = Date.now()): void {
    if (now - lastUsageRefreshAt < 60_000) return;
    lastUsageRefreshAt = now;
    void useUserStore.getState().refresh();
}

export function resetManagedUsageRefreshForTests(): void {
    lastUsageRefreshAt = Number.NEGATIVE_INFINITY;
}

export class ManagedModelUnavailableError extends Error {
    constructor(public readonly capability: ModelCapability) {
        super("managed_model_unavailable");
        this.name = "ManagedModelUnavailableError";
    }
}

export async function resolveManagedModelForCapability(config: AiConfig, capability: ModelCapability): Promise<ManagedModelDescriptor> {
    let models: ManagedModelDescriptor[];
    try {
        models = await ensureManagedCatalog();
    } catch (error) {
        models = managedCatalogSnapshot()?.models ?? [];
        if (!models.length) throw error;
    }
    const selected = config.managedModels[capability];
    const available = models.filter((model) => model.capability === capability);
    const model = available.find((item) => item.id === selected) ?? available[0];
    if (!model) throw new ManagedModelUnavailableError(capability);
    return model;
}

export async function resolveManagedModel(config: AiConfig, capability: ModelCapability, modelId: string): Promise<ManagedModelDescriptor> {
    const models = await managedBridge().listModels();
    const model = models.find((item) => item.capability === capability && item.id === modelId);
    if (!model) throw new Error("managed_model_unavailable");
    return model;
}

/** Clone only non-credential generation preferences for a managed request. */
export function toManagedRequestConfig(config: AiConfig, model: string): AiConfig {
    const safe: Record<string, unknown> = {};
    for (const key of Object.keys(config)) {
        if (key === "apiKey" || key === "baseUrl" || key === "channels") continue;
        safe[key] = config[key as keyof AiConfig];
    }
    return {
        ...(safe as unknown as AiConfig),
        credentialMode: "shotshot",
        model,
        baseUrl: "",
        apiKey: "",
        apiFormat: "openai",
        channels: [],
    };
}

export async function requestModel<T>(request: ModelTransportRequest<T>): Promise<T> {
    const capability = request.capability || (request.timeoutClass === "video" ? "video" : request.timeoutClass === "image" ? "image" : request.timeoutClass === "audio" ? "audio" : "text");
    if (credentialModeFor(request.config, capability) === "byok") return (await request.byok()).data;

    const bridge = managedBridge();
    const id = crypto.randomUUID();
    const onAbort = () => { void bridge.abort(id); };
    if (request.signal?.aborted) {
        await bridge.abort(id);
        throw new DOMException("The operation was aborted", "AbortError");
    }
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
        const response = await bridge.fetch({
            id,
            path: request.path,
            method: request.method ?? "POST",
            headers: request.headers,
            body: await encodeBody(request.body),
            timeoutClass: request.timeoutClass,
        });
        const text = response.body.kind === "text" ? response.body.value : "";
        if (response.status < 200 || response.status >= 400) throw responseError(response.status, text);
        scheduleUsageRefresh();
        if (request.responseType === "json") {
            if (response.body.kind !== "text") throw new Error("managed_invalid_response");
            return JSON.parse(response.body.value) as T;
        }
        if (request.responseType === "text") {
            if (response.body.kind !== "text") throw new Error("managed_invalid_response");
            return response.body.value as T;
        }
        if (response.body.kind === "temporary-file") throw new Error("managed_response_file_unavailable");
        if (response.body.kind === "text") return new Blob([response.body.value], { type: response.headers["content-type"] || "text/plain" }) as T;
        const bytes = Uint8Array.from(response.body.value);
        return new Blob([bytes.buffer], { type: response.body.contentType }) as T;
    } finally {
        request.signal?.removeEventListener("abort", onAbort);
    }
}
