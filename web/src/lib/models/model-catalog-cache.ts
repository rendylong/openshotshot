import localforage from "localforage";

import type { CatalogMetadata, CatalogPage, CatalogQuery, FalSchemaAssessment } from "./model-catalog-types";
import type { ModelChannel } from "@/stores/use-config-store";

const CACHE_VERSION = 1;
const CACHE_KEY_PREFIX = "shotshot:model-catalog:";
const catalogStore = localforage.createInstance({
    name: "shotshot",
    storeName: "model_catalog",
    driver: localforage.INDEXEDDB,
});

type CatalogCacheRecord = {
    version: number;
    page: CatalogPage;
};

export function catalogCacheKey(channel: ModelChannel, query: CatalogQuery): string {
    const provider = channel.provider ?? "custom";
    const normalizedBaseUrl = channel.baseUrl.trim().replace(/\/+$/, "");
    return `${CACHE_KEY_PREFIX}${JSON.stringify([
        provider,
        normalizedBaseUrl,
        query.q,
        query.category,
        query.cursor,
    ])}`;
}

export async function readCatalogCache(key: string): Promise<CatalogPage | null> {
    const stored = await catalogStore.getItem<unknown>(key);
    if (stored === null) return null;
    return assertSupportedRecord(stored).page;
}

export async function writeCatalogCache(key: string, page: CatalogPage): Promise<void> {
    const stored = await catalogStore.getItem<unknown>(key);
    if (stored !== null) assertSupportedRecord(stored);
    const record: CatalogCacheRecord = { version: CACHE_VERSION, page };
    await catalogStore.setItem(key, record);
}

function assertSupportedRecord(value: unknown): CatalogCacheRecord {
    if (!isRecord(value) || value.version !== CACHE_VERSION || !isRecord(value.page)) {
        throw new Error("catalog_cache_version_unsupported");
    }
    return value as CatalogCacheRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Small public assessment only; OpenAPI documents never enter persistent storage. */
export async function readFalAssessment(endpointId: string): Promise<CatalogMetadata | null> {
    const value = await catalogStore.getItem<unknown>(`${CACHE_KEY_PREFIX}fal-assessment:${endpointId}`);
    if (value === null) return null;
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.metadata)) throw new Error("catalog_cache_version_unsupported");
    const metadata = value.metadata;
    const schema = recordAssessment(metadata.falSchema);
    if (metadata.version !== 1 || metadata.source !== "provider_models" || !["active", "deprecated", "unknown"].includes(String(metadata.providerStatus)) || (metadata.falSchema !== undefined && !schema)) throw new Error("catalog_cache_invalid_assessment");
    return { version: 1, source: "provider_models", providerStatus: metadata.providerStatus as "active" | "deprecated" | "unknown", ...(schema ? { falSchema: schema } : {}) };
}

export async function writeFalAssessment(endpointId: string, metadata: CatalogMetadata): Promise<void> {
    await readFalAssessment(endpointId); // Unknown cache versions are never overwritten.
    await catalogStore.setItem(`${CACHE_KEY_PREFIX}fal-assessment:${endpointId}`, { version: 1, metadata });
}

function recordAssessment(value: unknown): FalSchemaAssessment | undefined {
    if (!isRecord(value) || typeof value.profileId !== "string" || value.profileVersion !== 1 || (value.status !== "compatible" && value.status !== "incompatible") || !Array.isArray(value.diagnostics) || !value.diagnostics.every(item => typeof item === "string")) return undefined;
    return { profileId: value.profileId, profileVersion: 1, status: value.status, diagnostics: value.diagnostics };
}
