export type CatalogProvider = "openrouter" | "fal";
export type CatalogCategory = "text" | "text-to-image" | "image-to-image" | "text-to-video" | "image-to-video";

export type FalSchemaAssessment = { profileId: string; profileVersion: 1; status: "compatible" | "incompatible"; diagnostics: string[] };

export type CatalogMetadata = {
    falSchema?: FalSchemaAssessment;
    version: number;
    source: "provider_models";
    inputModalities?: string[];
    outputModalities?: string[];
    supportsTools?: boolean;
    providerStatus: "active" | "deprecated" | "unknown";
};

export type CatalogEntry = {
    id: string;
    displayName: string;
    provider: CatalogProvider;
    category: CatalogCategory;
    metadata: CatalogMetadata;
    availability: "ready" | "unsupported" | "deprecated" | "schema-incompatible";
};

export type CatalogPage = {
    entries: CatalogEntry[];
    nextCursor: string | null;
    hasMore: boolean;
    source: "network" | "cache" | "builtin";
    cacheUnavailable?: boolean;
};

export type CatalogQuery = {
    q: string;
    category?: CatalogCategory;
    cursor?: string;
};
