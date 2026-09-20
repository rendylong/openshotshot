import { describe, expect, test } from "vitest";

import i18n from "@/i18n";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import type { Asset } from "@/stores/use-asset-store";
import { applyAssetMentionReferences, assetMentionResolverFrom, buildAssetMentionCandidates, parseAssetTokenSegments } from "./asset-mentions";

const imageAsset: Asset = { id: "a1", kind: "image", title: "唐剑", coverUrl: "blob:cover-a1", tags: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", data: { dataUrl: "data:image/png;base64,A1", width: 8, height: 8, bytes: 8, mimeType: "image/png" } };
const videoAsset: Asset = { id: "v1", kind: "video", title: "航拍", coverUrl: "blob:cover-v1", tags: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", data: { url: "https://example.com/v.mp4", width: 100, height: 100, bytes: 2, mimeType: "video/mp4" } };
const textAsset: Asset = { id: "t1", kind: "text", title: "文本", coverUrl: "", tags: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", data: { content: "hi" } };

describe("parseAssetTokenSegments", () => {
    test("splits text and asset tokens in order", () => {
        expect(parseAssetTokenSegments("a@[asset:x1]b")).toEqual([
            { type: "text", value: "a" },
            { type: "asset", assetId: "x1" },
            { type: "text", value: "b" },
        ]);
    });
    test("adjacent tokens and plain text passthrough", () => {
        expect(parseAssetTokenSegments("@[asset:x1]@[asset:x2]")).toEqual([{ type: "asset", assetId: "x1" }, { type: "asset", assetId: "x2" }]);
        expect(parseAssetTokenSegments("no tokens")).toEqual([{ type: "text", value: "no tokens" }]);
        expect(parseAssetTokenSegments("")).toEqual([]);
    });
});

describe("buildAssetMentionCandidates", () => {
    test("keeps image/video assets only, in store order", () => {
        expect(buildAssetMentionCandidates([imageAsset, textAsset, videoAsset])).toEqual([
            { assetId: "a1", kind: "image", title: "唐剑", coverUrl: "blob:cover-a1" },
            { assetId: "v1", kind: "video", title: "航拍", coverUrl: "blob:cover-v1" },
        ]);
    });
});

describe("assetMentionResolverFrom", () => {
    test("resolves image/video targets; text and missing assets are undefined", () => {
        const resolve = assetMentionResolverFrom([imageAsset, videoAsset, textAsset]);
        expect(resolve("a1")).toEqual({ kind: "image", title: "唐剑", dataUrl: "data:image/png;base64,A1", storageKey: undefined, mimeType: "image/png" });
        expect(resolve("v1")).toEqual({ kind: "video", title: "航拍", url: "https://example.com/v.mp4", storageKey: undefined, mimeType: "video/mp4" });
        expect(resolve("t1")).toBeUndefined();
        expect(resolve("gone")).toBeUndefined();
    });
});

describe("applyAssetMentionReferences", () => {
    const resolve = assetMentionResolverFrom([imageAsset, videoAsset]);
    test("appends references in word order after existing counts and rewrites tokens to continuing labels", () => {
        const result = applyAssetMentionReferences({ prompt: "A @[asset:a1] B @[asset:v1] C", resolveAsset: resolve, imageCount: 2, videoCount: 1 });
        expect(result.images.map((image) => image.id)).toEqual(["asset:a1"]);
        expect(result.images[0]).toMatchObject({ name: "唐剑.png", dataUrl: "data:image/png;base64,A1" });
        expect(result.videos.map((video) => video.id)).toEqual(["asset:v1"]);
        expect(result.videos[0]).toMatchObject({ name: "航拍.mp4", url: "https://example.com/v.mp4" });
        expect(result.prompt).toBe(`A ${imageReferenceLabel(2)} B ${i18n.t("canvas.configNode.videoReferences")} 2 C`);
    });
    test("dedupes repeated asset tokens to one reference with the same label", () => {
        const result = applyAssetMentionReferences({ prompt: "@[asset:a1] then @[asset:a1]", resolveAsset: resolve, imageCount: 0, videoCount: 0 });
        expect(result.images).toHaveLength(1);
        expect(result.prompt).toBe(`${imageReferenceLabel(0)} then ${imageReferenceLabel(0)}`);
    });
    test("throws for missing asset with the asset id in the message", () => {
        expect(() => applyAssetMentionReferences({ prompt: "x @[asset:gone]", resolveAsset: resolve, imageCount: 0, videoCount: 0 })).toThrowError(/gone/);
    });
    test("prompt without tokens passes through unchanged", () => {
        const result = applyAssetMentionReferences({ prompt: "plain", resolveAsset: resolve, imageCount: 1, videoCount: 0 });
        expect(result).toEqual({ prompt: "plain", images: [], videos: [] });
    });
});
