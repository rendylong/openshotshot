import i18n from "@/i18n";
import { getAutodlWorkflow, type AutodlMediaKind } from "@/lib/models/autodl-workflows";
import { isAutodlChannel } from "@/lib/models/model-resolver";
import { resolveModelChannel, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { getMediaBlob } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { getCanvasAssetBlob } from "@/services/project-asset-storage";
import { readFileAsDataUrl } from "@/lib/image-utils";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";
import type { NodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import type { MediaGenerateRequest } from "@/services/api/media-adapters/types";

export function getConfiguredAutodlWorkflow(config: AiConfig) {
    if (!isAutodlChannel(resolveModelChannel(config, config.model))) return undefined;
    return getAutodlWorkflow(resolveModelRequestConfig(config, config.model).model);
}

export type AutodlReferenceBinding = { sourceId: string; kind: AutodlMediaKind; field: string; label: string };

export function describeAutodlInput(workflowId: string, context: NodeGenerationContext) {
    const workflow = getAutodlWorkflow(workflowId);
    if (!workflow) throw new Error(i18n.t("autodlGeneration.unsupportedWorkflow"));
    const bindings: AutodlReferenceBinding[] = [];
    for (const kind of ["image", "audio", "video"] as const) {
        const assets = kind === "image" ? context.referenceImages : kind === "audio" ? context.referenceAudios : context.referenceVideos;
        const slots = workflow.media.filter(slot => slot.kind === kind);
        if (assets.length > slots.length) throw new Error(i18n.t("autodlGeneration.tooManyReferences", { kind: i18n.t(`autodlGeneration.${kind}`, { index: "" }).trim(), count: slots.length }));
        slots.forEach((slot, index) => {
            const asset = assets[index];
            if (!asset) {
                if (slot.required) throw new Error(i18n.t("autodlGeneration.missingReference", { name: slot.field }));
                return;
            }
            if (asset.type && !slot.acceptTypes.includes(asset.type)) throw new Error(i18n.t("autodlGeneration.invalidMedia", { name: asset.name, types: slot.acceptTypes.join(", ") }));
            const label = slot.field === "first_frame" ? i18n.t("autodlGeneration.firstFrame") : slot.field === "last_frame" ? i18n.t("autodlGeneration.lastFrame") : i18n.t(`autodlGeneration.${kind}`, { index: index + 1 });
            bindings.push({ sourceId: asset.id, kind, field: slot.field, label });
        });
    }
    return { prompt: context.prompt, bindings, promptUsed: Boolean(workflow.prompt) };
}

/** Reads renderer-owned media only; returned bytes live for the submission, never task persistence. */
export async function prepareAutodlMediaSource(source: string, kind: AutodlMediaKind, storageKey?: string, signal?: AbortSignal, assetRef?: CanvasAssetRef): Promise<string> {
    signal?.throwIfAborted();
    // project-file assetRef 是桌面唯一持久身份：优先解析；缺失显式报错不静默降级（spec §2）。
    if (assetRef?.backend === "project-file") {
        const blob = await getCanvasAssetBlob(assetRef);
        if (!blob) throw new Error(i18n.t("autodlGeneration.missingReference", { name: assetRef.assetId }));
        signal?.throwIfAborted();
        return readFileAsDataUrl(new File([blob], "reference", { type: blob.type }));
    }
    if (storageKey) {
        if (kind === "image") {
            const dataUrl = await imageToDataUrl({ storageKey, dataUrl: "" }, { signal });
            if (!dataUrl) throw new Error(i18n.t("autodlGeneration.missingReference", { name: storageKey }));
            return dataUrl;
        }
        const blob = await getMediaBlob(storageKey);
        if (!blob) throw new Error(i18n.t("autodlGeneration.missingReference", { name: storageKey }));
        signal?.throwIfAborted();
        return readFileAsDataUrl(new File([blob], "reference", { type: blob.type }));
    }
    if (/^https?:\/\//i.test(source) || source.startsWith("data:")) return source;
    if (source.startsWith("blob:")) {
        const response = await fetch(source, { signal });
        if (!response.ok) throw new Error(i18n.t("autodlGeneration.mediaReadFailed"));
        const blob = await response.blob();
        return readFileAsDataUrl(new File([blob], "reference", { type: blob.type }));
    }
    throw new Error(i18n.t("autodlGeneration.mediaReadFailed"));
}

export async function prepareAutodlGenerationRequest(config: AiConfig, context: NodeGenerationContext, signal?: AbortSignal): Promise<MediaGenerateRequest> {
    const requestConfig = resolveModelRequestConfig(config, config.model);
    const { bindings } = describeAutodlInput(requestConfig.model, context);
    if (bindings.length) console.info(`[autodl] prepare ${requestConfig.model}: ${bindings.map((b) => `${b.field} ← ${b.label}(${b.sourceId})`).join(", ")}`);
    const images = await Promise.all(context.referenceImages.map(ref => prepareAutodlMediaSource(ref.dataUrl, "image", ref.storageKey, signal, ref.assetRef)));
    const audios = await Promise.all(context.referenceAudios.map(ref => prepareAutodlMediaSource(ref.url, "audio", ref.storageKey, signal, ref.assetRef)));
    const videos = await Promise.all(context.referenceVideos.map(ref => prepareAutodlMediaSource(ref.url, "video", ref.storageKey, signal, ref.assetRef)));
    signal?.throwIfAborted();
    return { config: requestConfig, prompt: context.prompt, images, audios, videos, params: { seconds: config.videoSeconds, resolution: config.vquality }, signal };
}
