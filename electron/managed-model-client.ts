import { mkdir, open, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { GatewayCredential, ManagedModel, ShotshotCloudClient } from "./shotshot-cloud-client";
import { ShotshotCloudClientError } from "./shotshot-cloud-client";
import type { ManagedModelRequest, ManagedModelResponse, ManagedRequestBody } from "../web/src/lib/desktop/managed-model-types";

const MIB = 1024 * 1024;
const LIMITS = {
    text: { timeoutMs: 120_000, requestBytes: 2 * MIB, responseBytes: 16 * MIB },
    image: { timeoutMs: 300_000, requestBytes: 32 * MIB, responseBytes: 64 * MIB },
    audio: { timeoutMs: 300_000, requestBytes: 8 * MIB, responseBytes: 64 * MIB },
    video: { timeoutMs: 30 * 60_000, requestBytes: 8 * MIB, responseBytes: 16 * MIB },
} as const;
const BINARY_VIDEO_IPC_LIMIT = 64 * MIB;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_REQUEST_HEADERS = new Set(["accept", "content-type", "idempotency-key", "openai-beta", "x-request-id"]);
const SAFE_RESPONSE_HEADERS = new Set(["content-type", "content-length", "x-request-id", "openai-request-id"]);
const MODELS_TTL_MS = 10 * 60_000;
const BLOCKING_MARGIN_MS = 30_000;
const RENEW_MARGIN_MS = 5 * 60_000;

export class ManagedModelClientError extends Error {
    constructor(public readonly code:
        | "managed_invalid_request"
        | "managed_request_too_large"
        | "managed_response_too_large"
        | "managed_request_timeout"
        | "managed_request_aborted"
        | "managed_gateway_unavailable"
        | "managed_quota_exhausted"
        | "managed_invalid_response") {
        super(code);
        this.name = "ManagedModelClientError";
    }
}

type TemporaryFile = { path: string; size: number; contentType: string };

export type ManagedModelClientOptions = {
    gatewayOrigin: string;
    cloud: Pick<ShotshotCloudClient, "getManagedModels" | "getStoredGatewayCredential" | "issueGatewayCredential" | "rotateGatewayCredential" | "clearGatewayCredential" | "requestManagedAsset">;
    temporaryDirectory: string;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    allowLocalHttp?: boolean;
};

function recoveryPath(path: string): boolean {
    return /^\/v1\/media\/tasks\/[A-Za-z0-9-]+\/recover$/.test(path);
}

function assetPath(path: string): boolean {
    return path === "/v1/assets/upload" || /^\/v1\/assets\/[A-Za-z0-9-]+\/(?:content|complete)$/.test(path);
}

function allowedPath(path: string, method: ManagedModelRequest["method"]): boolean {
    if (path.includes("?") || path.includes("#") || path.includes("\\") || path.includes("..")) return false;
    if (method === "POST" && ["/v1/responses", "/v1/chat/completions", "/v1/images/generations", "/v1/images/edits", "/v1/audio/speech", "/v1/videos", "/v1/media/tasks", "/v1/assets/upload"].includes(path)) return true;
    if (method === "POST" && recoveryPath(path)) return true;
    if (method === "POST" && assetPath(path)) return true;
    if (method === "GET" && (/^\/v1\/videos\/[A-Za-z0-9._-]+(?:\/content)?$/.test(path) || /^\/v1\/media\/tasks\/[A-Za-z0-9-]+(?:\/content)?$/.test(path))) return true;
    return method === "DELETE" && /^\/v1\/videos\/[A-Za-z0-9._-]+$/.test(path);
}

function safeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers || {})) {
        const normalized = name.toLowerCase();
        if (!SAFE_REQUEST_HEADERS.has(normalized) || /[\r\n]/.test(value)) {
            throw new ManagedModelClientError("managed_invalid_request");
        }
        result[normalized] = value;
    }
    return result;
}

function bodySize(body: ManagedRequestBody | undefined): number {
    if (!body) return 0;
    if (body.kind === "bytes") return body.value.byteLength;
    if (body.kind === "multipart") return body.fields.reduce((total, field) => total + Buffer.byteLength(field.name) +
        (field.kind === "text" ? Buffer.byteLength(field.value) : field.value.byteLength + Buffer.byteLength(field.filename) + Buffer.byteLength(field.contentType)), 0);
    return Buffer.byteLength(body.value);
}

