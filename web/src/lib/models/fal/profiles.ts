import type { FalField, FalProfile, FalProfileDescriptor, FalSchemaSelection, JsonValue } from "./profile-types";
import { imageProfileDescriptors } from "./image-profiles";
import { videoProfileDescriptors } from "./video-profiles";
import imageSchemas from "./fixtures/image-schemas.json";
import videoSchemas from "./fixtures/video-schemas.json";

/** Only simple, explicitly selected controls are admitted. No runtime OpenAPI interpretation. */
function createReviewedFalProfile(descriptor: FalProfileDescriptor, schemas: FalSchemaSelection, modality: FalProfile["modality"]): FalProfile {
    const inputSchema = structuredClone(schemas.inputSchema);
    if (typeof inputSchema !== "object" || !inputSchema.properties) throw new Error("fal_profile_invalid: missing input properties");
    const properties = inputSchema.properties as Record<string, Record<string, unknown>>;
    const fields: FalField[] = descriptor.fields.map((field) => {
        const property = properties[field.name];
        if (!property) throw new Error("fal_profile_invalid: missing selected field");
        const variants = (property.anyOf ?? [property]) as Record<string, unknown>[];
        const simple = variants.filter((variant) => ["string", "integer", "number", "boolean"].includes(String(variant.type)));
        if (simple.length !== 1) throw new Error("fal_profile_invalid: selected field is not a simple control");
        const selected = simple[0];
        // image_size's object branch is intentionally outside the approved preset control scope.
        const kind = selected.enum ? "enum" : selected.type === "integer" ? "number" : selected.type;
        properties[field.name] = { ...property, type: selected.type, ...(selected.enum ? { enum: selected.enum } : {}) };
        return { ...field, labelKey: `fal.fields.${field.name}`, kind, ...(selected.enum ? { options: selected.enum as JsonValue[] } : {}), advanced: !field.common } as FalField;
    });
    const allowed = new Set(["prompt", ...fields.map((field) => field.name), ...descriptor.media.map((slot) => slot.field)]);
    if (Object.hasOwn(properties, "num_images")) {
        allowed.add("num_images");
        properties.num_images = { ...properties.num_images, const: 1 };
    }
    for (const name of Object.keys(properties)) if (!allowed.has(name)) delete properties[name];
    for (const slot of descriptor.media) {
        const uri = { type: "string", format: "uri", pattern: "^(https://|data:image/)" };
        properties[slot.field] = slot.mode === "many"
            ? { ...properties[slot.field], minItems: 1, items: uri }
            : { ...properties[slot.field], ...uri };
    }
    for (const [name, constraints] of Object.entries(descriptor.propertyConstraints ?? {})) {
        if (!properties[name]) throw new Error("fal_profile_invalid: constraints for unsupported property");
        properties[name] = { ...properties[name], ...constraints };
    }
    inputSchema.required = [...new Set([...(inputSchema.required ?? []), "prompt", ...descriptor.media.filter((slot) => slot.required).map((slot) => slot.field)])];
    inputSchema.additionalProperties = false;
    Object.assign(inputSchema, descriptor.inputConstraints);
    return {
        id: descriptor.endpointId, version: 1, endpointId: descriptor.endpointId, modality,
        submitPath: descriptor.submitPath, resultPath: descriptor.resultPath,
        inputSchema, outputSchema: schemas.outputSchema,
        defaults: descriptor.defaults, fields, media: descriptor.media,
    };
}

function freezeDeep<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) freezeDeep(child);
        Object.freeze(value);
    }
    return value;
}

/** Builds an isolated, immutable registry from reviewed source contracts. */
export function createFalProfileRegistry(profiles: readonly FalProfile[]) {
    const ids = new Set<string>();
    const byEndpoint: Record<string, FalProfile> = Object.create(null);
    const entries = profiles.map((profile) => {
        if (!profile.id || !profile.endpointId || profile.version !== 1 || (profile.modality !== "image" && profile.modality !== "video") || ids.has(profile.id) || Object.hasOwn(byEndpoint, profile.endpointId)) {
            throw new Error("fal_profile_invalid: duplicate registration or invalid identity, version or modality");
        }
        ids.add(profile.id);
        const registered = freezeDeep(structuredClone(profile));
        byEndpoint[profile.endpointId] = registered;
        return registered;
    });
    Object.freeze(byEndpoint);
    Object.freeze(entries);
    return Object.freeze({
        getFalProfile(endpointId: string, version: number = 1): FalProfile | undefined {
            return version === 1 ? byEndpoint[endpointId] : undefined;
        },
        listFalProfiles(): readonly FalProfile[] {
            return entries;
        },
    });
}

const sourceSchemas: Record<string, FalSchemaSelection> = { ...imageSchemas, ...videoSchemas };
const registry = createFalProfileRegistry([
    ...imageProfileDescriptors.map((descriptor) => createReviewedFalProfile(descriptor, sourceSchemas[descriptor.endpointId], "image")),
    ...videoProfileDescriptors.map((descriptor) => createReviewedFalProfile(descriptor, sourceSchemas[descriptor.endpointId], "video")),
]);
export const getFalProfile = registry.getFalProfile;
export const listFalProfiles = registry.listFalProfiles;
