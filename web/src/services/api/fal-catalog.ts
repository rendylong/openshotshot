import type { CatalogCategory, CatalogEntry, CatalogMetadata, CatalogPage, CatalogQuery } from "@/lib/models/model-catalog-types";
import { readFalAssessment, writeFalAssessment } from "@/lib/models/model-catalog-cache";
import { getFalProfile, listFalProfiles } from "@/lib/models/fal/profiles";
import { imageProfileDescriptors } from "@/lib/models/fal/image-profiles";
import { videoProfileDescriptors } from "@/lib/models/fal/video-profiles";
import { extractFalSchemas } from "@/lib/models/fal/schema";

const catalogUrl = "https://api.fal.ai/v1/models";
const schemas = new Map<string, unknown>();
const assessments = new Map<string, CatalogMetadata>();
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const categories: CatalogCategory[] = ["text-to-image", "image-to-image", "text-to-video", "image-to-video"];
const metadataFor = (): CatalogMetadata => ({ version: 1, source: "provider_models", providerStatus: "unknown" });

export function getFalModelAvailability(endpointId: string, metadata?: CatalogMetadata): { availability: CatalogEntry["availability"]; diagnostics: string[] } {
    const profile = getFalProfile(endpointId);
    const current = assessments.get(endpointId);
    if ((metadata && metadata.version !== 1) || (current && current.version !== 1)) return { availability: "unsupported", diagnostics: [] };
    if (metadata?.providerStatus === "deprecated" || current?.providerStatus === "deprecated") return { availability: "deprecated", diagnostics: [] };
    if (!profile) return { availability: "unsupported", diagnostics: [] };
    // A fresh successful check may replace a persisted assessment for the same profile version.
    const assessment = current?.falSchema ?? metadata?.falSchema;
    if (assessment?.profileId === profile.id && assessment.profileVersion === profile.version && assessment.status === "incompatible") {
        return { availability: "schema-incompatible", diagnostics: Array.isArray(assessment.diagnostics) ? assessment.diagnostics.filter((value): value is string => typeof value === "string") : [] };
    }
    return { availability: "ready", diagnostics: [] };
}

/** Submit gating restores prior public assessments even if the settings dialog was cancelled. Queries do not use this. */
export async function resolveFalModelAvailability(endpointId: string, metadata?: CatalogMetadata) {
    try {
        const saved = await readFalAssessment(endpointId);
        if (saved && !assessments.has(endpointId)) assessments.set(endpointId, saved);
    } catch {
        // A known in-memory/channel assessment still applies when IndexedDB is unavailable.
    }
    return getFalModelAvailability(endpointId, metadata);
}

/** Reapply remembered admission decisions to public network/cache/builtin listings after restart. */
export async function restoreFalCatalogAvailability(page: CatalogPage): Promise<CatalogPage> {
    return { ...page, entries: await Promise.all(page.entries.map(async entry => {
        await resolveFalModelAvailability(entry.id, entry.metadata);
        const metadata = { ...entry.metadata, ...assessments.get(entry.id) };
        return { ...entry, metadata, ...getFalModelAvailability(entry.id, metadata) };
    })) };
}

async function remember(endpointId: string, metadata: CatalogMetadata): Promise<boolean> {
    // Status observations must not erase an incompatible schema assessment after restart.
    await resolveFalModelAvailability(endpointId);
    const previous = assessments.get(endpointId);
    const merged = { ...previous, ...metadata, ...(metadata.falSchema === undefined && previous?.falSchema ? { falSchema: previous.falSchema } : {}) };
    assessments.set(endpointId, merged);
    try { await writeFalAssessment(endpointId, merged); return true; } catch { return false; }
}