function serializeBody(body: ManagedRequestBody | undefined, headers: Record<string, string>): string | Uint8Array | FormData | undefined {
    if (!body) return undefined;
    if (body.kind === "json") {
        try { JSON.parse(body.value); } catch { throw new ManagedModelClientError("managed_invalid_request"); }
        headers["content-type"] = "application/json";
        return body.value;
    }
    if (body.kind === "text") return body.value;
    if (body.kind === "bytes") {
        headers["content-type"] = body.contentType;
        return body.value;
    }
    delete headers["content-type"];
    const form = new FormData();
    for (const field of body.fields) {
        if (!field.name || /[\r\n]/.test(field.name)) throw new ManagedModelClientError("managed_invalid_request");
        if (field.kind === "text") form.append(field.name, field.value);
        else form.append(field.name, new Blob([Buffer.from(field.value)], { type: field.contentType }), field.filename);
    }
    return form;
}

function sameModels(credential: GatewayCredential, models: ManagedModel[]): boolean {
    const current = [...credential.modelIds].sort();
    const expected = models.map((model) => model.id).sort();
    return current.length === expected.length && current.every((id, index) => id === expected[index]);
}

export class ManagedModelClient {
    private readonly gatewayOrigin: string;
    private readonly fetch: typeof globalThis.fetch;
    private readonly now: () => number;
    private readonly files = new Map<string, TemporaryFile>();
    private readonly controllers = new Set<AbortController>();
    private credentialRenewal: Promise<GatewayCredential> | null = null;
    private generation = 0;
    private resolveCache: { models: ManagedModel[]; modelsFetchedAt: number; credential: GatewayCredential | null } | null = null;

    constructor(private readonly options: ManagedModelClientOptions) {
        const url = new URL(options.gatewayOrigin);
        const localHttp = options.allowLocalHttp && url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
        if (url.origin !== options.gatewayOrigin || (url.protocol !== "https:" && !localHttp)) throw new Error("invalid_gateway_origin");
        this.gatewayOrigin = url.origin;
        this.fetch = options.fetch ?? globalThis.fetch;
        this.now = options.now ?? Date.now;
    }

    listModels(): Promise<ManagedModel[]> {
        // 公共方法保持"真值"语义：显式刷新路径（渲染器 invalidateManagedCatalog、retryCatalog）直达网络，
        // 成功后回填热缓存。
        return this.options.cloud.getManagedModels().then((models) => {
            this.resolveCache = { models, modelsFetchedAt: this.now(), credential: this.resolveCache?.credential ?? null };
            return models;
        });
    }

    /** Main-process-only resolver used by the Pi provider; never exposed through preload. */
    async resolveApiKeyForTextModel(modelId: string): Promise<string> {
        const startedAt = this.now();
        const models = await this.listModelsCached();
        if (!models.some((model) => model.id === modelId && model.capability === "text")) {
            throw new ManagedModelClientError("managed_invalid_request");
        }
        return (await this.credentialCached(models, startedAt)).secret;
    }

    /** Main-process-only descriptor resolver used by the Pi provider; never exposed through preload. */
    async resolveTextModelDescriptor(modelId: string): Promise<{
        inputModalities: Array<"text" | "image">;
    }> {
        const model = (await this.listModelsCached())
            .find((candidate) => candidate.id === modelId && candidate.capability === "text");
        if (!model) throw new ManagedModelClientError("managed_invalid_request");
        return { inputModalities: [...(model.input_modalities ?? ["text"])] };
    }

