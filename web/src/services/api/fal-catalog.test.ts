import { afterEach, expect, it, vi } from "vitest";
import { builtinFalCatalog, fetchFalCatalog, fetchFalSchema, getFalModelAvailability, invalidateFalSchemaCache, refreshFalSchemaCompatibility } from "./fal-catalog";
import { resolveModel } from "@/lib/models/model-resolver";
import { createModelChannel } from "@/stores/use-config-store";
import { getFalProfile } from "@/lib/models/fal/profiles";
const storage = vi.hoisted(() => {
    const records = new Map<string, unknown>();
    return { records, getItem: vi.fn(async (key: string) => records.get(key) ?? null), setItem: vi.fn(async (key: string, value: unknown) => { records.set(key, value); return value; }) };
});
vi.mock("localforage", () => ({ default: { INDEXEDDB: "asyncStorage", createInstance: () => storage } }));
const id = "fal-ai/flux-2-pro";
const row = (endpoint_id = id, status = "active") => ({ endpoint_id, metadata: { display_name: "FLUX", category: "text-to-image", status } });
const page = (models: unknown[], next_cursor: string | null = null) => ({ models, has_more: next_cursor !== null, next_cursor });
const profile = getFalProfile(id)!;
function document(input: unknown = profile.inputSchema, selectedProfile = profile) {
    return { openapi: "3.0.0", paths: {
        [selectedProfile.submitPath!]: { post: { requestBody: { content: { "application/json": { schema: input } } } } },
        [selectedProfile.resultPath!]: { get: { responses: { "200": { content: { "application/json": { schema: selectedProfile.outputSchema } } } } } },
    } };
}
afterEach(() => { vi.unstubAllGlobals(); invalidateFalSchemaCache(); });
it("preserves distinct pages and upstream cursor verbatim without credentials", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(page([row()], "opaque +/="))).mockResolvedValueOnce(Response.json(page([row("fal-ai/new-model")])));
    vi.stubGlobal("fetch", fetcher);
    const first = await fetchFalCatalog({ q: "flux", category: "text-to-image" });
    expect(first).toMatchObject({ hasMore: true, nextCursor: "opaque +/=", entries: [{ id, availability: "ready" }] });
    const second = await fetchFalCatalog({ q: "flux", cursor: first.nextCursor! });
    expect(second.entries[0]).toMatchObject({ id: "fal-ai/new-model", availability: "unsupported" });
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get("cursor")).toBe("opaque +/=");
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty("headers");
    expect([...new URL(fetcher.mock.calls[0][0]).searchParams.keys()]).toEqual(["status", "q", "category"]);
});
it("keeps empty pages with a cursor and rejects 429", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(page([], "next"))).mockResolvedValueOnce(new Response(null, { status: 429 })));
    expect(await fetchFalCatalog({ q: "" })).toMatchObject({ entries: [], hasMore: true, nextCursor: "next" });
    await expect(fetchFalCatalog({ q: "" })).rejects.toThrow("catalog_http_429");
});
it("finds only the exact schema across pages and caches it independently", async () => {
    const schema = document();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(page([{ ...row("other"), openapi: { wrong: true } }], "schema +2"))).mockResolvedValueOnce(Response.json(page([{ ...row(), openapi: schema }])));
    vi.stubGlobal("fetch", fetcher);
    expect(await fetchFalSchema(id)).toEqual(schema);
    expect(await fetchFalSchema(id)).toEqual(schema);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get("cursor")).toBe("schema +2");
    invalidateFalSchemaCache(id);
    fetcher.mockResolvedValue(Response.json(page([{ ...row(), openapi: schema }])));
    await fetchFalSchema(id);
    expect(fetcher).toHaveBeenCalledTimes(3);
});
it("uses reviewed schema paths and ignores descriptions but gates breaking types", async () => {
    const input = structuredClone(profile.inputSchema) as Record<string, any>;
    input.description = "Changed description";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(page([{ ...row(), openapi: document(input) }]))));
    expect(await refreshFalSchemaCompatibility(id)).toMatchObject({ availability: "ready" });
    input.properties.prompt.type = "integer";
    invalidateFalSchemaCache(id);
    expect(await refreshFalSchemaCompatibility(id)).toMatchObject({ availability: "schema-incompatible" });
    expect(getFalModelAvailability(id).diagnostics.join(" ")).toContain("prompt");
    expect(getFalModelAvailability("fal-ai/flux-2-pro/edit").availability).toBe("ready");
    expect(profile.inputSchema).not.toEqual(input);
});
it("marks deprecated entries unavailable and supplies exactly 36 builtin models", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(page([row(id, "deprecated")]))));
    expect((await fetchFalCatalog({ q: "" })).entries[0].availability).toBe("deprecated");
    expect(getFalModelAvailability(id).availability).toBe("deprecated");
    expect(builtinFalCatalog({ q: "" })).toMatchObject({ source: "builtin", hasMore: false });
    expect(builtinFalCatalog({ q: "" }).entries).toHaveLength(36);
});

