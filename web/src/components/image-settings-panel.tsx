import type { CanvasNodeMetadata } from "@/types/canvas";
import { FalGenerationSettings } from "@/components/canvas/fal-generation-settings";
import { configuredFalProfile } from "@/lib/canvas/fal-settings";
import type { ProviderOptions } from "@/lib/models/provider-options";
import { useEffect, useState } from "react";
import { Switch } from "antd";
import { useTranslation } from "react-i18next";

import { MANAGED_SPEC_RATIOS } from "@/services/api/image";

import i18n from "@/i18n";
import { cn } from "@/lib/utils";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { OptionPill, SettingGroup, QuickPillRow } from "@/components/ui/settings-controls";
import { GenerationDefaultsFooter } from "@/components/generation-defaults-footer";
import { useManagedCatalog } from "@/lib/desktop/use-managed-catalog";
import type { ManagedCatalogSnapshot } from "@/lib/desktop/managed-catalog-cache";
import type { ManagedModelDescriptor } from "@/lib/desktop/managed-model-types";
import { useConfigStore, credentialModeFor } from "@/stores/use-config-store";
import type { AiConfig } from "@/stores/use-config-store";

const qualityOptions = [
    { value: "auto", tier: "" },
    { value: "low", tier: "1K" },
    { value: "medium", tier: "2K" },
    { value: "high", tier: "4K" },
];
const DIMENSION_STEP = 16;
const DEFAULT_SHORT_SIDE = 1024;
/** 与 services/api/image.ts 的 QUALITY_BASE 对齐：质量档位就是分辨率档位（spec v3 §4.1）。 */
const QUALITY_BASE: Record<string, number> = { low: 1024, medium: 2048, high: 2880 };

const aspectOptions = [
    { value: "1:1", label: "1:1", width: 1024, height: 1024, icon: "square" },
    { value: "3:2", label: "3:2", width: 1536, height: 1024, icon: "landscape" },
    { value: "2:3", label: "2:3", width: 1024, height: 1536, icon: "portrait" },
    { value: "4:3", label: "4:3", width: 1360, height: 1024, icon: "landscape" },
    { value: "3:4", label: "3:4", width: 1024, height: 1360, icon: "portrait" },
    { value: "16:9", label: "16:9", width: 1824, height: 1024, icon: "landscape" },
    { value: "9:16", label: "9:16", width: 1024, height: 1824, icon: "portrait" },
    { value: "1:1-2k", label: "1:1(2k)", size: "2048x2048", width: 2048, height: 2048, icon: "square" },
    { value: "16:9-2k", label: "16:9(2k)", size: "2048x1152", width: 2048, height: 1152, icon: "landscape" },
    { value: "9:16-2k", label: "9:16(2k)", size: "1152x2048", width: 1152, height: 2048, icon: "portrait" },
    { value: "16:9-4k", label: "16:9(4k)", size: "3840x2160", width: 3840, height: 2160, icon: "landscape" },
    { value: "9:16-4k", label: "9:16(4k)", size: "2160x3840", width: 2160, height: 3840, icon: "portrait" },
    { value: "auto", label: "auto", width: 0, height: 0, icon: "auto" },
];
const ratioTiles = aspectOptions.filter((item) => item.icon === "auto" || !item.label.includes("("));
/** 托管回退路径只能表达设计固定的比例子集：AUTO 与自定义 W×H 在托管线路上无对应键。 */
const managedFallbackRatioItems = ratioTiles.filter((item) => item.value !== "auto" && (MANAGED_SPEC_RATIOS as readonly string[]).includes(item.value));

type RatioTile = (typeof aspectOptions)[number];
/** 托管档位词表固定（spec §5.2/§5.3）：未声明的档位灰置并给出原因，而不是凭空消失。 */
const MANAGED_TIER_ORDER = ["1K", "2K", "4K"];
const MANAGED_QUALITY_ORDER = ["standard", "fine", "ultra"];

/**
 * 与请求路径 `resolveManagedModelForCapability` 同构：偏好命中优先，否则取该能力目录首项。
 * 目录未水合（null）或读取失败时返回 undefined，调用方回退全局表格。
 */
