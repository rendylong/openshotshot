import type { RemoteTaskPhase } from "@/types/remote-media-task";
import { resolveManagedVideoSettings } from "@/lib/canvas/managed-video-settings";
import { prepareReferenceObjects } from "../reference-image-preparation";
import { assertByokGenerationAllowed } from "./ai-source-guard";
import axios from "axios";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { dataUrlToFile } from "@/lib/image-utils";
import { uploadMediaFile, uploadRemoteMediaFile, type RemoteMediaStorageContext, type UploadedFile } from "@/services/file-storage";
import { getCanvasAssetBlob, storeCanvasMedia, type ProjectAssetWriteContext, type StoredCanvasMedia } from "@/services/project-asset-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { getMediaBlob } from "@/services/file-storage";
import { boolConfig, buildApiUrl, credentialModeFor, modelOptionName, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { generateResolvedMedia } from "./media-dispatcher";
import { runModelPlugin } from "./model-plugin";
import { requestModel } from "./model-transport";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { resolveManagedModel } from "./model-transport";

type VideoResponse = { id: string; status?: string; error?: { message?: string }; url?: string; result_url?: string; video_url?: string; content?: { video_url?: string; url?: string } | null };
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };
type RequestOptions = { signal?: AbortSignal; onPhase?: (phase: RemoteTaskPhase) => Promise<void>; recoverDelivery?: boolean };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string };
export type VideoGenerationTask = { id: string; provider: "openai" | "shotshot" | "plugin"; model: string };
export type VideoGenerationTaskState = { status: "pending"; phase?: RemoteTaskPhase } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

/** Results for scripted (plugin) video models, which run their own create+poll in one shot at task creation. */
const pluginVideoResults = new Map<string, VideoGenerationResult>();

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: RequestOptions): Promise<VideoGenerationResult> {
    await assertByokGenerationAllowed("video");
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    assertVideoConfig(requestConfig, requestConfig.model);
    const images = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const result = await generateResolvedMedia({
        config,
        modality: "video",
        prompt,
        images,
        params: {
            seconds: credentialModeFor(config, "video") === "shotshot" ? config.videoSeconds : normalizeVideoSeconds(config.videoSeconds),
            size: normalizeVideoSize(config.size),
            resolution: credentialModeFor(config, "video") === "shotshot" ? config.vquality : normalizeVideoResolution(config.vquality),
            ratio: config.size,
            generateAudio: boolConfig(config.videoGenerateAudio, true),
            watermark: boolConfig(config.videoWatermark, false),
        },
        signal: options?.signal,
    });
    if (result.kind !== "video") throw new Error(apiText("noPlayableVideo"));
    return result.source instanceof Blob
        ? { blob: result.source, mimeType: result.mimeType }
        : { url: result.source, mimeType: result.mimeType || "video/mp4" };
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    await assertByokGenerationAllowed("video");
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    assertVideoConfig(requestConfig, requestConfig.model);
    const script = resolveModelScript(config, selectedModel);
    if (script) return createPluginVideoTask(requestConfig, selectedModel, script, prompt, references, options);
    return createOpenAIVideoTask(requestConfig, selectedModel, prompt, references, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        return result ? { status: "completed", result } : { status: "failed", error: apiText("pluginVideoExpired") };
    }
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (task.provider === "shotshot") return pollShotshotManagedVideoTask(requestConfig, task, options);
    return pollOpenAIVideoTask(requestConfig, task, options);
}

async function createPluginVideoTask(config: AiConfig, model: string, script: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const result = normalizePluginVideo(
        await runModelPlugin({
            capability: "video",
            script,
            config,
            prompt,
            images: refs,
            params: {
                seconds: normalizeVideoSeconds(config.videoSeconds),
                size: normalizeVideoSize(config.size),
                resolution: normalizeVideoResolution(config.vquality),
                ratio: config.size,
                generateAudio: boolConfig(config.videoGenerateAudio, true),
                watermark: boolConfig(config.videoWatermark, false),
            },
            signal: options?.signal,
        }),
    );
    const id = nanoid();
    pluginVideoResults.set(id, result);
    return { id, provider: "plugin", model };
}

