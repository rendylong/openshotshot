import axios from "axios";
import i18n from "@/i18n";
import { getAutodlWorkflow } from "@/lib/models/autodl-workflows";
import type { MediaAdapter, MediaGenerateRequest, MediaTaskQueryResult } from "./types";

function fail(key: string, values?: Record<string, unknown>): never {
    throw new Error(i18n.t(`autodlGeneration.${key}`, values));
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isHttpUrl(source: string) {
    try { const url = new URL(source); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}

export function buildAutodlVideoBody(request: MediaGenerateRequest): Record<string, unknown> {
    const workflow = getAutodlWorkflow(request.config.model);
    if (!workflow) return fail("unsupportedWorkflow");
    const body: Record<string, unknown> = {};
    if (workflow.prompt) {
        if (!request.prompt.trim() || request.prompt.length < workflow.prompt.minLength || request.prompt.length > workflow.prompt.maxLength) fail("promptLength", { min: workflow.prompt.minLength, max: workflow.prompt.maxLength });
        body.prompt = request.prompt;
    }
    if (workflow.duration) {
        const raw = request.params.seconds;
        const seconds = raw === undefined || raw === "" ? workflow.duration.default : Number(raw);
        const rule = workflow.duration;
        if (!Number.isFinite(seconds) || seconds < rule.min || seconds > rule.max || (rule.integer && !Number.isInteger(seconds))) fail("invalidDuration", { min: rule.min, max: rule.max, integer: rule.integer ? i18n.t("autodlGeneration.integer") : "" });
        body[rule.field] = seconds;
    }
    const resolution = request.params.resolution ?? workflow.resolution.default;
    if (typeof resolution !== "string" || !workflow.resolution.options.includes(resolution)) fail("invalidResolution");
    body.resolution = resolution;
    for (const kind of ["image", "audio", "video"] as const) {
        const sources = kind === "image" ? request.images : kind === "audio" ? request.audios || [] : request.videos || [];
        const slots = workflow.media.filter(slot => slot.kind === kind);
        if (sources.length > slots.length) fail("tooManyReferences", { count: slots.length, kind: i18n.t(`autodlGeneration.${kind}`, { index: "" }) });
        slots.forEach((slot, index) => {
            const source = sources[index];
            if (source === undefined) { if (slot.required) fail("missingReference", { name: slot.field }); return; }
            const data = /^data:([^;,]+);base64,([a-zA-Z0-9+/]+={0,2})$/.exec(source);
            if (!isHttpUrl(source) && (!data || !slot.acceptTypes.includes(data[1]))) fail("invalidMedia", { name: slot.field, types: slot.acceptTypes.join(", ") });
            body[slot.field] = source;
        });
    }
    return body;
}

function endpoint(baseUrl: string, suffix: string): string {
    try {
        const url = new URL(baseUrl);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return fail("invalidEndpoint");
        const path = url.pathname.replace(/\/+$/, "");
        if (!["", "/api/v1", "/api/v1/comfyui"].includes(path)) return fail("invalidEndpoint");
        return `${url.origin}/api/v1/comfyui/comfyui_workflow/${suffix}`;
    } catch { return fail("invalidEndpoint"); }
}

function responseMessage(value: unknown, key: string, fallback: string): string {
    const data = record(value);
    const nested = record(data.error);
    const message = [nested.message, data.msg, data.message, typeof data.error === "string" ? data.error : undefined].find(item => typeof item === "string" && item.trim());
    // Provider errors must never turn an echoed token or media body into an application log.
    const text = typeof message === "string" ? message : fallback;
    const token = key.trim();
    return (token ? text.split(token).join("[redacted]") : text).replace(/data:[^\s"']+;base64,[a-zA-Z0-9+/=]+/g, "[media]");
}

function readVideoTaskState(value: unknown, apiKey: string): MediaTaskQueryResult {
    const root = record(value);
    if (root.code !== "Success") return { status: "failed", error: responseMessage(root, apiKey, i18n.t("autodlGeneration.protocolError")) };
    const data = record(root.data);
    const status = typeof data.status === "string" ? data.status.toUpperCase() : "";
    if (status === "QUEUED" || status === "RUNNING") return { status: "pending", phase: status === "QUEUED" ? "queued" : "running" };
    if (status === "SUCCESS" || status === "COMPLETED") {
        const video = (Array.isArray(data.results) ? data.results : []).map(record).find(item => item.type === "video" && item.output_type !== "preview" && typeof item.url === "string" && isHttpUrl(item.url));
        if (!video) return { status: "failed", error: i18n.t("autodlGeneration.noVideo") };
        return { status: "succeeded", result: { kind: "video", source: video.url as string, mimeType: video.file_type === "webm" ? "video/webm" : "video/mp4" } };
    }
    return { status: "failed", error: responseMessage(data, apiKey, responseMessage(root, apiKey, i18n.t(status === "FAILED" ? "autodlGeneration.failed" : "autodlGeneration.protocolError"))) };
}

async function call(request: MediaGenerateRequest, taskId?: string, body?: Record<string, unknown>): Promise<unknown> {
    if (!request.config.apiKey.trim()) fail("missingKey");
    const config = { headers: { Authorization: request.config.apiKey.trim(), "Content-Type": "application/json" }, signal: request.signal };
    const url = endpoint(request.config.baseUrl, taskId === undefined ? encodeURIComponent(request.config.model) : `result/${encodeURIComponent(taskId)}`);
    // Construct before the try so validation errors are never mistaken for a submitted network request.
    const payload = body ?? (taskId === undefined ? buildAutodlVideoBody(request) : undefined);
    try {
        const response = taskId === undefined ? await axios.post<unknown>(url, payload, config) : await axios.get<unknown>(url, config);
        return response.data;
    } catch (error) {
        if (request.signal?.aborted) throw request.signal.reason;
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        const key = status === 401 ? "unauthorized" : status === 403 ? "forbidden" : "requestFailed";
        const safe = new Error(responseMessage(axios.isAxiosError(error) ? error.response?.data : undefined, request.config.apiKey, i18n.t(`autodlGeneration.${key}`, { status: status || "network" })));
        // Preserve only the transport code used by the existing runner's submission_unknown/network recovery.
        if (axios.isAxiosError(error) && error.code) Object.assign(safe, { code: error.code });
        throw safe;
    }
}

export const autodlVideoAdapter: MediaAdapter = {
    id: "autodl.video", version: 1, modality: "video", execution: "remote_task",
    async submit(request) {
        const body = buildAutodlVideoBody(request);
        const root = record(await call(request, undefined, body));
        const data = record(root.data);
        if (root.code !== "Success" || typeof data.task_id !== "string" || !data.task_id.trim()) throw new Error(responseMessage(root, request.config.apiKey, i18n.t("autodlGeneration.protocolError")));
        const taskId = data.task_id.trim();
        const fields = Object.keys(body).filter((key) => key.startsWith("ref_"));
        if (fields.length) console.info(`[autodl] submit ${request.config.model} task=${taskId} fields=${fields.join(",")}`);
        return { taskId };
    },
    async query(request) { return readVideoTaskState(await call(request, request.taskId), request.config.apiKey); },
};