function resolveManagedImageModel(config: AiConfig, catalog: ManagedCatalogSnapshot | null): ManagedModelDescriptor | undefined {
    if (!catalog || catalog.status === "error" || !catalog.models.length) return undefined;
    // 托管图片分派器按 model.execution 选适配器（direct→openai.image，remote_task→shotshot.managed-image），
    // 两类模型都可执行，因此都按其 spec 渲染面板。
    const available = catalog.models.filter((model) => model.capability === "image");
    return available.find((model) => model.id === config.managedModels.image) ?? available[0];
}

/** 声明的比例按目录顺序映射到既有 ratio tile；固定子集之外的比例兜底成通用方形块，不丢选项。 */
function managedRatioTile(ratio: string): RatioTile {
    return aspectOptions.find((item) => item.icon !== "auto" && item.value === ratio)
        ?? { value: ratio, label: ratio, width: 1024, height: 1024, icon: "square" };
}

/** 已知质量 token 走 i18n；声明但词表之外的 token 原样渲染，绝不静默消失。 */
function managedAxisLabel(value: string, axis: "resolutions" | "qualities"): string {
    return axis === "qualities" && MANAGED_QUALITY_ORDER.includes(value) ? i18n.t(`settingsPanels.common.${value}`) : value;
}

export const imageQualityOptions = qualityOptions.map((item) => ({ value: item.value, get label() { return i18n.t(`settingsPanels.common.${item.value}`); } }));
export const imageAspectOptions = aspectOptions.map((item) => ({ value: item.size || item.value, label: item.label }));

