import type { CatalogEntry } from "@/lib/models/model-catalog-types";
import { providerModelsUrl } from "@/services/api/provider-endpoints";
import type { ModelChannel } from "@/stores/use-config-store";

type UnknownRecord = Record<string, unknown>;

export function parseOpenRouterCatalog(payload: unknown): CatalogEntry[] {
    if (!isRecord(payload) || !Array.isArray(payload.data)) return [];

    return payload.data.flatMap((value): CatalogEntry[] => {
        if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) return [];
        const architecture = isRecord(value.architecture) ? value.architecture : undefined;
        const inputModalities = stringArray(architecture?.input_modalities);
        const outputModalities = stringArray(architecture?.output_modalities);
        if (!outputModalities?.includes("text")) return [];

        const supportedParameters = stringArray(value.supported_parameters);
        return [{
            id: value.id,
            displayName: typeof value.name === "string" && value.name.trim() ? value.name : value.id,
            provider: "openrouter",
            category: "text",
            metadata: {
                version: 1,
                source: "provider_models",
                ...(inputModalities === undefined ? {} : { inputModalities }),
                outputModalities,
                ...(supportedParameters === undefined ? {} : { supportsTools: supportedParameters.includes("tools") }),
                providerStatus: "unknown",
            },
            availability: "ready",
        }];
    });
}

export async function fetchOpenRouterCatalog(channel: ModelChannel, signal?: AbortSignal): Promise<CatalogEntry[]> {
    const response = await fetch(`${providerModelsUrl("openrouter", channel.baseUrl.trim())}?output_modalities=text`, {
        headers: { Authorization: `Bearer ${channel.apiKey}` },
        signal,
    });
    if (!response.ok) throw new Error(`catalog_http_${response.status}`);
    return parseOpenRouterCatalog(await response.json());
}

function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}