    async request(request: ManagedModelRequest, signal?: AbortSignal): Promise<ManagedModelResponse> {
        const generation = this.generation;
        this.validateRequest(request);
        const assetUpload = request.method === "POST" && assetPath(request.path);
        const models = assetUpload ? [] : await this.listModelsCached();
        if (request.method === "POST") {
            const requestedModel = this.requestedModel(request.body);
            if (!assetUpload && !recoveryPath(request.path) && (!requestedModel || !models.some((model) => model.id === requestedModel))) {
                throw new ManagedModelClientError("managed_invalid_request");
            }
        }
        const credential = assetUpload ? undefined : await this.credential(models);
        if (generation !== this.generation) throw new ManagedModelClientError("managed_request_aborted");
        const first = await this.execute(request, credential, signal);
        if (!first.unauthorized) return first.response;
        await this.options.cloud.clearGatewayCredential();
        if (this.resolveCache) this.resolveCache.credential = null;
        const rotated = await this.credential(models, "after_unauthorized");
        if (this.resolveCache) this.resolveCache.credential = rotated;
        const second = await this.execute(request, rotated, signal);
        if (second.unauthorized) throw new ManagedModelClientError("managed_gateway_unavailable");
        return second.response;
    }

    async discardTemporaryFile(id: string): Promise<void> {
        const file = this.files.get(id);
        if (!file) return;
        this.files.delete(id);
        await rm(file.path, { force: true });
    }

    async dispose(): Promise<void> {
        this.generation += 1;
        this.resolveCache = null;
        for (const controller of this.controllers) controller.abort();
        this.controllers.clear();
        await Promise.all([...this.files.keys()].map((id) => this.discardTemporaryFile(id)));
    }

    private async listModelsCached(): Promise<ManagedModel[]> {
        const cached = this.resolveCache;
        if (cached && this.now() - cached.modelsFetchedAt < MODELS_TTL_MS) return cached.models;
        return this.listModels();
    }

    private validateRequest(request: ManagedModelRequest): void {
        if (!REQUEST_ID.test(request.id) || !allowedPath(request.path, request.method)) {
            throw new ManagedModelClientError("managed_invalid_request");
        }
        safeHeaders(request.headers);
        if ((request.method === "GET" || request.method === "DELETE") && request.body) {
            throw new ManagedModelClientError("managed_invalid_request");
        }
        if (bodySize(request.body) > LIMITS[request.timeoutClass].requestBytes) {
            throw new ManagedModelClientError("managed_request_too_large");
        }
    }

    private requestedModel(body: ManagedRequestBody | undefined): string | null {
        if (body?.kind === "json") {
            try {
                const value = JSON.parse(body.value) as { model?: unknown };
                return typeof value.model === "string" ? value.model : null;
            } catch {
                throw new ManagedModelClientError("managed_invalid_request");
            }
        }
        if (body?.kind === "multipart") {
            const model = body.fields.find((field) => field.kind === "text" && field.name === "model");
            return model?.kind === "text" ? model.value : null;
        }
        return null;
    }

    private async credential(models: ManagedModel[], mode: "auto" | "after_unauthorized" = "auto", onBlocking?: () => void): Promise<GatewayCredential> {
        const stored = await this.options.cloud.getStoredGatewayCredential();
        if (mode === "auto" && stored && Date.parse(stored.expiresAt) > this.now() + 30_000 && sameModels(stored, models)) {
            return stored;
        }
        if (!this.credentialRenewal) {
            this.credentialRenewal = this.renewCredential(models, stored, mode).finally(() => {
                this.credentialRenewal = null;
            });
        }
        onBlocking?.();
        return this.credentialRenewal;
    }

    private async credentialCached(models: ManagedModel[], startedAt: number): Promise<GatewayCredential> {
        const cached = this.resolveCache?.credential ?? null;
        const remaining = cached ? Date.parse(cached.expiresAt) - this.now() : 0;
        if (cached && remaining > BLOCKING_MARGIN_MS) {
            const renewed = remaining < RENEW_MARGIN_MS;
            if (renewed) this.renewInBackground(models);
            this.logResolve(renewed ? "renewed" : "hit", startedAt);
            return cached; // 旧secret仍有效，绝不等待
        }
        let blocking = false;
        const credential = await this.credential(models, "auto", () => {
            blocking = true;
        });
        if (this.resolveCache) this.resolveCache.credential = credential;
        else this.resolveCache = { models, modelsFetchedAt: this.now(), credential };
        // 冷缓存首解同样按边距触发后台轮换：先落缓存，让 renewCredential 拿到 stored 走 rotate 而非 issue。
        const renewed = Date.parse(credential.expiresAt) - this.now() < RENEW_MARGIN_MS;
        if (renewed) this.renewInBackground(models);
        // 打点语义：blocking=本次 resolve 等待了重新签发；renewed=未等待但边距触发了后台轮换；hit=直接命中。
        this.logResolve(blocking ? "blocking" : renewed ? "renewed" : "hit", startedAt);
        return credential;
    }

