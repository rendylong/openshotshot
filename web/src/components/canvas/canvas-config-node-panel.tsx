import { falModelSelectionPatch } from "@/lib/canvas/fal-settings";
import "./canvas-config-node-panel.css";
import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { Image as ImageIcon, MessageSquare, Music2, Pencil, Play, Square, Video } from "lucide-react";
import { useTranslation } from "react-i18next";

import { videoModelSelectionPatch } from "@/components/video-settings-panel";
import { buildInputEvidence } from "@/lib/canvas/canvas-generation-helpers";
import { getConfiguredAutodlWorkflow } from "@/lib/canvas/autodl-generation-input";
import { CapabilityModelPicker } from "@/components/managed-model-picker";
import { useConfigStore, useEffectiveConfig, modelOptionName, type AiConfig } from "@/stores/use-config-store";
import { audioConfigPatch, audioOverrideKeys, buildNodeConfig, clearMetadataPatch, hasMetadataOverride, imageOverrideKeys, textOverrideKeys, videoConfigPatch, videoOverrideKeys } from "@/lib/canvas/node-config";
import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover } from "./canvas-audio-settings-popover";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import { ghostModelPickerClass, ghostSettingsButtonClass } from "./canvas-node-prompt-panel";
import type { NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import type { CanvasGenerationMode, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export type ConfigInputSummary = { textCount: number; imageCount: number; videoCount: number; audioCount: number };

type CanvasConfigNodePanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    inputs: NodeGenerationInput[];
    inputSummary: ConfigInputSummary;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onGenerate: (nodeId: string) => void;
    onStop: (nodeId: string) => void;
    onComposerToggle: () => void;
};

const MODES: Array<{ value: CanvasGenerationMode; icon: typeof ImageIcon; labelKey: string }> = [
    { value: "image", icon: ImageIcon, labelKey: "canvas.configNode.image" },
    { value: "text", icon: MessageSquare, labelKey: "canvas.configNode.text" },
    { value: "video", icon: Video, labelKey: "canvas.configNode.video" },
    { value: "audio", icon: Music2, labelKey: "canvas.configNode.audio" },
];

const MODE_OVERRIDE_KEYS = { image: imageOverrideKeys, text: textOverrideKeys, video: videoOverrideKeys, audio: audioOverrideKeys } as const;

const EVIDENCE_GROUP_LABEL_KEYS = { image: "canvas.configNode.references", video: "canvas.configNode.videoReferences", audio: "canvas.configNode.audioReferences" } as const;

const REFERENCE_TILE_LIMIT = 3;

/** CTA 缺输入原因 key：video workflow 优先按第一个未满足的必填槽位，其余按模式给通用文案。 */
export function missingReasonKey(mode: CanvasGenerationMode, workflow: { media: readonly { kind: string; required?: boolean }[] } | undefined, inputSummary: ConfigInputSummary): string {
    const missingSlot = workflow?.media
        .filter((slot) => slot.required)
        .find((slot) => {
            const index = workflow.media.filter((item) => item.kind === slot.kind).indexOf(slot);
            return inputSummary[`${slot.kind}Count` as keyof ConfigInputSummary] <= index;
        });
    if (mode === "video" && missingSlot) {
        const slotKeys = { image: "canvas.configNode.missingSlotImage", video: "canvas.configNode.missingSlotVideo", audio: "canvas.configNode.missingSlotAudio", text: "canvas.configNode.missingSlotText" } as const;
        return slotKeys[missingSlot.kind as keyof typeof slotKeys];
    }
    const modeKeys = { image: "canvas.configNode.missingReason.image", text: "canvas.configNode.missingReason.text", video: "canvas.configNode.missingReason.video", audio: "canvas.configNode.missingReason.audio" } as const;
    return modeKeys[mode];
}

export function CanvasConfigNodePanel({ node, isRunning, inputs, inputSummary, onConfigChange, onGenerate, onStop, onComposerToggle }: CanvasConfigNodePanelProps) {
    const { t } = useTranslation();
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = node.metadata?.generationMode || "image";
    const config = buildNodeConfig(globalConfig, node, mode);
    const evidence = buildInputEvidence(inputs, mode);
    const composerText = node.metadata?.composerContent ?? node.metadata?.prompt ?? "";
    const promptText = composerText.trim() ? composerText : evidence.textPreview;
    const hasAnyInput = Boolean(inputSummary.textCount || inputSummary.imageCount || inputSummary.videoCount || inputSummary.audioCount);
    const hasComposerContent = Boolean(composerText.trim());
    const workflow = mode === "video" ? getConfiguredAutodlWorkflow(config) : undefined;
    const hasRequiredMedia = workflow?.media.filter(slot => slot.required).every(slot => {
        const index = workflow.media.filter(item => item.kind === slot.kind).indexOf(slot);
        return inputSummary[`${slot.kind}Count` as keyof ConfigInputSummary] > index;
    });
    const canGenerate = workflow && !workflow.prompt ? hasRequiredMedia : hasComposerContent || (mode === "audio" ? inputSummary.textCount > 0 : hasAnyInput);
    // 创建节点会预置 size/count/model（与创建时全局一致）；覆盖点按「值偏离当前全局默认」显示，避免新节点天生带点。「重置参数」仍按键存在性。
    const defaultSideConfig = buildNodeConfig(globalConfig, { ...node, metadata: undefined }, mode);
    const OVERRIDE_COMPARE_CONFIG_KEYS = { seconds: "videoSeconds" } as const;
    const hasOverride = MODE_OVERRIDE_KEYS[mode].some((key) => {
        if (node.metadata?.[key as keyof CanvasNodeMetadata] === undefined) return false;
        const configKey = (OVERRIDE_COMPARE_CONFIG_KEYS[key as keyof typeof OVERRIDE_COMPARE_CONFIG_KEYS] ?? key) as keyof AiConfig;
        return config[configKey] !== defaultSideConfig[configKey];
    });

    const [elapsed, setElapsed] = useState(0);
    useEffect(() => {
        if (!isRunning) {
            setElapsed(0);
            return;
        }
        const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
        return () => window.clearInterval(timer);
    }, [isRunning]);

    const ctaLabel = isRunning
        ? t("canvas.configNode.running", { seconds: elapsed })
        : mode === "image"
            ? t("canvas.configNode.generateImage", { count: config.count })
            : t(mode === "video" ? "canvas.configNode.generateVideo" : mode === "text" ? "canvas.configNode.generateText" : "canvas.configNode.generateAudio");

    const popoverTriggerClassName = ghostSettingsButtonClass;

    return (
        <div className="canvas-config-panel flex h-full w-full cursor-move flex-col px-3 pb-3 pt-7 text-sm" style={{ color: theme.node.text }} onWheel={(event) => event.stopPropagation()}>
            <div className="cfg-row mb-2 flex items-center justify-between gap-2" style={{ "--i": 0 } as CSSProperties}>
                <div className="shrink-0 text-xs font-semibold">{t("canvas.configNode.title")}</div>
                <ModeRail mode={mode} theme={theme} onChange={(value) => onConfigChange(node.id, { generationMode: value })} />
            </div>

            <div className="cfg-row mb-1 flex items-center gap-1.5 px-2 py-[7px]" style={{ "--i": 1 } as CSSProperties} onMouseDown={(event) => event.stopPropagation()}>
                <MessageSquare className="size-[13px] shrink-0" style={{ color: theme.node.faint }} />
                <span className="min-w-0 flex-1 truncate text-[11.5px] leading-[1.45]" style={promptText ? undefined : { color: theme.node.faint, opacity: 0.8 }}>
                    {promptText || t("canvas.configNode.noPrompt")}
                </span>
                <button
                    type="button"
                    title={t("canvas.configNode.compose")}
                    aria-label={t("canvas.configNode.compose")}
                    onClick={onComposerToggle}
                    className="grid size-[22px] shrink-0 cursor-pointer place-items-center rounded-[7px] transition-colors hover:bg-[var(--cfg-hover)]"
                    style={{ color: theme.node.faint, "--cfg-hover": theme.toolbar.itemHover } as CSSProperties}
                >
                    <Pencil className="size-3" />
                </button>
            </div>

            {evidence.groups.length > 0 && (
                <div className="cfg-row mb-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 px-2 pb-1.5" style={{ "--i": 2 } as CSSProperties}>
                    {evidence.groups.map((group) => (
                        <span key={group.kind} className="inline-flex items-center gap-1.5">
                            <span className="text-[10.5px]" style={{ color: theme.node.faint }}>
                                {t(EVIDENCE_GROUP_LABEL_KEYS[group.kind])}
                            </span>
                            {group.items.length === 0 ? (
                                <span className="text-[10.5px] opacity-60" style={{ color: theme.node.faint }}>
                                    {t("canvas.configNode.notConnected")}
                                </span>
                            ) : (
                                <span className="inline-flex items-center">
                                    {group.items.slice(0, REFERENCE_TILE_LIMIT).map((item, index) => (
                                        <span
                                            key={item.nodeId}
                                            title={item.title}
                                            className={`inline-flex size-[22px] items-center justify-center overflow-hidden rounded-md border-[1.5px] ${index > 0 ? "-ml-[7px]" : ""}`}
                                            style={{ borderColor: theme.node.fill, background: theme.node.panel, color: theme.node.muted }}
                                        >
                                            <EvidenceTile kind={group.kind} previewUrl={item.previewUrl} />
                                        </span>
                                    ))}
                                    {group.items.length > REFERENCE_TILE_LIMIT && (
                                        <span className="ml-1 text-[10px] tabular-nums" style={{ color: theme.node.muted }}>
                                            {t("canvas.configNode.moreReferences", { count: group.items.length - REFERENCE_TILE_LIMIT })}
                                        </span>
                                    )}
                                </span>
                            )}
                        </span>
                    ))}
                </div>
            )}

            <div className="cfg-row" style={{ "--i": 3 } as CSSProperties} onMouseDown={(event) => event.stopPropagation()}>
                <div className="h-px" style={{ background: theme.node.stroke }} />
                <div className="mt-1 flex items-center gap-1">
                    <CapabilityModelPicker
                        className={`${ghostModelPickerClass} flex-1`}
                        config={config}
                        value={config.model}
                        nodeModel={node.metadata?.model}
                        currentLabel={config.model ? modelOptionName(config.model) : undefined}
                        onChange={(model) => onConfigChange(node.id, mode === "video" ? (falModelSelectionPatch(config, model, node.metadata) || videoModelSelectionPatch(config, model)) : (falModelSelectionPatch(config, model, node.metadata) || { model }))}
                        capability={mode}
                        onMissingConfig={() => openConfigDialog(true)}
                    />
                    {hasOverride && (
                        <span data-testid="config-override-dot" title={t("canvas.configNode.overrideTitle")} className="size-[5px] shrink-0 rounded-full" style={{ background: "var(--warning)" }} />
                    )}
                    {mode === "video" ? (
                        <CanvasVideoSettingsPopover config={config} providerOptions={node.metadata?.providerOptions} onMetadataChange={(patch) => onConfigChange(node.id, patch)} placement="topRight" buttonClassName={popoverTriggerClassName} onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))} isOverridden={hasMetadataOverride(node.metadata, videoOverrideKeys)} onResetOverrides={() => onConfigChange(node.id, clearMetadataPatch(videoOverrideKeys))} />
                    ) : mode === "image" ? (
                        <CanvasImageSettingsPopover config={config} providerOptions={node.metadata?.providerOptions} onMetadataChange={(patch) => onConfigChange(node.id, patch)} placement="topRight" autoAdjustOverflow={false} buttonClassName={popoverTriggerClassName} onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })} isOverridden={hasMetadataOverride(node.metadata, imageOverrideKeys)} onResetOverrides={() => onConfigChange(node.id, clearMetadataPatch(imageOverrideKeys))} />
                    ) : mode === "audio" ? (
                        <CanvasAudioSettingsPopover config={config} placement="topRight" buttonClassName={popoverTriggerClassName} onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} isOverridden={hasMetadataOverride(node.metadata, audioOverrideKeys)} onResetOverrides={() => onConfigChange(node.id, clearMetadataPatch(audioOverrideKeys))} />
                    ) : (
                        <CanvasTextSettingsPopover config={config} count={node.metadata?.textCount || 1} placement="topRight" buttonClassName={popoverTriggerClassName} onConfigChange={(_, value) => onConfigChange(node.id, { reasoningEffort: value })} onCountChange={(textCount) => onConfigChange(node.id, { textCount })} isOverridden={hasMetadataOverride(node.metadata, textOverrideKeys)} onResetOverrides={() => onConfigChange(node.id, clearMetadataPatch(textOverrideKeys))} />
                    )}
                </div>
            </div>

            <div className="cfg-row mt-auto" style={{ "--i": 4 } as CSSProperties}>
                <button
                    type="button"
                    disabled={!isRunning && !canGenerate}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={() => (isRunning ? onStop(node.id) : onGenerate(node.id))}
                    className={`relative flex h-[34px] w-full cursor-pointer items-center justify-center gap-1.5 overflow-hidden rounded-[10px] text-[12.5px] transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100 ${isRunning || canGenerate ? "font-medium" : "border border-dashed font-normal"}`}
                    style={isRunning || canGenerate ? { background: theme.canvas.selectionStroke, color: theme.canvas.background } : { borderColor: theme.node.stroke, color: theme.node.faint }}
                >
                    {isRunning && (
                        <span aria-hidden className="cfg-shimmer cfg-shimmer-animated" style={{ background: `linear-gradient(100deg, transparent 30%, color-mix(in srgb, ${theme.canvas.background} 22%, transparent) 50%, transparent 70%)` }} />
                    )}
                    {isRunning ? (
                        <>
                            <Square className="size-3 fill-current" />
                            <span>{t("canvas.configNode.running", { seconds: elapsed })}</span>
                        </>
                    ) : (
                        <>
                            <Play className="size-3.5" />
                            <span>{ctaLabel}</span>
                        </>
                    )}
                </button>
                {!isRunning && !canGenerate && (
                    <div className="mt-1.5 text-center text-[10.5px]" style={{ color: theme.node.faint }}>
                        {t(missingReasonKey(mode, workflow, inputSummary))}
                    </div>
                )}
            </div>
        </div>
    );
}