it.each(["enum", "required"])("blocks a %s incompatibility only for the exact profile", async kind => {
    const endpointId = "fal-ai/nano-banana";
    const current = getFalProfile(endpointId)!;
    const input = structuredClone(current.inputSchema) as Record<string, any>;
    if (kind === "enum") input.properties.output_format.enum = ["not-a-supported-value"];
    else input.required.push("new_remote_requirement");
    const schema = { openapi: "3.0.0", paths: {
        [current.submitPath!]: { post: { requestBody: { content: { "application/json": { schema: input } } } } },
        [current.resultPath!]: { get: { responses: { "200": { content: { "application/json": { schema: current.outputSchema } } } } } },
    } };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(page([{ ...row(endpointId), openapi: schema }]))));
    expect(await refreshFalSchemaCompatibility(endpointId)).toMatchObject({ availability: "schema-incompatible", metadata: { falSchema: { profileId: endpointId, profileVersion: 1, status: "incompatible" } } });
});

it("uses persisted metadata after reload but ignores a different profile identity/version", () => {
    const endpointId = "fal-ai/nano-banana-pro";
    const metadata = { version: 1, source: "provider_models" as const, providerStatus: "unknown" as const, falSchema: { profileId: endpointId, profileVersion: 1 as const, status: "incompatible" as const, diagnostics: ["input.prompt: type changed"] } };
    expect(getFalModelAvailability(endpointId, metadata).availability).toBe("schema-incompatible");
    expect(getFalModelAvailability(endpointId, { ...metadata, falSchema: { ...metadata.falSchema, profileId: id } }).availability).toBe("ready");
    expect(getFalModelAvailability(endpointId, { ...metadata, falSchema: { ...metadata.falSchema, profileVersion: 2 as 1 } }).availability).toBe("ready");
    expect(getFalModelAvailability(endpointId, { ...metadata, providerStatus: "deprecated" }).availability).toBe("deprecated");
});

it("registers all 36 exact media endpoints and never infers fal text", () => {
    const channel = createModelChannel({ provider: "fal" });
    expect(channel).toMatchObject({ provider: "fal", name: "fal.ai", baseUrl: "https://queue.fal.run", models: [] });
    for (const entry of builtinFalCatalog({ q: "" }).entries) {
        const profile = getFalProfile(entry.id)!;
        expect(resolveModel({ ...channel, model: entry.id })).toMatchObject({ provider: "fal", modality: profile.modality, execution: "remote_task", adapterId: `fal.${profile.modality}`, confidence: "exact" });
    }
    for (const model of ["gpt-4", "fal-ai/FLUX-2-PRO", "unknown/model"]) expect(resolveModel({ ...channel, model, userCapability: "text" })).toMatchObject({ modality: "unknown", execution: "unsupported", adapterId: null });
});

