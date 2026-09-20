import axios, { type AxiosResponse } from "axios";

import { audioMimeType } from "@/lib/audio-generation";
import type { MediaTaskQueryResult } from "@/services/api/media-adapters/types";
import type { AiConfig, ChannelProvider } from "@/stores/use-config-store";

const ENDPOINTS_V1 = {
    image: "/v1/image_generation",
    speech: "/v1/t2a_v2",
    music: "/v1/music_generation",
    videoSubmit: "/v1/video_generation",
    videoQuery: "/v1/query/video_generation",
    file: "/v1/files/retrieve",
} as const;

const ENDPOINTS_V2 = {
    image: "/v1/image_generation",
    speech: "/v1/t2a_v2",
    music: "/v1/music_generation",
    videoSubmit: "/v2/video_generation",
    videoQuery: "/v2/query/video_generation",
    file: "/v1/files/retrieve",
} as const;

function minimaxVideoApiVersion(model: string): "v1" | "v2" {
    const lower = model.toLowerCase();
    const hSeriesMatch = lower.match(/^minimax-h(\d+)/);
    if (hSeriesMatch && Number(hSeriesMatch[1]) >= 3) return "v2";
    const hailuoMatch = lower.match(/hailuo-(\d+)/);
    if (hailuoMatch && Number(hailuoMatch[1]) >= 3) return "v2";
    return "v1";
}

function minimaxVideoEndpoints(model: string) {
    return minimaxVideoApiVersion(model) === "v2" ? ENDPOINTS_V2 : ENDPOINTS_V1;
}

const MINIMAX_V2_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
type MiniMaxV2Ratio = (typeof MINIMAX_V2_RATIOS)[number];

const MINIMAX_V2_H3 = { name: "MiniMax-H3", minDuration: 4, resolutions: new Set(["480P", "768P", "2K"]) };
const MINIMAX_V2_H3_MAX = { name: "MiniMax-H3-Max", minDuration: 5, resolutions: new Set(["480P", "768P"]) };
const MINIMAX_V2_MAX_DURATION = 15;

function minimaxV2Profile(model: string) {
    return /h3-max$/i.test(model) ? MINIMAX_V2_H3_MAX : MINIMAX_V2_H3;
}

function minimaxV2ModelName(model: string) {
    if (/^minimax-h3-max$/i.test(model)) return MINIMAX_V2_H3_MAX.name;
    if (/^minimax-h3$/i.test(model)) return MINIMAX_V2_H3.name;
    return model;
}

export function snapMinimaxVideoRatio(ratio: unknown): MiniMaxV2Ratio {
    const value = String(ratio ?? "").trim().toLowerCase();
    if ((MINIMAX_V2_RATIOS as readonly string[]).includes(value)) return value as MiniMaxV2Ratio;
    const dimensions = value.match(/^(\d+)[x×](\d+)$/i);
    if (dimensions) {
        const target = Number(dimensions[1]) / Number(dimensions[2]);
        if (target > 0) {
            let closest: MiniMaxV2Ratio = MINIMAX_V2_RATIOS[1];
            let smallestGap = Infinity;
            for (const candidate of MINIMAX_V2_RATIOS) {
                const [width, height] = candidate.split(":").map(Number);
                const gap = Math.abs(Math.log(target / (width / height)));
                if (gap < smallestGap) {
                    smallestGap = gap;
                    closest = candidate;
                }
            }
            return closest;
        }
    }
    return "16:9";
}

function minimaxV2Duration(model: string, seconds: unknown) {
    const requested = Math.floor(Number(seconds));
    if (!Number.isFinite(requested) || requested <= 0) return 6;
    return Math.min(MINIMAX_V2_MAX_DURATION, Math.max(minimaxV2Profile(model).minDuration, requested));
}

function minimaxV2Resolution(model: string, resolution: unknown) {
    const requested = String(resolution ?? "").trim().toUpperCase();
    const candidate = requested.includes("480") ? "480P" : requested.includes("2K") ? "2K" : "768P";
    return minimaxV2Profile(model).resolutions.has(candidate) ? candidate : "768P";
}

