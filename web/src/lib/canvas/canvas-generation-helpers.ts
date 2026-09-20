import { falNodeConfig } from "./fal-settings";
import { nanoid } from "nanoid";
import { credentialModeFor, defaultConfig, resolveModelForCapability, type AiConfig } from "@/stores/use-config-store";
import i18n from "@/i18n";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { imageMetadata, referenceUrl } from "@/lib/canvas/canvas-node-factory";
import { isCanvasReferenceNode } from "@/lib/canvas/canvas-resource-references";
import { isAssetRefToken, parseAssetRefToken, serializeProjectAssetToken } from "@/lib/canvas/asset-ref-token";
import { getCanvasAssetBlob, resolveCanvasAssetUrl } from "@/services/project-asset-storage";
import { readFileAsDataUrl } from "@/lib/image-utils";
import { isPluginNodeType } from "@/lib/canvas/model-3d-snapshot";
import type { NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import type { CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { CanvasNodeType, type CanvasAssistantSession, type CanvasConnection, type CanvasGenerationMode, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import { managedCatalogSnapshot } from "@/lib/desktop/managed-catalog-cache";

export function imageExtension(dataUrl: string) {
    return dataUrl.match(/^data:image[/]([^;]+)/)?.[1] || dataUrl.match(/image[/]([^;]+)/)?.[1] || "png";
}

export function audioExtension(mimeType?: string) {
    if (mimeType?.includes("wav")) return "wav";
    if (mimeType?.includes("opus")) return "opus";
    if (mimeType?.includes("aac")) return "aac";
    if (mimeType?.includes("flac")) return "flac";
    if (mimeType?.includes("pcm")) return "pcm";
    return "mp3";
}

export function generationReferenceUrls(context: { referenceImages: ReferenceImage[]; referenceVideos: ReferenceVideo[]; referenceAudios?: ReferenceAudio[] }) {
    // 音视频与 images 同序的持久身份优先（project-file assetRef 的 pfile: token → storageKey → 运行时 URL）：
    // 桌面物化的音视频节点为 assetRef-only；move 语义下旧 storageKey 字节可能已删，token 必须先行（spec §2）。
    return [
        ...context.referenceImages.map(referenceUrl).filter((url): url is string => Boolean(url)),
        ...context.referenceVideos.map((video) => (video.assetRef?.backend === "project-file" ? serializeProjectAssetToken(video.assetRef) : undefined) || video.storageKey || video.url).filter((url): url is string => Boolean(url)),
        ...(context.referenceAudios || []).map((audio) => (audio.assetRef?.backend === "project-file" ? serializeProjectAssetToken(audio.assetRef) : undefined) || audio.storageKey || audio.url).filter((url): url is string => Boolean(url)),
    ];
}

export async function resolveMetadataReferences(metadata: CanvasNodeMetadata) {
    if (metadata.generationType !== "edit") return [];
    if (!metadata.references?.length) return null;
    const references = await Promise.all(
        metadata.references.map(async (url, index) => {
            if (isAssetRefToken(url)) {
                const ref = parseAssetRefToken(url);
                if (!ref) return null;
                const blob = await getCanvasAssetBlob(ref);
                if (!blob) return null;
                const dataUrl = await readFileAsDataUrl(new File([blob], "reference", { type: blob.type }));
                return dataUrl ? { id: `${index}`, name: `reference-${index}.png`, type: blob.type, dataUrl } : null;
            }
            const dataUrl = url.startsWith("image:") ? await resolveImageUrl(url, "") : url;
            return dataUrl ? { id: `${index}`, name: `reference-${index}.png`, type: "image/png", dataUrl, storageKey: url.startsWith("image:") ? url : undefined } : null;
        }),
    );
    return references.every(Boolean) ? (references as ReferenceImage[]) : null;
}

export async function hydrateCanvasImages(nodes: CanvasNodeData[]) {
    return Promise.all(
        nodes.map(async (node) => {
            const metadata = node.metadata;
            const content = metadata?.content;
            if (node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) {
                // project-file assetRef 是桌面唯一持久身份，优先解析；storageKey 仅作未迁移回退（spec §2）。
                if (metadata?.assetRef?.backend === "project-file") return { ...node, metadata: { ...metadata, content: await resolveCanvasAssetUrl(metadata.assetRef, content) } };
                if (metadata?.storageKey) return { ...node, metadata: { ...metadata, content: await resolveMediaUrl(metadata.storageKey, content) } };
                return node;
            }
            // 3d nodes persist blob: URLs that die on reload — re-resolve from the stored GLB identity
            // (assetRef first, legacy storageKey as fallback).
            if (node.type === "3d" && metadata?.model3d) {
                const model3d = metadata.model3d;
                if (model3d.assetRef?.backend === "project-file" || model3d.storageKey) {
                    const url = model3d.assetRef?.backend === "project-file" ? await resolveCanvasAssetUrl(model3d.assetRef, content) : await resolveMediaUrl(model3d.storageKey!, content);
                    return { ...node, metadata: { ...metadata, content: url, model3d: { ...model3d, content: url } } };
                }
                return node;
            }
            if (node.type !== CanvasNodeType.Image || !metadata || !content) return node;
            const images = await Promise.all((metadata.images || []).map(async (image) => (image.content ? { ...image, content: await (image.assetRef?.backend === "project-file" ? resolveCanvasAssetUrl(image.assetRef, image.content) : resolveImageUrl(image.storageKey, image.content)) } : image)));
            if (metadata.assetRef?.backend === "project-file") return { ...node, metadata: { ...metadata, content: await resolveCanvasAssetUrl(metadata.assetRef, content), images } };
            if (metadata.storageKey) return { ...node, metadata: { ...metadata, content: await resolveImageUrl(metadata.storageKey, content), images } };
            if (!content.startsWith("data:image/")) return node;
            return { ...node, metadata: { ...metadata, ...imageMetadata(await uploadImage(content)) } };
        }),
    );
}

export async function hydrateAssistantImages(sessions: CanvasAssistantSession[]) {
    const hydrateItem = async <T extends { dataUrl?: string; storageKey?: string }>(item: T) => {
        if (item.storageKey) return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        if (item.dataUrl?.startsWith("data:image/")) {
            const image = await uploadImage(item.dataUrl);
            return { ...item, dataUrl: image.url, storageKey: image.storageKey };
        }
        return item;
    };
    return Promise.all(
        sessions.map(async (session) => ({
            ...session,
            messages: await Promise.all(
                session.messages.map(async (message) => ({
                    ...message,
                    references: await Promise.all((message.references || []).map(hydrateItem)),
                })),
            ),
        })),
    );
}

export function getGenerationCount(count: string) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(count)) || 1)));
}

