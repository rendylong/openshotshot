import { afterEach, describe, expect, it, vi } from "vitest";

import type { LibraryAssetsBridge } from "@/lib/library-assets/library-asset-types";
import { localForageStorage } from "@/lib/localforage-storage";
import { migrateLegacyAssetsToLibrary } from "./library-asset-migration";

vi.mock("@/lib/localforage-storage", () => ({
    localForageStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock("@/services/image-storage", () => ({ getImageBlob: vi.fn().mockResolvedValue(new Blob([new Uint8Array([1])], { type: "image/png" })) }));
vi.mock("@/services/file-storage", () => ({ getMediaBlob: vi.fn().mockResolvedValue(null) }));

const legacyAsset = (overrides: Record<string, unknown> = {}) => ({
    id: "legacy-1", kind: "image", title: "旧图", coverUrl: "", tags: ["旧"], source: "Canvas",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    data: { dataUrl: "", storageKey: "image:abc", width: 1, height: 1, bytes: 4, mimeType: "image/png" },
    ...overrides,
});

function seedLegacyStore(assets: unknown[]) {
    // 真实存储为 zustand persist JSON.stringify 后的字符串（use-asset-store 的 assetStorage）。
    vi.mocked(localForageStorage.getItem).mockResolvedValue(JSON.stringify({ state: { assets } }));
}

function installBridge(overrides: Partial<LibraryAssetsBridge> = {}) {
    const bridge = {
        list: vi.fn().mockResolvedValue({ ok: true, value: { assets: [] } }),
        write: vi.fn().mockResolvedValue({ ok: true, value: { record: { assetId: "legacy-1" }, ref: { backend: "library-file" } } }),
        markLegacyMigrated: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    } as unknown as LibraryAssetsBridge & { write: ReturnType<typeof vi.fn>; markLegacyMigrated: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> };
    (window as unknown as { shotshot: unknown }).shotshot = { libraryAssets: bridge, platform: "darwin" };
    return bridge;
}

describe("migrateLegacyAssetsToLibrary", () => {
    afterEach(() => {
        delete (window as unknown as { shotshot?: unknown }).shotshot;
        vi.clearAllMocks();
    });

    it("无桥直接跳过", async () => {
        const result = await migrateLegacyAssetsToLibrary();
        expect(result).toEqual({ migrated: 0, missing: 0 });
    });

    it("迁移保留 id/createdAt/tags，完成后标记 legacyMigratedAt", async () => {
        const bridge = installBridge();
        seedLegacyStore([legacyAsset(), legacyAsset({ id: "text-1", kind: "text", data: { content: "# 设定" } })]);
        const result = await migrateLegacyAssetsToLibrary();
        expect(result).toEqual({ migrated: 2, missing: 0 });
        expect(bridge.write).toHaveBeenCalledWith(expect.objectContaining({ assetId: "legacy-1", createdAt: "2026-01-01T00:00:00.000Z", mimeType: "image/png" }));
        expect(bridge.write).toHaveBeenCalledWith(expect.objectContaining({ assetId: "text-1", mimeType: "text/markdown" }));
        expect(bridge.markLegacyMigrated).toHaveBeenCalledTimes(1);
    });

    it("已迁移过（manifest 带标记）不重复迁移", async () => {
        const bridge = installBridge({ list: vi.fn().mockResolvedValue({ ok: true, value: { assets: [], legacyMigratedAt: "2026-01-02T00:00:00.000Z" } }) });
        seedLegacyStore([legacyAsset()]);
        expect(await migrateLegacyAssetsToLibrary()).toEqual({ migrated: 0, missing: 0 });
        expect(bridge.write).not.toHaveBeenCalled();
    });

    it("字节缺失计 missing 且跳过，写失败中止且不标记", async () => {
        const failingBridge = installBridge({ write: vi.fn().mockResolvedValue({ ok: false, error: "disk full" }) });
        seedLegacyStore([legacyAsset()]);
        await expect(migrateLegacyAssetsToLibrary()).rejects.toThrow("disk full");
        expect(failingBridge.markLegacyMigrated).not.toHaveBeenCalled();
    });

    it("坏条目（data 缺失）计 missing 跳过，不中止其余条目迁移", async () => {
        const bridge = installBridge();
        seedLegacyStore([legacyAsset({ id: "bad-1", data: undefined }), legacyAsset()]);
        const result = await migrateLegacyAssetsToLibrary();
        expect(result).toEqual({ migrated: 1, missing: 1 });
        expect(bridge.write).toHaveBeenCalledTimes(1);
        expect(bridge.write).toHaveBeenCalledWith(expect.objectContaining({ assetId: "legacy-1" }));
        expect(bridge.markLegacyMigrated).toHaveBeenCalledTimes(1);
    });
});
