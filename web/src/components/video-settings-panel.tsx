import { FalGenerationSettings } from "@/components/canvas/fal-generation-settings";
import { configuredFalProfile } from "@/lib/canvas/fal-settings";
import type { ProviderOptions } from "@/lib/models/provider-options";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { cn } from "@/lib/utils";
import { getConfiguredAutodlWorkflow } from "@/lib/canvas/autodl-generation-input";
import { OptionPill, QuickPillRow, SettingGroup } from "@/components/ui/settings-controls";
import { GenerationDefaultsFooter } from "@/components/generation-defaults-footer";
import { useConfigStore } from "@/stores/use-config-store";
import type { CanvasNodeMetadata } from "@/types/canvas";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { type AiConfig } from "@/stores/use-config-store";

const resolutionOptions = [
    { value: "720", label: "720p" },
    { value: "480", label: "480p" },
];

const sizeOptions = [
    { value: "1280x720", labelKey: "landscape", width: 1280, height: 720 },
    { value: "720x1280", labelKey: "portrait", width: 720, height: 1280 },
    { value: "1024x1024", labelKey: "square", width: 1024, height: 1024 },
    { value: "1792x1024", labelKey: "widescreen", width: 1792, height: 1024 },
    { value: "1024x1792", labelKey: "tall", width: 1024, height: 1792 },
    { value: "auto", labelKey: "auto", width: 0, height: 0 },
];

const secondOptions = [6, 10, 12, 16, 20];

export const videoResolutionOptions = resolutionOptions.map((item) => ({ value: item.value, label: item.label }));
export const videoSizeOptions = sizeOptions.map((item) => ({ value: item.value, get label() { return i18n.t(`settingsPanels.video.sizes.${item.labelKey}`); } }));
export const videoSecondOptions = secondOptions.map((value) => String(value));

