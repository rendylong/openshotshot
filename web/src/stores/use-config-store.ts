import { decodeChannelModel, encodeChannelModel } from "@/lib/models/channel-model-id";
export { decodeChannelModel, encodeChannelModel, isChannelModelValue } from "@/lib/models/channel-model-id";
import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { OFFICIAL_CATALOG_SNAPSHOT } from "@/lib/models/catalog-snapshot";
import { AUTODL_WORKFLOWS, getAutodlWorkflow } from "@/lib/models/autodl-workflows";
import { isAutodlChannel, resolveModel } from "@/lib/models/model-resolver";
import type { CatalogMetadata } from "@/lib/models/model-catalog-types";

export type ApiCallFormat = "openai" | "gemini";
export type AgentApiMode = "responses" | "chat_completions";
export type ChannelProvider = "custom" | "fal" | "openrouter" | "minimax-cn" | "minimax-global" | "deepseek" | "moonshot" | "zhipu" | "hiapi" | "autodl";
export type ModelCapability = "image" | "video" | "text" | "audio";
export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "xhigh";
export type ModelExecutionMode = "direct" | "remote_task";
export const DEFAULT_REMOTE_TASK_TIMEOUT_MINUTES = 5;
export const DEFAULT_VIDEO_TASK_TIMEOUT_MINUTES = 30;
export type RemoteTaskConfig = { timeoutMinutes: number; submitScript: string; queryScript: string };
export type ChatPanelSide = "left" | "right";
export type CredentialMode = "byok" | "shotshot";
export type ManagedModelSelections = Record<ModelCapability, string>;
export type CredentialModeKey = ModelCapability | "agent";
export type CredentialModeSelections = Record<CredentialModeKey, CredentialMode>;

export type ChannelModel = {
    name: string;
    capability: ModelCapability;
    /** Whether this text model accepts image inputs; independent from media-generation capability. */
    supportsImageInput?: boolean;
    /** Whether this text model emits reasoning; enables reasoning request params in agent responses mode. */
    supportsReasoning?: boolean;
    executionMode?: ModelExecutionMode;
    script?: string;
    remoteTask?: RemoteTaskConfig;
    catalog?: CatalogMetadata;
};

export type ModelChannel = {
    id: string;
    name: string;
    provider?: ChannelProvider;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    models: ChannelModel[];
};

export type AiConfig = {
    credentialMode: CredentialMode;
    /** Per-capability source overrides. `credentialMode` remains the legacy default. */
    credentialModes: CredentialModeSelections;
    managedModels: ManagedModelSelections;
    channelMode: "remote" | "local";
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    channels: ModelChannel[];
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    agentModel: string;
    /** shotshot 模式下 Agent 使用的套餐文本模型 id；空表示用目录第一个 text 模型。 */
    managedAgentModel: string;
    agentApiMode: AgentApiMode;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
    models: string[];
    quality: string;
    size: string;
    background: string;
    count: string;
    canvasImageCount: string;
    compressReferenceImages: boolean;
    canvasTextCount: string;
    textCount: string;
    chatPanelSide: ChatPanelSide;
};

export type WebdavSyncConfig = {
    url: string;
    username: string;
    password: string;
    directory: string;
    lastSyncedAt: string;
};
export type ConfigTabKey = "account" | "channels" | "preferences" | "webdav" | "local-storage" | "memory";

export const CONFIG_STORE_KEY = "shotshot:ai_config_store";
const OPENAI_BASE_URL = "https://api.openai.com";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";

