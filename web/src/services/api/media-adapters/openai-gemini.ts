import axios from "axios";

import i18n from "@/i18n";
import { audioMimeType, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { requestOpenAISpeech } from "@/services/api/audio";
import { requestGeminiImages, requestOpenAIImages } from "@/services/api/image";
import { createOpenAIVideoTask, pollOpenAIVideoTask } from "@/services/api/video";
import type { ReferenceImage } from "@/types/image";

import type { MediaAdapter, MediaGenerateRequest, MediaTaskQueryResult } from "./types";

type GeminiInlineData = { mimeType?: unknown; mime_type?: unknown; data?: unknown };
type GeminiPart = { inlineData?: GeminiInlineData; inline_data?: GeminiInlineData };
type GeminiSpeechPayload = {
    candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
    error?: { message?: unknown };
};
type GeminiOperationPayload = {
    name?: unknown;
    done?: unknown;
    error?: { message?: unknown };
    response?: { generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: unknown } }> } };
};

const GEMINI_VOICE_NAMES = [
    "Zephyr",
    "Puck",
    "Charon",
    "Kore",
    "Fenrir",
    "Leda",
    "Orus",
    "Aoede",
    "Callirrhoe",
    "Autonoe",
    "Enceladus",
    "Iapetus",
    "Umbriel",
    "Algieba",
    "Despina",
    "Erinome",
    "Algenib",
    "Rasalgethi",
    "Laomedeia",
    "Achernar",
    "Alnilam",
    "Schedar",
    "Gacrux",
    "Pulcherrima",
    "Achird",
    "Zubenelgenubi",
    "Vindemiatrix",
    "Sadachbia",
    "Sadaltager",
    "Sulafat",
] as const;
const GEMINI_VOICE_BY_LOWERCASE = new Map(GEMINI_VOICE_NAMES.map((voice) => [voice.toLowerCase(), voice]));

function selectedCount(request: MediaGenerateRequest) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(request.params.count ?? request.config.count)) || 1)));
}

