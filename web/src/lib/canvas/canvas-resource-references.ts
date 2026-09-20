import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import i18n from "@/i18n";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import { getCanvasAssetBlob } from "@/services/project-asset-storage";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import type { AgentCanvasImageReadRequest, AgentCanvasImageReadResult, PiSessionScope } from "@/lib/agent/pi-agent-types";
import { ensureModel3dViews } from "@/lib/canvas/model-3d-snapshot";
import type { Model3dViewId } from "@/lib/canvas/model-3d-camera";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";

export type CanvasResourceKind = "image" | "video" | "audio" | "text";
type ResourceTraversalOptions = { strictReferences?: boolean };

/** 项目文件资产 → data URL；读取失败返回空串（由调用方按既有缺失语义处理）。 */
async function canvasAssetRefDataUrl(assetRef: CanvasAssetRef): Promise<string> {
    const blob = await getCanvasAssetBlob(assetRef);
    if (!blob) return "";
    return await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => resolve("");
        reader.readAsDataURL(blob);
    });
}

export type CanvasResourceReference = {
    id: string;
    nodeId: string;
    kind: CanvasResourceKind;
    label: string;
    title: string;
    previewUrl?: string;
    text?: string;
    active: boolean;
};

export function buildNodeMentionReferences(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return labelResourceNodes(getMentionResourceNodes(node.id, nodes, connections), true);
}

/** Chip/preview URL for a node: prefer the runtime resource snapshot; fall back to metadata.content only
 * when it decodes as an image (3D nodes keep the GLB blob: URL there and must render an icon instead). */
export function nodePreviewImageUrl(node: CanvasNodeData): string | undefined {
    const resource = getNodeDefinition(node.type)?.resource?.(node);
    if (resource?.url) return resource.url;
    const content = node.metadata?.content;
    if (!content) return undefined;
    const mimeType = node.metadata?.mimeType;
    return !mimeType || mimeType.startsWith("image/") ? content : undefined;
}

export function buildCanvasResourceReferences(nodes: CanvasNodeData[]) {
    return labelResourceNodes(nodes, true);
}

