import type { AiTextMessage } from "@/services/api/image";
import i18n from "@/i18n";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { SCRIPT_NODE_TYPE } from "@/types/script-node";
import { getGenerationResourceNodes, getGroupResourceNodes } from "@/lib/canvas/canvas-resource-references";
import { applyAssetMentionReferences, REFERENCE_TOKEN_PATTERN, type AssetMentionResolver } from "@/lib/canvas/asset-mentions";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { getLiveModel3dViews } from "@/lib/canvas/model-3d-snapshot";
import type { Model3dViewId } from "@/lib/canvas/model-3d-camera";

export type NodeGenerationContext = {
    prompt: string;
    referenceImages: ReferenceImage[];
    referenceVideos: ReferenceVideo[];
    referenceAudios: ReferenceAudio[];
    textCount: number;
    imageCount: number;
    videoCount: number;
    audioCount: number;
};

type NodeGenerationResourceInput = {
    nodeId: string;
    type: "text" | "image" | "video" | "audio";
    title: string;
    text?: string;
    image?: ReferenceImage;
    images?: ReferenceImage[];
    video?: ReferenceVideo;
    audio?: ReferenceAudio;
};

type NodeGenerationGroupInput = {
    nodeId: string;
    type: "group";
    title: string;
    children: NodeGenerationResourceInput[];
};

export type NodeGenerationInput = NodeGenerationResourceInput | NodeGenerationGroupInput;

export type NodeGenerationOptions = {
    strictReferences?: boolean;
    sourceImages?: ReferenceImage[];
    inputsSourceNodeId?: string;
    resolveAsset?: AssetMentionResolver;
    reference3dViews?: Record<string, Model3dViewId | "all">;
};

export function buildNodeGenerationContext(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], prompt: string, options: NodeGenerationOptions = {}): NodeGenerationContext {
    // inputsSourceNodeId 只替换参考的收集起点，prompt 语义（composer 判定等）仍以 nodeId 为准：
    // 从生成链上的媒体节点重新生成时参考取自 Config 祖先，但不得触发 config 的 composer 分支。
    const sourceNode = nodes.find((node) => node.id === nodeId);
    const resolvedOptions = options.reference3dViews || !sourceNode?.metadata?.reference3dViews
        ? options
        : { ...options, reference3dViews: sourceNode.metadata.reference3dViews };
    const inputs = buildNodeGenerationInputs(options.inputsSourceNodeId ?? nodeId, nodes, connections, resolvedOptions);
    if (resolvedOptions.strictReferences) {
        const composer = Boolean(sourceNode?.metadata?.composerContent?.trim()) || /@\[node:[^\]]+\]/.test(prompt);
        return buildStrictGenerationContext(inputs, prompt, composer, resolvedOptions.sourceImages, resolvedOptions.resolveAsset);
    }
    if (sourceNode?.type === CanvasNodeType.Config && Boolean(sourceNode.metadata?.composerContent?.trim())) {
        return buildComposerGenerationContext(inputs, prompt, resolvedOptions.resolveAsset);
    }

    const resourceInputs = flattenGenerationInputs(inputs);
    const upstreamText = resourceInputs
        .map((input) => input.text)
        .filter(Boolean)
        .join("\n\n");
    const referenceImages = resourceInputs.flatMap((input) => input.images || (input.image ? [input.image] : []));
    const referenceVideos = resourceInputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = resourceInputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));
    // 资产 token 是「附加」语义：排在连线参考之后按语序解析；上面的 composer 判定保持只认 node token（保护脚本镜头连线参考）
    const assetMentions = resolvedOptions.resolveAsset
        ? applyAssetMentionReferences({ prompt, resolveAsset: resolvedOptions.resolveAsset, imageCount: referenceImages.length, videoCount: referenceVideos.length })
        : null;
    const basePrompt = assetMentions ? assetMentions.prompt : prompt;
    const allImages = assetMentions ? [...referenceImages, ...assetMentions.images] : referenceImages;
    const allVideos = assetMentions ? [...referenceVideos, ...assetMentions.videos] : referenceVideos;

    return {
        prompt: upstreamText ? `${basePrompt}\n\n${upstreamText}` : basePrompt,
        referenceImages: allImages,
        referenceVideos: allVideos,
        referenceAudios,
        textCount: resourceInputs.filter((input) => input.type === "text").length,
        imageCount: allImages.length,
        videoCount: allVideos.length,
        audioCount: referenceAudios.length,
    };
}

