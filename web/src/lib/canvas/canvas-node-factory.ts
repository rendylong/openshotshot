import { getNodeSpec, NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { serializeProjectAssetToken } from "@/lib/canvas/asset-ref-token";
import type { AiConfig } from "@/stores/use-config-store";
import type { UploadedImage } from "@/services/image-storage";
import type { UploadedFile } from "@/services/file-storage";
import type { ReferenceImage } from "@/types/image";
import { CanvasNodeType, type CanvasImageGenerationType, type CanvasNodeData, type CanvasNodeMetadata, type CanvasNodeTypeId, type Position } from "@/types/canvas";

export function createCanvasNode(type: CanvasNodeTypeId, position: Position, metadata?: CanvasNodeMetadata): CanvasNodeData {
    const spec = getNodeSpec(type);
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    return {
        id,
        type,
        title: spec.title,
        position: {
            x: position.x - spec.width / 2,
            y: position.y - spec.height / 2,
        },
        width: spec.width,
        height: spec.height,
        metadata: { ...spec.metadata, ...metadata },
    };
}

export function imageMetadata(image: UploadedImage): CanvasNodeMetadata {
    // 桌面 project-file 资产是唯一持久身份：不携带 storageKey 字段（条件展开），IDB 键随交付删除（P2 spec §1）。
    const persistableKey = image.assetRef?.backend === "project-file" ? undefined : image.storageKey;
    return { content: image.url, ...(persistableKey ? { storageKey: persistableKey } : {}), status: "success", naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType, ...(image.assetRef ? { assetRef: image.assetRef } : {}) };
}

/** 兼容 IndexedDB（storageKey 必有）与项目文件（仅 assetRef）两种存储结果。 */
export type StoredMediaResult = Omit<UploadedFile, "storageKey"> & { storageKey?: string };

export function videoMetadata(video: StoredMediaResult): CanvasNodeMetadata {
    const persistableKey = video.assetRef?.backend === "project-file" ? undefined : video.storageKey;
    return { content: video.url, ...(persistableKey ? { storageKey: persistableKey } : {}), status: "success", naturalWidth: video.width, naturalHeight: video.height, bytes: video.bytes, mimeType: video.mimeType || "video/mp4", durationMs: video.durationMs, ...(video.assetRef ? { assetRef: video.assetRef } : {}) };
}

export function audioMetadata(audio: StoredMediaResult): CanvasNodeMetadata {
    const persistableKey = audio.assetRef?.backend === "project-file" ? undefined : audio.storageKey;
    return { content: audio.url, ...(persistableKey ? { storageKey: persistableKey } : {}), status: "success", bytes: audio.bytes, mimeType: audio.mimeType || "audio/mpeg", durationMs: audio.durationMs, ...(audio.assetRef ? { assetRef: audio.assetRef } : {}) };
}

export function referenceUrl(image: ReferenceImage) {
    // 持久身份优先：project-file assetRef（pfile: token）→ storageKey（IndexedDB）→ 运行时 URL。
    // 顺序不能动：dataUrl 可能是重载即死的 objectURL，必须排在两种持久身份之后；
    // 桌面 move 语义下 storageKey 指向的字节可能已删，token 必须先行（P2 spec §2）。
    if (image.assetRef?.backend === "project-file") return serializeProjectAssetToken(image.assetRef);
    if (image.storageKey) return image.storageKey;
    if (image.assetRef?.backend === "indexeddb") return image.assetRef.storageKey;
    return image.url || (!image.dataUrl.startsWith("data:") ? image.dataUrl : undefined);
}

export function buildImageGenerationMetadata(type: CanvasImageGenerationType, config: AiConfig, count: number, references: ReferenceImage[]): CanvasNodeMetadata {
    return {
        generationType: type,
        model: config.model,
        size: config.size,
        quality: config.quality,
        vquality: config.vquality,
        ...(config.background ? { background: config.background } : {}),
        count,
        references: references.map(referenceUrl).filter((url): url is string => Boolean(url)),
    };
}

export function buildAudioGenerationMetadata(config: AiConfig): CanvasNodeMetadata {
    return {
        model: config.model,
        audioVoice: config.audioVoice,
        audioFormat: config.audioFormat,
        audioSpeed: config.audioSpeed,
        audioInstructions: config.audioInstructions,
    };
}

export function applyNodeConfigPatch(node: CanvasNodeData, patch: Partial<CanvasNodeData["metadata"]>) {
    const safePatch = patch || {};
    const next = { ...node, metadata: { ...node.metadata, ...safePatch } };
    const spec = node.type === CanvasNodeType.Video ? NODE_DEFAULT_SIZE[CanvasNodeType.Video] : NODE_DEFAULT_SIZE[CanvasNodeType.Image];
    const size = typeof safePatch.size === "string" && !node.metadata?.content ? nodeSizeFromRatio(safePatch.size, spec.width, spec.height) : null;
    return size && (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) ? { ...next, ...size, position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 } } : next;
}

/** Copy generation settings without carrying the original remote task identity. */
export function copyImageGenerationMetadata(metadata: CanvasNodeMetadata = {}): CanvasNodeMetadata {
    return {
        prompt: metadata.prompt,
        generationType: metadata.generationType,
        model: metadata.model,
        size: metadata.size,
        quality: metadata.quality,
        vquality: metadata.vquality,
        background: metadata.background,
        references: metadata.references,
        providerOptions: metadata.providerOptions,
    };
}
