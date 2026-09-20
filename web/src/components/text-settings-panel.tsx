import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { cn } from "@/lib/utils";
import { GenerationDefaultsFooter } from "@/components/generation-defaults-footer";
import { OptionPill, QuickPillRow } from "@/components/ui/settings-controls";
import { useConfigStore } from "@/stores/use-config-store";
import { type ReasoningEffort } from "@/stores/use-config-store";

const reasoningEffortOptions: ReasoningEffort[] = ["auto", "low", "medium", "high", "xhigh"];

type TextSettingsPanelProps = {
    config: import("@/stores/use-config-store").AiConfig;
    onConfigChange: (key: "reasoningEffort", value: ReasoningEffort) => void;
    count?: number;
    onCountChange?: (count: number) => void;
    isOverridden?: boolean;
    onResetOverrides?: () => void;
    className?: string;
};

export function TextSettingsPanel({ config, onConfigChange, count = 1, onCountChange, isOverridden = false, onResetOverrides, className = "space-y-2.5" }: TextSettingsPanelProps) {
    const { t } = useTranslation();
    const defaults = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const textCount = Math.max(1, Math.min(15, Math.floor(Number(config.textCount) || count || 1)));
    const sameAsDefault = (config.reasoningEffort || "auto") === (defaults.reasoningEffort || "auto") && textCount === Math.max(1, Math.min(15, Number(defaults.canvasTextCount) || 1));

    return (
        <div className={cn("text-foreground", className)} onMouseDown={(event) => event.stopPropagation()}>
            <div className="space-y-2.5">
                <div className="text-xs font-medium text-muted-foreground">{t("settingsPanels.text.reasoning")}</div>
                <div className="grid grid-cols-5 gap-2">
                    {reasoningEffortOptions.map((value) => (
                        <OptionPill key={value} selected={config.reasoningEffort === value} onClick={() => onConfigChange("reasoningEffort", value)}>
                            {t(`settingsPanels.common.${value}`)}
                        </OptionPill>
                    ))}
                </div>
            </div>
            {onCountChange ? (
                <div className="mt-2.5 space-y-2.5">
                    <div className="text-xs font-medium text-muted-foreground">{t("settingsPanels.text.count")}</div>
                    <QuickPillRow
                        values={[1, 2, 3, 4]}
                        value={textCount}
                        format={(v) => String(v)}
                        min={1}
                        max={15}
                        parse={(s) => { const n = Math.floor(Number(s)); return Number.isFinite(n) ? Math.max(1, Math.min(15, n)) : null; }}
                        onChange={(v) => onCountChange(Number(v))}
                        gridClassName="grid-cols-5"
                    />
                </div>
            ) : null}
            {onCountChange && onResetOverrides ? (
                <GenerationDefaultsFooter
                    typeName={t("settingsPanels.model.capabilities.text")}
                    summary={`${i18n.t(`settingsPanels.common.${config.reasoningEffort || "auto"}`)} · ${t("settingsPanels.text.count")} ${textCount}`}
                    canSet={!sameAsDefault}
                    canReset={isOverridden}
                    onSetDefault={() => {
                        updateConfig("reasoningEffort", config.reasoningEffort || "auto");
                        updateConfig("canvasTextCount", String(textCount));
                    }}
                    onReset={onResetOverrides}
                />
            ) : null}
        </div>
    );
}

export function reasoningEffortLabel(value: ReasoningEffort) {
    return reasoningEffortOptions.includes(value) ? i18n.t(`settingsPanels.common.${value}`) : value;
}
