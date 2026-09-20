import type { AiConfig } from "@/stores/use-config-store";
import { decodeChannelModel } from "@/stores/use-config-store";
import type { CanvasNodeMetadata } from "@/types/canvas";
import type { FalField, FalProfile, JsonValue } from "@/lib/models/fal/profile-types";
import { getFalProfile } from "@/lib/models/fal/profiles";
import { compileFalInput } from "@/lib/models/fal/input";
import { readProviderParams, type ProviderOptions } from "@/lib/models/provider-options";
import { isConfiguredFalModel } from "./fal-generation-input";

export const falCommonConfigKeys = { size: "size", quality: "quality", seconds: "videoSeconds", resolution: "vquality", generateAudio: "videoGenerateAudio" } as const;
export const falCommonMetadataKeys = { size: "size", quality: "quality", seconds: "seconds", resolution: "vquality", generateAudio: "generateAudio" } as const;

export function configuredFalProfile(config: AiConfig): FalProfile | undefined {
    const selected = decodeChannelModel(config.model || "");
    return selected && config.channels?.some(channel => channel.id === selected.channelId && channel.provider === "fal") && isConfiguredFalModel(config) ? getFalProfile(selected.model) : undefined;
}
/** Provider-native enum/default to the host's persisted common representation. */
export function falCommonValue(field: FalField, value: JsonValue | undefined): string {
    if (value === undefined) return "";
    if (field.common === "seconds" && field.secondsFormat === "seconds-suffix" && typeof value === "string") return value.replace(/s$/, "");
    return String(value);
}
export function falNativeValue(field: FalField, value: string): JsonValue {
    if (field.common === "size" && field.valueMap && Object.hasOwn(field.valueMap, value)) return field.valueMap[value];
    if (field.common === "generateAudio") return value === "true" ? true : value === "false" ? false : value;
    if (field.common === "seconds" && value !== "auto" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) && Number.isFinite(Number(value))) {
        return field.secondsFormat === "number" ? Number(value) : field.secondsFormat === "seconds-suffix" ? `${Number(value)}s` : String(Number(value));
    }
    return value;
}
/** Call only when creating a new fal node. Never use this patch to repair existing metadata. */
export function falDefaultMetadata(config: AiConfig): Partial<CanvasNodeMetadata> {
    const profile = configuredFalProfile(config);
    if (!profile) return {};
    const patch: Partial<CanvasNodeMetadata> = { model: config.model };
    for (const field of profile.fields) if (field.common) patch[falCommonMetadataKeys[field.common]] = falCommonValue(field, profile.defaults[field.name]);
    return patch;
}
/** Missing fal node values inherit its profile, not generic OpenAI/global defaults. Explicit values remain intact. */
export function falNodeConfig(config: AiConfig, metadata?: CanvasNodeMetadata): Partial<AiConfig> {
    const profile = configuredFalProfile(config);
    if (!profile) return {};
    const patch: Partial<AiConfig> = {};
    for (const field of profile.fields) if (field.common) patch[falCommonConfigKeys[field.common]] = metadata?.[falCommonMetadataKeys[field.common]] ?? falCommonValue(field, profile.defaults[field.name]);
    return patch;
}
export function falSettingsParams(profile: FalProfile, config: AiConfig, options?: ProviderOptions): Record<string, unknown> {
    const params: Record<string, unknown> = { providerParams: readProviderParams(options, config.model) };
    for (const field of profile.fields) if (field.common) {
        const value = config[falCommonConfigKeys[field.common]];
        if (value !== "" && value !== undefined) params[field.common] = field.common === "generateAudio" ? falNativeValue(field, value) : value;
    }
    return params;
}
/** Parameters only: placeholders satisfy slot presence, never assert actual media readability/limits. */
export function validateFalSettings(profile: FalProfile, config: AiConfig, options?: ProviderOptions): void {
    compileFalInput(profile, { prompt: "Preview", images: profile.media.filter(slot => slot.required).map(() => "https://reference.invalid/preview.png"), params: falSettingsParams(profile, config, options) });
}
/** Switching model is not consent to discard a saved value. Invalid choices stay visible for correction. */
export function falModelSelectionPatch(config: AiConfig, model: string, metadata?: CanvasNodeMetadata): Partial<CanvasNodeMetadata> | undefined {
    const profile = configuredFalProfile({ ...config, model });
    if (!profile) return undefined;
    const patch: Partial<CanvasNodeMetadata> = { model };
    const previous = configuredFalProfile(config);
    for (const field of profile.fields) if (field.common) {
        const value = metadata ? metadata[falCommonMetadataKeys[field.common]] ?? (previous?.fields.some(item => item.common === field.common) ? config[falCommonConfigKeys[field.common]] : undefined) : config[falCommonConfigKeys[field.common]];
        patch[falCommonMetadataKeys[field.common]] = value === undefined || value === "" ? falCommonValue(field, profile.defaults[field.name]) : value;
    }
    return patch;
}