export function getInputSummary(inputs: NodeGenerationInput[]) {
    const resources = [...new Map(inputs.flatMap((input) => (input.type === "group" ? input.children : [input])).map((input) => [input.nodeId, input])).values()];
    // 图片输入按实际发送张数计数：3D 多视角（主/左/右/顶）与多图节点展开为多张，单图节点记 1 张。
    const imageCount = resources.reduce((sum, input) => (input.type === "image" ? sum + (input.images?.length || 1) : sum), 0);
    return {
        textCount: resources.filter((input) => input.type === "text").length,
        imageCount,
        videoCount: resources.filter((input) => input.type === "video").length,
        audioCount: resources.filter((input) => input.type === "audio").length,
    };
}

export type InputEvidenceItem = { nodeId: string; title: string; previewUrl?: string };
export type InputEvidenceGroup = { kind: "image" | "video" | "audio"; items: InputEvidenceItem[] };
export type InputEvidence = { textPreview: string; groups: InputEvidenceGroup[] };

const EVIDENCE_GROUP_KINDS: Record<CanvasGenerationMode, Array<"image" | "video" | "audio">> = {
    image: ["image"],
    text: [],
    video: ["image", "video"],
    audio: ["audio"],
};

/** Config 节点证据行数据：与 getInputSummary 同源同过滤（group 展开、nodeId 去重）；预览缺省时面板退化为图标 tile。 */
export function buildInputEvidence(inputs: NodeGenerationInput[], mode: CanvasGenerationMode): InputEvidence {
    const resources = [...new Map(inputs.flatMap((input) => (input.type === "group" ? input.children : [input])).map((input) => [input.nodeId, input])).values()];
    return {
        textPreview: resources.find((input) => input.type === "text")?.text || "",
        groups: EVIDENCE_GROUP_KINDS[mode].map((kind) => ({
            kind,
            items: resources
                .filter((input) => input.type === kind)
                .map((input) => ({
                    nodeId: input.nodeId,
                    title: input.title,
                    previewUrl: input.type === "image" ? input.images?.[0]?.dataUrl || input.image?.dataUrl : undefined,
                })),
        })),
    };
}