function buildComposerGenerationContext(inputs: NodeGenerationInput[], prompt: string, resolveAsset?: AssetMentionResolver): NodeGenerationContext {
    const inputByNodeId = new Map(inputs.map((input) => [input.nodeId, input]));
    const selectedInputs: NodeGenerationResourceInput[] = [];
    const labelByNodeId = new Map<string, string>();
    const textBlocks: string[] = [];
    const counts = { image: 0, video: 0, audio: 0, text: 0 };
    let hasToken = false;
    let lastIndex = 0;
    let nextPrompt = "";

    for (const match of prompt.matchAll(REFERENCE_TOKEN_PATTERN)) {
        if (match.index === undefined) continue;
        hasToken = true;
        nextPrompt += prompt.slice(lastIndex, match.index);
        const input = match[1] === "asset" ? assetMentionInput(match[2], resolveAsset) : inputByNodeId.get(match[2]);
        if (input) {
            const labels = flattenGenerationInputs([input]).map((resource) => {
                let label = labelByNodeId.get(resource.nodeId);
                if (!label) {
                    label = generationLabel(resource.type, counts[resource.type]++);
                    labelByNodeId.set(resource.nodeId, label);
                    if (resource.type === "text") textBlocks.push(`【${label}】\n${resource.text || ""}`);
                    else selectedInputs.push(resource);
                }
                return resource.type === "text" ? `【${label}】` : label;
            });
            nextPrompt += labels.join("、");
        }
        lastIndex = match.index + match[0].length;
    }

    nextPrompt += prompt.slice(lastIndex);
    if (textBlocks.length) nextPrompt = `${nextPrompt.trim()}\n\n${textBlocks.join("\n\n")}`;
    const referenceImages = selectedInputs.flatMap((input) => input.images || (input.image ? [input.image] : []));
    const referenceVideos = selectedInputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = selectedInputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));

    if (!hasToken) {
        return {
            prompt,
            referenceImages: [],
            referenceVideos: [],
            referenceAudios: [],
            textCount: 0,
            imageCount: 0,
            videoCount: 0,
            audioCount: 0,
        };
    }

    return {
        prompt: nextPrompt,
        referenceImages,
        referenceVideos,
        referenceAudios,
        textCount: counts.text,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

/** composer 分支的资产 token → 与节点输入同构的参考输入（缺失即抛错，显式引用不静默） */
function assetMentionInput(assetId: string, resolveAsset?: AssetMentionResolver): NodeGenerationResourceInput {
    const target = resolveAsset?.(assetId);
    if (!target) throw new Error(i18n.t("autodlGeneration.missingReference", { name: assetId }));
    return target.kind === "image"
        ? { nodeId: `asset:${assetId}`, type: "image", title: target.title, image: { id: `asset:${assetId}`, name: `${target.title}.png`, type: target.mimeType || "image/png", dataUrl: target.dataUrl, storageKey: target.storageKey } }
        : { nodeId: `asset:${assetId}`, type: "video", title: target.title, video: { id: `asset:${assetId}`, name: `${target.title}.mp4`, type: target.mimeType || "video/mp4", url: target.url, storageKey: target.storageKey } };
}


/** Compile actual media identities once, so labels and submitted slots have the same order. */
export function buildStrictGenerationContext(inputs: NodeGenerationInput[], prompt: string, composer: boolean, sourceImages: ReferenceImage[] = [], resolveAsset?: AssetMentionResolver): NodeGenerationContext {
    const available = new Map<string, NodeGenerationInput>();
    for (const input of inputs) {
        available.set(input.nodeId, input);
        if (input.type === "group") for (const child of input.children) available.set(child.nodeId, child);
    }
    const context: NodeGenerationContext = { prompt, referenceImages: [], referenceAudios: [], referenceVideos: [], textCount: 0, imageCount: 0, audioCount: 0, videoCount: 0 };
    const labels = new Map<string, string>();
    const textBlocks: string[] = [];
    const select = (resource: NodeGenerationResourceInput): string[] => {
        const assets = resource.type === "image" ? (resource.images || (resource.image ? [resource.image] : []))
            : resource.type === "audio" ? (resource.audio ? [resource.audio] : [])
            : resource.type === "video" ? (resource.video ? [resource.video] : []) : [{ id: resource.nodeId }];
        if (!assets.length) throw new Error(i18n.t("autodlGeneration.missingReference", { name: resource.title || resource.nodeId }));
        return assets.map(asset => {
            const source = asset as ReferenceImage & ReferenceVideo & ReferenceAudio;
            if (resource.type !== "text" && !source.dataUrl && !source.url && !source.storageKey && !source.assetRef) {
                throw new Error(i18n.t("autodlGeneration.missingReference", { name: source.name || resource.title || resource.nodeId }));
            }
            const key = `${resource.type}:${asset.id}:${source.storageKey || ""}`;
            const existing = labels.get(key);
            if (existing) return existing;
            const index = resource.type === "image" ? context.referenceImages.length : resource.type === "audio" ? context.referenceAudios.length : resource.type === "video" ? context.referenceVideos.length : context.textCount;
            const label = generationLabel(resource.type, index);
            labels.set(key, label);
            if (resource.type === "image") context.referenceImages.push(asset as ReferenceImage);
            else if (resource.type === "audio") context.referenceAudios.push(asset as ReferenceAudio);
            else if (resource.type === "video") context.referenceVideos.push(asset as ReferenceVideo);
            else { context.textCount++; textBlocks.push(composer ? `【${label}】\n${resource.text || ""}` : resource.text || ""); }
            return resource.type === "text" && composer ? `【${label}】` : label;
        });
    };
    // The implicit editing source is primary; assign its slots before expanding explicit composer tags.
    if (sourceImages.length) select({ nodeId: "", title: "", type: "image", images: sourceImages });
    if (composer) {
        context.prompt = prompt.replace(REFERENCE_TOKEN_PATTERN, (_token, kind: string, id: string) => {
            const input = kind === "asset" ? assetMentionInput(id, resolveAsset) : available.get(id);
            if (!input) throw new Error(i18n.t("autodlGeneration.missingReference", { name: id }));
            const children = input.type === "group" ? input.children : [input];
            return children.flatMap(select).join("、");
        });
    } else {
        flattenGenerationInputs(inputs).forEach(select);
        if (resolveAsset) {
            const assets = applyAssetMentionReferences({ prompt: context.prompt, resolveAsset, imageCount: context.referenceImages.length, videoCount: context.referenceVideos.length });
            context.prompt = assets.prompt;
            context.referenceImages.push(...assets.images);
            context.referenceVideos.push(...assets.videos);
        }
    }
    if (textBlocks.length) context.prompt += `\n\n${textBlocks.join("\n\n")}`;
    context.imageCount = context.referenceImages.length;
    context.audioCount = context.referenceAudios.length;
    context.videoCount = context.referenceVideos.length;
    return context;
}

export function buildNodeGenerationInputs(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], options: NodeGenerationOptions = {}): NodeGenerationInput[] {
    const target = nodes.find((node) => node.id === nodeId);
    const resolvedOptions = options.reference3dViews || !target?.metadata?.reference3dViews
        ? options
        : { ...options, reference3dViews: target.metadata.reference3dViews };
    return getGenerationResourceNodes(nodeId, nodes, connections, resolvedOptions).flatMap((node): NodeGenerationInput[] => {
        if (node.type === CanvasNodeType.Group) {
            const children = getGroupResourceNodes(node.id, nodes, resolvedOptions).flatMap(child => readNodeGenerationResource(child, resolvedOptions));
            return children.length ? [{ nodeId: node.id, type: "group", title: node.title, children }] : [];
        }
        return readNodeGenerationResource(node, resolvedOptions);
    });
}