const OFFICIAL_CHANNEL_PRESETS: Record<Exclude<ChannelProvider, "custom">, { nameKey: string; baseUrl: string; models: ChannelModel[] }> = {
    fal: { nameKey: "config.channels.presets.fal", baseUrl: "https://queue.fal.run", models: [] },
    openrouter: {
        nameKey: "config.channels.presets.openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        models: [],
    },
    autodl: {
        nameKey: "config.channels.presets.autodl",
        baseUrl: "https://autodl.art",
        models: AUTODL_WORKFLOWS.map(({ id }) => ({ name: id, capability: "video" })),
    },
    "minimax-cn": {
        nameKey: "config.channels.presets.minimaxCn",
        baseUrl: "https://api.minimaxi.com",
        models: [
            { name: "MiniMax-M2.7", capability: "text" },
            { name: "MiniMax-M2.7-highspeed", capability: "text" },
            { name: "image-01", capability: "image" },
            { name: "image-01-live", capability: "image" },
            { name: "MiniMax-Hailuo-2.3", capability: "video" },
            { name: "MiniMax-Hailuo-2.3-Fast", capability: "video" },
            { name: "MiniMax-H3", capability: "video" },
            { name: "MiniMax-H3-Max", capability: "video" },
            { name: "speech-2.8-hd", capability: "audio" },
            { name: "speech-2.8-turbo", capability: "audio" },
        ],
    },
    "minimax-global": {
        nameKey: "config.channels.presets.minimaxGlobal",
        baseUrl: "https://api.minimax.io",
        models: [
            { name: "MiniMax-M2.7", capability: "text" },
            { name: "MiniMax-M2.7-highspeed", capability: "text" },
            { name: "image-01", capability: "image" },
            { name: "image-01-live", capability: "image" },
            { name: "MiniMax-Hailuo-2.3", capability: "video" },
            { name: "MiniMax-Hailuo-2.3-Fast", capability: "video" },
            { name: "MiniMax-H3", capability: "video" },
            { name: "MiniMax-H3-Max", capability: "video" },
            { name: "speech-2.8-hd", capability: "audio" },
            { name: "speech-2.8-turbo", capability: "audio" },
        ],
    },
    deepseek: {
        nameKey: "config.channels.presets.deepseek",
        baseUrl: "https://api.deepseek.com",
        models: [
            { name: "deepseek-v4-flash", capability: "text" },
            { name: "deepseek-v4-pro", capability: "text" },
            { name: "deepseek-v4-flash-vision-exp", capability: "text" },
        ],
    },
    moonshot: {
        nameKey: "config.channels.presets.moonshot",
        baseUrl: "https://api.moonshot.cn/v1",
        models: catalogModels("moonshot", "https://api.moonshot.cn/v1"),
    },
    zhipu: {
        nameKey: "config.channels.presets.zhipu",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        models: catalogModels("zhipu", "https://open.bigmodel.cn/api/paas/v4"),
    },
    hiapi: {
        nameKey: "config.channels.presets.hiapi",
        baseUrl: "https://api.hiapi.ai",
        models: [
            { name: "gpt-image-2/text-to-image", capability: "image" },
            { name: "gpt-image-2/image-to-image", capability: "image" },
            { name: "grok-imagine/text-to-image", capability: "image" },
            { name: "grok-imagine/image-to-image", capability: "image" },
            { name: "grok-imagine-quality/text-to-image", capability: "image" },
            { name: "grok-imagine-quality/image-to-image", capability: "image" },
            { name: "seedream-4.5/text-to-image", capability: "image" },
            { name: "seedream-4.5/image-to-image", capability: "image" },
            { name: "seedream-5.0-lite/text-to-image", capability: "image" },
            { name: "seedream-5.0-lite/image-to-image", capability: "image" },
            { name: "seedream-5.0-pro/text-to-image", capability: "image" },
            { name: "seedream-5.0-pro/image-to-image", capability: "image" },
            { name: "nano-banana-2", capability: "image" },
            { name: "nano-banana-pro", capability: "image" },
            { name: "flux-2/text-to-image", capability: "image" },
            { name: "flux-2/image-to-image", capability: "image" },
            { name: "qwen-image-3.0/text-to-image", capability: "image" },
            { name: "qwen-image-3.0/image-to-image", capability: "image" },
            { name: "z-image", capability: "image" },
            { name: "wan2.7-image/text-to-image", capability: "image" },
            { name: "ideogram-v4", capability: "image" },
            { name: "veo-3.1/text-to-video", capability: "video" },
            { name: "veo-3.1/image-to-video", capability: "video" },
            { name: "veo-3.1-fast/text-to-video", capability: "video" },
            { name: "veo-3.1-fast/image-to-video", capability: "video" },
            { name: "seedance-2.0", capability: "video" },
            { name: "seedance-2.5/text-to-video", capability: "video" },
            { name: "seedance-2.5/image-to-video", capability: "video" },
            { name: "grok-imagine/text-to-video", capability: "video" },
            { name: "grok-imagine/image-to-video", capability: "video" },
            { name: "happyhorse-1.1/text-to-video", capability: "video" },
            { name: "happyhorse-1.1/image-to-video", capability: "video" },
            { name: "hailuo-2.3/text-to-video", capability: "video" },
            { name: "hailuo-2.3/image-to-video", capability: "video" },
            { name: "kling-3.0-turbo/text-to-video", capability: "video" },
            { name: "kling-3.0-turbo/image-to-video", capability: "video" },
            { name: "wan2.7-video/text-to-video", capability: "video" },
            { name: "wan2.7-video/image-to-video", capability: "video" },
            { name: "qwen-audio-3.0-tts-plus", capability: "audio" },
            { name: "qwen-audio-3.0-tts-flash", capability: "audio" },
            { name: "elevenlabs/text-to-dialogue", capability: "audio" },
            { name: "minimax-music-1.5", capability: "audio" },
            { name: "minimax-music-2.6", capability: "audio" },
        ],
    },
};