function parsePage(payload: unknown): { models: unknown[]; nextCursor: string | null; hasMore: boolean } {
    const data = record(payload);
    if (!data || !Array.isArray(data.models) || typeof data.has_more !== "boolean") throw new Error("catalog_invalid_page");
    const cursor = typeof data.next_cursor === "string" && data.next_cursor ? data.next_cursor : null;
    if (data.has_more && !cursor) throw new Error("catalog_invalid_cursor");
    return { models: data.models, nextCursor: cursor, hasMore: data.has_more };
}
async function request(params: URLSearchParams, signal?: AbortSignal) {
    const response = await fetch(`${catalogUrl}?${params}`, { signal });
    if (!response.ok) throw new Error(`catalog_http_${response.status}`);
    return parsePage(await response.json());
}
export function builtinFalEntry(endpointId: string): CatalogEntry | undefined {
    const profile = getFalProfile(endpointId);
    if (!profile) return undefined;
    const hasImage = profile.media.length > 0;
    const category = `${hasImage ? "image" : "text"}-to-${profile.modality}` as CatalogCategory;
    const metadata: CatalogMetadata = { ...metadataFor(), inputModalities: hasImage ? ["text", "image"] : ["text"], outputModalities: [profile.modality] };
    return { id: endpointId, displayName: endpointId, provider: "fal", category, metadata, ...getFalModelAvailability(endpointId) };
}
export function builtinFalCatalog(query: CatalogQuery): CatalogPage {
    const term = query.q.trim().toLowerCase();
    return { source: "builtin", entries: query.cursor ? [] : listFalProfiles().map(profile => builtinFalEntry(profile.endpointId)!).filter(entry => (!query.category || query.category === entry.category) && (!term || entry.id.toLowerCase().includes(term))), nextCursor: null, hasMore: false };
}
export async function fetchFalCatalog(query: CatalogQuery, signal?: AbortSignal): Promise<CatalogPage> {
    const params = new URLSearchParams({ status: "active" });
    if (query.q) params.set("q", query.q);
    if (query.category) params.set("category", query.category);
    if (query.cursor) params.set("cursor", query.cursor);
    const page = await request(params, signal);
    const entries: CatalogEntry[] = [];
    let cacheUnavailable = false;
    for (const value of page.models) {
        const model = record(value), upstream = record(model?.metadata);
        if (typeof model?.endpoint_id !== "string" || !model.endpoint_id.trim()) continue;
        const id = model.endpoint_id, profile = getFalProfile(id);
        const category = categories.includes(upstream?.category as CatalogCategory) ? upstream!.category as CatalogCategory : profile ? builtinFalEntry(id)!.category : undefined;
        if (!category) continue; // Never treat an unknown media category as text.
        const status = upstream?.status === "active" ? "active" : ["deprecated", "disabled", "inactive"].includes(String(upstream?.status)) ? "deprecated" : "unknown";
        const metadata: CatalogMetadata = { ...(profile ? builtinFalEntry(id)!.metadata : metadataFor()), ...assessments.get(id), providerStatus: status };
        if ((status === "deprecated" || assessments.has(id)) && !await remember(id, metadata)) cacheUnavailable = true;
        entries.push({ id, displayName: typeof upstream?.display_name === "string" ? upstream.display_name : id, provider: "fal", category, metadata, ...getFalModelAvailability(id, metadata) });
    }
    return { entries, nextCursor: page.nextCursor, hasMore: page.hasMore, source: "network", ...(cacheUnavailable ? { cacheUnavailable: true } : {}) };
}
export function invalidateFalSchemaCache(endpointId?: string): void {
    if (endpointId) schemas.delete(endpointId);
    else schemas.clear();
}
export async function fetchFalSchema(endpointId: string, signal?: AbortSignal): Promise<unknown> {
    if (schemas.has(endpointId)) return structuredClone(schemas.get(endpointId));
    let cursor: string | null = null;
    const visited = new Set<string>();
    do {
        const params = new URLSearchParams({ endpoint_id: endpointId, expand: "openapi-3.0" });
        if (cursor) params.set("cursor", cursor);
        const page = await request(params, signal);
        const model = page.models.map(record).find(value => value?.endpoint_id === endpointId);
        if (model) {
            if (["deprecated", "disabled", "inactive"].includes(String(record(model.metadata)?.status))) {
                await remember(endpointId, { ...metadataFor(), ...assessments.get(endpointId), providerStatus: "deprecated" });
            }
            if (!record(model.openapi)) throw new Error("fal_schema_missing");
            schemas.set(endpointId, structuredClone(model.openapi));
            return structuredClone(model.openapi);
        }
        cursor = page.hasMore ? page.nextCursor : null;
        if (cursor && visited.has(cursor)) throw new Error("catalog_invalid_cursor");
        if (cursor) visited.add(cursor);
    } while (cursor);
    throw new Error("fal_schema_missing");
}