function flattenGenerationInputs(inputs: NodeGenerationInput[]) {
    const resources = inputs.flatMap((input) => (input.type === "group" ? input.children : [input]));
    return [...new Map(resources.map((input) => [input.nodeId, input])).values()];
}

/** Exact items for generation invoked on an image or image-reference plugin node itself. */
export function buildSourceImageReferences(node: CanvasNodeData) {
    return readNodeGenerationResource(node, { strictReferences: true }).flatMap(input => input.images || (input.image ? [input.image] : []));
}

/** Reference images a single node contributes: multi-view sources (3D: primary/left/right/top) and
 * multi-image nodes expand to several, so panels can show the real count instead of "1 per node".
 * Unresolved strict placeholders count 0 — the run would abort before sending them. */
export function countNodeReferenceImages(node: CanvasNodeData): number {
    return readNodeGenerationResource(node, { strictReferences: true })
        .flatMap((input) => (input.type === "image" ? input.images || (input.image ? [input.image] : []) : []))
        .length;
}

function readNodeGenerationResource(node: CanvasNodeData, options: NodeGenerationOptions = {}): NodeGenerationResourceInput[] {
    // 脚本节点只表达从属关系，不作为任何生成的参考（v0.5）：注入脚本文本/JSON 会污染 prompt 导致生成失败。
    if (node.type === SCRIPT_NODE_TYPE) return [];
    if (node.type === "3d") {
        const live = getLiveModel3dViews(node.id);
        const persisted = node.metadata?.model3d?.views || [];
        const views = live.length
            ? live
            : persisted.map((view) => ({ ...view, dataUrl: "" }));
        const selection = options.reference3dViews?.[node.id];
        const selectedViews = selection && selection !== "all"
            ? views.filter((view) => view.id === selection)
            : views;
        if (selectedViews.length) {
            return [{
                nodeId: node.id,
                type: "image",
                title: node.title,
                images: selectedViews.map((view) => ({
                    id: `${node.id}:${view.id}`,
                    name: `${node.title || node.id}-${view.id}.png`,
                    type: "image/png",
                    dataUrl: view.dataUrl,
                    storageKey: view.storageKey,
                    // 桌面 move 语义：迁移后的持久化 views 只剩 project-file assetRef（storageKey 已剥离），
                    // 必须随参考透传，否则 strict 校验视为缺参考、hydration 也无从读取工作区字节。
                    ...(view.assetRef ? { assetRef: view.assetRef } : {}),
                })),
            }];
        }
    }
    if (options.strictReferences && node.type === CanvasNodeType.Image && node.metadata?.images?.length) {
        const images = node.metadata.images.map(image => ({
            id: `${node.id}:${image.id}`, name: `${node.title || node.id}-${image.id}.png`,
            type: image.mimeType || "image/png", dataUrl: image.content || "", storageKey: image.storageKey,
            assetRef: image.assetRef,
        }));
        return [{ nodeId: node.id, type: "image", title: node.title, images }];
    }
    const image = readReferenceImage(node, options.strictReferences);
    if (image) return [{ nodeId: node.id, type: "image", title: node.title, image }];
    const video = readReferenceVideo(node, options.strictReferences);
    if (video) return [{ nodeId: node.id, type: "video", title: node.title, video }];
    const audio = readReferenceAudio(node, options.strictReferences);
    if (audio) return [{ nodeId: node.id, type: "audio", title: node.title, audio }];
    const definition = getNodeDefinition(node.type);
    const resource = definition?.resource?.(node);
    if (resource?.kind === "image" && resource.url) return [{ nodeId: node.id, type: "image", title: node.title, image: { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata?.mimeType || "image/png", dataUrl: resource.url, storageKey: node.metadata?.storageKey, ...(node.metadata?.assetRef ? { assetRef: node.metadata.assetRef } : {}) } }];
    if (resource?.kind === "video" && resource.url) return [{ nodeId: node.id, type: "video", title: node.title, video: { id: node.id, name: `${node.title || node.id}.mp4`, type: node.metadata?.mimeType || "video/mp4", url: resource.url, storageKey: node.metadata?.storageKey, ...(node.metadata?.assetRef ? { assetRef: node.metadata.assetRef } : {}) } }];
    if (resource?.kind === "audio" && resource.url) return [{ nodeId: node.id, type: "audio", title: node.title, audio: { id: node.id, name: `${node.title || node.id}.mp3`, type: node.metadata?.mimeType || "audio/mpeg", url: resource.url, storageKey: node.metadata?.storageKey, ...(node.metadata?.assetRef ? { assetRef: node.metadata.assetRef } : {}) } }];
    if (resource?.kind === "text" && resource.text) return [{ nodeId: node.id, type: "text", title: node.title, text: resource.text }];
    // Nodes statically declared as image references must not degrade into their metadata.prompt text when
    // the snapshot cache is cold — a stale prompt injected as text silently turns the run into text-to-image.
    // Callers warm the snapshot via ensureSnapshot() and abort with a visible error when it is unavailable.
    if (options.strictReferences) {
        const kind = definition?.referenceKind || node.type;
        if (kind === "image" || kind === "video" || kind === "audio") return [{ nodeId: node.id, type: kind as "image" | "video" | "audio", title: node.title }];
    }
    if (definition?.referenceKind === "image") return [];
    const text = readNodeTextInput(node);
    return text ? [{ nodeId: node.id, type: "text", title: node.title, text }] : [];
}

