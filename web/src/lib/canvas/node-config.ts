import { falNodeConfig } from "./fal-settings";
import { defaultConfig, resolveModelForCapability, type AiConfig } from "@/stores/use-config-store";
import type { CanvasAudioSettingKey } from "@/components/canvas/canvas-audio-settings-popover";
import type { CanvasGenerationMode, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasGenerationMode): AiConfig {
    return {
        ...globalConfig,
        model: resolveModelForCapability(globalConfig, node.metadata?.model, mode),
        reasoningEffort: node.metadata?.reasoningEffort || globalConfig.reasoningEffort || defaultConfig.reasoningEffort,
        quality: node.metadata?.quality || globalConfig.quality || defaultConfig.quality,
        size: node.metadata?.size || globalConfig.size || defaultConfig.size,
        background: node.metadata?.background ?? globalConfig.background ?? defaultConfig.background,
        videoSeconds: node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        vquality: node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
        videoGenerateAudio: node.metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node.metadata?.watermark || globalConfig.videoWatermark || defaultConfig.videoWatermark,
        audioVoice: node.metadata?.audioVoice || globalConfig.audioVoice || defaultConfig.audioVoice,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node.metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        count: String(node.metadata?.count || (mode === "image" ? globalConfig.canvasImageCount || globalConfig.count : globalConfig.count) || defaultConfig.count),
        textCount: String(node.metadata?.textCount || Math.max(1, Math.min(15, Number(globalConfig.canvasTextCount) || 1))),
        ...falNodeConfig({ ...globalConfig, model: resolveModelForCapability(globalConfig, node.metadata?.model, mode) }, node.metadata),
    };
}

export function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    return { [key]: value };
}

export function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioVoice") return { audioVoice: value };
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSpeed") return { audioSpeed: value };
    return { audioInstructions: value };
}

/** 「重置参数」逐面板的 metadata 覆盖键；与 spec §3 写入映射一一对应。 */
export const imageOverrideKeys = ["quality", "size", "background", "count"];
export const videoOverrideKeys = ["vquality", "size", "seconds"];
export const audioOverrideKeys = ["audioVoice", "audioSpeed", "audioFormat", "audioInstructions"];
export const textOverrideKeys = ["reasoningEffort", "textCount"];

/** 覆盖=键上显式写过值；`undefined`（重置后的残留键）不算覆盖。 */
export function hasMetadataOverride(metadata: Record<string, unknown> | undefined, keys: readonly string[]): boolean {
    return keys.some((key) => metadata?.[key] !== undefined);
}

/** 清除节点覆盖：applyNodeConfigPatch 是 spread merge，undefined 值写入后回退链视为未设置。 */
export function clearMetadataPatch(keys: readonly string[]): Partial<CanvasNodeMetadata> {
    return Object.fromEntries(keys.map((key) => [key, undefined]));
}