export const defaultConfig: AiConfig = {
    credentialMode: "byok",
    credentialModes: { agent: "byok", image: "byok", video: "byok", text: "byok", audio: "byok" },
    managedModels: { text: "", image: "", video: "", audio: "" },
    channelMode: "local",
    baseUrl: OPENAI_BASE_URL,
    apiKey: "",
    apiFormat: "openai",
    channels: [
        {
            id: "default",
            name: i18n.t("config.channels.defaultName"),
            provider: "custom",
            baseUrl: OPENAI_BASE_URL,
            apiKey: "",
            apiFormat: "openai",
            models: [
                { name: "gpt-image-2", capability: "image" },
                { name: "grok-imagine-video", capability: "video" },
                { name: "gpt-5.5", capability: "text", supportsImageInput: true },
                { name: "gpt-4o-mini-tts", capability: "audio" },
            ],
        },
    ],
    model: "default::gpt-image-2",
    imageModel: "default::gpt-image-2",
    videoModel: "default::grok-imagine-video",
    textModel: "default::gpt-5.5",
    agentModel: "default::gpt-5.5",
    managedAgentModel: "",
    agentApiMode: "responses",
    audioModel: "default::gpt-4o-mini-tts",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "6",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    systemPrompt: "",
    reasoningEffort: "auto",
    models: ["default::gpt-image-2", "default::grok-imagine-video", "default::gpt-5.5", "default::gpt-4o-mini-tts"],
    quality: "auto",
    size: "1:1",
    background: "",
    count: "1",
    canvasImageCount: "3",
    compressReferenceImages: true,
    canvasTextCount: "1",
    textCount: "1",
    chatPanelSide: "right",
};

export const defaultWebdavSyncConfig: WebdavSyncConfig = {
    url: "",
    username: "",
    password: "",
    directory: "shotshot",
    lastSyncedAt: "",
};

