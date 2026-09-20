import { assertByokGenerationAllowed } from "./ai-source-guard";
import axios from "axios";

import i18n from "@/i18n";
import { audioMimeType, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { resolveModel } from "@/lib/models/model-resolver";
import { uploadMediaFile, uploadRemoteMediaFile, type RemoteMediaStorageContext, type UploadedFile } from "@/services/file-storage";
import { storeCanvasMedia, type ProjectAssetWriteContext, type StoredCanvasMedia } from "@/services/project-asset-storage";
import { buildApiUrl, resolveModelChannel, resolveModelExecution, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { generateResolvedMedia } from "./media-dispatcher";

type RequestOptions = { signal?: AbortSignal };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
    };
}

export async function requestAudioGeneration(config: AiConfig, prompt: string, options?: RequestOptions): Promise<Blob> {
    await assertByokGenerationAllowed("audio");
    const selectedModel = config.model || config.audioModel;
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const model = requestConfig.model.trim();
    const format = normalizeAudioFormatValue(config.audioFormat);
    if (!model) throw new Error(apiText("audioModelRequired"));
    const legacyScript = resolveModelScript(config, selectedModel);
    if (legacyScript && !requestConfig.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (legacyScript && !requestConfig.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    const channel = resolveModelChannel(config, selectedModel);
    const storedCapability = resolveModelExecution(config, selectedModel)?.capability;
    const resolved = resolveModel({ provider: channel.provider, baseUrl: requestConfig.baseUrl, apiFormat: requestConfig.apiFormat, model, userCapability: storedCapability });
    const modality = resolved.modality === "music" ? "music" : "speech";
    try {
        const result = await generateResolvedMedia({
            config,
            modality,
            prompt,
            params: {
                voice: legacyScript ? normalizeAudioVoiceValue(config.audioVoice) : config.audioVoice,
                format,
                speed: normalizeAudioSpeedValue(config.audioSpeed),
                instructions: config.audioInstructions.trim(),
            },
            signal: options?.signal,
        });
        if (result.kind !== "audio") throw new Error(apiText("scriptNoAudio"));
        return result.source instanceof Blob ? result.source : normalizePluginAudio(result.source, format);
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("audioGenerationFailed")));
    }
}

export async function requestOpenAISpeech(config: AiConfig, prompt: string, voice: string, format: string, speed: number, instructions: string, signal?: AbortSignal): Promise<Blob> {
    await assertByokGenerationAllowed("audio");
    assertAudioConfig(config, config.model.trim());
    try {
        const body = {
            model: config.model,
            input: prompt,
            voice,
            response_format: format,
            speed,
            ...(instructions ? { instructions } : {}),
        };
        const audio = (
            await axios.post<Blob>(aiApiUrl(config, "/audio/speech"), body, { headers: aiHeaders(config), responseType: "blob", signal })
        ).data;
        await assertAudioBlob(audio);
        return audio.type.startsWith("audio/") ? audio : new Blob([audio], { type: audioMimeType(format) });
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("audioGenerationFailed")));
    }
}

export async function normalizePluginAudio(result: unknown, format: string, context?: RemoteMediaStorageContext): Promise<Blob> {
    if (result instanceof Blob) return result.type.startsWith("audio/") ? result : new Blob([result], { type: audioMimeType(format) });
    let source = "";
    if (typeof result === "string") source = result;
    else if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        source = typeof record.b64_json === "string" ? record.b64_json : typeof record.data === "string" ? record.data : typeof record.url === "string" ? record.url : "";
    }
    if (!source) throw new Error(apiText("scriptNoAudio"));
    const url = source.startsWith("data:") || /^https?:/i.test(source) ? source : `data:${audioMimeType(format)};base64,${source}`;
    const response = await fetch(url, { signal: context?.signal });
    if (context && !response.ok) throw new Error(`Failed to download remote audio (${response.status})`);
    if (context && (context.signal.aborted || !context.isActive())) throw context.signal.reason instanceof Error ? context.signal.reason : new DOMException("Remote media task stopped", "AbortError");
    const blob = await response.blob();
    if (context && (context.signal.aborted || !context.isActive())) throw context.signal.reason instanceof Error ? context.signal.reason : new DOMException("Remote media task stopped", "AbortError");
    return blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
}

export async function storeGeneratedAudio(blob: Blob, format = "mp3", assetWriteContext?: ProjectAssetWriteContext): Promise<StoredCanvasMedia> {
    const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    if (assetWriteContext) return storeCanvasMedia(audio, assetWriteContext);
    return uploadMediaFile(audio, "audio");
}

export async function storeRemoteGeneratedAudio(blob: Blob, format: string, context: RemoteMediaStorageContext): Promise<UploadedFile> {
    const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    return uploadRemoteMediaFile(audio, "audio", context);
}

function assertAudioConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("audioModelRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    if (config.apiFormat === "gemini") throw new Error(apiText("geminiAudioUnsupported"));
}

async function assertAudioBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || apiText("audioGenerationFailed"));
    if (payload.error?.message) throw new Error(payload.error.message);
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            if (/<[a-z][\s\S]*>/i.test(value)) return apiText("htmlError", { preview: `${value.slice(0, 80)}...` });
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
    const errorMsg = typeof payload.error === "string" ? payload.error : (payload.error as { message?: unknown })?.message;
    return readApiErrorMessage(payload.msg) || readApiErrorMessage(payload.message) || readApiErrorMessage(errorMsg) || readApiErrorMessage(payload.detail) || "";
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError(error)) {
        if (!error.response && error.code === "ERR_NETWORK") return apiText("requestFailed");
        const responseData = error.response?.data;
        const apiMsg = readApiErrorMessage(responseData);
        if (apiMsg) return apiMsg;
        const statusMsg = statusMessage(error.response?.status, fallback);
        if (statusMsg) return statusMsg;
        return error.message || fallback;
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    if (status === 404) return apiText("notFound");
    if (status === 502) return apiText("badGateway");
    if (status === 503) return apiText("serviceBusy");
    return status ? apiText("httpFailed", { status }) : fallback;
}