export function normalizePluginVideo(result: unknown): VideoGenerationResult {
    if (result instanceof Blob) return { blob: result };
    if (typeof result === "string") return { url: result, mimeType: "video/mp4" };
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        if (record.blob instanceof Blob) return { blob: record.blob };
        const url = [record.url, record.video_url, record.result_url].find((value) => typeof value === "string" && value) as string | undefined;
        if (url) return { url, mimeType: "video/mp4" };
    }
    throw new Error(apiText("scriptNoVideo"));
}

export async function storeGeneratedVideo(result: VideoGenerationResult, assetWriteContext?: ProjectAssetWriteContext): Promise<StoredCanvasMedia> {
    if (result.blob) return assetWriteContext ? storeCanvasMedia(result.blob, assetWriteContext) : uploadMediaFile(result.blob, "video");
    if (result.url) {
        // 项目资产路径不允许静默降级为裸远端 URL：节点成功必须以稳定文件为前提。
        if (assetWriteContext) return storeCanvasMedia(result.url, assetWriteContext);
        try {
            return await uploadMediaFile(result.url, "video");
        } catch {
            return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
        }
    }
    throw new Error(apiText("noPlayableVideo"));
}

export async function storeRemoteGeneratedVideo(result: VideoGenerationResult, context: RemoteMediaStorageContext): Promise<UploadedFile> {
    if (result.blob) return uploadRemoteMediaFile(result.blob, "video", context);
    if (result.url) return uploadRemoteMediaFile(result.url, "video", context);
    throw new Error(apiText("noPlayableVideo"));
}

export async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions, managedReferences?: { audioReferences?: ReferenceAudio[]; videoReferences?: ReferenceVideo[] }): Promise<VideoGenerationTask> {
    await assertByokGenerationAllowed("video");
    assertOpenAIVideoConfig(config, model);
    references = await prepareReferenceObjects(config, references, { signal: options?.signal });
    if (credentialModeFor(config, "video") === "shotshot") return createShotshotManagedVideoTask(config, model, prompt, references, options, managedReferences);
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    if (normalizeVideoSize(config.size)) body.append("size", normalizeVideoSize(config.size)!);
    body.append("resolution_name", normalizeVideoResolution(config.vquality));
    body.append("preset", "normal");
    const files = await Promise.all(references.slice(0, 7).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => body.append("input_reference[]", file));
    try {
        const data = await requestModel<ApiVideoResponse>({
            config,
            timeoutClass: "video",
            path: "/v1/videos",
            body,
            responseType: "json",
            signal: options?.signal,
            byok: () => axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal }),
        });
        const created = unwrapVideoResponse(data);
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function createShotshotManagedVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions, managedReferences?: { audioReferences?: ReferenceAudio[]; videoReferences?: ReferenceVideo[] }): Promise<VideoGenerationTask> {
    const assets: Record<string, string> = {};
    const descriptor = await resolveManagedModel(config, "video", model);
    const { resolution, seconds } = resolveManagedVideoSettings(config, descriptor);
    const slots = descriptor.input_slots ?? [];
    const referencesByKind = {
        image: references,
        audio: managedReferences?.audioReferences ?? [],
        video: managedReferences?.videoReferences ?? [],
    };
    // Validate the actual managed model before any asset upload. Node settings
    // can still carry a BYOK model whose reference contract is different.
    for (const kind of ["image", "audio", "video"] as const) {
        const declared = slots.filter((slot) => slot.kind === kind);
        const supplied = referencesByKind[kind];
        for (const [index, slot] of declared.entries()) {
            if (slot.required && !supplied[index]) throw new Error(apiText("managedVideoMissingReference", { model: descriptor.name, field: slot.field }));
        }
        if (supplied.length > declared.length) throw new Error(apiText("managedVideoUnexpectedReference", { model: descriptor.name, kind, count: declared.length }));
    }
    const allReferences: Array<{ kind: "image" | "audio" | "video"; reference: ReferenceImage | ReferenceAudio | ReferenceVideo }> = [
        ...references.map((reference) => ({ kind: "image" as const, reference })),
        ...referencesByKind.audio.map((reference) => ({ kind: "audio" as const, reference })),
        ...referencesByKind.video.map((reference) => ({ kind: "video" as const, reference })),
    ];
    const usedByKind: Record<string, number> = {};
    for (const item of allReferences) {
        const index = usedByKind[item.kind] ?? 0;
        usedByKind[item.kind] = index + 1;
        const field = slots.filter((candidate) => candidate.kind === item.kind)[index]!.field;
        const file = await managedReferenceToFile(item.reference, item.kind, index);
        const metadata = await requestModel<{ asset_id?: string }>({
            config,
            capability: "video",
            timeoutClass: item.kind,
            path: "/v1/assets/upload",
            body: { mime_type: file.type || "image/png", byte_size: file.size, filename: file.name || `reference-${index}.png` },
            responseType: "json",
            signal: options?.signal,
            byok: async () => { throw new Error("managed_desktop_required"); },
        });
        if (!metadata.asset_id) throw new Error("managed_media_asset_upload_failed");
        await requestModel({
            config,
            capability: "video",
            timeoutClass: item.kind,
            path: `/v1/assets/${encodeURIComponent(metadata.asset_id)}/content`,
            method: "POST",
            headers: { "content-type": file.type || "image/png" },
            body: new Uint8Array(await file.arrayBuffer()),
            responseType: "json",
            signal: options?.signal,
            byok: async () => { throw new Error("managed_desktop_required"); },
        });
        await requestModel({
            config,
            capability: "video",
            timeoutClass: item.kind,
            path: `/v1/assets/${encodeURIComponent(metadata.asset_id)}/complete`,
            method: "POST",
            body: { byte_size: file.size },
            responseType: "json",
            signal: options?.signal,
            byok: async () => { throw new Error("managed_desktop_required"); },
        });
        assets[field] = metadata.asset_id;
    }
    const data = await requestModel<{ id?: string; state?: string }>({
        config,
        timeoutClass: "video",
        path: "/v1/media/tasks",
        body: {
            model: modelOptionName(model),
            prompt,
            duration_milliseconds: Math.round(seconds * 1000),
            resolution,
            assets,
            idempotency_key: crypto.randomUUID(),
        },
        responseType: "json",
        signal: options?.signal,
        byok: async () => { throw new Error("managed_desktop_required"); },
    });
    if (!data.id) throw new Error(apiText("noVideoTaskId"));
    return { id: data.id, provider: "shotshot", model };
}