export function normalizeAiConfig(persistedConfig: Partial<AiConfig>): AiConfig {
    const config = { ...defaultConfig, ...persistedConfig };
    const agentModel = persistedConfig.agentModel || config.textModel || config.model;
    if (!Array.isArray(persistedConfig.channels)) config.channels = [];
    const channels = normalizeChannels(config);
    return {
        ...config,
        credentialMode: normalizeCredentialMode(config.credentialMode),
        credentialModes: normalizeCredentialModeSelections(persistedConfig.credentialModes, config.credentialMode, config.managedModels),
        managedModels: normalizeManagedModelSelections(config.managedModels),
        channelMode: config.channelMode === "remote" ? "remote" : "local",
        apiFormat: normalizeApiFormat(config.apiFormat),
        channels,
        models: modelOptionsFromChannels(channels),
        imageModel: normalizeModelOptionValue(config.imageModel || config.model, channels),
        videoModel: normalizeModelOptionValue(config.videoModel, channels),
        textModel: normalizeModelOptionValue(config.textModel || config.model, channels),
        agentModel: normalizeModelOptionValue(agentModel, channels),
        agentApiMode: normalizeAgentApiMode(config.agentApiMode),
        audioModel: normalizeModelOptionValue(config.audioModel || defaultConfig.audioModel, channels),
        audioVoice: config.audioVoice || defaultConfig.audioVoice,
        audioFormat: config.audioFormat || defaultConfig.audioFormat,
        audioSpeed: config.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: config.audioInstructions || "",
        reasoningEffort: config.reasoningEffort || "auto",
        videoSeconds: config.videoSeconds || "6",
        vquality: config.vquality || "720",
        videoGenerateAudio: config.videoGenerateAudio || "true",
        videoWatermark: config.videoWatermark || "false",
        canvasImageCount: config.canvasImageCount || "3",
        canvasTextCount: config.canvasTextCount || "1",
        compressReferenceImages: config.compressReferenceImages !== false,
        textCount: config.textCount || "1",
        chatPanelSide: normalizeChatPanelSide(config.chatPanelSide),
    };
}

type ConfigStore = {
    config: AiConfig;
    webdav: WebdavSyncConfig;
    isConfigOpen: boolean;
    configTab: ConfigTabKey;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    updateWebdavConfig: <K extends keyof WebdavSyncConfig>(key: K, value: WebdavSyncConfig[K]) => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean, tab?: ConfigTabKey) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};

export function boolConfig(value: string, fallback: boolean) {
    return value ? value === "true" : fallback;
}

/** Resolver-backed default capability for a fetched or manually entered model; user can override it in the channel editor. */
export function guessCapability(name: string, channel?: Pick<ModelChannel, "provider" | "baseUrl" | "apiFormat">): ModelCapability {
    const resolved = resolveModel({
        provider: channel?.provider,
        baseUrl: channel?.baseUrl || "",
        apiFormat: channel?.apiFormat || "openai",
        model: name,
    });
    if (resolved.modality === "image" || resolved.modality === "video" || resolved.modality === "text") return resolved.modality;
    return resolved.modality === "speech" || resolved.modality === "music" ? "audio" : "text";
}

function findChannelModel(config: AiConfig, value: string): { channel: ModelChannel; model: ChannelModel } | null {
    const decoded = decodeChannelModel(value);
    const name = decoded?.model || value;
    const channel = decoded ? config.channels.find((item) => item.id === decoded.channelId) : config.channels.find((item) => item.models.some((model) => model.name === name));
    const model = channel?.models.find((item) => item.name === name);
    return channel && model ? { channel, model } : null;
}

export function modelCapabilityOf(config: AiConfig, value: string): ModelCapability | undefined {
    return findChannelModel(config, value)?.model.capability;
}

export function modelProviderOf(config: AiConfig, value: string): ChannelProvider | undefined {
    return findChannelModel(config, value)?.channel.provider;
}

export function resolveModelExecution(config: AiConfig, value: string) {
    return findChannelModel(config, value)?.model;
}

export function modelMatchesCapability(config: AiConfig, value: string, capability?: ModelCapability) {
    if (!capability) return true;
    return modelCapabilityOf(config, value) === capability;
}

export function resolveModelForCapability(config: AiConfig, currentModel: string | undefined, capability: ModelCapability) {
    const defaultModel = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel;
    const fallbackModel = capability === "image" ? defaultConfig.imageModel : capability === "video" ? defaultConfig.videoModel : capability === "audio" ? defaultConfig.audioModel : defaultConfig.textModel;
    if (currentModel && modelMatchesCapability(config, currentModel, capability)) return currentModel;
    if (defaultModel && modelMatchesCapability(config, defaultModel, capability)) return defaultModel;
    return fallbackModel;
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return config.channels.flatMap((channel) => channel.models.filter((model) => model.capability === capability).map((model) => encodeChannelModel(channel.id, model.name)));
}