export function buildNodeResponseMessages(context: NodeGenerationContext): AiTextMessage[] {
    if (!context.referenceImages.length) {
        return [{ role: "user", content: context.prompt }];
    }

    return [
        {
            role: "user",
            content: [{ type: "text" as const, text: context.prompt }, ...context.referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))],
        },
    ];
}

export async function hydrateNodeGenerationContext(context: NodeGenerationContext) {
    const { imageToDataUrl } = await import("@/services/image-storage");
    const { getCanvasAssetBlob } = await import("@/services/project-asset-storage");
    const { readFileAsDataUrl } = await import("@/lib/image-utils");
    return {
        ...context,
        referenceImages: await Promise.all(
            context.referenceImages.map(async (image) => {
                if (!image.storageKey && image.assetRef) {
                    const blob = await getCanvasAssetBlob(image.assetRef);
                    if (blob) return { ...image, dataUrl: await readFileAsDataUrl(new File([blob], "reference", { type: blob.type })) };
                }
                return { ...image, dataUrl: await imageToDataUrl(image) };
            }),
        ),
    };
}

function readNodeTextInput(node: CanvasNodeData) {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt || "";
    return node.metadata?.prompt || "";
}

function generationLabel(type: NodeGenerationResourceInput["type"], index: number) {
    if (type === "image") return imageReferenceLabel(index);
    if (type === "video") return i18n.t("canvas.configNode.videoReferences") + ` ${index + 1}`;
    if (type === "audio") return i18n.t("canvas.configNode.audioReferences") + ` ${index + 1}`;
    return i18n.t("canvas.composer.resources.text", { index: index + 1 });
}

