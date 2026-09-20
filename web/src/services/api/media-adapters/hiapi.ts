import axios from "axios";

import i18n from "@/i18n";

import type { MediaAdapter, MediaGenerateRequest, MediaTaskQueryResult } from "./types";
import { detectHiapiImageField, fetchHiapiCatalog, resolveCatalogFieldValue } from "./hiapi-catalog";

type HiapiOutput = { url?: unknown; type?: unknown };
type HiapiError = { message?: unknown } | string | null | undefined;
type HiapiTask = { status?: unknown; output?: unknown; error?: HiapiError; message?: unknown };

const HIAPI_AUDIO_VOICE = "EkK5I93UQWFDigLMpZcX";

function trimBase(value: string) {
    return value.trim().replace(/\/+$/, "");
}

function endpoint(baseUrl: string, path: string) {
    const base = trimBase(baseUrl).replace(/\/v1$/i, "");
    return `${base}/v1${path}`;
}

function headers(apiKey: string) {
    return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

function requestHeaders(request: MediaGenerateRequest) {
    return {
        ...headers(request.config.apiKey),
        ...(request.idempotencyKey ? { "Idempotency-Key": request.idempotencyKey } : {}),
    };
}

/** hiapi answers 409 + Retry-After while the first keyed request is still processing; surface it for the runner's wait loop. */
function idempotencyPendingError(retryAfter: unknown): Error & { idempotencyPending: true; retryAfterMs: number } {
    const seconds = Number(retryAfter);
    const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(30_000, Math.max(1_000, seconds * 1000)) : 2_000;
    return Object.assign(new Error("idempotency key still processing"), { idempotencyPending: true as const, retryAfterMs });
}

function nonEmpty(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function taskPayload(value: unknown): HiapiTask | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const root = value as { data?: unknown };
    if (root.data && typeof root.data === "object" && !Array.isArray(root.data)) return root.data as HiapiTask;
    return value as HiapiTask;
}

function taskId(value: unknown): string {
    const root = value && typeof value === "object" && !Array.isArray(value) ? (value as { data?: unknown; taskId?: unknown }) : undefined;
    const data = root?.data && typeof root.data === "object" && !Array.isArray(root.data) ? (root.data as { taskId?: unknown }) : undefined;
    const id = nonEmpty(data?.taskId) ?? nonEmpty(root?.taskId);
    if (!id) throw new Error(i18n.t("apiErrors.hiapiTaskId"));
    return id;
}

function modelAndRoute(model: string) {
    const [base, route] = model.split("@", 2);
    return { model: base || model, ...(route ? { route } : {}) };
}

function aspectRatio(value: unknown): string | undefined {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw || raw === "auto") return raw || undefined;
    if (/^\d+:\d+$/.test(raw)) return raw;
    const match = raw.match(/^(\d+)x(\d+)$/i);
    if (!match) return undefined;
    let a = Number(match[1]);
    let b = Number(match[2]);
    while (b) [a, b] = [b, a % b];
    const width = Number(match[1]);
    const height = Number(match[2]);
    return `${Math.round(width / (a || 1))}:${Math.round(height / (a || 1))}`;
}

function imageResolution(value: unknown): string {
    const quality = String(value ?? "")
        .trim()
        .toLowerCase();
    if (quality === "high" || quality === "4k" || quality === "4") return "4K";
    if (quality === "medium" || quality === "2k" || quality === "2") return "2K";
    return "1K";
}

function betaImageSize(value: unknown): string {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw || raw === "auto") return "auto";
    if (/^\d+x\d+$/i.test(raw)) return raw;
    const ratio = aspectRatio(raw);
    if (!ratio) return "auto";
    const [width, height] = ratio.split(":").map(Number);
    const edge = 1024;
    return width >= height ? `${edge}x${Math.max(1, Math.round((edge * height) / width))}` : `${Math.max(1, Math.round((edge * width) / height))}x${edge}`;
}

function videoResolution(value: unknown): string {
    const normalized = String(value ?? "720")
        .trim()
        .toLowerCase();
    if (normalized === "1080" || normalized === "1080p") return "1080p";
    if (normalized === "4k" || normalized === "2160" || normalized === "2160p") return "4k";
    return "720p";
}

function videoDuration(value: unknown): number {
    const duration = Number(value);
    return duration === 4 || duration === 6 || duration === 8 ? duration : 6;
}

