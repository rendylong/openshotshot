import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";

import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { useAssetMentionCandidates, useAssetMentionResolver } from "./use-asset-mention";

const imageAsset: Asset = { id: "a1", kind: "image", title: "唐剑", coverUrl: "blob:cover-a1", tags: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", data: { dataUrl: "data:image/png;base64,A1", width: 8, height: 8, bytes: 8, mimeType: "image/png" } };
const textAsset: Asset = { id: "t1", kind: "text", title: "文本", coverUrl: "", tags: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", data: { content: "hi" } };

beforeEach(() => {
    useAssetStore.setState({ assets: [] });
});

describe("use-asset-mention", () => {
    test("candidates derive from the asset store, image/video only", () => {
        useAssetStore.setState({ assets: [imageAsset, textAsset] });
        const { result } = renderHook(() => useAssetMentionCandidates());
        expect(result.current).toEqual([{ assetId: "a1", kind: "image", title: "唐剑", coverUrl: "blob:cover-a1" }]);
    });
    test("resolver resolves targets from the asset store", () => {
        useAssetStore.setState({ assets: [imageAsset] });
        const { result } = renderHook(() => useAssetMentionResolver());
        expect(result.current("a1")?.kind).toBe("image");
        expect(result.current("gone")).toBeUndefined();
    });
});
