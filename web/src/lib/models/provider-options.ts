import { decodeChannelModel } from "./channel-model-id";
import { getFalProfile } from "./fal/profiles";
import type { FalProfile, JsonValue } from "./fal/profile-types";

export type ProviderModelOptions = { provider: "fal"; profileId: string; profileVersion: number; params: Record<string, JsonValue> };
export type ProviderOptions = { version: number; models: Record<string, ProviderModelOptions> };

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function isJson(value: unknown, ancestors = new Set<object>()): value is JsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if ((!Array.isArray(value) && !record(value)) || ancestors.has(value)) return false;
    ancestors.add(value);
    const valid = Object.values(value).every(item => isJson(item, ancestors));
    ancestors.delete(value);
    return valid;
}
function checkOptions(options: ProviderOptions | undefined) {
    if (options !== undefined && (!record(options) || options.version !== 1 || !record(options.models))) throw new Error("fal_options_version");
}
function checkIdentity(channelModelId: string, profile: FalProfile) {
    const decoded = decodeChannelModel(channelModelId);
    if (!decoded?.channelId || decoded.model !== profile.endpointId || getFalProfile(profile.id, profile.version)?.endpointId !== decoded.model) throw new Error("fal_options_profile");
}
function checkParams(params: unknown, profile: FalProfile): asserts params is Record<string, JsonValue> {
    if (!record(params) || !isJson(params)) throw new Error("fal_options_invalid");
    const admitted = new Set(profile.fields.filter(field => field.advanced && !field.common).map(field => field.name));
    if (Object.keys(params).some(name => !admitted.has(name))) throw new Error("fal_unsupported_parameter");
}
export function readProviderParams(options: ProviderOptions | undefined, channelModelId: string): Record<string, JsonValue> {
    checkOptions(options);
    if (!options || !Object.hasOwn(options.models, channelModelId)) return {};
    const stored = options.models[channelModelId];
    // Persisted records must declare the supported version; undefined must not use the registry default.
    if (!record(stored) || stored.provider !== "fal" || stored.profileVersion !== 1) throw new Error("fal_options_profile");
    const profile = getFalProfile(stored.profileId, stored.profileVersion);
    if (!profile) throw new Error("fal_options_profile");
    checkIdentity(channelModelId, profile);
    checkParams(stored.params, profile);
    return structuredClone(stored.params);
}
export function patchProviderParams(options: ProviderOptions | undefined, channelModelId: string, profile: FalProfile, patch: Record<string, JsonValue>): ProviderOptions {
    checkOptions(options);
    checkIdentity(channelModelId, profile);
    checkParams(patch, profile);
    const params = { ...readProviderParams(options, channelModelId), ...structuredClone(patch) };
    return { version: 1, models: { ...options?.models, [channelModelId]: { provider: "fal", profileId: profile.id, profileVersion: profile.version, params } } };
}

/** Validate the complete tool write, including inactive entries; reads retain future data unchanged. */
export function validateProviderOptions(value: unknown): ProviderOptions {
    if (!record(value) || !isJson(value) || Object.keys(value).some(key => !["version", "models"].includes(key))) throw new Error("fal_options_invalid");
    const options = value as ProviderOptions;
    checkOptions(options);
    for (const key of Object.keys(options.models)) {
        const params = readProviderParams(options, key);
        const stored = options.models[key];
        if (Object.keys(stored).some(name => !["provider", "profileId", "profileVersion", "params"].includes(name))) throw new Error("fal_options_invalid");
        const profile = getFalProfile(stored.profileId, stored.profileVersion)!;
        for (const [name, param] of Object.entries(params)) {
            const field = profile.fields.find(field => field.name === name)!;
            // Reviewed controls admit only scalar values (or scalar arrays), never executable
            // objects, credentials, request targets or embedded media under a control name.
            const scalar = (item: unknown, kind: string, choices?: readonly JsonValue[]) =>
                (choices ? choices.includes(item as JsonValue) : typeof item === kind) && !(typeof item === "string" && /^data:/i.test(item));
            const valid = field.kind === "array"
                ? Array.isArray(param) && param.every(item => scalar(item, field.items.kind, field.items.options))
                : scalar(param, field.kind, field.options);
            if (!valid) throw new Error("fal_options_invalid");
        }
    }
    return structuredClone(options);
}