it("persists schema assessment immediately and restores it before submit after a reload", async () => {
    const endpointId = "fal-ai/nano-banana-2";
    const fetcher = vi.fn(async () => Response.json(page([{ ...row(endpointId), openapi: { openapi: "3.0.0", paths: {} } }])));
    vi.stubGlobal("fetch", fetcher);
    const result = await refreshFalSchemaCompatibility(endpointId);
    expect(result).toMatchObject({ availability: "schema-incompatible", cacheUnavailable: false });
    expect(JSON.stringify([...storage.records])).not.toContain('"openapi"');
    vi.resetModules();
    const reloaded = await import("./fal-catalog");
    expect(reloaded.getFalModelAvailability(endpointId).availability).toBe("ready");
    expect(await reloaded.resolveFalModelAvailability(endpointId)).toMatchObject({ availability: "schema-incompatible" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await reloaded.restoreFalCatalogAvailability(reloaded.builtinFalCatalog({ q: endpointId }))).entries[0]).toMatchObject({ availability: "schema-incompatible", metadata: { falSchema: { profileId: endpointId, status: "incompatible" } } });
});

it("accepts all 36 captured public schemas against their reviewed profile fields", async () => {
    vi.resetModules();
    const fresh = await import("./fal-catalog");
    const fixtures = import.meta.glob("../../lib/models/fal/fixtures/*.json", { eager: true, import: "default" });
    expect(Object.values(fixtures).filter(value => (value as { endpointId?: string }).endpointId)).toHaveLength(36);
    for (const fixture of Object.values(fixtures) as { endpointId?: string; openapi?: unknown }[]) {
        if (!fixture.endpointId || !fixture.openapi) continue;
        vi.stubGlobal("fetch", vi.fn(async () => Response.json(page([{ ...row(fixture.endpointId), openapi: fixture.openapi }]))));
        expect(await fresh.refreshFalSchemaCompatibility(fixture.endpointId), fixture.endpointId).toMatchObject({ availability: "ready" });
    }
});

it("remembers deactivation from an exact schema expansion", async () => {
    const endpointId = "fal-ai/nano-banana-pro/edit";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(page([{ ...row(endpointId, "disabled"), openapi: document() }]))));
    await fetchFalSchema(endpointId);
    expect(getFalModelAvailability(endpointId).availability).toBe("deprecated");
});

it.each(["catalog", "schema"])("preserves persisted incompatibility through %s deprecation after restart until a successful check", async observation => {
    storage.records.clear();
    vi.resetModules();
    const initial = await import("./fal-catalog");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(page([{ ...row(), openapi: { openapi: "3.0.0", paths: {} } }]))));
    expect(await initial.refreshFalSchemaCompatibility(id)).toMatchObject({ availability: "schema-incompatible" });

    vi.resetModules();
    const restarted = await import("./fal-catalog");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(page([{ ...row(id, "deprecated"), openapi: document() }]))));
    if (observation === "catalog") await restarted.fetchFalCatalog({ q: "" });
    else await restarted.fetchFalSchema(id);
    expect(restarted.getFalModelAvailability(id).availability).toBe("deprecated");
    expect(storage.records.get(`shotshot:model-catalog:fal-assessment:${id}`)).toMatchObject({ metadata: { providerStatus: "deprecated", falSchema: { status: "incompatible" } } });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json(page([row()]))));
    await restarted.fetchFalCatalog({ q: "" });
    expect(await restarted.resolveFalModelAvailability(id)).toMatchObject({ availability: "schema-incompatible" });
    vi.resetModules();
    expect(await (await import("./fal-catalog")).resolveFalModelAvailability(id)).toMatchObject({ availability: "schema-incompatible" });

    restarted.invalidateFalSchemaCache(id);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(page([{ ...row(), openapi: document() }]))));
    expect(await restarted.refreshFalSchemaCompatibility(id)).toMatchObject({ availability: "ready", metadata: { falSchema: { status: "compatible" } } });
});