    // 复用既有单飞与 rotate→issue→rotate 409 恢复链；失败只记日志，下一轮重试。
    private renewInBackground(models: ManagedModel[]): void {
        if (this.credentialRenewal) return;
        const startedAt = this.now();
        this.credentialRenewal = this.renewCredential(models, this.resolveCache?.credential ?? null, "auto")
            .then((credential) => {
                if (this.resolveCache) this.resolveCache.credential = credential;
                this.logResolve("rotated", startedAt);
                return credential;
            })
            .finally(() => {
                this.credentialRenewal = null;
            });
        // fire-and-forget：后台失败只记日志；阻塞路径若共享了这次单飞，仍按原语义收到拒绝。
        void this.credentialRenewal.catch((error) => {
            console.error(JSON.stringify({ event: "managed_credential_background_renew_failed", error: String(error) }));
        });
    }

    // D9 时序埋点：结构化单行日志，纯观察；调用方需保证每次 resolve 至多一条。
    private logResolve(cache: "hit" | "renewed" | "rotated" | "blocking", startedAt: number): void {
        console.error(JSON.stringify({ event: "managed_resolve", cache, ms: this.now() - startedAt }));
    }

    /**
     * Serialized issue/rotate renewal. Cloud rotates with a compare-and-swap on
     * the attached token id, so concurrent renewals would 409 each other and
     * revoke freshly issued tokens; all callers must share one renewal.
     */
    private async renewCredential(models: ManagedModel[], stored: GatewayCredential | null, mode: "auto" | "after_unauthorized"): Promise<GatewayCredential> {
        const modelIds = models.map((model) => model.id);
        const rotateFirst = mode === "after_unauthorized" || stored !== null;
        if (rotateFirst) {
            try {
                return await this.options.cloud.rotateGatewayCredential(modelIds);
            } catch (error) {
                if (!(error instanceof ShotshotCloudClientError) ||
                    (error.serverCode !== "device_token_changed" && error.serverCode !== "device_token_not_found")) {
                    throw error;
                }
                // The device attachment moved under this rotation (a concurrent
                // renewal or a revoked token): re-anchor with a fresh issue.
            }
        }
        try {
            return await this.options.cloud.issueGatewayCredential(modelIds);
        } catch (error) {
            if (error instanceof ShotshotCloudClientError && error.serverCode === "device_token_exists") {
                return this.options.cloud.rotateGatewayCredential(modelIds);
            }
            throw error;
        }
    }