/** The user script (if any) attached to a model; empty string means use the system default call. */
export function resolveModelScript(config: AiConfig, value: string) {
    return findChannelModel(config, value)?.model.script?.trim() || "";
}

function isAiConfigReady(config: AiConfig, model: string) {
    const channel = resolveModelChannel(config, model);
    return Boolean(model.trim() && channel.baseUrl.trim() && channel.apiKey.trim());
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set, get) => ({
            config: defaultConfig,
            webdav: defaultWebdavSyncConfig,
            isConfigOpen: false,
            configTab: "channels",
            shouldPromptContinue: false,
            updateConfig: (key, value) =>
                set((state) => ({
                    config: {
                        ...state.config,
                        [key]: value,
                    },
                })),
            updateWebdavConfig: (key, value) =>
                set((state) => ({
                    webdav: {
                        ...state.webdav,
                        [key]: value,
                    },
                })),
            isAiConfigReady: (config, model) => isAiConfigReady(config, model),
            openConfigDialog: (shouldPromptContinue = false, configTab = "channels") => set({ isConfigOpen: true, shouldPromptContinue, configTab }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            partialize: (state) => ({ config: state.config, webdav: state.webdav }),
            merge: (persisted, current) => {
                const persistedState = (persisted || {}) as Partial<ConfigStore>;
                const persistedConfig = (persistedState.config || {}) as Partial<AiConfig>;
                const persistedWebdav = (persistedState.webdav || {}) as Partial<WebdavSyncConfig>;
                return {
                    ...current,
                    webdav: { ...defaultWebdavSyncConfig, ...persistedWebdav },
                    config: normalizeAiConfig(persistedConfig),
                };
            },
        },
    ),
);

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    return useMemo(() => ({ ...config, channelMode: "local" as const }), [config]);
}

/** Normalize a mixed list of raw model names or model objects into deduped ChannelModel entries. */
export function normalizeChannelModels(models: Array<string | ChannelModel> | undefined, channel?: Pick<ModelChannel, "provider" | "baseUrl" | "apiFormat">): ChannelModel[] {
    const seen = new Set<string>();
    const result: ChannelModel[] = [];
    for (const item of models || []) {
        const name = (typeof item === "string" ? item : item?.name || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const capability = typeof item === "string" ? guessCapability(name, channel) : normalizeStoredCapability(item.capability, name, channel);
        const supportsImageInput = typeof item !== "string" && typeof item.supportsImageInput === "boolean"
            ? item.supportsImageInput
            : inferImageInputSupport(name, channel);
        if (typeof item !== "string") {
            result.push(preserveStoredModel(item, name, capability, supportsImageInput));
        } else {
            result.push({ name, capability, ...(supportsImageInput === undefined ? {} : { supportsImageInput }) });
        }
    }
    return result;
}

function normalizeStoredCapability(value: unknown, name: string, channel?: Pick<ModelChannel, "provider" | "baseUrl" | "apiFormat">): ModelCapability {
    return value === "image" || value === "video" || value === "text" || value === "audio" ? value : guessCapability(name, channel);
}

function preserveStoredModel(item: ChannelModel, name: string, capability: ModelCapability, supportsImageInput?: boolean): ChannelModel {
    return {
        ...item,
        name,
        capability,
        ...(supportsImageInput === undefined ? {} : { supportsImageInput }),
    };
}

/** Conservative defaults for well-known multimodal text model families; custom models remain opt-in. */
export function inferImageInputSupport(name: string, channel?: Pick<ModelChannel, "apiFormat">): boolean | undefined {
    const normalized = name.trim().toLowerCase();
    if (channel?.apiFormat === "gemini") return true;
    if (/^gpt-(?:4o|4\.1|5(?:[.-]|$))/.test(normalized)) return true;
    if (/^claude-(?:3|sonnet|opus|haiku)/.test(normalized)) return true;
    if (/(?:^|[-_/])(vision|vl|4v)(?:$|[-_/])/.test(normalized)) return true;
    if (/^kimi-k2\.5(?:$|[-_])/.test(normalized)) return true;
    if (/^minimax-m3(?:$|[-_.])/.test(normalized)) return true;
    return undefined;
}

export function createModelChannel(channel?: Partial<ModelChannel>): ModelChannel {
    const apiFormat = normalizeApiFormat(channel?.apiFormat);
    const provider = normalizeChannelProvider(channel?.provider);
    const preset = provider === "custom" ? undefined : OFFICIAL_CHANNEL_PRESETS[provider];
    return {
        id: channel?.id?.trim() || nanoid(),
        name: channel?.name?.trim() || (preset ? i18n.t(preset.nameKey) : i18n.t("config.channels.newName")),
        provider,
        baseUrl: channel?.baseUrl?.trim() || preset?.baseUrl || defaultBaseUrlForApiFormat(apiFormat),
        apiKey: channel?.apiKey || "",
        apiFormat,
        models: normalizeChannelModels(channel?.models === undefined ? preset?.models : channel.models, { provider, baseUrl: channel?.baseUrl?.trim() || preset?.baseUrl || defaultBaseUrlForApiFormat(apiFormat), apiFormat }),
    };
}

export function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

export function modelOptionLabel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    if (!decoded) return value;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    const workflow = channel && isAutodlChannel(channel) ? getAutodlWorkflow(decoded.model) : undefined;
    const label = workflow ? `${i18n.t(workflow.labelKey)} · ${decoded.model}` : decoded.model;
    return channel ? `${label}（${channel.name}）` : label;
}

