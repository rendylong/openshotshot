import i18n from "@/i18n";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceVideo } from "@/types/media";
import type { Asset } from "@/stores/use-asset-store";

/** 资产引用持久 token（与 canvas-config-composer 的 @[node:id] 同族） */
// 模块级共享 g 正则（lastIndex 跨调用共享）：只可经 String.replace / matchAll 消费，禁止裸 .test() 或中断的 .exec()（会污染 lastIndex）。
export const ASSET_TOKEN_PATTERN = /@\[asset:([^\]]+)\]/g;

/** composer 分支混排解析：组 1 = "node" | "asset"，组 2 = id */
// 同上：共享 g 正则，只可经 String.replace / matchAll 消费，禁止裸 .test() 或中断的 .exec()。
export const REFERENCE_TOKEN_PATTERN = /@\[(node|asset):([^\]]+)\]/g;

/** 资产在生成侧解析出的参考媒体（调用方从 use-asset-store 构造） */
export type AssetMentionTarget =
    | { kind: "image"; title: string; dataUrl: string; storageKey?: string; mimeType?: string }
    | { kind: "video"; title: string; url: string; storageKey?: string; mimeType?: string };

export type AssetMentionResolver = (assetId: string) => AssetMentionTarget | undefined;

/** @ 菜单候选（编辑器共用；仅 image/video 资产） */
export type AssetMentionCandidate = { assetId: string; kind: "image" | "video"; title: string; coverUrl: string };

export function buildAssetMentionCandidates(assets: Asset[]): AssetMentionCandidate[] {
    return assets
        .filter((asset): asset is Extract<Asset, { kind: "image" | "video" }> => asset.kind === "image" || asset.kind === "video")
        .map((asset) => ({ assetId: asset.id, kind: asset.kind, title: asset.title, coverUrl: asset.coverUrl }));
}

export function assetMentionResolverFrom(assets: Asset[]): AssetMentionResolver {
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    return (assetId) => {
        const asset = byId.get(assetId);
        if (asset?.kind === "image") return { kind: "image", title: asset.title, dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, mimeType: asset.data.mimeType };
        if (asset?.kind === "video") return { kind: "video", title: asset.title, url: asset.data.url, storageKey: asset.data.storageKey, mimeType: asset.data.mimeType };
        return undefined;
    };
}

export type AssetTokenSegment = { type: "text"; value: string } | { type: "asset"; assetId: string };

/** 把含 token 的提示词切成文本/资产段（编辑器渲染与序列化共用） */
export function parseAssetTokenSegments(value: string): AssetTokenSegment[] {
    const segments: AssetTokenSegment[] = [];
    let lastIndex = 0;
    for (const match of value.matchAll(ASSET_TOKEN_PATTERN)) {
        if (match.index === undefined) continue;
        if (match.index > lastIndex) segments.push({ type: "text", value: value.slice(lastIndex, match.index) });
        segments.push({ type: "asset", assetId: match[1] });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < value.length) segments.push({ type: "text", value: value.slice(lastIndex) });
    return segments;
}

/** 非 composer 分支的资产附加解析：参考按语序排在既有参考之后，token 重写为接续编号 label
    （图片N/视频N 与最终参考列表序号一致）；同资产去重（首次语序为准）；缺失资产抛错（显式引用不静默吞掉）。 */
export function applyAssetMentionReferences(args: { prompt: string; resolveAsset: AssetMentionResolver; imageCount: number; videoCount: number }): { prompt: string; images: ReferenceImage[]; videos: ReferenceVideo[] } {
    const images: ReferenceImage[] = [];
    const videos: ReferenceVideo[] = [];
    const labelByAssetId = new Map<string, string>();
    const prompt = args.prompt.replace(ASSET_TOKEN_PATTERN, (_token, assetId: string) => {
        const known = labelByAssetId.get(assetId);
        if (known) return known;
        const target = args.resolveAsset(assetId);
        if (!target) throw new Error(i18n.t("autodlGeneration.missingReference", { name: assetId }));
        if (target.kind === "image") {
            const label = imageReferenceLabel(args.imageCount + images.length);
            labelByAssetId.set(assetId, label);
            images.push({ id: `asset:${assetId}`, name: `${target.title}.png`, type: target.mimeType || "image/png", dataUrl: target.dataUrl, storageKey: target.storageKey });
            return label;
        }
        const label = `${i18n.t("canvas.configNode.videoReferences")} ${args.videoCount + videos.length + 1}`;
        labelByAssetId.set(assetId, label);
        videos.push({ id: `asset:${assetId}`, name: `${target.title}.mp4`, type: target.mimeType || "video/mp4", url: target.url, storageKey: target.storageKey });
        return label;
    });
    return { prompt, images, videos };
}