function readReferenceImage(node: CanvasNodeData, allowStored = false): ReferenceImage | null {
    if (node.type !== CanvasNodeType.Image || (!node.metadata?.content && !(allowStored && node.metadata?.storageKey))) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.png`,
        type: node.metadata!.mimeType || "image/png",
        dataUrl: node.metadata!.content || "",
        storageKey: node.metadata!.storageKey,
        assetRef: node.metadata!.assetRef,
    };
}

function readReferenceVideo(node: CanvasNodeData, allowStored = false): ReferenceVideo | null {
    if (node.type !== CanvasNodeType.Video || (!node.metadata?.content && !(allowStored && node.metadata?.storageKey))) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.mp4`,
        type: node.metadata!.mimeType || "video/mp4",
        url: node.metadata!.content || "",
        storageKey: node.metadata!.storageKey,
        bytes: node.metadata!.bytes,
        width: node.metadata!.naturalWidth,
        height: node.metadata!.naturalHeight,
        durationMs: node.metadata!.durationMs,
        assetRef: node.metadata!.assetRef,
    };
}

function readReferenceAudio(node: CanvasNodeData, allowStored = false): ReferenceAudio | null {
    if (node.type !== CanvasNodeType.Audio || (!node.metadata?.content && !(allowStored && node.metadata?.storageKey))) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.mp3`,
        type: node.metadata!.mimeType || "audio/mpeg",
        url: node.metadata!.content || "",
        storageKey: node.metadata!.storageKey,
        durationMs: node.metadata!.durationMs,
        assetRef: node.metadata!.assetRef,
    };
}
