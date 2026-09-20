import { builtinFalEntry } from "@/services/api/fal-catalog";
import type { ChannelModel, ModelCapability, ModelChannel } from "@/stores/use-config-store";
import type { CatalogCategory, CatalogEntry } from "./model-catalog-types";

export function canUseAsAgent(channel: ModelChannel, model: ChannelModel): boolean {
    if (channel.provider === "fal") return false;
    if (channel.provider !== "openrouter") return model.capability === "text";
    return model.capability === "text"
        && model.catalog?.version === 1
        && model.catalog.supportsTools === true
        && model.catalog.providerStatus !== "deprecated";
}

export function mergeCatalogSelection(channel: ModelChannel, ids: string[], entries: CatalogEntry[]): ChannelModel[] {
    const existingByName = new Map(channel.models.map((model) => [model.name, model]));
    const entriesById = new Map(entries.map((entry) => [entry.id, entry]));

    return ids.map((id) => {
        const existing = existingByName.get(id);
        const entry = entriesById.get(id) ?? (channel.provider === "fal" && !existing ? builtinFalEntry(id) : undefined);
        if (existing?.catalog && existing.catalog.version !== 1) return existing;
        if (!entry) return existing ?? { name: id, capability: "text" };
        if (entry.metadata.version !== 1) return existing ?? { name: id, capability: "text", catalog: entry.metadata };

        const { supportsImageInput: _supportsImageInput, ...preserved } = existing ?? { name: id, capability: capabilityFromCategory(entry.category) };
        const supportsImageInput = entry.metadata.inputModalities?.includes("image");
        return {
            ...preserved,
            name: id,
            capability: capabilityFromCategory(entry.category),
            ...(supportsImageInput === undefined ? {} : { supportsImageInput }),
            catalog: { ...entry.metadata, ...(entry.provider === "fal" && !entry.metadata.falSchema && existing?.catalog?.falSchema ? { falSchema: existing.catalog.falSchema } : {}) },
        };
    });
}

function capabilityFromCategory(category: CatalogCategory): ModelCapability {
    if (category === "text") return "text";
    if (category === "text-to-image" || category === "image-to-image") return "image";
    return "video";
}
