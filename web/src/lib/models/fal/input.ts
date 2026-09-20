import type { MediaGenerateRequest, MediaResult } from "@/services/api/media-adapters/types";
import type { FalField, FalProfile, JsonValue } from "./profile-types";
import { validateFalInput } from "./schema";

export type FalContractCase = {
    endpointId: string;
    request: Pick<MediaGenerateRequest, "prompt" | "images" | "params">;
    expectedInput: Record<string, JsonValue>;
    providerOutput: unknown;
    expectedResult: MediaResult;
};

function plainRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function jsonValue(value: unknown): value is JsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(jsonValue);
    return plainRecord(value) && Object.values(value).every(jsonValue);
}
function commonValue(field: FalField, value: unknown): unknown {
    if (field.common === "size" && field.valueMap && typeof value === "string" && Object.hasOwn(field.valueMap, value)) return field.valueMap[value];
    if (field.common !== "seconds") return value;
    if (value === "auto" && "options" in field && field.options?.includes("auto")) return value;
    if ((typeof value !== "number" && (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))) || !Number.isFinite(Number(value))) {
        throw new Error("fal_input_invalid: /duration: expected finite seconds");
    }
    const seconds = Number(value);
    if (field.secondsFormat === "number") return seconds;
    if (field.secondsFormat === "string") return String(seconds);
    if (field.secondsFormat === "seconds-suffix") return `${seconds}s`;
    throw new Error("fal_profile_invalid: missing seconds conversion");
}

/** Common controls are separate from plain advanced values in params.providerParams. */
export function compileFalInput(profile: FalProfile, request: Pick<MediaGenerateRequest, "prompt" | "images" | "audios" | "videos" | "params">): Record<string, JsonValue> {
    if ((request.audios?.length ?? 0) || (request.videos?.length ?? 0)) throw new Error("fal_unsupported_media");
    if (!Array.isArray(request.images) || !plainRecord(request.params)) throw new Error("fal_input_invalid: invalid request shape");
    const body: Record<string, JsonValue> = { ...structuredClone(profile.defaults), prompt: request.prompt };
    const common = new Map(profile.fields.filter((field) => field.common).map((field) => [field.common as string, field]));
    for (const [name, value] of Object.entries(request.params)) {
        if (name === "providerParams") continue;
        const field = common.get(name);
        if (!field) throw new Error("fal_unsupported_parameter");
        const converted = commonValue(field, value);
        if (!jsonValue(converted)) throw new Error("fal_input_invalid: invalid parameter value");
        body[field.name] = structuredClone(converted);
    }
    const advanced = Object.hasOwn(request.params, "providerParams") ? request.params.providerParams : {};
    if (!plainRecord(advanced)) throw new Error("fal_input_invalid: providerParams must be an object");
    const admitted = new Set(profile.fields.filter((field) => field.advanced && !field.common).map((field) => field.name));
    for (const [name, value] of Object.entries(advanced)) {
        if (!admitted.has(name)) throw new Error("fal_unsupported_parameter");
        if (!jsonValue(value)) throw new Error("fal_input_invalid: invalid parameter value");
        body[name] = structuredClone(value);
    }
    let imageIndex = 0;
    for (const slot of profile.media) {
        const value = slot.mode === "many" ? request.images.slice(imageIndex) : request.images[imageIndex];
        if (slot.mode === "many") imageIndex = request.images.length;
        else if (value !== undefined) imageIndex += 1;
        if (value !== undefined) body[slot.field] = value;
        if (slot.required && (value === undefined || (Array.isArray(value) && !value.length))) throw new Error(`fal_missing_reference:${slot.field}`);
    }
    if (imageIndex !== request.images.length) throw new Error("fal_extra_references");
    validateFalInput(profile, body);
    return body;
}

function mediaUrl(value: unknown): string {
    if (typeof value !== "string" || !/^https?:\/\//.test(value) || /[\u0000-\u0020\u007f]/.test(value)) throw new Error("fal_output_invalid");
    try {
        const url = new URL(value);
        if (!url.hostname || url.username || url.password) throw new Error();
    } catch {
        throw new Error("fal_output_invalid");
    }
    return value;
}
function mediaObject(value: unknown, kind: "image" | "video"): { url: string; mimeType?: string } {
    if (!plainRecord(value)) throw new Error("fal_output_invalid");
    const url = mediaUrl(value.url);
    const mimeType = value.content_type;
    if (mimeType !== undefined && mimeType !== null && (typeof mimeType !== "string" || !mimeType.startsWith(`${kind}/`) || !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType))) throw new Error("fal_output_invalid");
    return { url, ...(typeof mimeType === "string" ? { mimeType } : {}) };
}

/** Result URLs remain public provider URLs; credentials are never appended. */
export function parseFalOutput(profile: FalProfile, output: unknown): MediaResult {
    if (!plainRecord(output)) throw new Error("fal_output_invalid");
    if (profile.modality === "image") {
        if (!Array.isArray(output.images) || !output.images.length) throw new Error("fal_output_invalid");
        return { kind: "image", sources: output.images.map((value) => mediaObject(value, "image").url) };
    }
    const video = mediaObject(output.video, "video");
    return { kind: "video", source: video.url, ...(video.mimeType ? { mimeType: video.mimeType } : {}) };
}
