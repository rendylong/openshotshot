import { prepareReferenceImages } from "@/services/reference-image-preparation";
import type { NodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { readFileAsDataUrl } from "@/lib/image-utils";
import { compileFalInput } from "@/lib/models/fal/input";
import { getFalProfile } from "@/lib/models/fal/profiles";
import type { FalMediaConstraints } from "@/lib/models/fal/profile-types";
import { readProviderParams, type ProviderOptions } from "@/lib/models/provider-options";
import { imageToDataUrl } from "@/services/image-storage";
import type { MediaGenerateRequest } from "@/services/api/media-adapters/types";
import { decodeChannelModel, resolveModelChannel, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export function isConfiguredFalModel(config: AiConfig) {
    const channel = resolveModelChannel(config, config.model);
    const capability = channel.models.find(model => model.name === (decodeChannelModel(config.model)?.model || config.model))?.capability;
    return channel.provider === "fal" && (capability === "image" || capability === "video");
}
/** These operations have no admitted fal mask/target contract. Never silently discard them. */
export function assertFalGenerationOperationSupported(config: AiConfig, operation: "mask" | "plugin-self") {
    if (isConfiguredFalModel(config)) throw new Error(operation === "mask" ? "fal_mask_unsupported" : "fal_target_unsupported");
}

function validSource(source: string) {
    if (/^data:image\/[\w.+-]+[;,]/.test(source)) return true;
    try {
        const url = new URL(source);
        return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password && !/[\u0000-\u0020\u007f]/.test(source);
    } catch { return false; }
}
async function resolveImage(ref: ReferenceImage, signal?: AbortSignal) {
    signal?.throwIfAborted();
    let source = ref.dataUrl || ref.url || "";
    if (ref.storageKey) source = await imageToDataUrl({ storageKey: ref.storageKey, dataUrl: "" }, { signal });
    else if (source.startsWith("blob:")) {
        const response = await fetch(source, { signal, credentials: "omit" });
        if (!response.ok) throw new Error("fal_media_read_failed");
        const blob = await response.blob();
        source = await readFileAsDataUrl(new File([blob], "reference", { type: blob.type }));
    }
    signal?.throwIfAborted();
    if (!validSource(source)) throw new Error("fal_media_read_failed");
    return source;
}
function dimensions(blob: Blob, signal?: AbortSignal): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const url = URL.createObjectURL(blob);
        const image = new Image();
        const cleanup = () => { image.onload = null; image.onerror = null; signal?.removeEventListener("abort", abort); URL.revokeObjectURL(url); };
        const abort = () => { cleanup(); image.src = ""; reject(signal?.reason); };
        image.onload = () => { const width = image.naturalWidth, height = image.naturalHeight; cleanup(); width > 0 && height > 0 ? resolve({ width, height }) : reject(new Error("fal_media_read_failed")); };
        image.onerror = () => { cleanup(); reject(new Error("fal_media_read_failed")); };
        signal?.addEventListener("abort", abort, { once: true });
        image.src = url;
    });
}
async function checkMedia(source: string, limits: FalMediaConstraints, signal?: AbortSignal) {
    const response = await fetch(source, { signal, credentials: "omit" });
    if (!response.ok) throw new Error("fal_media_read_failed");
    const blob = await response.blob();
    signal?.throwIfAborted();
    if (limits.maxBytes !== undefined && blob.size > limits.maxBytes) throw new Error("fal_media_bytes");
    if (limits.mimeTypes && !limits.mimeTypes.includes(blob.type.toLowerCase())) throw new Error("fal_media_type");
    if (limits.minDimension !== undefined || limits.maxDimension !== undefined || limits.minAspectRatio !== undefined || limits.maxAspectRatio !== undefined) {
        const { width, height } = await dimensions(blob, signal);
        if ((limits.minDimension !== undefined && Math.min(width, height) < limits.minDimension) || (limits.maxDimension !== undefined && Math.max(width, height) > limits.maxDimension)) throw new Error("fal_media_dimensions");
        if ((limits.minAspectRatio !== undefined && width / height < limits.minAspectRatio) || (limits.maxAspectRatio !== undefined && width / height > limits.maxAspectRatio)) throw new Error("fal_media_ratio");
    }
}

/** Renderer preflight only. Resolved bytes never enter canvas metadata or the task store. */
export async function prepareFalGenerationRequest(config: AiConfig, context: NodeGenerationContext, options: ProviderOptions | undefined, signal?: AbortSignal): Promise<MediaGenerateRequest> {
    signal?.throwIfAborted();
    const selected = decodeChannelModel(config.model);
    const channel = config.channels.find(channel => channel.id === selected?.channelId);
    if (!selected || channel?.provider !== "fal" || !channel.models.some(model => model.name === selected.model)) throw new Error("fal_channel_invalid");
    const profile = getFalProfile(selected.model);
    if (!profile) throw new Error("fal_model_unsupported");
    const common = { size: config.size, quality: config.quality, seconds: config.videoSeconds, resolution: config.vquality, generateAudio: config.videoGenerateAudio };
    const params: Record<string, unknown> = { providerParams: readProviderParams(options, config.model) };
    for (const field of profile.fields) {
        if (!field.common) continue;
        const value = common[field.common];
        if (value === "" || value === undefined) continue;
        params[field.common] = field.common === "generateAudio" ? value === "true" ? true : value === "false" ? false : value : value;
    }
    // Validate counts/params/media kinds before reading any renderer-owned bytes.
    compileFalInput(profile, { prompt: context.prompt, images: context.referenceImages.map(ref => ref.storageKey || (ref.dataUrl || ref.url || "").startsWith("blob:") ? "https://reference.invalid/local" : ref.dataUrl || ref.url || ""), audios: context.referenceAudios.map(ref => ref.url), videos: context.referenceVideos.map(ref => ref.url), params });
    let images: string[];
    try { images = await Promise.all(context.referenceImages.map(ref => resolveImage(ref, signal))); }
    catch (error) { signal?.throwIfAborted(); throw error instanceof Error && error.message.startsWith("fal_") ? error : new Error("fal_media_read_failed"); }
    images = await prepareReferenceImages(config, images, { signal });
    const request = { config: resolveModelRequestConfig(config, config.model), channelId: channel.id, prompt: context.prompt, images, params, signal };
    compileFalInput(profile, request);
    let index = 0;
    for (const slot of profile.media) {
        const sources = slot.mode === "many" ? images.slice(index) : images.slice(index, index + 1);
        index += sources.length;
        if (slot.constraints) for (const source of sources) {
            try { await checkMedia(source, slot.constraints, signal); }
            catch (error) { signal?.throwIfAborted(); throw error instanceof Error && error.message.startsWith("fal_") ? error : new Error("fal_media_read_failed"); }
        }
    }
    signal?.throwIfAborted();
    return request;
}