async function managedReferenceToFile(reference: ReferenceImage | ReferenceAudio | ReferenceVideo, kind: "image" | "audio" | "video", index: number): Promise<File> {
    if (kind === "image") {
        const image = reference as ReferenceImage;
        if (image.assetRef?.backend === "project-file") {
            const blob = await getCanvasAssetBlob(image.assetRef);
            if (blob) return new File([blob], image.name || `reference-${index}.png`, { type: image.type || blob.type || "image/png" });
        }
        const dataUrl = await imageToDataUrl(image);
        return dataUrlToFile({ ...image, dataUrl });
    }
    const media = reference as ReferenceAudio | ReferenceVideo;
    let blob: Blob | null = null;
    if (media.assetRef?.backend === "project-file") blob = await getCanvasAssetBlob(media.assetRef);
    if (!blob && media.storageKey) blob = await getMediaBlob(media.storageKey);
    if (!blob && media.url) {
        if (media.url.startsWith("data:")) {
            const response = await fetch(media.url);
            blob = await response.blob();
        } else if (/^(?:blob:|https?:)/i.test(media.url)) {
            const response = await fetch(media.url);
            if (response.ok) blob = await response.blob();
        }
    }
    if (!blob) throw new Error(kind === "audio" ? apiText("invalidReferenceAudio") : apiText("invalidReferenceVideo"));
    const type = media.type || blob.type || (kind === "audio" ? "audio/mpeg" : "video/mp4");
    return new File([blob], media.name || `reference-${index}.${kind === "audio" ? "mp3" : "mp4"}`, { type });
}