export function buildGenerationConfig(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasNodeGenerationMode, managedImageModel?: string): AiConfig {
    // 节点显式模型若是托管目录 id（Agent 设定或节点面板选择），优先于套餐默认偏好；
    // 并把请求偏好钉到该模型（托管请求层按 managedModels[capability] 解析），保证节点上的选择真实生效。
    const requestedManagedModel = credentialModeFor(config, mode) === "shotshot"
        ? managedCatalogSnapshot()?.models.find((candidate) => candidate.capability === mode && candidate.id === node?.metadata?.model)?.id
        : undefined;
    const resolvedManagedModel = managedImageModel || requestedManagedModel;
    const model = resolvedManagedModel || resolveModelForCapability(config, node?.metadata?.model, mode);
    return {
        ...config,
        model,
        ...(resolvedManagedModel ? { managedModels: { ...config.managedModels, [mode]: resolvedManagedModel } } : {}),
        reasoningEffort: node?.metadata?.reasoningEffort || config.reasoningEffort || defaultConfig.reasoningEffort,
        quality: node?.metadata?.quality || config.quality || defaultConfig.quality,
        size: node?.metadata?.size || config.size || defaultConfig.size,
        background: node?.metadata?.background ?? config.background ?? defaultConfig.background,
        videoSeconds: node?.metadata?.seconds || config.videoSeconds || defaultConfig.videoSeconds,
        vquality: node?.metadata?.vquality || config.vquality || defaultConfig.vquality,
        videoGenerateAudio: node?.metadata?.generateAudio || config.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node?.metadata?.watermark || config.videoWatermark || defaultConfig.videoWatermark,
        audioVoice: node?.metadata?.audioVoice || config.audioVoice || defaultConfig.audioVoice,
        audioFormat: node?.metadata?.audioFormat || config.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node?.metadata?.audioSpeed || config.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node?.metadata?.audioInstructions || config.audioInstructions || defaultConfig.audioInstructions,
        count: String(node?.metadata?.count || (mode === "image" ? config.canvasImageCount || config.count : config.count) || defaultConfig.count),
        textCount: String(node?.metadata?.textCount || Math.max(1, Math.min(15, Number(config.canvasTextCount) || 1))),
        ...falNodeConfig({ ...config, model }, node?.metadata),
    };
}

export function resetInterruptedGeneration(nodes: CanvasNodeData[]) {
    const activeTasks = nodes.flatMap((node) => [node.metadata?.remoteTask, ...(node.metadata?.images || []).map((image) => image.remoteTask)])
        .filter((task) => ["submitting", "pending", "waiting_network", "waiting_configuration"].includes(task?.status || ""));
    return nodes.map((node) =>
        node.metadata?.status === "loading"
        && !activeTasks.some((task) => task?.sourceNodeId === node.id || task === node.metadata?.remoteTask || node.metadata?.images?.some((image) => image.remoteTask === task))
            ? {
                  ...node,
                  metadata: {
                      ...node.metadata,
                      status: "error" as const,
                      errorDetails: i18n.t("canvas.generation.interrupted"),
                      images: node.metadata.images?.map((image) => (image.status === "loading" ? { ...image, status: "error" as const, errorDetails: i18n.t("canvas.generation.interrupted") } : image)),
                      texts: node.metadata.texts?.map((text) => (text.status === "loading" ? { ...text, status: "error" as const, errorDetails: i18n.t("canvas.generation.interrupted") } : text)),
                  },
              }
            : node,
    );
}

export function isGenerationCanceled(error: unknown) {
    return error instanceof Error && (error.message === i18n.t("common.requestCanceled") || error.name === "AbortError");
}

export function findRetrySourceNode(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const queue = connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId);
    const visited = new Set<string>();
    while (queue.length) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const node = nodes.find((item) => item.id === id);
        if (node?.type === CanvasNodeType.Config) return node;
        connections.filter((connection) => connection.toNodeId === id).forEach((connection) => queue.push(connection.fromNodeId));
    }
    return null;
}

/**
 * 已生成视频节点再生成时新建子节点的连线（project.tsx video 分支共用）：
 * - 血统边（lineage: true）表达"子节点由源节点再生成产生"。它不是参考输入，参考收集与引用栏
 *   必须跳过（getContextInputNodes / connectedNodesByNodeId），否则新节点的引用会显示成源视频自己，
 *   且在子节点上再次生成会把源视频误当参考输入；findRetrySourceNode 仍需穿透它向上找 config 祖先。
 * - 直接参考流（源是视频节点且无 config 祖先）把源节点的参考入边同步连到子节点，引用栏与后续
 *   再生成沿用同一批参考；config 祖先持有参考时不复制——参考仍由 config 管理（与 retry 同源），
 *   复制反而制造"断开无效"的假引用芯片。
 */