function booleanValue(value: unknown, fallback: boolean) {
    if (typeof value === "boolean") return value;
    if (value === undefined || value === null || value === "") return fallback;
    return String(value).toLowerCase() === "true";
}

type ImageRefPlan = { kind: "single"; field: string } | { kind: "array"; field: string };

function imageRefFieldPlan(model: string): ImageRefPlan | undefined {
    const fromCatalog = detectHiapiImageField(model);
    if (fromCatalog && fromCatalog.kind !== "media") return fromCatalog;
    // GPT Image 2 keeps the legacy input_urls (array).
    if (/^gpt-image-2\/image-to-image$/i.test(model)) return { kind: "array", field: "input_urls" };
    // Grok Imagine 2.0 takes a single image string.
    if (/^grok-imagine-image-2\.0\/image-to-image$/i.test(model)) return { kind: "single", field: "image" };
    // All other image-to-image models (qwen / flux / seedream / grok-imagine-quality / etc.) accept image_urls as an array.
    if (/\/(?:image-to-image|image-edit)$/i.test(model)) return { kind: "array", field: "image_urls" };
    return undefined;
}

function applyImageRefField(input: Record<string, unknown>, plan: ImageRefPlan, images: string[]) {
    if (plan.kind === "single") input[plan.field] = images[0];
    else input[plan.field] = images.slice(0, 5);
}

function imageInput(request: MediaGenerateRequest) {
    const { config, prompt, images, params } = request;
    const selected = modelAndRoute(config.model);
    const model = images.length && /\/text-to-image$/i.test(selected.model) ? selected.model.replace(/\/text-to-image$/i, "/image-to-image") : selected.model;
    // i2i-only 模型缺参考图必被远端拒（input_urls missing）；本地预检直接报错，省一次注定失败的远端往返（spec 2026-09-11 §4.5）
    if (!images.length && /\/(?:image-to-image|image-edit)$/i.test(model)) {
        throw new Error(i18n.t("apiErrors.hiapiImageToImageNeedsReference", { model }));
    }
    const route = selected.route;
    const isBeta = route === "beta" || /@beta$/i.test(config.model);
    const input: Record<string, unknown> = { prompt };
    if (isBeta) {
        input.size = betaImageSize(params.size ?? config.size);
    } else {
        const requestedRatio = aspectRatio(params.ratio ?? params.size ?? config.size) || "auto";
        const requestedResolution = imageResolution(params.resolution ?? params.quality ?? config.quality);
        input.aspect_ratio = resolveCatalogFieldValue(model, "aspect_ratio", requestedRatio);
        input.resolution = resolveCatalogFieldValue(model, "resolution", requestedResolution);
    }
    if (route === "ext") input.quality = String(params.quality ?? "auto").toLowerCase() === "high" ? "high" : "low";
    if (images.length) {
        const plan = imageRefFieldPlan(model);
        if (plan) applyImageRefField(input, plan, images);
    }
    return { model, ...(route ? { route } : {}), input };
}

type VideoImagePlan = { kind: "single"; field: string } | { kind: "array"; field: string } | { kind: "media" };

function videoImagePlan(model: string): VideoImagePlan | undefined {
    const fromCatalog = detectHiapiImageField(model);
    if (fromCatalog) return fromCatalog;
    // Seedance family (image-to-video) takes the first frame as a single first_frame_url.
    if (/^seedance-2\.0(?:-[\w.-]+)?$/i.test(model)) return { kind: "single", field: "first_frame_url" };
    if (/^seedance-[\w.-]+\/image-to-video$/i.test(model)) return { kind: "single", field: "first_frame_url" };
    // Seedance reference-to-video takes an array of reference images.
    if (/^seedance-[\w.-]+\/reference-to-video$/i.test(model)) return { kind: "array", field: "reference_image_urls" };
    // Kling / HappyHorse / Grok Imagine expose image_urls as an array.
    if (/^(?:kling-[\w.-]+|happyhorse-[\w.-]+|grok-imagine(?:-[\w.-]+)?)\/image-to-video$/i.test(model)) return { kind: "array", field: "image_urls" };
    if (/^(?:gemini-omni-flash|happyhorse-[\w.-]+)\/reference-to-video$/i.test(model)) return { kind: "array", field: "reference_image_urls" };
    // Veo / Hailuo / Gemini-omni-flash accept a single image_url.
    if (/^(?:veo-[\w.-]+|hailuo-[\w.-]+|gemini-omni-flash)\/image-to-video$/i.test(model)) return { kind: "single", field: "image_url" };
    // Wan 2.7 video expects a media descriptor list with first_frame entries.
    if (/^wan2\.7-video\/image-to-video$/i.test(model)) return { kind: "media" };
    return undefined;
}