function ModeRail({ mode, theme, onChange }: { mode: CanvasGenerationMode; theme: CanvasTheme; onChange: (mode: CanvasGenerationMode) => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-0.5" onMouseDown={(event) => event.stopPropagation()}>
            {MODES.map((item) => {
                const active = item.value === mode;
                const Icon = item.icon;
                return (
                    <button
                        key={item.value}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onChange(item.value)}
                        className={`inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[11.5px] transition-colors ${active ? "font-medium" : "hover:bg-[var(--cfg-hover)]"}`}
                        style={active ? { background: theme.toolbar.activeBg, color: theme.toolbar.activeText } : { color: theme.node.muted, "--cfg-hover": theme.toolbar.itemHover } as CSSProperties}
                    >
                        <Icon className="size-[13px]" />
                        <span>{t(item.labelKey)}</span>
                    </button>
                );
            })}
        </div>
    );
}

function EvidenceTile({ kind, previewUrl }: { kind: "image" | "video" | "audio"; previewUrl?: string }) {
    if (kind === "image" && previewUrl) return <img src={previewUrl} alt="" className="size-full object-cover" />;
    if (kind === "video") return <Video className="size-3" />;
    if (kind === "audio") return <Music2 className="size-3" />;
    return <ImageIcon className="size-3" />;
}