async function pollShotshotManagedVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    const read = (recover: boolean) => requestModel<{ id?: string; state?: string; result_asset_id?: string; error_code?: string; recovery_action?: string }>({
        config,
        timeoutClass: "video",
        path: `/v1/media/tasks/${encodeURIComponent(task.id)}${recover ? "/recover" : ""}`,
        method: recover ? "POST" : "GET",
        responseType: "json",
        signal: options?.signal,
        byok: async () => { throw new Error("managed_desktop_required"); },
    });
    // Always inspect the original task first: a lost recover response may already have advanced it.
    let data = await read(false);
    if (options?.recoverDelivery && data.state === "delivery_blocked" && data.recovery_action === "retry_delivery") data = await read(true);
    if (data.state === "delivery_blocked") return { status: "failed", error: i18n.t("canvas.remoteTask.deliveryBlocked", { code: data.error_code || "delivery_failed" }) };
    if (data.state === "succeeded") {
        await options?.onPhase?.("downloading");
        const content = await requestModel<Blob>({
            config,
            timeoutClass: "video",
            path: `/v1/media/tasks/${encodeURIComponent(task.id)}/content`,
            method: "GET",
            responseType: "blob",
            signal: options?.signal,
            byok: async () => { throw new Error("managed_desktop_required"); },
        });
        await assertVideoBlob(content);
        return { status: "completed", result: { blob: content, mimeType: content.type || "video/mp4" } };
    }
    if (data.state === "failed") return { status: "failed", error: data.error_code || apiText("videoGenerationFailed") };
    const phase: RemoteTaskPhase = data.state === "delivering" ? "delivering" : data.state === "settle_pending" ? "settling" : ["submitted", "running"].includes(data.state ?? "") ? "running" : "queued";
    return { status: "pending", phase };
}

export async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    assertOpenAIVideoConfig(config, task.model);
    if (credentialModeFor(config, "video") === "shotshot") return pollShotshotManagedVideoTask(config, task, options);
    try {
        const data = await requestModel<ApiVideoResponse>({
            config,
            timeoutClass: "video",
            path: `/v1/videos/${task.id}`,
            method: "GET",
            responseType: "json",
            signal: options?.signal,
            byok: () => axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal }),
        });
        const video = unwrapVideoResponse(data);
        const url = videoResultUrl(video);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (video.status === "completed") {
            const content = await requestModel<Blob>({
                config,
                timeoutClass: "video",
                path: `/v1/videos/${task.id}/content`,
                method: "GET",
                responseType: "blob",
                signal: options?.signal,
                byok: () => axios.get<Blob>(aiApiUrl(config, `/videos/${task.id}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal }),
            });
            await assertVideoBlob(content);
            return { status: "completed", result: { blob: content } };
        }
        if (video.status === "failed" || video.status === "cancelled") return { status: "failed", error: readApiErrorMessage(video.error?.message) || apiText("videoGenerationFailed") };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function videoResultFromUrl(url: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    try {
        const response = await axios.get<Blob>(url, { responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        return { url, mimeType: "video/mp4" };
    }
}

export function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("videoModelRequired"));
    if (credentialModeFor(config, "video") === "shotshot") return;
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
}

function assertOpenAIVideoConfig(config: AiConfig, model: string) {
    assertVideoConfig(config, model);
    if (config.apiFormat === "gemini") throw new Error(apiText("geminiVideoUnsupported"));
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, apiText("noVideoTask"));
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        if (payload.code !== 0 && payload.code !== "0") throw new Error(readApiErrorMessage(payload) || apiText("requestFailed"));
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

function videoResultUrl(payload: VideoResponse) {
    return [payload.video_url, payload.result_url, payload.url, payload.content?.video_url, payload.content?.url].find((url) => typeof url === "string" && (isPublicMediaUrl(url) || /\.mp4(\?|#|$)/i.test(url)));
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
    // error may be a string or an object containing a message.
    const errorMsg =
        typeof payload.error === "string"
            ? payload.error
            : (payload.error as { message?: unknown })?.message;
    return (
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(errorMsg) ||
        readApiErrorMessage(payload.detail) ||
        ""
    );
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string; code?: number | string }>(error)) {
        if (!error.response && error.code === "ERR_NETWORK") return apiText("requestFailed");
        const responseData = error.response?.data;
        return readApiErrorMessage(responseData) || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    return status ? `${fallback}（${status}）` : fallback;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(readApiErrorMessage(payload) || apiText("videoDownloadFailed"));
    if (payload.error?.message) throw new Error(readApiErrorMessage(payload.error.message) || payload.error.message);
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}