function applyVideoImageInput(input: Record<string, unknown>, plan: VideoImagePlan, images: string[]) {
    const first = images[0];
    if (plan.kind === "single") input[plan.field] = first;
    else if (plan.kind === "array") input[plan.field] = [first];
    else input.media = [{ type: "first_frame", url: first }];
}

function videoInput(request: MediaGenerateRequest) {
    const { config, prompt, images, params } = request;
    const selected = modelAndRoute(config.model);
    const requestedRatio = aspectRatio(params.ratio ?? params.size ?? config.size) || (images.length ? "auto" : "16:9");
    const requestedResolution = videoResolution(params.resolution ?? params.vquality ?? config.vquality);
    const requestedDuration = videoDuration(params.seconds ?? params.duration ?? config.videoSeconds);
    const input: Record<string, unknown> = {
        prompt,
        aspect_ratio: resolveCatalogFieldValue(selected.model, "aspect_ratio", requestedRatio),
        resolution: resolveCatalogFieldValue(selected.model, "resolution", requestedResolution),
        duration: resolveCatalogFieldValue(selected.model, "duration", requestedDuration),
        generate_audio: booleanValue(params.generateAudio ?? config.videoGenerateAudio, true),
    };
    if (images.length) {
        const plan = videoImagePlan(selected.model);
        if (plan) applyVideoImageInput(input, plan, images);
    }
    return { model: selected.model, ...(selected.route ? { route: selected.route } : {}), input };
}

function audioInput(request: MediaGenerateRequest) {
    const { config, prompt, params } = request;
    const selected = modelAndRoute(config.model);
    if (/^elevenlabs\/text-to-dialogue/i.test(selected.model)) {
        const voice = nonEmpty(params.voice) ?? nonEmpty(config.audioVoice) ?? HIAPI_AUDIO_VOICE;
        return { model: selected.model, ...(selected.route ? { route: selected.route } : {}), input: { dialogue: [{ text: prompt, voice: voice === "alloy" ? HIAPI_AUDIO_VOICE : voice }], stability: Number(params.stability ?? 0.5) } };
    }
    return {
        model: selected.model,
        ...(selected.route ? { route: selected.route } : {}),
        input: {
            text: prompt,
            voice: (() => {
                const voice = nonEmpty(params.voice) ?? nonEmpty(config.audioVoice) ?? "longanlingxin";
                return voice === "alloy" ? "longanlingxin" : voice;
            })(),
            format: nonEmpty(params.format) ?? (config.audioFormat || "mp3"),
            ...(params.speed !== undefined || config.audioSpeed ? { rate: Number(params.speed ?? config.audioSpeed) || 1 } : {}),
            ...(nonEmpty(params.instructions) || nonEmpty(config.audioInstructions) ? { instruction: nonEmpty(params.instructions) ?? config.audioInstructions.trim() } : {}),
        },
    };
}

function musicInput(request: MediaGenerateRequest) {
    const { config, prompt, params } = request;
    const selected = modelAndRoute(config.model);
    return {
        model: selected.model,
        ...(selected.route ? { route: selected.route } : {}),
        input: {
            prompt,
            ...(typeof params.lyrics === "string" ? { lyrics: params.lyrics } : {}),
            audio_format: nonEmpty(params.format) ?? (config.audioFormat || "mp3"),
        },
    };
}

function readSubmitErrorMessage(error: unknown): string | undefined {
    if (!axios.isAxiosError(error)) return undefined;
    const data = error.response?.data;
    const payload = data && typeof data === "object" && !Array.isArray(data) ? (data as { error?: { message?: unknown }; message?: unknown; base_resp?: { status_msg?: unknown }; detail?: unknown }) : undefined;
    const fromErrorObject = payload?.error && typeof payload.error === "object" ? (payload.error as { message?: unknown }).message : undefined;
    const fromBaseResp = payload?.base_resp && typeof payload.base_resp === "object" ? (payload.base_resp as { status_msg?: unknown }).status_msg : undefined;
    return nonEmpty(fromErrorObject) ?? nonEmpty(payload?.message) ?? nonEmpty(fromBaseResp) ?? nonEmpty(payload && typeof payload.detail === "string" ? payload.detail : undefined) ?? nonEmpty(typeof data === "string" ? data : undefined);
}