type VideoSettingsPanelProps = {
    config: AiConfig;
    providerOptions?: ProviderOptions;
    onMetadataChange?: (patch: Partial<CanvasNodeMetadata>) => void;
    onConfigChange: (key: "vquality" | "size" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    isOverridden?: boolean;
    onResetOverrides?: () => void;
};

/** 生视频设置（通用分支骨架：画幅→画质→时长→默认 footer；D9/D11/D12/D20）。 */
export function VideoSettingsPanel({ config, providerOptions, onMetadataChange, onConfigChange, theme, showTitle = false, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", isOverridden = false, onResetOverrides }: VideoSettingsPanelProps) {
    const { t } = useTranslation();
    const defaults = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const workflow = getConfiguredAutodlWorkflow(config);
    const seconds = config.videoSeconds || (workflow?.duration ? String(workflow.duration.default) : "6");
    const size = normalizeVideoSizeValue(config.size);
    const dimensions = readSizeDimensions(size);
    const resolution = normalizeVideoResolutionValue(config.vquality);
    const updateDimension = (key: "width" | "height", value: number | null) => {
        const next = Math.max(1, Math.floor(value || dimensions[key] || 720));
        onConfigChange("size", `${key === "width" ? next : dimensions.width}x${key === "height" ? next : dimensions.height}`);
    };

    const profile = configuredFalProfile(config);
    if (profile) return <div className={cn("text-foreground", className)} onMouseDown={event => event.stopPropagation()}>
        {showTitle ? <div className="text-lg font-semibold">{t("fal.settings.parameters")}</div> : null}
        <FalGenerationSettings profile={profile} config={config} options={providerOptions} onChange={patch => {
            if (onMetadataChange) onMetadataChange(patch);
            else for (const [key, value] of Object.entries(patch)) if (typeof value === "string") onConfigChange(({ seconds: "videoSeconds", generateAudio: "videoGenerateAudio" }[key] || key) as Parameters<typeof onConfigChange>[0], value);
        }} />
    </div>;

    if (workflow) {
        const error = autodlVideoSettingsError(config);
        const duration = workflow.duration;
        return <div className={cn("text-foreground", className)} onMouseDown={(event) => event.stopPropagation()}>
            {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.video.title")}</div> : null}
            <SettingGroup title={t("settingsPanels.video.quality")}>
                <div className="grid grid-cols-2 gap-2">
                    {workflow.resolution.options.map(value => <OptionPill key={value} selected={(config.vquality || workflow.resolution.default) === value} onClick={() => onConfigChange("vquality", value)}>{value}</OptionPill>)}
                </div>
            </SettingGroup>
            {duration ? <SettingGroup title={t(duration.field === "audio_duration" ? "autodlGeneration.audioDuration" : "settingsPanels.video.seconds")}>
                <QuickPillRow
                    values={[5, 10, 15].filter(value => value >= duration.min && value <= duration.max)}
                    value={Number(seconds) || duration.default}
                    format={(v) => `${v}s`}
                    min={duration.min}
                    max={duration.max}
                    parse={(s) => { const n = duration.integer ? Math.floor(Number(s)) : Number(s); return Number.isFinite(n) ? Math.max(duration.min, Math.min(duration.max, n)) : null; }}
                    onChange={(v) => onConfigChange("videoSeconds", String(v))}
                />
            </SettingGroup> : <p className="text-xs text-muted-foreground">{t("autodlGeneration.workflowDuration")}</p>}
            {!workflow.prompt ? <p className="text-xs text-muted-foreground">{t("autodlGeneration.promptUnused")}</p> : null}
            {workflow.media.length ? <SettingGroup title={t("autodlGeneration.requirements")}>
                <ul className="space-y-1 text-xs">
                    {workflow.media.map(slot => {
                        const index = workflow.media.filter(item => item.kind === slot.kind).indexOf(slot) + 1;
                        const label = slot.field === "first_frame" ? t("autodlGeneration.firstFrame") : slot.field === "last_frame" ? t("autodlGeneration.lastFrame") : t(`autodlGeneration.${slot.kind}`, { index });
                        return <li key={slot.field}>{label} · {t(slot.required ? "autodlGeneration.required" : "autodlGeneration.optional")}</li>;
                    })}
                </ul>
            </SettingGroup> : null}
            {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        </div>;
    }

    return (
        <div className={cn("text-foreground", className)} onMouseDown={(event) => event.stopPropagation()}>
            <SettingGroup title={t("settingsPanels.video.ratio")}>
                <div className="grid grid-cols-3 gap-2">
                    {sizeOptions.map((item) => {
                        const label = t(`settingsPanels.video.sizes.${item.labelKey}`);
                        return (
                            <button
                                key={item.value}
                                type="button"
                                className={cn("flex h-11 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-[10px] border bg-transparent text-[12.5px] transition hover:opacity-80", size === item.value && "border-foreground border-[1.5px]")}
                                style={{ borderColor: size === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => onConfigChange("size", item.value)}
                            >
                                <span>{label}</span>
                                <span className="text-[10px] text-muted-foreground">{item.value === "auto" ? t("settingsPanels.video.autoHint") : item.value.replace("x", "×")}</span>
                            </button>
                        );
                    })}
                </div>
                {size !== "auto" && !sizeOptions.some((item) => item.value === size) ? (
                    <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                        <DimensionInput prefix="W" value={dimensions.width} theme={theme} onChange={(value) => updateDimension("width", value)} />
                        <span className="text-lg opacity-45">↔</span>
                        <DimensionInput prefix="H" value={dimensions.height} theme={theme} onChange={(value) => updateDimension("height", value)} />
                    </div>
                ) : null}
            </SettingGroup>
            <SettingGroup title={t("settingsPanels.video.quality")}>
                <div className="grid grid-cols-4 gap-2">
                    {resolutionOptions.map((item) => (
                        <OptionPill key={item.value} selected={resolution === item.value} onClick={() => onConfigChange("vquality", item.value)}>
                            {item.label}
                        </OptionPill>
                    ))}
                </div>
            </SettingGroup>
            <SettingGroup title={t("settingsPanels.video.seconds")}>
                <QuickPillRow
                    values={secondOptions}
                    value={Number(seconds) || 6}
                    format={(v) => `${v}s`}
                    min={1}
                    max={20}
                    parse={(s) => { const n = Math.floor(Number(s)); return Number.isFinite(n) ? Math.max(1, Math.min(20, n)) : null; }}
                    onChange={(v) => onConfigChange("videoSeconds", String(v))}
                />
            </SettingGroup>
            <GenerationDefaultsFooter
                typeName={t("settingsPanels.model.capabilities.video")}
                summary={`${videoResolutionLabel(resolution)} · ${videoSizeLabel(size)} · ${videoSecondsLabel(seconds)}`}
                canSet={(() => {
                    const same = (config.vquality || "720") === (defaults.vquality || "720") && (config.size || "1280x720") === (defaults.size || "1280x720") && (config.videoSeconds || "6") === (defaults.videoSeconds || "6");
                    return !same;
                })()}
                canReset={isOverridden}
                onSetDefault={() => {
                    updateConfig("vquality", config.vquality || "720");
                    updateConfig("size", config.size || "1280x720");
                    updateConfig("videoSeconds", config.videoSeconds || "6");
                }}
                onReset={onResetOverrides || (() => {})}
            />
        </div>
    );
}

export function videoResolutionLabel(value: string) {
    if (/p[竖横(]|px\(/.test(value)) return value;
    return `${normalizeVideoResolutionValue(value)}p`;
}

export function videoSizeLabel(value: string) {
    if (value === "adaptive" || value === "auto") return i18n.t("settingsPanels.video.adaptive");
    const size = normalizeVideoSizeValue(value);
    const option = sizeOptions.find((item) => item.value === size);
    return option ? i18n.t(`settingsPanels.video.sizes.${option.labelKey}`) : size;
}

export function videoSecondsLabel(value: string) {
    if (String(value).trim() === "-1") return i18n.t("settingsPanels.video.smart");
    return `${value || "6"}s`;
}

export function normalizeVideoSizeValue(value: string) {
    if (value === "auto") return "auto";
    if (/^\d+x\d+$/.test(value || "")) return value;
    return ["9:16", "2:3", "3:4"].includes(value) ? "720x1280" : "1280x720";
}

export function normalizeVideoResolutionValue(value: string) {
    if (value === "480p" || value === "low") return "480";
    if (value === "720p" || value === "auto" || value === "high" || value === "medium") return "720";
    return value.replace(/p$/i, "") || "720";
}

function DimensionInput({ prefix, value, theme, onChange }: { prefix: string; value: number; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    const commit = (input: HTMLInputElement) => {
        const next = Math.max(1, Math.floor(Number(input.value) || value || 720));
        input.value = String(next);
        onChange(next);
    };

    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input
                type="number"
                min={1}
                className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                defaultValue={value || ""}
                key={`${prefix}-${value}`}
                onBlur={(event) => commit(event.currentTarget)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function readSizeDimensions(size: string) {
    if (size === "auto") return { width: 0, height: 0 };
    const match = size.match(/^(\d+)x(\d+)$/);
    return { width: Number(match?.[1]) || 1280, height: Number(match?.[2]) || 720 };
}

/** Apply defaults only during an explicit model selection; never rewrite a loaded node. */
export function videoModelSelectionPatch(config: AiConfig, model: string): Partial<CanvasNodeMetadata> {
    const workflow = getConfiguredAutodlWorkflow({ ...config, model });
    if (!workflow) return { model };
    const duration = Number(config.videoSeconds);
    return {
        model,
        vquality: workflow.resolution.options.includes(config.vquality) ? config.vquality : workflow.resolution.default,
        ...(workflow.duration ? { seconds: config.videoSeconds.trim() && Number.isFinite(duration) && duration >= workflow.duration.min && duration <= workflow.duration.max && (!workflow.duration.integer || Number.isInteger(duration)) ? config.videoSeconds : String(workflow.duration.default) } : {}),
    };
}

export function autodlVideoSettingsError(config: AiConfig): string | undefined {
    const workflow = getConfiguredAutodlWorkflow(config);
    if (!workflow) return;
    if (config.vquality && !workflow.resolution.options.includes(config.vquality)) return i18n.t("autodlGeneration.invalidResolution");
    if (workflow.duration && config.videoSeconds) {
        const value = Number(config.videoSeconds);
        if (!config.videoSeconds.trim() || !Number.isFinite(value) || value < workflow.duration.min || value > workflow.duration.max || (workflow.duration.integer && !Number.isInteger(value))) {
            return i18n.t("autodlGeneration.invalidDuration", { min: workflow.duration.min, max: workflow.duration.max, integer: workflow.duration.integer ? i18n.t("autodlGeneration.integer") : "" });
        }
    }
}
