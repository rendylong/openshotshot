import axios from "axios";

import type { MediaAdapter, MediaGenerateRequest, MediaTaskQueryResult } from "./types";

type GlmError = { code?: unknown; message?: unknown };
type GlmTaskPayload = {
    id?: unknown;
    task_status?: unknown;
    image_result?: unknown;
    video_result?: unknown;
    error?: GlmError | string | null;
    error_message?: unknown;
    message?: unknown;
};

type GlmMediaKind = "image" | "video";

const GLM_IMAGE_RATIO_SIZES: Readonly<Record<string, string>> = {
    "1:1": "1280x1280",
    "3:2": "1568x1056",
    "2:3": "1056x1568",
    "4:3": "1472x1088",
    "3:4": "1088x1472",
    "16:9": "1728x960",
    "9:16": "960x1728",
};

const GLM_VIDEO_RATIO_SIZES: Readonly<Record<string, string>> = {
    "16:9": "1280x720",
    "3:2": "1280x720",
    "4:3": "1280x720",
    "9:16": "720x1280",
    "2:3": "720x1280",
    "3:4": "720x1280",
    "1:1": "1024x1024",
};

function trimBase(baseUrl: string) {
    return baseUrl.trim().replace(/\/+$/, "");
}

const glmEndpoints = (baseUrl: string) => ({
    imageSubmit: `${trimBase(baseUrl)}/async/images/generations`,
    videoSubmit: `${trimBase(baseUrl)}/videos/generations`,
    task: (taskId: string) => `${trimBase(baseUrl)}/async-result/${encodeURIComponent(taskId)}`,
});

function glmHeaders(apiKey: string) {
    return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
}

function asTaskPayload(value: unknown): GlmTaskPayload | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as GlmTaskPayload) : undefined;
}

function providerError(payload: GlmTaskPayload, fallback: string): string {
    if (typeof payload.error === "string") return nonEmptyString(payload.error) ?? fallback;
    const message = nonEmptyString(payload.error?.message) ?? nonEmptyString(payload.error_message) ?? nonEmptyString(payload.message);
    return message ?? fallback;
}

function taskId(payload: GlmTaskPayload, kind: GlmMediaKind): string {
    const id = nonEmptyString(payload.id);
    if (!id) throw new Error(`Zhipu did not return ${kind === "image" ? "an image" : "a video"} task ID`);
    return id;
}

function imageSuccess(payload: GlmTaskPayload): MediaTaskQueryResult {
    const sources = Array.isArray(payload.image_result)
        ? payload.image_result
              .map((item) => (item && typeof item === "object" ? nonEmptyString((item as { url?: unknown }).url) : undefined))
              .filter((source): source is string => Boolean(source))
        : [];
    if (!sources.length) throw new Error("Zhipu did not return an image result URL");
    return { status: "succeeded", result: { kind: "image", sources } };
}

function videoSuccess(payload: GlmTaskPayload): MediaTaskQueryResult {
    const first = Array.isArray(payload.video_result) ? payload.video_result[0] : undefined;
    const source = first && typeof first === "object" ? nonEmptyString((first as { url?: unknown }).url) : undefined;
    if (!source) throw new Error("Zhipu did not return a video result URL");
    return { status: "succeeded", result: { kind: "video", source, mimeType: "video/mp4" } };
}

function glmTaskState(payload: GlmTaskPayload, kind: GlmMediaKind): MediaTaskQueryResult {
    if (payload.error) return { status: "failed", error: providerError(payload, `Zhipu ${kind} task failed`) };
    if (payload.task_status === undefined || payload.task_status === null || payload.task_status === "") {
        return { status: "failed", error: "Zhipu did not return a media task status" };
    }
    if (typeof payload.task_status !== "string") {
        return { status: "failed", error: "Zhipu returned an invalid media task status" };
    }
    if (payload.task_status === "PROCESSING") return { status: "pending", phase: "running" };
    if (payload.task_status === "SUCCESS") return kind === "image" ? imageSuccess(payload) : videoSuccess(payload);
    if (payload.task_status === "FAIL" || payload.task_status === "FAILED") {
        return { status: "failed", error: providerError(payload, `Zhipu ${kind} task failed`) };
    }
    return { status: "failed", error: "Zhipu returned an unsupported media task status" };
}