async function submit(request: MediaGenerateRequest, payload: Record<string, unknown>) {
    try {
        const response = await axios.post<unknown>(endpoint(request.config.baseUrl, "/tasks"), payload, { headers: requestHeaders(request), signal: request.signal });
        return { taskId: taskId(response.data) };
    } catch (error) {
        if (request.idempotencyKey && axios.isAxiosError(error) && error.response?.status === 409) {
            throw idempotencyPendingError(error.response.headers?.["retry-after"]);
        }
        const message = readSubmitErrorMessage(error);
        if (message) throw new Error(message);
        throw error;
    }
}

function outputUrl(task: HiapiTask, expectedType: "image" | "video" | "audio") {
    const output = Array.isArray(task.output) ? task.output : [];
    const typed = output.find((item) => item && typeof item === "object" && (item as HiapiOutput).type === expectedType) as HiapiOutput | undefined;
    const url = nonEmpty(typed?.url);
    if (url) return url;
    return undefined;
}

function audioMimeType(format: unknown) {
    const normalized = String(format || "mp3").toLowerCase();
    if (normalized === "wav") return "audio/wav";
    if (normalized === "opus") return "audio/ogg";
    if (normalized === "pcm") return "audio/pcm";
    return "audio/mpeg";
}

async function query(request: MediaGenerateRequest & { taskId: string }, expectedType: "image" | "video" | "audio"): Promise<MediaTaskQueryResult> {
    const response = await axios.get<unknown>(endpoint(request.config.baseUrl, `/tasks/${encodeURIComponent(request.taskId)}`), { headers: headers(request.config.apiKey), signal: request.signal });
    const payload = taskPayload(response.data);
    if (!payload || typeof payload.status !== "string") return { status: "failed", error: i18n.t("apiErrors.hiapiTaskStatus") };
    if (payload.status === "queued") return { status: "pending", phase: "queued" };
    if (payload.status === "handling" || payload.status === "archiving") return { status: "pending", phase: "running" };
    if (payload.status === "fail") {
        const message = typeof payload.error === "string" ? payload.error : (nonEmpty(payload.error && typeof payload.error === "object" ? payload.error.message : undefined) ?? nonEmpty(payload.message));
        return { status: "failed", error: message ?? i18n.t("apiErrors.hiapiTaskFailed", { type: expectedType }) };
    }
    if (payload.status !== "success") return { status: "failed", error: i18n.t("apiErrors.hiapiUnsupportedStatus") };
    const url = outputUrl(payload, expectedType);
    if (!url) return { status: "failed", error: i18n.t("apiErrors.hiapiResultUrl", { type: expectedType }) };
    if (expectedType === "image") return { status: "succeeded", result: { kind: "image", sources: [url] } };
    if (expectedType === "video") return { status: "succeeded", result: { kind: "video", source: url, mimeType: "video/mp4" } };
    return { status: "succeeded", result: { kind: "audio", source: url, mimeType: audioMimeType(request.config.audioFormat) } };
}

export const hiapiImageAdapter: MediaAdapter = {
    id: "hiapi.image",
    version: 1,
    modality: "image",
    execution: "remote_task",
    idempotentSubmit: true,
    submit: async (request) => {
        await fetchHiapiCatalog();
        return submit(request, imageInput(request));
    },
    query: (request) => query(request, "image"),
};

export const hiapiVideoAdapter: MediaAdapter = {
    id: "hiapi.video",
    version: 1,
    modality: "video",
    execution: "remote_task",
    idempotentSubmit: true,
    submit: async (request) => {
        await fetchHiapiCatalog();
        return submit(request, videoInput(request));
    },
    query: (request) => query(request, "video"),
};

export const hiapiAudioAdapter: MediaAdapter = {
    id: "hiapi.speech",
    version: 1,
    modality: "speech",
    execution: "remote_task",
    idempotentSubmit: true,
    submit: (request) => submit(request, audioInput(request)),
    query: (request) => query(request, "audio"),
};

export const hiapiMusicAdapter: MediaAdapter = {
    id: "hiapi.music",
    version: 1,
    modality: "music",
    execution: "remote_task",
    idempotentSubmit: true,
    submit: (request) => submit(request, musicInput(request)),
    query: (request) => query(request, "audio"),
};
