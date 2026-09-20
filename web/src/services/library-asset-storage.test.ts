import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LibraryAssetRecord, LibraryAssetsBridge } from "@/lib/library-assets/library-asset-types";

// 避免 jsdom 里真实的图片解码（10s 超时）：loadImageMeta/readVideoMeta 给假尺寸，其余导出保留真实实现。
vi.mock("@/services/image-storage", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getImageBlob: vi.fn().mockResolvedValue(null),
    loadImageMeta: vi.fn().mockResolvedValue({ width: 2, height: 2 }),
}));
vi.mock("@/services/file-storage", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getMediaBlob: vi.fn().mockResolvedValue(null),
    readVideoMeta: vi.fn().mockResolvedValue({ width: 4, height: 4 }),
}));

const makeRecord = (overrides: Partial<LibraryAssetRecord> = {}): LibraryAssetRecord => ({
    backend: "library-file", assetId: "a1", relativePath: "images/a--12345678.png", revision: 1,
    originalName: "a.png", kind: "image", mimeType: "image/png", bytes: 4, sha256: "x",
    title: "a", tags: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
});

function installBridge(overrides: Partial<LibraryAssetsBridge> = {}) {
    const bridge = {
        list: vi.fn().mockResolvedValue({ ok: true, value: { assets: [makeRecord()] } }),
        write: vi.fn().mockResolvedValue({ ok: true, value: { record: makeRecord(), ref: { backend: "library-file", assetId: "a1", relativePath: "images/a--12345678.png", revision: 1 } } }),
        importPath: vi.fn(),
        read: vi.fn().mockResolvedValue({ ok: true, value: { bytes: pngBytes(), record: makeRecord() } }),
        stat: vi.fn(),
        remove: vi.fn().mockResolvedValue({ ok: true, value: true }),
        onChanged: vi.fn().mockReturnValue(() => undefined),
        ...overrides,
    };
    (window as unknown as { shotshot: unknown }).shotshot = { libraryAssets: bridge, platform: "darwin" };
    return bridge as unknown as LibraryAssetsBridge & Record<string, ReturnType<typeof vi.fn>>;
}

const pngBytes = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

// 门面的 URL/missing 缓存是模块级状态：resetModules 后按用例重新加载，避免用例间串扰。
const importFacade = () => import("./library-asset-storage");

describe("library-asset-storage", () => {
    beforeEach(async () => {
        vi.resetModules();
        const { useAssetStore } = await import("@/stores/use-asset-store");
        useAssetStore.setState({ assets: [] });
        let urlCount = 0;
        // 类形式保持 URL 可构造：jsdom 未实现 createObjectURL（与 project-asset-storage.test.ts 同一套桩）。
        const UrlStub = class extends URL {};
        UrlStub.createObjectURL = vi.fn(() => `blob:url-${(urlCount += 1)}`);
        UrlStub.revokeObjectURL = vi.fn();
        vi.stubGlobal("URL", UrlStub);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        delete (window as unknown as { shotshot?: unknown }).shotshot;
        vi.restoreAllMocks();
    });

    it("resolveLibraryAssetUrl 经桥读字节并缓存", async () => {
        const bridge = installBridge();
        const { resolveLibraryAssetUrl } = await importFacade();
        const ref = { backend: "library-file" as const, assetId: "a1", relativePath: "images/a--12345678.png", revision: 1 };
        const url = await resolveLibraryAssetUrl(ref);
        expect(url.startsWith("blob:")).toBe(true);
        expect(bridge.read).toHaveBeenCalledTimes(1);
        expect(await resolveLibraryAssetUrl(ref)).toBe(url);
        expect(bridge.read).toHaveBeenCalledTimes(1);
    });

    it("read 失败回退 fallback", async () => {
        installBridge({ read: vi.fn().mockResolvedValue({ ok: false, error: "missing" }) });
        const { resolveLibraryAssetUrl, getLibraryAssetBlob } = await importFacade();
        const ref = { backend: "library-file" as const, assetId: "a1", relativePath: "images/a--12345678.png", revision: 1 };
        expect(await resolveLibraryAssetUrl(ref, "fb")).toBe("fb");
        expect(await getLibraryAssetBlob(ref)).toBeNull();
    });

    it("buildLibraryAsset 写库并返回可入库的 Asset（含 storageRef）", async () => {
        installBridge();
        const { buildLibraryAsset } = await importFacade();
        const blob = new Blob([pngBytes()], { type: "image/png" });
        const asset = await buildLibraryAsset(blob, { title: "测试图", source: "Upload" });
        expect(asset.kind).toBe("image");
        expect(asset.id).toBe("a1");
        expect(asset.metadata?.storageRef).toMatchObject({ backend: "library-file", assetId: "a1" });
        const dataUrl = asset.kind === "image" ? asset.data.dataUrl : "";
        expect(dataUrl.startsWith("blob:") || dataUrl === "").toBe(true);
    });

    it("removeLibraryAsset 走桥并抛出失败", async () => {
        const bridge = installBridge();
        const { removeLibraryAsset } = await importFacade();
        await removeLibraryAsset("a1");
        expect(bridge.remove).toHaveBeenCalledWith("a1");
        installBridge({ remove: vi.fn().mockResolvedValue({ ok: false, error: "boom" }) });
        await expect(removeLibraryAsset("a1")).rejects.toThrow("boom");
    });

    it("libraryBlobFromMedia 拒绝 blob: 死链", async () => {
        installBridge();
        const { libraryBlobFromMedia } = await importFacade();
        expect(await libraryBlobFromMedia({ content: "blob:dead" })).toBeNull();
        expect(await libraryBlobFromMedia({ content: "data:text/plain;base64,aGk=" })).not.toBeNull();
    });
});