export function buildVideoChildConnections(sourceNodeId: string, childId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasConnection[] {
    const child: CanvasConnection = { id: nanoid(), fromNodeId: sourceNodeId, toNodeId: childId, lineage: true };
    const source = nodes.find((node) => node.id === sourceNodeId);
    if (source?.type !== CanvasNodeType.Video || findRetrySourceNode(sourceNodeId, nodes, connections)) return [child];
    const inherited = connections
        .filter((connection) => connection.toNodeId === sourceNodeId && !connection.lineage)
        .filter((connection) => {
            const from = nodes.find((node) => node.id === connection.fromNodeId);
            return Boolean(from && isCanvasReferenceNode(from, nodes, { strictReferences: true }));
        })
        .map((connection) => ({ id: nanoid(), fromNodeId: connection.fromNodeId, toNodeId: childId }));
    return [child, ...inherited];
}

export function sourceNodeReferenceImages(node: CanvasNodeData | null) {
    if (!node || node.type !== CanvasNodeType.Image || !node.metadata?.content) return [];
    return [
        {
            id: node.id,
            name: `${node.title || node.id}.png`,
            type: node.metadata.mimeType || "image/png",
            dataUrl: node.metadata.content,
            storageKey: node.metadata.storageKey,
            assetRef: node.metadata?.assetRef,
        },
    ];
}

export function isAudioFile(file: File) {
    return file.type.startsWith("audio/") || /\.(mp3|wav)$/i.test(file.name);
}

export function buildAngleLabel(params: CanvasImageAngleParams) {
    const horizontal = params.horizontalAngle === 0 ? i18n.t("canvas.generation.front") : params.horizontalAngle > 0 ? i18n.t("canvas.generation.rotateRight", { angle: params.horizontalAngle }) : i18n.t("canvas.generation.rotateLeft", { angle: Math.abs(params.horizontalAngle) });
    const pitch = params.pitchAngle === 0 ? i18n.t("canvas.generation.level") : params.pitchAngle > 0 ? i18n.t("canvas.generation.topDown", { angle: params.pitchAngle }) : i18n.t("canvas.generation.lowAngle", { angle: Math.abs(params.pitchAngle) });
    return i18n.t("canvas.generation.angleLabel", { horizontal, pitch, distance: params.cameraDistance.toFixed(1), lens: i18n.t(params.wideAngle ? "canvas.editors.wide" : "canvas.editors.standard") });
}

export function buildAnglePrompt(params: CanvasImageAngleParams) {
    return i18n.t("canvas.generation.anglePrompt", { angle: buildAngleLabel(params) });
}

export type ImageModeSourceTransformOptions = {
    isConfigNode: boolean;
    isEmptyImageNode: boolean;
    isImageNode: boolean;
    rootNode: CanvasNodeData;
    prompt: string;
    parentConfig: { width: number; height: number };
};

/**
 * Image 模式下对生成源节点的就地变换（从 project.tsx handleGenerateNode 抽取以便单测）。
 * plugin 节点（如 3d）原样保留——此前的 else 分支会把它们改写成 Text(prompt) 节点，
 * 恰好是「3D 模型节点丢失、变成用户输入 prompt」的确定性根因。
 */
export function imageModeSourceNodeTransform(node: CanvasNodeData, options: ImageModeSourceTransformOptions): CanvasNodeData {
    const { isConfigNode, isEmptyImageNode, isImageNode, rootNode, prompt, parentConfig } = options;
    if (isConfigNode) {
        return { ...node, metadata: { ...node.metadata, status: "loading", errorDetails: undefined } };
    }
    if (isEmptyImageNode) {
        return {
            ...node,
            position: rootNode.position,
            width: rootNode.width,
            height: rootNode.height,
            title: rootNode.title,
            // scriptEntityRef 标记"该节点为哪个实体生成参考图"，模板展开不得清除（槽位回写依赖它）。
            metadata: { ...node.metadata, ...rootNode.metadata, ...(node.metadata?.scriptEntityRef ? { scriptEntityRef: node.metadata.scriptEntityRef } : {}), errorDetails: undefined },
        };
    }
    if (isImageNode) {
        return { ...node, metadata: { ...node.metadata, status: "success", errorDetails: undefined } };
    }
    // Plugin display nodes (type outside the CanvasNodeType enum, e.g. "3d") keep their type and
    // metadata; the generated image lands in the newly created child node instead.
    if (isPluginNodeType(node.type)) return node;
    return {
        ...node,
        type: CanvasNodeType.Text,
        title: prompt.slice(0, 32) || "Prompt",
        width: parentConfig.width,
        height: parentConfig.height,
        metadata: { ...node.metadata, content: prompt, prompt, status: "success", fontSize: 14, errorDetails: undefined },
    };
}

/**
 * 生成期间是否在源节点上标记 loading。plugin 节点跳过——NodeContent 的 loading 分支
 * 优先于插件渲染器，会把 3D 预览整个顶掉；子 image 节点自带 loading 指示。
 */
export function shouldMarkSourceStatus(node: CanvasNodeData) {
    return !isPluginNodeType(node.type);
}
