import { useEffect, useId, useMemo, useState, type ComponentType } from "react";
import { Cpu, Search, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Popover, message } from "antd";

import { canUseAsAgent } from "@/lib/models/channel-model-metadata";
import i18n from "@/i18n";
// 按品牌 Mono 子路径引入：目录默认入口会连带 Avatar/Combine → @lobehub/ui（EmojiPicker/emoji-mart），
// 导致 vitest 下的 ESM JSON 导入报错，也让主包体积无谓变大；Mono 即默认渲染形态
import Claude from "@lobehub/icons/es/Claude/components/Mono";
import Cohere from "@lobehub/icons/es/Cohere/components/Mono";
import DeepSeek from "@lobehub/icons/es/DeepSeek/components/Mono";
import Doubao from "@lobehub/icons/es/Doubao/components/Mono";
import Flux from "@lobehub/icons/es/Flux/components/Mono";
import Gemini from "@lobehub/icons/es/Gemini/components/Mono";
import Grok from "@lobehub/icons/es/Grok/components/Mono";
import Groq from "@lobehub/icons/es/Groq/components/Mono";
import Hunyuan from "@lobehub/icons/es/Hunyuan/components/Mono";
import Meta from "@lobehub/icons/es/Meta/components/Mono";
import Midjourney from "@lobehub/icons/es/Midjourney/components/Mono";
import MiniMax from "@lobehub/icons/es/Minimax/components/Mono";
import Mistral from "@lobehub/icons/es/Mistral/components/Mono";
import Moonshot from "@lobehub/icons/es/Moonshot/components/Mono";
import Ollama from "@lobehub/icons/es/Ollama/components/Mono";
import OpenAI from "@lobehub/icons/es/OpenAI/components/Mono";
import Perplexity from "@lobehub/icons/es/Perplexity/components/Mono";
import Qwen from "@lobehub/icons/es/Qwen/components/Mono";
import Recraft from "@lobehub/icons/es/Recraft/components/Mono";
import Stability from "@lobehub/icons/es/Stability/components/Mono";
import XAI from "@lobehub/icons/es/XAI/components/Mono";
import Zhipu from "@lobehub/icons/es/Zhipu/components/Mono";
import { cn } from "@/lib/utils";
import { modelOptionLabel, modelOptionName, resolveModelChannel, resolveModelExecution, selectableModelsByCapability, useConfigStore, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

type ModelPickerProps = {
    extraOptions?: Array<{ value: string; label: string; disabled?: boolean }>;
    currentLabel?: string;
    disabled?: boolean;
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    purpose?: "generation" | "agent";
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
    /** 只渲染 extraOptions（托管目录选择），不列出 BYOK 渠道模型。 */
    extraOnly?: boolean;
    extraOptionsHeader?: string;
};

const capabilityDefaultKey: Record<ModelCapability, keyof AiConfig> = { image: "imageModel", video: "videoModel", audio: "audioModel", text: "textModel" };

const iconMatchers: Array<[RegExp, ComponentType<{ size?: number }>]> = [
    [/claude|anthropic/, Claude],
    [/gemini|google/, Gemini],
    [/gpt|openai|chatgpt|dalle|dall-e/, OpenAI],
    [/grok|xAI/, XAI],
    [/deepseek/, DeepSeek],
    [/glm|zhipu|chatglm/, Zhipu],
    [/qwen|tongyi/, Qwen],
    [/doubao|seedream|seedance|jimeng/, Doubao],
    [/moonshot|kimi/, Moonshot],
    [/minimax/, MiniMax],
    [/flux/, Flux],
    [/stability|sdxl|stable-/, Stability],
    [/mistral|mixtral/, Mistral],
    [/llama|meta/, Meta],
    [/groq/, Groq],
    [/perplexity|sonar/, Perplexity],
    [/cohere|command/, Cohere],
    [/hunyuan/, Hunyuan],
    [/midjourney|niji/, Midjourney],
    [/recraft/, Recraft],
    [/ollama/, Ollama],
];

function ModelIcon({ model }: { model: string }) {
    const name = modelOptionName(model).toLowerCase();
    const Icon = iconMatchers.find(([re]) => re.test(name))?.[1];
    return Icon ? <Icon size={14} /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

export function ModelPicker({ config, value, onChange, capability, purpose = "generation", className, fullWidth = false, placeholder, onMissingConfig, extraOptions = [], currentLabel, disabled, extraOnly = false, extraOptionsHeader }: ModelPickerProps) {
    const { t } = useTranslation();
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const defaults = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const allOptions = useMemo(() => Array.from(new Set([...(config.channelMode === "local" && !capability ? [value] : []), ...selectableModelsByCapability(config, capability)].filter((model): model is string => Boolean(model)))), [capability, config, value]);
    const options = useMemo(() => purpose !== "agent" ? allOptions : allOptions.filter((value) => {
        const channel = resolveModelChannel(config, value);
        const model = resolveModelExecution(config, value);
        return channel.provider !== "openrouter" || Boolean(model && canUseAsAgent(channel, model));
    }), [allOptions, config, purpose]);
    const excludedAgentModels = options.length !== allOptions.length;
    const current = value || "";
    const defaultKey = capability ? capabilityDefaultKey[capability] : undefined;
    const defaultModel = defaultKey ? String(defaults[defaultKey] || "") : "";

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    const groups = useMemo(() => {
        if (extraOnly) return [] as Array<[string, string[]]>;
        const map = new Map<string, string[]>();
        for (const model of options) {
            const name = resolveModelChannel(config, model)?.name || i18n.t("config.channels.defaultName");
            const bucket = map.get(name) || [];
            bucket.push(model);
            map.set(name, bucket);
        }
        return Array.from(map.entries());
    }, [extraOnly, options, config]);

    const visibleGroups = groups
        .map(([name, models]) => [name, models.filter((model) => model.toLowerCase().includes(query.toLowerCase()) || name.toLowerCase().includes(query.toLowerCase()))] as const)
        .filter(([, models]) => models.length);

    return (
        <Popover
            trigger="click"
            open={open}
            // Radix 模态弹窗（设置弹窗）打开时给 body 设 pointer-events:none，portal 到 body 的浮层
            // 视觉在上层但点击全被弹窗拦截；落进弹窗内容子树（pointer-events:auto 区域）才能交互。
            getPopupContainer={(node) => (node.closest('[data-slot="dialog-content"]') as HTMLElement | null) ?? document.body}
            onOpenChange={(next) => {
                if (next && !extraOnly && !options.length && !extraOptions.length && config.channelMode === "local") onMissingConfig?.();
                if (next) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                setOpen(next);
            }}
            content={
                <div
                    className="w-72"
                    onClick={(event) => event.stopPropagation()}
                    // 弹层 portal 到 body 后，React 事件仍沿组件树冒泡到画布容器（shotshot.tsx onPointerDown），
                    // 会被误判为背景点击并 setPointerCapture 劫持 pointerup/click，导致选项点击失效。
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <div className="mb-2 flex h-8 items-center gap-1.5 rounded-[10px] border border-border bg-muted/40 px-2.5">
                        <Search className="size-3.5 text-muted-foreground" />
                        <input
                            autoFocus
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={t("settingsPanels.model.search")}
                            className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                        />
                    </div>
                    <div className="thin-scrollbar max-h-[60vh] overflow-y-auto">
                        {!extraOnly && excludedAgentModels ? <div className="flex h-8 items-center gap-2 rounded-lg px-2 text-[12.5px] text-muted-foreground">{t("config.catalog.agentRequiresTools")}</div> : null}
                        {extraOnly && extraOptionsHeader ? <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{extraOptionsHeader}</div> : null}
                        {extraOptions.map((option) => {
                            const isCurrentExtra = current === option.value;
                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    disabled={option.disabled}
                                    className={cn("flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12.5px]", !option.disabled && "hover:bg-accent", option.disabled && "opacity-50", isCurrentExtra && "bg-accent")}
                                    onClick={() => { onChange(option.value); setOpen(false); setQuery(""); }}
                                >
                                    <Cpu className="size-4 shrink-0 opacity-70" />
                                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                                    {isCurrentExtra ? <span className="size-3.5 shrink-0 rounded-full bg-foreground" /> : null}
                                </button>
                            );
                        })}
                        {!extraOnly && visibleGroups.map(([name, models]) => (
                            <div key={name} className="mb-1">
                                <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{name}</div>
                                {models.map((model) => {
                                    const isDefault = Boolean(defaultKey) && defaultModel === model;
                                    const isCurrent = current === model;
                                    return (
                                        <button
                                            key={model}
                                            type="button"
                                            className={cn("group flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12.5px] hover:bg-accent", isCurrent && "bg-accent")}
                                            onClick={() => { onChange(model); setOpen(false); setQuery(""); }}
                                        >
                                            <ModelIcon model={model} />
                                            <span className="min-w-0 flex-1 truncate">{modelOptionLabel(config, model)}</span>
                                            {isDefault ? <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">{t("settingsPanels.model.default")}</span> : null}
                                            {defaultKey && !isDefault ? (
                                                <span
                                                    role="button"
                                                    title={t("settingsPanels.model.setAsDefault")}
                                                    className="hidden group-hover:inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        updateConfig(defaultKey, model);
                                                        message.success(t("settingsPanels.model.setDefaultToast", { model: modelOptionName(model), type: capability ? t(`settingsPanels.model.capabilities.${capability}`) : "" }));
                                                        setOpen(true);
                                                    }}
                                                >
                                                    <StarGlyph />{t("settingsPanels.model.setAsDefault")}
                                                </span>
                                            ) : null}
                                            {isCurrent ? <span className="size-3.5 shrink-0 rounded-full bg-foreground" /> : null}
                                        </button>
                                    );
                                })}
                            </div>
                        ))}
                        {!extraOnly && !visibleGroups.length ? <div className="px-2 py-3 text-center text-xs text-muted-foreground">{t("settingsPanels.model.noMatch", { capability: capability ? t(`settingsPanels.model.capabilities.${capability}`) : "" })}</div> : null}
                    </div>
                    {!extraOnly && (
                        <button type="button" className="mt-1 flex h-8 w-full items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => { setOpen(false); onMissingConfig?.(); }}>
                            <Settings className="size-3.5" />
                            {t("settingsPanels.model.manageProviders")}
                        </button>
                    )}
                </div>
            }
            overlayClassName="model-picker-popover"
            overlayStyle={{ borderRadius: 12 }}
            styles={{ container: { padding: 8 } }}
        >
            <button
                type="button"
                disabled={disabled}
                data-state={open ? "open" : "closed"}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={currentLabel || (current ? modelOptionLabel(config, current) : placeholder || t("settingsPanels.model.select"))}
                className={cn(
                    "canvas-composer-model-picker inline-flex h-8 min-w-[9rem] max-w-full items-center gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors hover:bg-accent/40",
                    fullWidth && "w-full min-w-0",
                    className,
                )}
            >
                <ModelIcon model={current} />
                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{currentLabel || (current ? modelOptionLabel(config, current) : placeholder || t("settingsPanels.model.select"))}</span>
            </button>
        </Popover>
    );
}

function StarGlyph() {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" /></svg>;
}

function emptyModelLabel(config: AiConfig, capability?: ModelCapability) {
    const label = capability ? i18n.t(`settingsPanels.model.capabilities.${capability}`) : "";
    if (capability && config.models.length) return i18n.t("settingsPanels.model.assign", { capability: label });
    return config.models.length ? i18n.t("settingsPanels.model.noMatch", { capability: label }) : i18n.t("settingsPanels.model.addFirst");
}