function minimaxV2VideoBody(config: AiConfig, prompt: string, images: string[], params: Record<string, unknown>) {
    const image = images[0]?.trim() || "";
    return {
        model: minimaxV2ModelName(config.model),
        content: [
            { type: "text", text: prompt },
            ...(image ? [{ type: "image_url", image_url: image, role: "first_frame" }] : []),
        ],
        resolution: minimaxV2Resolution(config.model, params.resolution),
        duration: minimaxV2Duration(config.model, params.seconds),
        ...(image ? {} : { ratio: snapMinimaxVideoRatio(params.ratio) }),
        ...(params.watermark === true ? { aigc_watermark: true } : {}),
    };
}

function minimaxV1VideoBody(config: AiConfig, prompt: string, images: string[], params: Record<string, unknown>) {
    const seconds = Math.floor(Number(params.seconds) || 6);
    const duration = seconds >= 10 ? 10 : 6;
    const requestedResolution = String(params.resolution || "").toUpperCase();
    return {
        model: config.model,
        prompt,
        ...(images[0] ? { first_frame_image: images[0] } : {}),
        resolution: duration === 10 ? "768P" : requestedResolution.includes("1080") ? "1080P" : "768P",
        duration,
    };
}

function minimaxV2RequestError(error: unknown) {
    if (axios.isAxiosError(error)) {
        const message = (error.response?.data as { error?: { message?: unknown } } | undefined)?.error?.message;
        if (typeof message === "string" && message.trim()) return new Error(message.trim());
    }
    return error;
}

const MINIMAX_IMAGE_RATIOS = new Set(["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"]);
const OPENAI_VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"]);

type MiniMaxBaseResponse = { status_code?: number; status_msg?: string };
type MiniMaxImageResponse = { data?: { image_base64?: string[]; image_urls?: string[] }; base_resp?: MiniMaxBaseResponse };
type MiniMaxSpeechResponse = { data?: { audio?: string; status?: number }; base_resp?: MiniMaxBaseResponse };
type MiniMaxVideoSubmitResponse = { task_id?: string; base_resp?: MiniMaxBaseResponse };
type MiniMaxVideoQueryResponse = { status?: unknown; file_id?: string; error_message?: string; base_resp?: MiniMaxBaseResponse };
type MiniMaxV2VideoQueryResponse = { task?: { status?: unknown; content?: { url?: unknown }; error?: { message?: unknown } } };
type MiniMaxFileResponse = { file?: { download_url?: string }; base_resp?: MiniMaxBaseResponse };

export function isMiniMaxProvider(provider: ChannelProvider | undefined) {
    return provider === "minimax-cn" || provider === "minimax-global";
}