function videoAudio(request: MediaGenerateRequest): boolean {
    const value = request.params.generateAudio ?? request.config.videoGenerateAudio;
    if (typeof value === "boolean") return value;
    return String(value) === "true";
}

function explicitSize(value: string): boolean {
    return /^[1-9]\d*x[1-9]\d*$/.test(value);
}

function normalizeGlmImageSize(value: unknown): string {
    if (value === undefined || value === null) return "1280x1280";
    if (typeof value !== "string") throw new Error("Zhipu image size must be WIDTHxHEIGHT or a supported aspect ratio");
    const size = value.trim();
    if (!size || size === "auto") return "1280x1280";
    if (explicitSize(size)) return size;
    const mapped = GLM_IMAGE_RATIO_SIZES[size];
    if (mapped) return mapped;
    throw new Error("Zhipu image size must be WIDTHxHEIGHT or a supported aspect ratio");
}

function normalizeGlmVideoSize(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new Error("Zhipu video size must be WIDTHxHEIGHT, auto, or a supported aspect ratio");
    const size = value.trim();
    if (!size || size === "auto") return undefined;
    if (explicitSize(size)) return size;
    const mapped = GLM_VIDEO_RATIO_SIZES[size];
    if (mapped) return mapped;
    throw new Error("Zhipu video size must be WIDTHxHEIGHT, auto, or a supported aspect ratio");
}

async function queryTask(request: MediaGenerateRequest & { taskId: string }, kind: GlmMediaKind): Promise<MediaTaskQueryResult> {
    const response = await axios.get<unknown>(glmEndpoints(request.config.baseUrl).task(request.taskId), {
        headers: glmHeaders(request.config.apiKey),
        signal: request.signal,
    });
    const payload = asTaskPayload(response.data);
    return payload ? glmTaskState(payload, kind) : { status: "failed", error: "Zhipu returned an invalid media task payload" };
}

export const zhipuImageAdapter: MediaAdapter = {
    id: "zhipu.image",
    version: 1,
    modality: "image",
    execution: "remote_task",
    submit: async ({ config, prompt, params, signal }) => {
        const size = normalizeGlmImageSize(params.size === undefined ? config.size : params.size);
        const response = await axios.post<unknown>(
            glmEndpoints(config.baseUrl).imageSubmit,
            { model: config.model, prompt, size },
            { headers: glmHeaders(config.apiKey), signal },
        );
        const payload = asTaskPayload(response.data) ?? {};
        if (payload.error) throw new Error(providerError(payload, "Zhipu image submission failed"));
        return { taskId: taskId(payload, "image") };
    },
    query: async (request) => queryTask(request, "image"),
};

export const zhipuVideoAdapter: MediaAdapter = {
    id: "zhipu.video",
    version: 1,
    modality: "video",
    execution: "remote_task",
    submit: async (request) => {
        const { config, prompt, images, params, signal } = request;
        const size = normalizeGlmVideoSize(params.size === undefined ? config.size : params.size);
        const response = await axios.post<unknown>(
            glmEndpoints(config.baseUrl).videoSubmit,
            {
                model: config.model,
                prompt,
                ...(images[0] ? { image_url: images[0] } : {}),
                with_audio: videoAudio(request),
                ...(size ? { size } : {}),
            },
            { headers: glmHeaders(config.apiKey), signal },
        );
        const payload = asTaskPayload(response.data) ?? {};
        if (payload.error) throw new Error(providerError(payload, "Zhipu video submission failed"));
        return { taskId: taskId(payload, "video") };
    },
    query: async (request) => queryTask(request, "video"),
};