const schemaAnnotations = new Set(["title", "description", "$comment", "examples", "example", "default", "servers", "deprecated", "readOnly", "writeOnly"]);
const schemaMaps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);

/** Structural comparison only: new/changed compositions require review, not runtime interpretation. */
function compositionShape(value: unknown, schemaMap = false): unknown {
    if (Array.isArray(value)) return value.map(item => compositionShape(item));
    const object = record(value);
    if (!object) return value;
    return Object.fromEntries(Object.keys(object).sort().filter(key => schemaMap || !schemaAnnotations.has(key)).map(key => [
        key,
        // Enum/const payloads are data, and schema-map keys are field names, not annotations.
        !schemaMap && (key === "enum" || key === "const") ? object[key] : compositionShape(object[key], !schemaMap && schemaMaps.has(key)),
    ]));
}

/** Compare only executable, locally admitted fields; documentation and server URLs are ignored. */
function compatibilityIssues(localValue: unknown, remoteValue: unknown, path = "input", authoredRootAllOf?: unknown): string[] {
    const local = record(localValue), remote = record(remoteValue);
    if (!local || !remote) return localValue === remoteValue ? [] : [`${path}: schema changed`];
    const issues: string[] = [];
    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
        const localComposition = JSON.stringify(compositionShape(local[keyword]));
        const remoteComposition = JSON.stringify(compositionShape(remote[keyword]));
        // Only the exact, explicitly authored root strengthening may be absent upstream.
        // Recursive calls do not receive this provenance, so nested compositions have no exemption.
        const authoredAbsence = keyword === "allOf" && remote.allOf === undefined && authoredRootAllOf !== undefined
            && localComposition === JSON.stringify(compositionShape(authoredRootAllOf));
        if (!authoredAbsence && localComposition !== remoteComposition) {
            issues.push(`${path}: ${keyword} composition changed; review required`);
        }
    }
    const variants = Array.isArray(remote.anyOf) ? remote.anyOf.map(record).filter(Boolean) : [remote];
    const match = variants.find(value => value?.type === local.type) ?? remote;
    if (local.type !== undefined && match.type !== local.type) issues.push(`${path}: type changed`);
    if (Array.isArray(match.enum) && (!Array.isArray(local.enum) || local.enum.some(value => !(match.enum as unknown[]).includes(value)))) issues.push(`${path}: enum narrowed`);
    const localRequired = Array.isArray(local.required) ? local.required : [];
    if (Array.isArray(remote.required)) for (const field of remote.required) if (!localRequired.includes(field)) issues.push(`${path}: newly required ${Object.hasOwn(record(local.properties) ?? {}, String(field)) ? String(field) : "unsupported field"}`);
    const properties = record(local.properties), other = record(remote.properties);
    if (properties) for (const [name, schema] of Object.entries(properties)) issues.push(...compatibilityIssues(schema, other?.[name], `${path}.${name}`));
    if (local.items) issues.push(...compatibilityIssues(local.items, match.items, `${path}[]`));
    return issues;
}
export async function refreshFalSchemaCompatibility(endpointId: string, signal?: AbortSignal) {
    const profile = getFalProfile(endpointId);
    if (!profile) return { ...getFalModelAvailability(endpointId), metadata: metadataFor(), cacheUnavailable: false };
    const openapi = await fetchFalSchema(endpointId, signal);
    let diagnostics: string[];
    try {
        const remote = await extractFalSchemas(openapi, profile.submitPath!, profile.resultPath!);
        const descriptor = [...imageProfileDescriptors, ...videoProfileDescriptors].find(value => value.endpointId === endpointId);
        diagnostics = compatibilityIssues(profile.inputSchema, remote.inputSchema, "input", descriptor?.inputConstraints?.allOf);
    } catch { diagnostics = ["input: schema unavailable at reviewed paths"]; }
    const metadata: CatalogMetadata = { ...metadataFor(), ...assessments.get(endpointId), falSchema: { profileId: profile.id, profileVersion: profile.version, status: diagnostics.length ? "incompatible" : "compatible", diagnostics } };
    const cached = await remember(endpointId, metadata);
    return { ...getFalModelAvailability(endpointId), metadata, cacheUnavailable: !cached };
}
