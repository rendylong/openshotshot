import { describe, expect, it } from "vitest";
import fixture from "./fixtures/fal-ai%2Fnano-banana-2.json";
import type { FalProfile } from "./profile-types";
import { createFalProfileRegistry, getFalProfile, listFalProfiles } from "./profiles";
import { extractFalSchemas } from "./schema";

async function profile(): Promise<FalProfile> {
    return {
        id: "nano-banana-2",
        version: 1,
        endpointId: fixture.endpointId,
        modality: "image",
        ...(await extractFalSchemas(fixture.openapi, "/fal-ai/nano-banana-2", "/fal-ai/nano-banana-2/requests/{request_id}")),
        defaults: { num_images: 1 },
        fields: [{ name: "seed", labelKey: "fal.seed", kind: "number" }],
        media: [],
    };
}

describe("fal profile registry", () => {
    it("matches exact endpoint and version synchronously, never aliases unknown versions", async () => {
        const item = await profile();
        const registry = createFalProfileRegistry([item]);
        expect(registry.getFalProfile(item.endpointId)).toEqual(item);
        expect(registry.getFalProfile(item.endpointId, 1)).toEqual(item);
        expect(registry.getFalProfile(item.endpointId, 2)).toBeUndefined();
        expect(registry.getFalProfile(item.endpointId, 0)).toBeUndefined();
        expect(registry.getFalProfile(`${item.endpointId}/edit`)).toBeUndefined();
        expect(registry.getFalProfile(` ${item.endpointId}`)).toBeUndefined();
        expect(getFalProfile("unregistered", 99)).toBeUndefined();
        expect(Array.isArray(listFalProfiles())).toBe(true);
    });

    it("rejects duplicate profile IDs, endpoint registrations, invalid versions and modalities", async () => {
        const item = await profile();
        expect(() => createFalProfileRegistry([item, { ...item, endpointId: "another" }])).toThrow("fal_profile_invalid");
        expect(() => createFalProfileRegistry([item, { ...item, id: "another" }])).toThrow("fal_profile_invalid");
        expect(() => createFalProfileRegistry([{ ...item, version: 2 } as unknown as FalProfile])).toThrow("fal_profile_invalid");
        expect(() => createFalProfileRegistry([{ ...item, modality: "audio" } as unknown as FalProfile])).toThrow("fal_profile_invalid");
    });

    it("freezes nested registered contracts and isolates them from caller mutations", async () => {
        const item = await profile();
        const registry = createFalProfileRegistry([item]);
        item.defaults.num_images = 4;
        const registered = registry.getFalProfile(item.endpointId)!;
        expect(registered.defaults.num_images).toBe(1);
        expect(Object.isFrozen(registry.listFalProfiles())).toBe(true);
        expect(Object.isFrozen(registered)).toBe(true);
        expect(Object.isFrozen(registered.defaults)).toBe(true);
        expect(Object.isFrozen(registered.inputSchema)).toBe(true);
        expect(() => {
            registered.defaults.num_images = 2;
        }).toThrow();
    });
});

it("has exactly the approved endpoint set and 12 image / 24 video profiles", async () => {
    const { FAL_ENDPOINT_IDS } = await import("./endpoint-ids");
    const { default: cases } = await import("./fixtures/contract-cases.json");
    expect(cases.map((c) => c.endpointId).sort()).toEqual([...FAL_ENDPOINT_IDS].sort());
    expect(listFalProfiles().map((p) => p.endpointId).sort()).toEqual([...FAL_ENDPOINT_IDS].sort());
    expect(listFalProfiles().filter((p) => p.modality === "image")).toHaveLength(12);
    expect(listFalProfiles().filter((p) => p.modality === "video")).toHaveLength(24);
});

// These source paths are exercised against the unmodified captured docs, independently
// of the runtime construction helper; generated schema snapshots cannot drift silently.
const capturedDocuments = import.meta.glob<{ endpointId: string; openapi: unknown }>("./fixtures/*%2F*.json", { eager: true, import: "default" });
const rawByEndpoint = new Map(Object.values(capturedDocuments).map((document) => [document.endpointId, document.openapi]));
const sourceSchemas = { ...((await import("./fixtures/image-schemas.json")).default), ...((await import("./fixtures/video-schemas.json")).default) };

it.each(Object.keys(sourceSchemas))("retains the independently selected source schemas for %s", async (endpointId) => {
    const item = getFalProfile(endpointId)!;
    expect(item.submitPath).toBeTruthy();
    expect(item.resultPath).toBeTruthy();
    const extracted = await extractFalSchemas(rawByEndpoint.get(endpointId), item.submitPath!, item.resultPath!);
    expect(extracted).toEqual(sourceSchemas[endpointId as keyof typeof sourceSchemas]);
    expect(item.outputSchema).toEqual(extracted.outputSchema);
    expect(item.inputSchema).toMatchObject({ additionalProperties: false });
    expect(item.fields.some((field) => field.name === "num_images")).toBe(false);
});
it("preserves execution IDs when the documentation path differs", () => {
    expect(getFalProfile("openai/gpt-image-2")!.submitPath).toBe("/fal-ai/gpt-image-2");
    expect(getFalProfile("wan/v2.6/image-to-video")!.submitPath).toBe("/fal-ai/wan-26-i2v");
    expect(getFalProfile("fal-ai/gpt-image-2")).toBeUndefined();
    expect(getFalProfile("fal-ai/nano-banana-3")).toBeUndefined();
});
it("retains provider defaults only for admitted controls and disables optional audio locally", () => {
    for (const item of listFalProfiles()) {
        const source = sourceSchemas[item.endpointId as keyof typeof sourceSchemas].inputSchema;
        const properties = source.properties as Record<string, { default?: unknown }>;
        for (const [name, value] of Object.entries(item.defaults)) {
            expect(name === "num_images" || item.fields.some((field) => field.name === name)).toBe(true);
            expect(value).toEqual(name === "generate_audio" ? false : properties[name].default);
        }
        expect(item.fields.some((field) => field.name === "generate_audio")).toBe(Object.hasOwn(properties, "generate_audio"));
    }
});