export async function requestMiniMaxImages(config: AiConfig, prompt: string, images: string[], count: number, signal?: AbortSignal) {
    const size = config.size.trim();
    const dimensions = size.match(/^(\d+)x(\d+)$/i);
    const response = await axios.post<MiniMaxImageResponse>(
        miniMaxUrl(config.baseUrl, ENDPOINTS_V1.image),
        {
            model: config.model,
            prompt,
            response_format: "base64",
            n: Math.max(1, Math.min(9, count)),
            ...(MINIMAX_IMAGE_RATIOS.has(size) ? { aspect_ratio: size } : dimensions ? { width: Number(dimensions[1]), height: Number(dimensions[2]) } : {}),
            ...(images.length ? { subject_reference: images.map((image_file) => ({ type: "character", image_file })) } : {}),
        },
        { headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" }, signal },
    );
    assertMiniMaxSuccess(response.data.base_resp);
    const base64 = response.data.data?.image_base64 || [];
    const urls = response.data.data?.image_urls || [];
    const results = [...base64.map((value) => `data:image/jpeg;base64,${value}`), ...urls];
    if (!results.length) throw new Error("MiniMax did not return an image");
    return results;
}

export async function requestMiniMaxSpeech(config: AiConfig, text: string, format: string, speed: number, signal?: AbortSignal) {
    const requestedVoice = config.audioVoice.trim();
    const voiceId = !requestedVoice || OPENAI_VOICES.has(requestedVoice) ? "male-qn-qingse" : requestedVoice;
    const requestedFormat = ["mp3", "wav", "flac", "pcm"].includes(format) ? format : "mp3";
    const response = await axios.post<MiniMaxSpeechResponse>(
        miniMaxUrl(config.baseUrl, ENDPOINTS_V1.speech),
        {
            model: config.model,
            text,
            stream: false,
            output_format: "hex",
            voice_setting: { voice_id: voiceId, speed: Math.max(0.5, Math.min(2, speed)), vol: 1, pitch: 0 },
            audio_setting: { sample_rate: 32000, bitrate: 128000, format: requestedFormat, channel: 1 },
        },
        { headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" }, signal },
    );
    assertMiniMaxSuccess(response.data.base_resp);
    const hex = response.data.data?.audio?.trim() || "";
    return decodeMiniMaxHex(hex, audioMimeType(requestedFormat), "MiniMax did not return valid audio data");
}

export async function requestMiniMaxMusic(config: AiConfig, prompt: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Blob | string> {
    const lyrics = typeof params.lyrics === "string" ? params.lyrics.trim() : "";
    const outputFormat = params.output_format === "url" ? "url" : "hex";
    const response = await axios.post<MiniMaxSpeechResponse>(
        miniMaxUrl(config.baseUrl, ENDPOINTS_V1.music),
        {
            model: config.model,
            prompt,
            ...(lyrics ? { lyrics } : { lyrics_optimizer: true }),
            stream: false,
            output_format: outputFormat,
        },
        { headers: miniMaxHeaders(config), signal },
    );
    assertMiniMaxSuccess(response.data.base_resp);
    const audio = response.data.data?.audio?.trim() || "";
    if (outputFormat === "url") {
        if (!/^https?:\/\//i.test(audio)) throw new Error("MiniMax did not return a music download URL");
        return audio;
    }
    return decodeMiniMaxHex(audio, "audio/mpeg", "MiniMax did not return valid music data");
}

export async function submitMiniMaxVideo(config: AiConfig, prompt: string, images: string[], params: Record<string, unknown>, signal?: AbortSignal): Promise<{ taskId: string }> {
    const isV2 = minimaxVideoApiVersion(config.model) === "v2";
    let response: AxiosResponse<MiniMaxVideoSubmitResponse>;
    try {
        response = await axios.request<MiniMaxVideoSubmitResponse>({
            method: "post",
            url: miniMaxUrl(config.baseUrl, minimaxVideoEndpoints(config.model).videoSubmit),
            headers: miniMaxHeaders(config),
            data: isV2 ? minimaxV2VideoBody(config, prompt, images, params) : minimaxV1VideoBody(config, prompt, images, params),
            signal,
        });
    } catch (error) {
        throw isV2 ? minimaxV2RequestError(error) : error;
    }
    assertMiniMaxSuccess(response.data.base_resp);
    const taskId = response.data.task_id?.trim() || "";
    if (!taskId) throw new Error("MiniMax did not return a video task ID");
    return { taskId };
}

async function queryMiniMaxV2Video(config: AiConfig, taskId: string, signal?: AbortSignal): Promise<MediaTaskQueryResult> {
    const response = await axios.request<MiniMaxV2VideoQueryResponse>({
        method: "get",
        url: `${miniMaxUrl(config.baseUrl, minimaxVideoEndpoints(config.model).videoQuery)}/${encodeURIComponent(taskId)}`,
        headers: miniMaxHeaders(config),
        signal,
    });
    const status = typeof response.data.task?.status === "string" ? response.data.task.status.trim().toLowerCase() : "";
    if (status === "queued") return { status: "pending", phase: "queued" };
    if (status === "running") return { status: "pending", phase: "running" };
    if (status === "succeeded") {
        const source = typeof response.data.task?.content?.url === "string" ? response.data.task.content.url.trim() : "";
        if (!source) return { status: "failed", error: "MiniMax did not return a video download URL" };
        return { status: "succeeded", result: { kind: "video", source, mimeType: "video/mp4" } };
    }
    if (status === "failed" || status === "cancelled") {
        const message = typeof response.data.task?.error?.message === "string" ? response.data.task.error.message.trim() : "";
        return { status: "failed", error: message || "MiniMax video generation failed" };
    }
    return { status: "failed", error: "MiniMax returned an unsupported video task status" };
}

export async function queryMiniMaxVideo(config: AiConfig, taskId: string, signal?: AbortSignal): Promise<MediaTaskQueryResult> {
    if (minimaxVideoApiVersion(config.model) === "v2") return queryMiniMaxV2Video(config, taskId, signal);
    const response = await axios.request<MiniMaxVideoQueryResponse>({
        method: "get",
        url: miniMaxUrl(config.baseUrl, minimaxVideoEndpoints(config.model).videoQuery),
        headers: miniMaxHeaders(config),
        params: { task_id: taskId },
        signal,
    });
    const providerError = miniMaxError(response.data.base_resp);
    if (providerError) return { status: "failed", error: providerError };

    if (response.data.status === undefined || response.data.status === null) return { status: "failed", error: "MiniMax did not return a video task status" };
    if (typeof response.data.status !== "string") return { status: "failed", error: "MiniMax returned an invalid video task status" };
    const status = response.data.status.trim().toLowerCase();
    if (!status) return { status: "failed", error: "MiniMax did not return a video task status" };
    if (status === "success") {
        const fileId = response.data.file_id?.trim() || "";
        if (!fileId) return { status: "failed", error: "MiniMax video task succeeded without a file ID" };
        const retrieved = await axios.request<MiniMaxFileResponse>({
            method: "get",
            url: miniMaxUrl(config.baseUrl, ENDPOINTS_V1.file),
            headers: miniMaxHeaders(config),
            params: { file_id: fileId },
            signal,
        });
        const fileError = miniMaxError(retrieved.data.base_resp);
        if (fileError) return { status: "failed", error: fileError };
        const source = retrieved.data.file?.download_url?.trim() || "";
        if (!source) return { status: "failed", error: "MiniMax did not return a video download URL" };
        return { status: "succeeded", result: { kind: "video", source, mimeType: "video/mp4" } };
    }
    if (status === "fail" || status === "failed" || status === "cancelled") {
        return { status: "failed", error: response.data.error_message?.trim() || response.data.base_resp?.status_msg?.trim() || "MiniMax video generation failed" };
    }
    if (status === "queueing" || status === "preparing") return { status: "pending", phase: "queued" };
    if (status === "processing") return { status: "pending", phase: "running" };
    return { status: "failed", error: "MiniMax returned an unsupported video task status" };
}

export function assertMiniMaxSuccess(response: MiniMaxBaseResponse | undefined) {
    if (response?.status_code && response.status_code !== 0) throw new Error(response.status_msg || `MiniMax request failed (${response.status_code})`);
}

function miniMaxError(response: MiniMaxBaseResponse | undefined): string {
    return response?.status_code && response.status_code !== 0 ? response.status_msg?.trim() || `MiniMax request failed (${response.status_code})` : "";
}

function miniMaxUrl(baseUrl: string, endpoint: string): string {
    const normalized = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
    return `${normalized}${endpoint}`;
}

function miniMaxHeaders(config: AiConfig) {
    return { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };
}

function decodeMiniMaxHex(hex: string, mimeType: string, errorMessage: string): Blob {
    if (!hex || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) throw new Error(errorMessage);
    const bytes = Uint8Array.from({ length: hex.length / 2 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
    return new Blob([bytes], { type: mimeType });
}