type ImageSettingsPanelProps = {
    config: AiConfig;
    providerOptions?: ProviderOptions;
    onMetadataChange?: (patch: Partial<CanvasNodeMetadata>) => void;
    onConfigChange: (key: "quality" | "size" | "count" | "background", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    maxCount?: number;
    /** 数量锁定（资产参考图场景）：数量区渲染为不可改的单「1 张」说明，config.count 恒按 1 处理。 */
    countLocked?: boolean;
    isOverridden?: boolean;
    onResetOverrides?: () => void;
};

/** 生图设置（spec v3 §4.1 骨架：形态→档位→数量→输出选项→默认 footer；D8-D13）。 */
export function ImageSettingsPanel({ config, providerOptions, onMetadataChange, onConfigChange, theme, showTitle, className = "w-[320px] space-y-2.5 rounded-2xl px-1 py-0.5", maxCount = 15, countLocked = false, isOverridden = false, onResetOverrides }: ImageSettingsPanelProps) {
    const { t } = useTranslation();
    const defaults = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const [customOpen, setCustomOpen] = useState(false);
    const [snapDimensionToStep, setSnapDimensionToStep] = useState(true);
    const profile = configuredFalProfile(config);
    const quality = config.quality || "auto";
    const count = countLocked ? 1 : Math.max(1, Math.min(maxCount, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = config.size || "auto";
    const transparentBackground = config.background === "transparent";
    const selectedAspect = aspectOptions.find((item) => (item.size || item.value) === activeSize || item.value === activeSize);
    const isCustomSize = activeSize !== "auto" && !selectedAspect;
    const dimensions = readSizeDimensions(activeSize, quality, selectedAspect || aspectOptions[0]);

    // —— 托管图片：按所选模型的 spec 决定渲染哪些轴（请求路径用同一模型解析，二者必须一致）——
    const managedCatalog = useManagedCatalog();
    const managed = credentialModeFor(config, "image") === "shotshot";
    const managedModel = managed ? resolveManagedImageModel(config, managedCatalog) : undefined;
    const managedSpec = managedModel?.spec;
    // 空 spec（无任何轴取值）等同「无规格」：回退全局表格，避免空面板。
    const specDriven = Boolean(managedSpec && (managedSpec.aspectRatios?.length || managedSpec.resolutions?.length || managedSpec.qualities?.length));
    const twoAxes = Boolean(managedSpec?.resolutions?.length && managedSpec.qualities?.length);
    // 托管回退（无 spec）只能列设计固定子集：AUTO/自定义 W×H 在托管线路上无法表达。
    const ratioItems = specDriven ? (managedSpec?.aspectRatios ?? []).map(managedRatioTile) : managed ? managedFallbackRatioItems : ratioTiles;
    // 轴与取值未声明即不渲染该控件；两轴并存时整体不可用（请求侧会抛错，UI 不能假装可选）。
    const showRatioGroup = !twoAxes && (!specDriven || ratioItems.length > 0);
    const secondAxis: "global" | "resolutions" | "qualities" | "none" = !specDriven
        ? "global"
        : twoAxes
            ? "none"
            : managedSpec?.resolutions?.length
                ? "resolutions"
                : managedSpec?.qualities?.length
                    ? "qualities"
                    : "none";
    // 第二轴的渲染集合：声明值必须全部出现（按声明顺序），固定词表中未声明的已知值仍灰置展示。
    const axisVocabulary = secondAxis === "resolutions" ? MANAGED_TIER_ORDER : secondAxis === "qualities" ? MANAGED_QUALITY_ORDER : [];
    const declaredAxisValues = secondAxis === "resolutions" ? managedSpec?.resolutions ?? [] : secondAxis === "qualities" ? managedSpec?.qualities ?? [] : [];
    const undeclaredAxisValues = axisVocabulary.filter((value) => !declaredAxisValues.includes(value));
    const axisValues = [...declaredAxisValues, ...undeclaredAxisValues];
    // 已知但未声明的档位：灰置 + 可见原因（disabled 元素的原生 title 在多数浏览器不弹出）。
    const unavailableAxisLabels = undeclaredAxisValues.map((value) => managedAxisLabel(value, secondAxis === "qualities" ? "qualities" : "resolutions"));

    // Finding A：模型声明了唯一第二轴时，config.quality 必须落在声明集合内，否则请求侧会以「裸比例无定价行」拒绝。
    // 面板拥有选择权：把缺失/未声明的值补写为第一个声明值，让面板选中态与请求键按构造一致（不是仅渲染选中）。
    const declaredAxisKey = declaredAxisValues.join("|");
    useEffect(() => {
        if (!declaredAxisValues.length) return;
        if (declaredAxisValues.includes(quality)) return;
        onConfigChange("quality", declaredAxisValues[0]!);
        // declaredAxisKey 已覆盖 declaredAxisValues 的内容依赖。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [declaredAxisKey, quality]);

    if (profile) {
        return (
            <div className={cn("text-foreground", className)} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">{t("fal.settings.parameters")}</div> : null}
                <FalGenerationSettings profile={profile} config={config} options={providerOptions} onChange={(patch) => {
                    if (onMetadataChange) onMetadataChange(patch);
                    else for (const [key, value] of Object.entries(patch)) if (typeof value === "string") onConfigChange(({ seconds: "videoSeconds", generateAudio: "videoGenerateAudio" }[key] || key) as Parameters<typeof onConfigChange>[0], value);
                }} />
            </div>
        );
    }

    const sameAsDefault =
        quality === (defaults.quality || "auto") &&
        activeSize === (defaults.size || "1:1") &&
        config.background === (defaults.background || "") &&
        count === Math.max(1, Math.min(15, Math.floor(Number(defaults.canvasImageCount) || 1)));
    const handleSetDefault = () => {
        updateConfig("quality", quality);
        updateConfig("size", activeSize);
        updateConfig("background", config.background);
        updateConfig("canvasImageCount", String(count));
    };
    const disclosureOpen = customOpen || isCustomSize;

    return (
        <div
            className={cn("text-foreground", className)}
            onMouseDown={(event) => {
                event.stopPropagation();
                if (event.target instanceof HTMLInputElement) return;
                if (document.activeElement instanceof HTMLInputElement && event.currentTarget.contains(document.activeElement)) document.activeElement.blur();
            }}
        >
            {showRatioGroup ? (
                <SettingGroup title={t("settingsPanels.image.size")}>
                    <div className="grid grid-cols-4 gap-2">
                        {ratioItems.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className={cn("flex h-12 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-[10px] border bg-transparent text-xs transition hover:opacity-80", selectedAspect?.value === item.value && "border-foreground border-[1.5px]")}
                                style={{ borderColor: selectedAspect?.value === item.value ? theme.node.text : theme.node.stroke, background: "transparent", color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => onConfigChange("size", item.size || item.value)}
                            >
                                {item.icon === "auto" ? <span className="text-[10px] opacity-60 tracking-wide">AUTO</span> : <AspectIcon type={item.icon} width={item.width} height={item.height} color={theme.node.text} />}
                                <span>{item.label}</span>
                            </button>
                        ))}
                    </div>
                    {specDriven || managed ? null : activeSize === "auto" ? (
                        <p className="mt-1.5 text-[11.5px] text-muted-foreground">{t("settingsPanels.image.modelDecidesSize")}</p>
                    ) : (
                        <p className="mt-1.5 text-[11.5px] text-muted-foreground">
                            {t("settingsPanels.image.outputSize", { size: `${dimensions.width} × ${dimensions.height}` })}
                            {isCustomSize ? ` · ${t("settingsPanels.common.custom")}` : ""}
                        </p>
                    )}
                    {specDriven || managed ? null : (
                        <>
                            <button
                                type="button"
                                className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                                onClick={() => setCustomOpen(!customOpen)}
                            >
                                <span className={cn("inline-block text-[10px] transition-transform", disclosureOpen && "rotate-90")}>▶</span>
                                {t("settingsPanels.image.customSize")}
                            </button>
                            {disclosureOpen ? (
                                <div className="mt-2 space-y-2">
                                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                                        <DimensionInput prefix="W" value={dimensions.width} disabled={activeSize === "auto"} theme={theme} onChange={(value) => updateDimension("width", value)} />
                                        <span className="text-lg opacity-45">↔</span>
                                        <DimensionInput prefix="H" value={dimensions.height} disabled={activeSize === "auto"} theme={theme} onChange={(value) => updateDimension("height", value)} />
                                    </div>
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-xs text-muted-foreground">{t("settingsPanels.image.align16")}</span>
                                        <Switch size="small" checked={snapDimensionToStep} onChange={setSnapDimensionToStep} />
                                    </div>
                                </div>
                            ) : null}
                        </>
                    )}
                </SettingGroup>
            ) : null}

            {secondAxis !== "none" ? (
                <SettingGroup title={secondAxis === "resolutions" ? t("settingsPanels.image.resolution") : t("settingsPanels.image.quality")}>
                    {secondAxis === "global" ? (
                        <div className="grid grid-cols-4 gap-1.5">
                            {qualityOptions.map((item) => (
                                <OptionPill key={item.value} selected={quality === item.value} onClick={() => onConfigChange("quality", item.value)} className="px-1.5">
                                    {t(`settingsPanels.common.${item.value}`)}
                                    {item.tier ? <span className="text-[10px] opacity-55">{item.tier}</span> : null}
                                </OptionPill>
                            ))}
                        </div>
                    ) : (
                        <>
                            <div className="grid grid-cols-3 gap-1.5">
                                {axisValues.map((value) => {
                                    const declared = declaredAxisValues.includes(value);
                                    const label = managedAxisLabel(value, secondAxis === "qualities" ? "qualities" : "resolutions");
                                    return (
                                        <OptionPill
                                            key={value}
                                            selected={quality === value}
                                            disabled={!declared}
                                            title={declared ? undefined : t("settingsPanels.image.axisUnavailable", { axis: label })}
                                            onClick={() => onConfigChange("quality", value)}
                                            className="px-1.5"
                                        >
                                            {label}
                                        </OptionPill>
                                    );
                                })}
                            </div>
                            {unavailableAxisLabels.length ? (
                                <p className="text-[11.5px] text-muted-foreground">{t("settingsPanels.image.axisUnavailable", { axis: unavailableAxisLabels.join(t("settingsPanels.image.axisSeparator")) })}</p>
                            ) : null}
                        </>
                    )}
                </SettingGroup>
            ) : null}

            {twoAxes ? <p className="text-[11.5px] text-muted-foreground">{t("settingsPanels.image.twoAxesUnsupported")}</p> : null}

            <SettingGroup title={t("settingsPanels.image.count")}>
                {countLocked ? (
                    <div className="flex items-center gap-2 py-0.5">
                        <span className="flex h-8 items-center rounded-full border border-input bg-muted/40 px-3.5 text-xs text-muted-foreground">{t("settingsPanels.image.images", { count: 1 })}</span>
                        <span className="text-[11px] text-muted-foreground/75">{t("settingsPanels.image.countLockedHint")}</span>
                    </div>
                ) : (
                    <QuickPillRow
                        values={[1, 2, 3, 4]}
                        value={count}
                        format={(v) => t("settingsPanels.image.images", { count: v })}
                        min={1}
                        max={15}
                        parse={(s) => { const n = Math.floor(Number(s)); return Number.isFinite(n) ? Math.max(1, Math.min(15, n)) : null; }}
                        onChange={(v) => onConfigChange("count", String(v))}
                    />
                )}
            </SettingGroup>

            <div className="flex items-center justify-between gap-3">
                <div className="space-y-0.5">
                    <div className="text-xs font-medium text-muted-foreground">{t("settingsPanels.image.transparent")}</div>
                    <div className="text-xs text-muted-foreground/75">{t("settingsPanels.image.transparentHint")}</div>
                </div>
                <Switch size="small" checked={transparentBackground} onChange={(checked) => onConfigChange("background", checked ? "transparent" : "")} />
            </div>

            <GenerationDefaultsFooter
                typeName={t("settingsPanels.model.capabilities.image")}
                summary={`${imageQualityLabel(quality)} · ${imageSizeLabel(activeSize)} · ${t("settingsPanels.image.images", { count })}${transparentBackground ? ` · ${t("settingsPanels.image.transparent")}` : ""}`}
                canSet={!sameAsDefault}
                canReset={isOverridden}
                onSetDefault={handleSetDefault}
                onReset={onResetOverrides || (() => {})}
            />
        </div>
    );

    function updateDimension(key: "width" | "height", value: number | null) {
        const next = Math.max(1, Math.floor(value || dimensions[key] || 1024));
        const width = key === "width" ? next : dimensions.width;
        const height = key === "height" ? next : dimensions.height;
        onConfigChange("size", `${alignDimension(width, snapDimensionToStep)}x${alignDimension(height, snapDimensionToStep)}`);
    }
}

export function imageQualityLabel(value: string) {
    return (["auto", "high", "medium", "low", "standard", "fine", "ultra"].includes(value) ? i18n.t(`settingsPanels.common.${value}`) : value);
}

export function imageSizeLabel(size: string) {
    return aspectOptions.find((item) => (item.size || item.value) === size || item.value === size)?.label || size;
}

function AspectIcon({ type, width, height, color }: { type: string; width: number; height: number; color: string }) {
    if (type === "auto") return null;
    const ratio = width / Math.max(1, height);
    const boxWidth = ratio >= 1 ? 16 : Math.max(7, 16 * ratio);
    const boxHeight = ratio >= 1 ? Math.max(7, 16 / ratio) : 16;
    return (
        <span className="grid h-[18px] place-items-center">
            <span className="rounded-[1px] border-[1.5px]" style={{ width: boxWidth, height: boxHeight, borderColor: color }} />
        </span>
    );
}

function DimensionInput({ prefix, value, disabled, theme, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    const commit = (input: HTMLInputElement) => {
        const next = Math.max(1, Math.floor(Number(input.value) || value || 1024));
        input.value = String(next);
        onChange(next);
    };

    return (
        <label className="flex h-8 overflow-hidden rounded-[10px] text-[12.5px]" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-7 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input
                type="number"
                min={1}
                disabled={disabled}
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

/** 显式 W×H 原样展示；比例值按质量档位实时解析出输出尺寸（与 resolveSize 同构，spec §4.1：高+16:9 → 3840×2160）。 */
function readSizeDimensions(size: string, quality: string, fallback: { width: number; height: number }) {
    const match = size.match(/^(\d+)x(\d+)$/i);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
    const ratio = size.match(/^(\d+):(\d+)$/);
    if (!ratio) return fallback;
    return resolveRatioDimensions(quality, Number(ratio[1]), Number(ratio[2]));
}

function resolveRatioDimensions(quality: string, ratioWidth: number, ratioHeight: number) {
    const basePixels = QUALITY_BASE[quality];
    const isLandscape = ratioWidth >= ratioHeight;
    const longRatio = isLandscape ? ratioWidth / ratioHeight : ratioHeight / ratioWidth;
    let longSide: number;
    let shortSide: number;
    if (basePixels) {
        longSide = Math.floor(Math.sqrt(basePixels * basePixels * longRatio) / DIMENSION_STEP) * DIMENSION_STEP;
        shortSide = Math.round(longSide / longRatio / DIMENSION_STEP) * DIMENSION_STEP;
    } else {
        shortSide = DEFAULT_SHORT_SIDE;
        longSide = Math.round((shortSide * longRatio) / DIMENSION_STEP) * DIMENSION_STEP;
    }
    return { width: isLandscape ? longSide : shortSide, height: isLandscape ? shortSide : longSide };
}

function alignDimension(value: number, enabled: boolean) {
    return enabled ? Math.ceil(value / DIMENSION_STEP) * DIMENSION_STEP : value;
}