export function modelOptionsFromChannels(channels: ModelChannel[]) {
    return uniqueModelOptions(channels.flatMap((channel) => channel.models.map((model) => encodeChannelModel(channel.id, model.name))));
}

export function normalizeModelOptionValue(value: string | undefined, channels: ModelChannel[]) {
    const model = (value || "").trim();
    if (!model) return "";
    const decoded = decodeChannelModel(model);
    if (decoded) {
        const channel = channels.find((item) => item.id === decoded.channelId);
        return channel && channel.models.some((item) => item.name === decoded.model) ? model : "";
    }
    const channel = channels.find((item) => item.models.some((entry) => entry.name === model)) || channels[0];
    return channel && channel.models.some((item) => item.name === model) ? encodeChannelModel(channel.id, model) : model;
}

export function resolveModelChannel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const model = decoded?.model || value;
    const matched = decoded ? config.channels.find((channel) => channel.id === decoded.channelId) : config.channels.find((channel) => channel.models.some((item) => item.name === model));
    return matched || config.channels[0] || createModelChannel({ id: "default", name: i18n.t("config.channels.defaultName"), baseUrl: config.baseUrl, apiKey: config.apiKey, apiFormat: config.apiFormat, models: config.models.map(modelOptionName).map((name) => ({ name, capability: guessCapability(name) })) });
}

export function resolveModelRequestConfig(config: AiConfig, value: string) {
    const channel = resolveModelChannel(config, value);
    return {
        ...config,
        model: modelOptionName(value || config.model),
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        apiFormat: channel.apiFormat,
    };
}

function normalizeChannels(config: AiConfig) {
    const persistedChannels = Array.isArray(config.channels) ? config.channels : [];
    const channels = persistedChannels.map((channel, index) =>
        createModelChannel({
            ...channel,
            id: channel.id || (index === 0 ? "default" : `channel-${index + 1}`),
            name: channel.name || (index === 0 ? i18n.t("config.channels.defaultName") : i18n.t("config.channels.indexedName", { index: index + 1 })),
            models: normalizeChannelModels([...(channel.models || []), ...selectedChannelModels(config, channel)], channel),
        }),
    );
    if (!channels.length) {
        channels.push(
            createModelChannel({
                id: "default",
                name: i18n.t("config.channels.defaultName"),
                baseUrl: config.baseUrl || defaultConfig.baseUrl,
                apiKey: config.apiKey || "",
                apiFormat: config.apiFormat || defaultConfig.apiFormat,
                models: normalizeChannelModels([config.model, config.imageModel, config.videoModel, config.textModel, config.audioModel].map(modelOptionName)),
            }),
        );
    }
    return channels;
}

