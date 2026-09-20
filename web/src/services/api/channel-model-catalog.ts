import type { CatalogEntry, CatalogPage, CatalogQuery } from "@/lib/models/model-catalog-types";
import { catalogCacheKey, readCatalogCache, writeCatalogCache } from "@/lib/models/model-catalog-cache";
import type { ModelChannel } from "@/stores/use-config-store";
import { builtinFalCatalog, fetchFalCatalog, restoreFalCatalogAvailability } from "./fal-catalog";
import { fetchOpenRouterCatalog } from "./openrouter-catalog";

export async function fetchChannelCatalog(
    channel: ModelChannel,
    query: CatalogQuery,
    signal?: AbortSignal,
): Promise<CatalogPage> {
    if (channel.provider !== "openrouter" && channel.provider !== "fal") throw new Error("catalog_provider_unsupported");

    const key = catalogCacheKey(channel, query);
    let page: CatalogPage;
    try {
        page = channel.provider === "fal" ? await fetchFalCatalog(query, signal) : { entries: filterEntries(await fetchOpenRouterCatalog(channel, signal), query), nextCursor: null, hasMore: false, source: "network" };
    } catch (networkError) {
        if (isAbortError(networkError, signal)) throw networkError;
        try {
            const cached = await readCatalogCache(key);
            if (cached) return channel.provider === "fal" ? restoreFalCatalogAvailability({ ...cached, source: "cache" }) : { ...cached, source: "cache" };
        } catch {
            // Cache is an optional fallback. Keep the provider error when storage is unavailable or incompatible.
        }
        if (channel.provider === "fal") return restoreFalCatalogAvailability(builtinFalCatalog(query));
        throw networkError;
    }

    if (channel.provider === "fal") page = await restoreFalCatalogAvailability(page);
    try {
        await writeCatalogCache(key, page);
        return page;
    } catch {
        return { ...page, cacheUnavailable: true };
    }
}

function filterEntries(entries: CatalogEntry[], query: CatalogQuery): CatalogEntry[] {
    if (query.category && query.category !== "text") return [];
    const term = query.q.trim().toLocaleLowerCase();
    if (!term) return entries;
    return entries.filter((entry) => entry.id.toLocaleLowerCase().includes(term)
        || entry.displayName.toLocaleLowerCase().includes(term));
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return true;
    return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}