function withSystemPrompt(config: MediaGenerateRequest["config"], prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function referenceImage(source: string, index: number): ReferenceImage {
    const type = source.match(/^data:([^;,]+)/i)?.[1] || "image/png";
    return { id: `adapter-reference-${index}`, name: `reference-${index + 1}`, type, dataUrl: source };
}

function referenceImages(sources: string[]) {
    return sources.map(referenceImage);
}

function optionalMask(value: unknown): ReferenceImage | undefined {
    return typeof value === "string" && value ? referenceImage(value, -1) : undefined;
}

function trimGeminiBaseUrl(baseUrl: string) {
    return baseUrl
        .trim()
        .replace(/\/+$/, "")
        .replace(/\/v1(?:beta)?$/i, "");
}

function geminiModelUrl(request: MediaGenerateRequest, action: "generateContent" | "predictLongRunning") {
    return `${trimGeminiBaseUrl(request.config.baseUrl)}/v1beta/models/${encodeURIComponent(request.config.model)}:${action}`;
}

function geminiHeaders(apiKey: string) {
    return { "Content-Type": "application/json", "x-goog-api-key": apiKey };
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function decodeBase64(source: string) {
    const binary = atob(source);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function geminiVoiceName(value: unknown) {
    if (typeof value !== "string") return "Kore";
    return GEMINI_VOICE_BY_LOWERCASE.get(value.trim().toLowerCase()) || "Kore";
}

function pcmSampleRate(mimeType: string) {
    const value = Number(mimeType.match(/(?:^|[;\s])rate\s*=\s*(\d+)/i)?.[1]);
    return Number.isFinite(value) && value > 0 ? value : 24_000;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string) {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
}

function pcm16ToWav(pcm: Uint8Array, sampleRate: number) {
    const bytes = new Uint8Array(44 + pcm.byteLength);
    const view = new DataView(bytes.buffer);
    writeAscii(bytes, 0, "RIFF");
    view.setUint32(4, 36 + pcm.byteLength, true);
    writeAscii(bytes, 8, "WAVE");
    writeAscii(bytes, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(bytes, 36, "data");
    view.setUint32(40, pcm.byteLength, true);
    bytes.set(pcm, 44);
    return bytes;
}

function geminiAudioBlob(data: string, mimeType: string) {
    const bytes = decodeBase64(data);
    if (/^audio\/(?:l16|pcm)(?:;|$)/i.test(mimeType)) return new Blob([pcm16ToWav(bytes, pcmSampleRate(mimeType))], { type: "audio/wav" });
    return new Blob([bytes], { type: mimeType });
}

function geminiInlineData(payload: GeminiSpeechPayload): { data: string; mimeType: string } {
    if (payload.error?.message) throw new Error(String(payload.error.message));
    const inline = payload.candidates
        ?.flatMap((candidate) => candidate.content?.parts || [])
        .map((part) => part.inlineData || part.inline_data)
        .find((value) => nonEmptyString(value?.data));
    const data = nonEmptyString(inline?.data);
    if (!data) throw new Error(i18n.t("modelPlugin.templates.geminiNoAudio"));
    return { data, mimeType: nonEmptyString(inline?.mimeType) || nonEmptyString(inline?.mime_type) || "audio/L16;rate=24000" };
}

function geminiOperationUrl(request: MediaGenerateRequest, taskId: string) {
    const operation = taskId.trim().replace(/^\/+/, "");
    if (!operation || operation.includes("..") || !/^[\w./~-]+$/.test(operation)) throw new Error(i18n.t("apiErrors.geminiInvalidVideoOperation"));
    return `${trimGeminiBaseUrl(request.config.baseUrl)}/v1beta/${operation.split("/").map(encodeURIComponent).join("/")}`;
}

function geminiVideoSource(uri: string, apiKey: string) {
    if (/[?&]key=/i.test(uri)) return uri;
    return `${uri}${uri.includes("?") ? "&" : "?"}key=${encodeURIComponent(apiKey)}`;
}

function veoQueryResult(payload: GeminiOperationPayload, apiKey: string): MediaTaskQueryResult {
    if (payload.error) return { status: "failed", error: nonEmptyString(payload.error.message) || i18n.t("apiErrors.geminiVideoGenerationFailed") };
    if (payload.done !== true) return { status: "pending", phase: "running" };
    const uri = nonEmptyString(payload.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri);
    if (!uri) return { status: "failed", error: i18n.t("modelPlugin.templates.geminiNoVideoUri") };
    return { status: "succeeded", result: { kind: "video", source: geminiVideoSource(uri, apiKey), mimeType: "video/mp4" } };
}

export const openAIImageAdapter: MediaAdapter = {
    id: "openai.image",
    version: 1,
    modality: "image",
    execution: "direct",
    generate: async (request) => {
        const config = {
            ...request.config,
            count: String(request.params.count ?? request.config.count),
            size: typeof request.params.size === "string" ? request.params.size : request.config.size,
            quality: typeof request.params.quality === "string" ? request.params.quality : request.config.quality,
            background: typeof request.params.background === "string" ? request.params.background : request.config.background,
        };
        const images = await requestOpenAIImages(config, withSystemPrompt(config, request.prompt), referenceImages(request.images), selectedCount(request), optionalMask(request.params.mask), { signal: request.signal });
        return { kind: "image", sources: images.map((image) => image.dataUrl) };
    },
};

export const openAISpeechAdapter: MediaAdapter = {
    id: "openai.speech",
    version: 1,
    modality: "speech",
    execution: "direct",
    generate: async ({ config, prompt, params, signal }) => {
        const format = normalizeAudioFormatValue(typeof params.format === "string" ? params.format : config.audioFormat);
        const voice = normalizeAudioVoiceValue(typeof params.voice === "string" ? params.voice : config.audioVoice);
        const speed = Number(normalizeAudioSpeedValue(String(params.speed ?? config.audioSpeed)));
        const instructions = typeof params.instructions === "string" ? params.instructions.trim() : config.audioInstructions.trim();
        const source = await requestOpenAISpeech(config, prompt, voice, format, speed, instructions, signal);
        return { kind: "audio", source, mimeType: source.type || audioMimeType(format) };
    },
};

export const openAIVideoAdapter: MediaAdapter = {
    id: "openai.video",
    version: 1,
    modality: "video",
    execution: "remote_task",
    submit: async ({ config, prompt, images, params, signal }) => {
        const requestConfig = {
            ...config,
            videoSeconds: String(params.seconds ?? config.videoSeconds),
            size: typeof params.size === "string" ? params.size : config.size,
            vquality: typeof params.resolution === "string" ? params.resolution : config.vquality,
        };
        const task = await createOpenAIVideoTask(requestConfig, requestConfig.model, prompt, referenceImages(images), { signal });
        return { taskId: task.id };
    },
    query: (request) => queryOpenAIVideo(request),
    recover: (request) => queryOpenAIVideo(request, true),
};

export const geminiImageAdapter: MediaAdapter = {
    id: "gemini.image",
    version: 1,
    modality: "image",
    execution: "direct",
    generate: async (request) => {
        if (request.params.mask) throw new Error(i18n.t("apiErrors.geminiMaskUnsupported"));
        const images = await requestGeminiImages(request.config, request.prompt, referenceImages(request.images), selectedCount(request), { signal: request.signal });
        return { kind: "image", sources: images.map((image) => image.dataUrl) };
    },
};

export const geminiSpeechAdapter: MediaAdapter = {
    id: "gemini.speech",
    version: 1,
    modality: "speech",
    execution: "direct",
    generate: async (request) => {
        const voiceName = geminiVoiceName(request.params.voice || request.config.audioVoice);
        const response = await axios.post<GeminiSpeechPayload>(
            geminiModelUrl(request, "generateContent"),
            {
                contents: [{ role: "user", parts: [{ text: request.prompt }] }],
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
                },
            },
            { headers: geminiHeaders(request.config.apiKey), signal: request.signal },
        );
        const audio = geminiInlineData(response.data);
        const source = geminiAudioBlob(audio.data, audio.mimeType);
        return { kind: "audio", source, mimeType: source.type };
    },
};

export const geminiVideoAdapter: MediaAdapter = {
    id: "gemini.video",
    version: 1,
    modality: "video",
    execution: "remote_task",
    submit: async (request) => {
        const instance: Record<string, unknown> = { prompt: request.prompt };
        const first = request.images[0]?.match(/^data:([^;]+);base64,(.*)$/);
        if (first) instance.image = { bytesBase64Encoded: first[2], mimeType: first[1] };
        const response = await axios.post<GeminiOperationPayload>(
            geminiModelUrl(request, "predictLongRunning"),
            {
                instances: [instance],
                parameters: { aspectRatio: typeof request.params.ratio === "string" ? request.params.ratio : request.config.size },
            },
            { headers: geminiHeaders(request.config.apiKey), signal: request.signal },
        );
        const taskId = nonEmptyString(response.data.name);
        if (!taskId) throw new Error(i18n.t("apiErrors.geminiNoVideoOperation"));
        geminiOperationUrl(request, taskId);
        return { taskId };
    },
    query: async (request) => {
        const response = await axios.get<GeminiOperationPayload>(geminiOperationUrl(request, request.taskId), {
            headers: geminiHeaders(request.config.apiKey),
            signal: request.signal,
        });
        return veoQueryResult(response.data, request.config.apiKey);
    },
};

async function queryOpenAIVideo({ config, taskId, signal, onPhase }: MediaGenerateRequest & { taskId: string }, recoverDelivery = false): Promise<MediaTaskQueryResult> {
    const state = await pollOpenAIVideoTask(config, { id: taskId, provider: "openai", model: config.model }, { signal, onPhase, recoverDelivery });
    if (state.status === "pending") return { status: "pending", phase: state.phase ?? "running" };
    if (state.status === "failed") return state;
    const source = state.result.blob || state.result.url;
    if (!source) return { status: "failed", error: i18n.t("apiErrors.noPlayableVideo") };
    return { status: "succeeded", result: { kind: "video", source, mimeType: state.result.mimeType || (source instanceof Blob ? source.type : "video/mp4") } };
}
