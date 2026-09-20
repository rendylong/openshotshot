import { prepareReferenceImages, hasReferenceMask, withReferenceImageSession } from "../reference-image-preparation";
import { assertByokGenerationAllowed } from "./ai-source-guard";
import i18n from "@/i18n";
import { resolveModel } from "@/lib/models/model-resolver";
import { credentialModeFor, resolveModelChannel, resolveModelExecution, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";

import { normalizePluginAudio } from "./audio";
import { normalizePluginImages, runModelPlugin } from "./model-plugin";
import { getMediaAdapter } from "./media-adapters/registry";
import type { MediaGenerateRequest, MediaResult } from "./media-adapters/types";
import { normalizePluginVideo } from "./video";
import { resolveManagedModelForCapability, toManagedRequestConfig } from "./model-transport";

export type GenerateResolvedMediaInput = {
    config: AiConfig;
    modality: "image" | "video" | "speech" | "music";
    prompt: string;
    images?: string[];
    params?: Record<string, unknown>;
    signal?: AbortSignal;
};

function selectedModel(input: GenerateResolvedMediaInput) {
    const fallback = input.modality === "image" ? input.config.imageModel : input.modality === "video" ? input.config.videoModel : input.config.audioModel;
    return (input.config.model || fallback).trim();
}

function toMediaGenerateRequest(input: GenerateResolvedMediaInput, config: AiConfig): MediaGenerateRequest {
    return {
        config,
        channelId: resolveModelChannel(input.config, selectedModel(input)).id,
        prompt: input.prompt,
        images: input.images || [],
        params: input.params || {},
        signal: input.signal,
    };
}

async function runLegacyDirectMedia(input: GenerateResolvedMediaInput, request: MediaGenerateRequest, script: string): Promise<MediaResult> {
    const capability = input.modality === "image" ? "image" : input.modality === "video" ? "video" : "audio";
    const result = await runModelPlugin({
        capability,
        script,
        config: request.config,
        prompt: request.prompt,
        images: request.images,
        params: request.params,
        signal: request.signal,
    });
    if (input.modality === "image") return { kind: "image", sources: normalizePluginImages(result) };
    if (input.modality === "video") {
        const video = normalizePluginVideo(result);
        const source = video.blob || video.url;
        if (!source) throw new Error(i18n.t("apiErrors.noPlayableVideo"));
        return { kind: "video", source, mimeType: video.mimeType || (source instanceof Blob ? source.type : "video/mp4") };
    }
    const format = typeof request.params.format === "string" ? request.params.format : request.config.audioFormat;
    const source = await normalizePluginAudio(result, format);
    return { kind: "audio", source, mimeType: source.type };
}

export async function generateResolvedMedia(input: GenerateResolvedMediaInput): Promise<MediaResult> {
    input = { ...input, config: withReferenceImageSession(input.config), images: await prepareReferenceImages(input.config, input.images || [], { signal: input.signal, preserveOriginal: hasReferenceMask(input.params) }) };
    const capability = input.modality === "image" ? "image" : input.modality === "video" ? "video" : "audio";
    if (credentialModeFor(input.config, capability) === "shotshot") {
        const managed = await resolveManagedModelForCapability(input.config, capability);
        // Managed image models can be `direct` (openai.image) or `remote_task` (gateway task);
        // video/audio keep their existing mapping so their behaviour is untouched.
        const adapterId = capability === "image"
            ? (managed.execution === "remote_task" ? "shotshot.managed-image" : "openai.image")
            : capability === "video" ? "openai.video" : "openai.speech";
        const adapter = getMediaAdapter(adapterId);
        if (!adapter || adapter.execution !== managed.execution) throw new Error(i18n.t("apiErrors.noAutomaticAdapter", { model: managed.id }));
        if (!adapter.generate) throw new Error(i18n.t("apiErrors.modelRequiresRemoteTask", { model: managed.id }));
        const requestConfig = toManagedRequestConfig(input.config, managed.id);
        return adapter.generate(toMediaGenerateRequest(input, requestConfig));
    }
    await assertByokGenerationAllowed(input.modality === "speech" || input.modality === "music" ? "audio" : input.modality);
    const selected = selectedModel(input);
    const requestConfig = resolveModelRequestConfig(input.config, selected);
    const request = toMediaGenerateRequest(input, requestConfig);
    const legacyScript = resolveModelScript(input.config, selected);
    if (legacyScript) return runLegacyDirectMedia(input, request, legacyScript);

    const channel = resolveModelChannel(input.config, selected);
    const storedCapability = resolveModelExecution(input.config, selected)?.capability;
    const resolved = resolveModel({
        provider: channel.provider,
        baseUrl: requestConfig.baseUrl,
        apiFormat: requestConfig.apiFormat,
        model: requestConfig.model,
        userCapability: storedCapability,
    });
    if (resolved.modality !== input.modality || resolved.execution === "unsupported" || !resolved.adapterId) {
        throw new Error(i18n.t("apiErrors.noAutomaticAdapter", { model: resolved.model }));
    }

    const adapter = getMediaAdapter(resolved.adapterId);
    if (!adapter || adapter.execution !== resolved.execution || adapter.version !== resolved.adapterVersion) {
        throw new Error(i18n.t("apiErrors.noAutomaticAdapter", { model: resolved.model }));
    }
    if (!adapter.generate) {
        throw new Error(i18n.t("apiErrors.modelRequiresRemoteTask", { model: resolved.model }));
    }
    return adapter.generate(request);
}
