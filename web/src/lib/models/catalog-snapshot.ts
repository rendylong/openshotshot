import type { ModelModality, ProviderId } from "./model-adapter-types";

type CatalogModel = {
    id: string;
    modality: Exclude<ModelModality, "unknown">;
    sourceUrl: string;
};

/**
 * Reviewed descriptive metadata for official-channel defaults.
 * This is deliberately static metadata: endpoint behavior stays in provider-endpoints.ts.
 */
export const OFFICIAL_CATALOG_SNAPSHOT: Readonly<Partial<Record<ProviderId, readonly CatalogModel[]>>> = {
    moonshot: [
        { id: "kimi-k2.5", modality: "text", sourceUrl: "https://platform.moonshot.cn/docs/api/chat" },
    ],
    zhipu: [
        { id: "glm-5.2", modality: "text", sourceUrl: "https://docs.bigmodel.cn/cn/guide/models/text/glm-5" },
        { id: "glm-image", modality: "image", sourceUrl: "https://docs.bigmodel.cn/cn/guide/models/image/glm-image" },
        { id: "cogvideox-3", modality: "video", sourceUrl: "https://docs.bigmodel.cn/cn/guide/models/video/cogvideox-3" },
    ],
};
