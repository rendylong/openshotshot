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

import type { CatalogEntry, CatalogPage } from "@/lib/models/model-catalog-types";
import { createModelChannel } from "@/stores/use-config-store";
import { fetchChannelCatalog } from "./channel-model-catalog";

const entries: CatalogEntry[] = [
    {
        id: "vendor/vision-pro",
        displayName: "Vision Pro",
        provider: "openrouter",
        category: "text",
        metadata: {
            version: 1,
            source: "provider_models",
            inputModalities: ["text", "image"],
            outputModalities: ["text"],
            supportsTools: true,
            providerStatus: "unknown",
        },
        availability: "ready",
    },
    {
        id: "vendor/text-fast",
        displayName: "Fast Chat",
        provider: "openrouter",
        category: "text",
        metadata: {
            version: 1,
            source: "provider_models",
            outputModalities: ["text"],
            providerStatus: "unknown",
        },
        availability: "ready",
    },
];

const channel = createModelChannel({ provider: "openrouter", apiKey: "sk-private" });

beforeEach(() => {
    storage.getItem.mockReset();
    storage.setItem.mockReset();
    storage.getItem.mockResolvedValue(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("channel model catalog", () => {
    it("filters OpenRouter text models locally and caches the resulting network page", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: entries.map(toProviderRow) }) } as Response)));

        const result = await fetchChannelCatalog(channel, { q: "FAST" });

        expect(result).toEqual({ entries: [entries[1]], nextCursor: null, hasMore: false, source: "network" });
        expect(storage.setItem).toHaveBeenCalledOnce();
        expect(JSON.stringify(storage.setItem.mock.calls[0])).not.toContain("sk-private");
    });

    it("returns no entries when the requested category is not text", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: entries.map(toProviderRow) }) } as Response)));

        await expect(fetchChannelCatalog(channel, { q: "", category: "text-to-image" })).resolves.toMatchObject({
            entries: [],
            hasMore: false,
            source: "network",
        });
    });

    it("falls back to a matching supported cache entry after a network error", async () => {
        const cached: CatalogPage = { entries: [entries[0]], nextCursor: null, hasMore: false, source: "network" };
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429 } as Response)));
        storage.getItem.mockResolvedValue({ version: 1, page: cached });

        await expect(fetchChannelCatalog(channel, { q: "vision" })).resolves.toEqual({ ...cached, source: "cache" });
    });

    it("rethrows the original abort without reading cache", async () => {
        const abort = new DOMException("cancelled", "AbortError");
        vi.stubGlobal("fetch", vi.fn(async () => { throw abort; }));

        const error = await fetchChannelCatalog(channel, { q: "" }).catch((caught: unknown) => caught);

        expect(error).toBe(abort);
        expect(storage.getItem).not.toHaveBeenCalled();
    });

    it("returns the network page with cacheUnavailable when IndexedDB cannot read", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: entries.map(toProviderRow) }) } as Response)));
        storage.getItem.mockRejectedValue(new Error("No available storage method found"));

        await expect(fetchChannelCatalog(channel, { q: "" })).resolves.toEqual({
            entries,
            nextCursor: null,
            hasMore: false,
            source: "network",
            cacheUnavailable: true,
        });
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    it("returns network data when setItem rejects after a successful empty read", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: entries.map(toProviderRow) })));
        storage.getItem.mockResolvedValue(null);
        storage.setItem.mockRejectedValueOnce(new Error("write failed"));
        await expect(fetchChannelCatalog(channel, { q: "" })).resolves.toMatchObject({ entries, source: "network", cacheUnavailable: true });
        expect(storage.setItem).toHaveBeenCalledOnce();
    });

    it("uses 36 builtins for the first failed public fal fetch without exposing keys", async () => {
        const fetcher = vi.fn(async () => new Response(null, { status: 429 }));
        vi.stubGlobal("fetch", fetcher);
        const result = await fetchChannelCatalog(createModelChannel({ provider: "fal", apiKey: "private-fal-key" }), { q: "" });
        expect(result.source).toBe("builtin");
        expect(result.entries).toHaveLength(36);
        expect(JSON.stringify(fetcher.mock.calls)).not.toContain("private-fal-key");
    });

    it("preserves unknown cache versions while returning the network page", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: entries.map(toProviderRow) }) } as Response)));
        storage.getItem.mockResolvedValue({ version: 3, page: { entries: [], nextCursor: null, hasMore: false, source: "cache" } });

        await expect(fetchChannelCatalog(channel, { q: "" })).resolves.toMatchObject({ source: "network", cacheUnavailable: true });
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    it("keeps the network error when unavailable storage cannot provide a fallback", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 } as Response)));
        storage.getItem.mockRejectedValue(new Error("No available storage method found"));

        await expect(fetchChannelCatalog(channel, { q: "" })).rejects.toThrow("catalog_http_401");
    });
});

function toProviderRow(entry: CatalogEntry) {
    return {
        id: entry.id,
        name: entry.displayName,
        architecture: {
            input_modalities: entry.metadata.inputModalities,
            output_modalities: entry.metadata.outputModalities,
        },
        supported_parameters: entry.metadata.supportsTools ? ["tools"] : undefined,
    };
}