export function defaultBaseUrlForApiFormat(apiFormat: ApiCallFormat) {
    if (apiFormat === "gemini") return GEMINI_BASE_URL;
    return OPENAI_BASE_URL;
}

function normalizeApiFormat(apiFormat: unknown): ApiCallFormat {
    return apiFormat === "gemini" ? apiFormat : "openai";
}

function normalizeAgentApiMode(value: unknown): AgentApiMode {
    return value === "chat_completions" ? value : "responses";
}

export function normalizeChatPanelSide(value: unknown): ChatPanelSide {
    return value === "left" ? "left" : "right";
}

export function normalizeCredentialMode(
    value: unknown,
    desktop = Boolean((globalThis as { window?: { shotshot?: { account?: unknown } } }).window?.shotshot?.account),
): CredentialMode {
    return value === "shotshot" && desktop ? "shotshot" : "byok";
}

export function normalizeCredentialModeSelections(value: unknown, fallback: unknown, managedModels?: unknown): CredentialModeSelections {
    const source = value && typeof value === "object" ? value as Partial<CredentialModeSelections> : {};
    const legacy = normalizeCredentialMode(fallback);
    const configuredManaged = managedModels && typeof managedModels === "object" ? managedModels as Partial<ManagedModelSelections> : {};
    const mode = (key: CredentialModeKey): CredentialMode => {
        if (source[key] === "shotshot" || source[key] === "byok") return source[key];
        if (legacy === "shotshot" && key !== "agent") return typeof configuredManaged[key] === "string" && Boolean(configuredManaged[key]?.trim()) ? "shotshot" : "byok";
        if (legacy === "shotshot" && key === "agent") return typeof configuredManaged.text === "string" && Boolean(configuredManaged.text.trim()) ? "shotshot" : "byok";
        return legacy;
    };
    return { agent: mode("agent"), image: mode("image"), video: mode("video"), text: mode("text"), audio: mode("audio") };
}

export function credentialModeFor(config: Pick<AiConfig, "credentialMode" | "credentialModes">, key: CredentialModeKey): CredentialMode {
    // 持久化配置经 normalizeAiConfig 后 credentialModes 恒为显式值；逐能力显式
    // 选择（含 legacy shotshot 因空 managedModels 的降级）必须原样生效。
    return config.credentialModes?.[key] || config.credentialMode;
}

export function normalizeManagedModelSelections(value: unknown): ManagedModelSelections {
    const selections = value && typeof value === "object" ? value as Partial<ManagedModelSelections> : {};
    return {
        text: typeof selections.text === "string" ? selections.text : "",
        image: typeof selections.image === "string" ? selections.image : "",
        video: typeof selections.video === "string" ? selections.video : "",
        audio: typeof selections.audio === "string" ? selections.audio : "",
    };
}

function normalizeChannelProvider(value: unknown): ChannelProvider {
    return value === "fal" || value === "openrouter" || value === "minimax-cn" || value === "minimax-global" || value === "deepseek" || value === "moonshot" || value === "zhipu" || value === "hiapi" || value === "autodl" ? value : "custom";
}

function catalogModels(provider: "moonshot" | "zhipu", baseUrl: string): ChannelModel[] {
    return (OFFICIAL_CATALOG_SNAPSHOT[provider] || []).map((model) => ({ name: model.id, capability: guessCapability(model.id, { provider, baseUrl, apiFormat: "openai" }) }));
}

function selectedChannelModels(config: AiConfig, channel: Pick<ModelChannel, "id" | "provider" | "baseUrl" | "apiFormat">): ChannelModel[] {
    return [config.model, config.imageModel, config.videoModel, config.textModel, config.agentModel, config.audioModel]
        .map(decodeChannelModel)
        .filter((value): value is NonNullable<typeof value> => value?.channelId === channel.id)
        .map(({ model }) => ({ name: model, capability: guessCapability(model, channel) }));
}

function uniqueModelOptions(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}

export function buildApiUrl(baseUrl: string, path: string) {
    const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const apiBaseUrl = lowerBaseUrl.endsWith("/v1") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return `${apiBaseUrl}${path}`;
}