    private async execute(
        request: ManagedModelRequest,
        credential: GatewayCredential | undefined,
        callerSignal?: AbortSignal,
    ): Promise<{ unauthorized: true } | { unauthorized: false; response: ManagedModelResponse }> {
        const limits = LIMITS[request.timeoutClass];
        const headers = safeHeaders(request.headers);
        if (credential) headers.authorization = `Bearer ${credential.secret}`;
        const body = serializeBody(request.body, headers);
        const controller = new AbortController();
        this.controllers.add(controller);
        let timedOut = false;
        const onAbort = () => controller.abort();
        if (callerSignal?.aborted) throw new ManagedModelClientError("managed_request_aborted");
        callerSignal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, limits.timeoutMs);
        try {
            if (!credential) {
                const encoded = request.body;
                if (encoded?.kind !== "json" && encoded?.kind !== "bytes") throw new ManagedModelClientError("managed_invalid_request");
                const result = await this.options.cloud.requestManagedAsset(
                    request.path,
                    encoded.kind === "json" ? JSON.parse(encoded.value) : encoded.value,
                    request.headers?.["content-type"] || (encoded.kind === "bytes" ? encoded.contentType : undefined),
                    controller.signal,
                );
                return { unauthorized: false, response: await this.sanitize(request, new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } })) };
            }
            const url = new URL(request.path, this.gatewayOrigin);
            if (url.origin !== this.gatewayOrigin) throw new ManagedModelClientError("managed_invalid_request");
            const response = await this.fetch(url, { method: request.method, headers, body: body as never, signal: controller.signal });
            if (response.status === 401) {
                await response.body?.cancel().catch(() => undefined);
                return { unauthorized: true };
            }
            return { unauthorized: false, response: await this.sanitize(request, response) };
        } catch (error) {
            if (error instanceof ManagedModelClientError) throw error;
            if (error instanceof ShotshotCloudClientError && !controller.signal.aborted) {
                // Electron only serializes Error.message. Return the existing safe HTTP
                // envelope so renderer diagnostics retain status and the server error code.
                if (!credential && error.status && error.status >= 400 && error.status <= 599) {
                    const code = error.serverCode && /^[a-z0-9_]{1,128}$/.test(error.serverCode) ? error.serverCode : error.code;
                    return { unauthorized: false, response: await this.sanitize(request, new Response(JSON.stringify({ error: code }), {
                        status: error.status, headers: { "content-type": "application/json" },
                    })) };
                }
                throw error;
            }
            if (timedOut) throw new ManagedModelClientError("managed_request_timeout");
            if (callerSignal?.aborted || controller.signal.aborted) throw new ManagedModelClientError("managed_request_aborted");
            throw new ManagedModelClientError("managed_gateway_unavailable");
        } finally {
            this.controllers.delete(controller);
            clearTimeout(timer);
            callerSignal?.removeEventListener("abort", onAbort);
        }
    }

    private async sanitize(request: ManagedModelRequest, response: Response): Promise<ManagedModelResponse> {
        if (response.status === 403) {
            const preview = await response.clone().text().catch(() => "");
            if (/quota|credit|insufficient/i.test(preview)) throw new ManagedModelClientError("managed_quota_exhausted");
        }
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
            if (SAFE_RESPONSE_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
        });
        const contentType = response.headers.get("content-type") || "application/octet-stream";
        const textual = /(?:json|text|xml|javascript|event-stream)/i.test(contentType);
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body?.getReader();
        if (!reader) throw new ManagedModelClientError("managed_invalid_response");
        let temporary: { id: string; file: Awaited<ReturnType<typeof open>>; path: string } | null = null;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                const responseLimit = request.timeoutClass === "video" && !textual ? BINARY_VIDEO_IPC_LIMIT : LIMITS[request.timeoutClass].responseBytes;
                if (size > responseLimit && !(request.timeoutClass === "video" && !textual)) {
                    await reader.cancel();
                    throw new ManagedModelClientError("managed_response_too_large");
                }
                if (request.timeoutClass === "video" && !textual && size > BINARY_VIDEO_IPC_LIMIT && !temporary) {
                    await mkdir(this.options.temporaryDirectory, { recursive: true });
                    const id = randomUUID();
                    const path = join(this.options.temporaryDirectory, `${id}.media`);
                    const file = await open(path, "wx", 0o600);
                    temporary = { id, file, path };
                    for (const chunk of chunks) await file.write(chunk);
                    chunks.length = 0;
                }
                if (temporary) await temporary.file.write(value);
                else chunks.push(value);
            }
            if (temporary) {
                await temporary.file.close();
                this.files.set(temporary.id, { path: temporary.path, size, contentType });
                return { id: request.id, status: response.status, statusText: response.statusText, headers, body: { kind: "temporary-file", id: temporary.id, size, contentType } };
            }
            const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
            return {
                id: request.id,
                status: response.status,
                statusText: response.statusText,
                headers,
                body: textual ? { kind: "text", value: bytes.toString("utf8") } : { kind: "bytes", value: new Uint8Array(bytes), contentType },
            };
        } catch (error) {
            if (temporary) {
                await temporary.file.close().catch(() => undefined);
                await rm(temporary.path, { force: true }).catch(() => undefined);
            }
            if (error instanceof ManagedModelClientError) throw error;
            throw new ManagedModelClientError("managed_invalid_response");
        }
    }
}
