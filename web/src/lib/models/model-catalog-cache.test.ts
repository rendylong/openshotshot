import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => {
    const getItem = vi.fn();
    const setItem = vi.fn();
    return {
        getItem,
        setItem,
        createInstance: vi.fn(() => ({ getItem, setItem })),
    };
});

vi.mock("localforage", () => ({
    default: {
        INDEXEDDB: "asyncStorage",
        createInstance: storage.createInstance,
    },
}));

import type { CatalogPage } from "./model-catalog-types";
import { catalogCacheKey, readCatalogCache, writeCatalogCache } from "./model-catalog-cache";
import { createModelChannel } from "@/stores/use-config-store";

const page: CatalogPage = {
    entries: [],
    nextCursor: null,
    hasMore: false,
    source: "network",
};

beforeEach(() => {
    storage.getItem.mockReset();
    storage.setItem.mockReset();
});

describe("model catalog cache", () => {
    it("configures a dedicated IndexedDB-only store", () => {
        expect(storage.createInstance).toHaveBeenCalledWith({
            name: "shotshot",
            storeName: "model_catalog",
            driver: "asyncStorage",
        });
    });

    it("builds a normalized key without serializing the API key", () => {
        const channel = createModelChannel({
            provider: "openrouter",
            baseUrl: "  https://openrouter.ai/api/v1///  ",
            apiKey: "sk-must-not-be-cached",
        });

        const key = catalogCacheKey(channel, { q: "vision", category: "text", cursor: "page-2" });

        expect(key).toBe('shotshot:model-catalog:["openrouter","https://openrouter.ai/api/v1","vision","text","page-2"]');
        expect(key).not.toContain("sk-must-not-be-cached");
    });

    it("reads a supported cached page", async () => {
        storage.getItem.mockResolvedValue({ version: 1, page });

        await expect(readCatalogCache("cache-key")).resolves.toEqual(page);
    });

    it("rejects an unknown version without changing it", async () => {
        storage.getItem.mockResolvedValue({ version: 7, page });

        await expect(readCatalogCache("cache-key")).rejects.toThrow("catalog_cache_version_unsupported");
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    it("refuses to overwrite an unknown version", async () => {
        storage.getItem.mockResolvedValue({ version: 7, page });

        await expect(writeCatalogCache("cache-key", page)).rejects.toThrow("catalog_cache_version_unsupported");
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    it("wraps successful writes in the current cache version", async () => {
        storage.getItem.mockResolvedValue(null);

        await writeCatalogCache("cache-key", page);

        expect(storage.setItem).toHaveBeenCalledWith("cache-key", { version: 1, page });
    });
});
