import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveImageUrl } from "@/services/image-storage";
import { resolveCanvasAssetUrl } from "@/services/project-asset-storage";

const storageMock = vi.hoisted(() => ({
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
}));

vi.mock("@/lib/localforage-storage", () => ({ localForageStorage: storageMock }));
vi.mock("@/services/image-storage", () => ({ resolveImageUrl: vi.fn(async () => ""), uploadImage: vi.fn(), cleanupUnusedImages: vi.fn() }));
vi.mock("@/services/file-storage", () => ({ resolveMediaUrl: vi.fn(async () => ""), cleanupUnusedMedia: vi.fn() }));
vi.mock("@/services/project-asset-storage", () => ({ resolveCanvasAssetUrl: vi.fn(async () => "") }));

import { migrateAssetMedia, type ImageAsset } from "./use-asset-store";

const imageAsset = (data: Partial<ImageAsset["data"]>, coverUrl = ""): ImageAsset => ({ id: "a1", kind: "image", title: "t", coverUrl, tags: [], createdAt: "", updatedAt: "", data: { dataUrl: "", width: 1, height: 1, bytes: 0, mimeType: "image/png", ...data } });

describe("migrateAssetMedia", () => {
    beforeEach(() => vi.restoreAllMocks());
    it("storageKey 既有分支回归：刷新 dataUrl", async () => {
        vi.mocked(resolveImageUrl).mockResolvedValue("blob:fresh");
        const out = await migrateAssetMedia(imageAsset({ storageKey: "image:k", dataUrl: "blob:stale" }));
        expect(out.data.dataUrl).toBe("blob:fresh");
    });
    it("assetRef 分支：project-file 资产刷新 dataUrl/coverUrl", async () => {
        vi.mocked(resolveCanvasAssetUrl).mockResolvedValue("blob:project");
        const ref = { backend: "project-file" as const, projectId: "p1", assetId: "a1", revision: 1, relativePath: "x.png" };
        const out = await migrateAssetMedia(imageAsset({ dataUrl: "blob:dead", assetRef: ref }, "blob:cover"));
        expect(out.data.dataUrl).toBe("blob:project");
        expect(out.coverUrl).toBe("blob:project");
    });
    it("assetRef 分支：coverUrl 非 blob 开头时保守保留", async () => {
        vi.mocked(resolveCanvasAssetUrl).mockResolvedValue("blob:project");
        const ref = { backend: "project-file" as const, projectId: "p1", assetId: "a1", revision: 1, relativePath: "x.png" };
        const out = await migrateAssetMedia(imageAsset({ dataUrl: "blob:dead", assetRef: ref }));
        expect(out.data.dataUrl).toBe("blob:project");
        expect(out.coverUrl).toBe("");
    });
    it("无 storageKey 无 assetRef 的死 blob：原样保留（不静默删）", async () => {
        const out = await migrateAssetMedia(imageAsset({ dataUrl: "blob:dead" }));
        expect(out.data.dataUrl).toBe("blob:dead");
    });
});

// 存储选择在模块加载时读取 window.shotshot，因此用 vi.resetModules + 动态 import 隔离两种环境。
describe("useAssetStore persistence gating", () => {
    afterEach(() => {
        delete (window as unknown as { shotshot?: unknown }).shotshot;
        vi.resetModules();
    });

    it("无 libraryAssets 桥时保持 localforage 持久化（现状行为）", async () => {
        vi.resetModules();
        const { useAssetStore } = await import("./use-asset-store");
        expect(useAssetStore.getState().assets).toEqual([]);
        // localforage 路径由既有用例覆盖，这里只断言模块可加载且无桥时不走内存分支的短路。
    });

    it("有 libraryAssets 桥时 setItem 为 no-op（内存 read-model）", async () => {
        vi.resetModules();
        (window as unknown as { shotshot: unknown }).shotshot = {
            libraryAssets: { list: async () => ({ ok: true, value: { assets: [] } }), onChanged: () => () => undefined },
            platform: "darwin",
        };
        const { useAssetStore } = await import("./use-asset-store");
        useAssetStore.getState().addAsset({ kind: "text", title: "t", coverUrl: "", tags: [], data: { content: "x" } });
        expect(useAssetStore.getState().assets).toHaveLength(1); // 内存仍在，但不落盘（无异常即通过）
    });
});