export async function resolveCanvasReferenceImages(references: CanvasResourceReference[], nodes: CanvasNodeData[]) {
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const resolved = await Promise.all(references.filter((reference) => reference.kind === "image").map(async (reference) => {
        const node = nodesById.get(reference.nodeId);
        if (!node) throw new Error(i18n.t("agent.composer.mentions.resourceMissing", { title: reference.title }));
        const metadata = node.metadata;
        // 3d 节点：顶层 storageKey/assetRef 是 GLB 本体，绝不能当图片解码；图像来源只有视口快照
        //（持久化 snapshot.storageKey 优先，实时 previewUrl 兜底）。两者皆不可用 → 优雅跳过该节点。
        if (metadata?.model3d) {
            const snapshotKey = metadata.model3d.snapshot?.storageKey;
            const dataUrl = await imageToDataUrl({ storageKey: snapshotKey, url: reference.previewUrl });
            if (!dataUrl.startsWith("data:image/")) {
                if (!snapshotKey) return null;
                throw new Error(i18n.t("agent.composer.mentions.imageReadFailed", { title: reference.title }));
            }
            const meta = metadata.naturalWidth && metadata.naturalHeight
                ? { width: metadata.naturalWidth, height: metadata.naturalHeight, mimeType: metadata.mimeType || dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png" }
                : await readImageMeta(dataUrl);
            return mentionImage(reference, node, metadata, dataUrl, meta);
        }
        // assetRef（项目文件）优先：无 storageKey 的桌面资产经门面读字节。
        const dataUrl = metadata?.assetRef
            ? await canvasAssetRefDataUrl(metadata.assetRef)
            : await imageToDataUrl({ storageKey: metadata?.storageKey, url: reference.previewUrl });
        if (!dataUrl.startsWith("data:image/")) throw new Error(i18n.t("agent.composer.mentions.imageReadFailed", { title: reference.title }));
        const meta = metadata?.naturalWidth && metadata.naturalHeight
            ? { width: metadata.naturalWidth, height: metadata.naturalHeight, mimeType: metadata.mimeType || dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png" }
            : await readImageMeta(dataUrl);
        return mentionImage(reference, node, metadata, dataUrl, meta);
    }));
    return resolved.filter((image): image is NonNullable<typeof image> => Boolean(image));
}

function mentionImage(
    reference: CanvasResourceReference,
    node: CanvasNodeData,
    metadata: CanvasNodeData["metadata"],
    dataUrl: string,
    meta: { width: number; height: number; mimeType: string },
) {
    return {
        id: `canvas:${node.id}`,
        name: reference.title,
        type: metadata?.mimeType || meta.mimeType,
        size: metadata?.bytes || getDataUrlByteSize(dataUrl),
        width: meta.width,
        height: meta.height,
        url: reference.previewUrl || dataUrl,
        dataUrl,
    };
}

export async function resolveCanvasImageForAgent(
    request: AgentCanvasImageReadRequest,
    currentScope: PiSessionScope,
    nodes: CanvasNodeData[],
): Promise<AgentCanvasImageReadResult> {
    if (request.scope.projectId !== currentScope.projectId || request.scope.canvasId !== currentScope.canvasId) {
        return { ok: false, error: i18n.t("agent.canvasImage.scopeMismatch") };
    }
    const node = nodes.find((item) => item.id === request.nodeId);
    if (!node) return { ok: false, error: i18n.t("agent.canvasImage.nodeMissing", { nodeId: request.nodeId }) };
    if (node.type === "3d") {
        const viewId = (request.imageId || "primary") as Model3dViewId;
        if (!["primary", "left", "right", "top"].includes(viewId)) {
            return { ok: false, error: i18n.t("agent.canvasImage.imageMissing", { imageId: request.imageId }) };
        }
        try {
            const view = (await ensureModel3dViews(node)).find((candidate) => candidate.id === viewId);
            if (!view?.dataUrl) return { ok: false, error: i18n.t("agent.canvasImage.imageMissing", { imageId: viewId }) };
            const readMeta = await readImageMeta(view.dataUrl);
            return {
                ok: true,
                image: {
                    nodeId: node.id,
                    imageId: view.id,
                    title: node.title,
                    dataUrl: view.dataUrl,
                    mimeType: readMeta.mimeType,
                    width: readMeta.width,
                    height: readMeta.height,
                    sizeBytes: getDataUrlByteSize(view.dataUrl),
                },
            };
        } catch {
            return { ok: false, error: i18n.t("agent.canvasImage.readFailed", { nodeId: request.nodeId }) };
        }
    }
    if (node.type !== CanvasNodeType.Image) return { ok: false, error: i18n.t("agent.canvasImage.wrongNodeType", { nodeId: request.nodeId }) };

    const metadata = node.metadata;
    const images = metadata?.images ?? [];
    const selected = request.imageId
        ? images.find((image) => image.id === request.imageId)
        : images.find((image) => image.id === metadata?.primaryImageId) ?? images[0];
    if (request.imageId && !selected) return { ok: false, error: i18n.t("agent.canvasImage.imageMissing", { imageId: request.imageId }) };

    const source = selected ?? metadata;
    if (!source?.storageKey && !source?.content && !source?.assetRef) return { ok: false, error: i18n.t("agent.canvasImage.sourceMissing", { nodeId: request.nodeId }) };
    try {
        const dataUrl = source.assetRef ? await canvasAssetRefDataUrl(source.assetRef) : await imageToDataUrl({ storageKey: source.storageKey, url: source.content });
        if (!dataUrl.startsWith("data:image/")) return { ok: false, error: i18n.t("agent.canvasImage.readFailed", { nodeId: request.nodeId }) };
        const readMeta = source.naturalWidth && source.naturalHeight
            ? { width: source.naturalWidth, height: source.naturalHeight, mimeType: source.mimeType || dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png" }
            : await readImageMeta(dataUrl);
        return {
            ok: true,
            image: {
                nodeId: node.id,
                ...(selected ? { imageId: selected.id } : {}),
                title: node.title,
                dataUrl,
                mimeType: source.mimeType || readMeta.mimeType,
                width: readMeta.width,
                height: readMeta.height,
                sizeBytes: source.bytes || getDataUrlByteSize(dataUrl),
            },
        };
    } catch {
        return { ok: false, error: i18n.t("agent.canvasImage.readFailed", { nodeId: request.nodeId }) };
    }
}

export function getMentionResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const configInputs = expandGroupResourceNodes(getConnectedConfigInputNodes(nodeId, nodes, connections), nodes);
    if (configInputs.length) return configInputs;
    const ownInputs = expandGroupResourceNodes(getContextInputNodes(nodeId, nodes, connections), nodes);
    if (ownInputs.length) return ownInputs;
    const node = nodes.find((item) => item.id === nodeId);
    return node && isResourceNode(node) ? [node] : [];
}

export function getGenerationResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], options: ResourceTraversalOptions = {}) {
    const configInputs = getConnectedConfigInputNodes(nodeId, nodes, connections, options);
    if (configInputs.length) return configInputs;
    const ownInputs = getContextInputNodes(nodeId, nodes, connections, options);
    if (ownInputs.length) return ownInputs;
    return [];
}

function getContextInputNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], options: ResourceTraversalOptions = {}) {
    // lineage 边是"子节点由父视频再生成产生"的血统关系，不是参考输入：计入会把父视频
    // 当参考（首次展示错误，再次生成还会把父视频真的送进 videoReferences）。
    return connections
        .filter((connection) => connection.toNodeId === nodeId && !connection.lineage)
        .map((connection) => nodes.find((node) => node.id === connection.fromNodeId))
        .filter((node): node is CanvasNodeData => Boolean(node && isCanvasReferenceNode(node, nodes, options)));
}

function getConnectedConfigInputNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], options: ResourceTraversalOptions = {}) {
    const configConnection = connections.find((connection) => connection.fromNodeId === nodeId && nodes.find((node) => node.id === connection.toNodeId)?.type === CanvasNodeType.Config);
    if (!configConnection) return [];
    return getContextInputNodes(configConnection.toNodeId, nodes, connections, options).filter((node) => node.id !== nodeId);
}

function hasGroupResources(node: CanvasNodeData, nodes: CanvasNodeData[], options: ResourceTraversalOptions = {}) {
    return node.type === CanvasNodeType.Group && getGroupResourceNodes(node.id, nodes, options).length > 0;
}

export function isCanvasReferenceNode(node: CanvasNodeData, nodes: CanvasNodeData[], options: ResourceTraversalOptions = {}) {
    return isResourceNode(node, options) || hasGroupResources(node, nodes, options);
}

function expandGroupResourceNodes(inputNodes: CanvasNodeData[], nodes: CanvasNodeData[]) {
    const resources = inputNodes.flatMap((node) => (node.type === CanvasNodeType.Group ? getGroupResourceNodes(node.id, nodes) : [node]));
    return [...new Map(resources.map((node) => [node.id, node])).values()];
}

export function getGroupResourceNodes(groupId: string, nodes: CanvasNodeData[], options: ResourceTraversalOptions = {}) {
    return nodes.filter((node) => node.metadata?.groupId === groupId && isResourceNode(node, options));
}

function labelResourceNodes(nodes: CanvasNodeData[], active: boolean) {
    const counts: Record<CanvasResourceKind, number> = { image: 0, video: 0, audio: 0, text: 0 };
    return nodes.flatMap((node): CanvasResourceReference[] => {
        const kind = resourceKind(node);
        if (!kind) return [];
        const resource = getNodeDefinition(node.type)?.resource?.(node);
        const index = counts[kind]++;
        const label = labelForKind(kind, index);
        return [
            {
                id: node.id,
                nodeId: node.id,
                kind,
                label,
                title: node.title || label,
                // Prefer the runtime resource URL (e.g. a warm 3D snapshot) over metadata.content,
                // which for 3d nodes is the GLB blob: URL and renders as a broken image chip.
                previewUrl: nodePreviewImageUrl(node),
                text: resourceText(node),
                active,
            },
        ];
    });
}

function labelForKind(kind: CanvasResourceKind, index: number) {
    if (kind === "image") return imageReferenceLabel(index);
    if (kind === "video") return i18n.t("canvas.configNode.videoReferences") + ` ${index + 1}`;
    if (kind === "audio") return i18n.t("canvas.configNode.audioReferences") + ` ${index + 1}`;
    return i18n.t("canvas.composer.resources.text", { index: index + 1 });
}

function isResourceNode(node: CanvasNodeData, options: ResourceTraversalOptions = {}) {
    // Strict generation must see persisted and unavailable media alike: hydration or compilation
    // decides whether a selected reference is usable, rather than silently dropping it here.
    if (options.strictReferences && [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio].includes(node.type as CanvasNodeType)) return true;
    return Boolean(resourceKind(node));
}

function resourceText(node: CanvasNodeData): string | undefined {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt;
    const resource = getNodeDefinition(node.type)?.resource?.(node);
    return resource?.kind === "text" ? resource.text : undefined;
}

function resourceKind(node: CanvasNodeData): CanvasResourceKind | null {
    if (node.type === CanvasNodeType.Image && node.metadata?.content) return "image";
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return "video";
    if (node.type === CanvasNodeType.Audio && node.metadata?.content) return "audio";
    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return "text";
    // Plugin nodes declare their input eligibility statically first (cold-cache reliable — resource() reads a
    // module-level snapshot cache that is empty before the node mounts), falling back to the runtime resource.
    const definition = getNodeDefinition(node.type);
    if (definition?.referenceKind) return definition.referenceKind;
    return definition?.resource?.(node)?.kind || null;
}