it.each(["root-allOf-required", "field-allOf-enum", "later-anyOf-branch"])("rejects unreviewed composition change: %s", async change => {
    storage.records.clear();
    vi.resetModules();
    const fresh = await import("./fal-catalog");
    const input = structuredClone(profile.inputSchema) as Record<string, any>;
    if (change === "root-allOf-required") input.allOf = [{ required: ["new_requirement"] }];
    if (change === "field-allOf-enum") input.properties.output_format.allOf = [{ enum: ["png"] }];
    if (change === "later-anyOf-branch") {
        const branches = input.properties.seed.anyOf;
        branches[1] = { type: "null", allOf: [false] };
    }
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(page([{ ...row(), openapi: document(input) }]))));
    const result = await fresh.refreshFalSchemaCompatibility(id);
    expect(result).toMatchObject({ availability: "schema-incompatible", metadata: { falSchema: { status: "incompatible" } } });
    expect(result.diagnostics.join(" ")).toContain("composition changed");
});

it("ignores documentation-only changes inside a reviewed composition", async () => {
    storage.records.clear();
    vi.resetModules();
    const fresh = await import("./fal-catalog");
    const input = structuredClone(profile.inputSchema) as Record<string, any>;
    input.properties.seed.anyOf[1].description = "Updated documentation";
    input.properties.seed.anyOf[1].examples = [null];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(page([{ ...row(), openapi: document(input) }]))));
    expect(await fresh.refreshFalSchemaCompatibility(id)).toMatchObject({ availability: "ready" });
});

it("rejects replacement of the captured FLUX seed integer-or-null composition with string", async () => {
    storage.records.clear();
    vi.resetModules();
    const fresh = await import("./fal-catalog");
    const input = structuredClone(profile.inputSchema) as Record<string, any>;
    expect(input.properties.seed.anyOf).toEqual([{ type: "integer" }, { type: "null" }]);
    expect(input.properties.seed.type).toBe("integer"); // Production profile enriches the captured anyOf.
    input.properties.seed = { type: "string" };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(page([{ ...row(), openapi: document(input) }]))));
    const result = await fresh.refreshFalSchemaCompatibility(id);
    expect(result).toMatchObject({ availability: "schema-incompatible", metadata: { falSchema: { status: "incompatible" } } });
    expect(result.diagnostics).toContain("input.seed: anyOf composition changed; review required");
});

it("requires review when a captured composition is removed even with the admitted scalar type retained", async () => {
    storage.records.clear();
    vi.resetModules();
    const fresh = await import("./fal-catalog");
    const input = structuredClone(profile.inputSchema) as Record<string, any>;
    delete input.properties.seed.anyOf;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(page([{ ...row(), openapi: document(input) }]))));
    const result = await fresh.refreshFalSchemaCompatibility(id);
    expect(result).toMatchObject({ availability: "schema-incompatible", metadata: { falSchema: { status: "incompatible" } } });
    expect(result.diagnostics).toContain("input.seed: anyOf composition changed; review required");
});

it.each(["fal-ai/ltx-2.3/text-to-video/fast", "fal-ai/ltx-2.3/image-to-video/fast"])("exempts only absent authored root composition on %s", async endpointId => {
    storage.records.clear();
    vi.resetModules();
    const fresh = await import("./fal-catalog");
    const current = getFalProfile(endpointId)!;
    const input = structuredClone(current.inputSchema) as Record<string, any>;
    expect(input.allOf).toBeDefined();
    delete input.allOf;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(page([{ ...row(endpointId), openapi: document(input, current) }]))));
    expect(await fresh.refreshFalSchemaCompatibility(endpointId)).toMatchObject({ availability: "ready" });
    fresh.invalidateFalSchemaCache(endpointId);
    input.allOf = [{ required: ["new_requirement"] }];
    expect(await fresh.refreshFalSchemaCompatibility(endpointId)).toMatchObject({ availability: "schema-incompatible", diagnostics: ["input: allOf composition changed; review required"] });
});


it("blocks unknown outer metadata versions synchronously and after assessment hydration without rewriting them", async () => {
    const { resolveFalModelAvailability } = await import("./fal-catalog");
    const future = { version: 99, source: "provider_models", providerStatus: "unknown" } as const;
    expect(getFalModelAvailability("fal-ai/nano-banana-2", future).availability).toBe("unsupported");
    expect((await resolveFalModelAvailability("fal-ai/nano-banana-2", future)).availability).toBe("unsupported");
    expect(future).toEqual({ version: 99, source: "provider_models", providerStatus: "unknown" });
});
