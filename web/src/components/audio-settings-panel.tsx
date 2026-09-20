import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { audioFormatLabel, audioFormatOptions, audioSpeedLabel, audioVoiceLabel, audioVoiceOptions, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { GenerationDefaultsFooter } from "@/components/generation-defaults-footer";
import { OptionPill, QuickPillRow, SettingGroup } from "@/components/ui/settings-controls";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";

type AudioSettingKey = "audioVoice" | "audioFormat" | "audioSpeed" | "audioInstructions";

type AudioSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: AudioSettingKey, value: string) => void;
    showTitle?: boolean;
    className?: string;
    isOverridden?: boolean;
    onResetOverrides?: () => void;
};

export function AudioSettingsPanel({ config, onConfigChange, showTitle = false, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", isOverridden = false, onResetOverrides }: AudioSettingsPanelProps) {
    const { t } = useTranslation();
    const defaults = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const voice = normalizeAudioVoiceValue(config.audioVoice);
    const format = normalizeAudioFormatValue(config.audioFormat);
    const speed = normalizeAudioSpeedValue(config.audioSpeed);

    return (
        <div className={cn("text-foreground", className)} onMouseDown={(event) => event.stopPropagation()}>
            {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.audio.title")}</div> : null}
            <SettingGroup title={t("settingsPanels.audio.voice")}>
                <div className="grid grid-cols-3 gap-2.5">
                    {audioVoiceOptions.map((item) => (
                        <OptionPill key={item.value} selected={voice === item.value} onClick={() => onConfigChange("audioVoice", item.value)}>
                            {item.label}
                        </OptionPill>
                    ))}
                </div>
            </SettingGroup>
            <SettingGroup title={t("settingsPanels.audio.speed")}>
                <QuickPillRow
                    values={["0.75", "1", "1.25", "1.5"]}
                    value={speed}
                    format={(v) => `${v}x`}
                    min={0.25}
                    max={4}
                    parse={(s) => { const n = Number(s); return Number.isFinite(n) ? String(Math.round(Math.max(0.25, Math.min(4, n)) * 100) / 100) : null; }}
                    onChange={(v) => onConfigChange("audioSpeed", String(v))}
                />
            </SettingGroup>
            <SettingGroup title={t("settingsPanels.audio.format")}>
                <div className="grid grid-cols-3 gap-2.5">
                    {audioFormatOptions.map((item) => (
                        <OptionPill key={item.value} selected={format === item.value} onClick={() => onConfigChange("audioFormat", item.value)}>
                            {item.label}
                        </OptionPill>
                    ))}
                </div>
            </SettingGroup>
            <SettingGroup title={t("settingsPanels.audio.instructions")}>
                <textarea
                    value={config.audioInstructions || ""}
                    placeholder={t("settingsPanels.audio.instructionsPlaceholder")}
                    className="thin-scrollbar h-20 w-full resize-none rounded-xl border border-input bg-transparent px-3 py-2 text-sm leading-5 text-foreground outline-none"
                    onChange={(event) => onConfigChange("audioInstructions", event.target.value)}
                    onMouseDown={(event) => event.stopPropagation()}
                />
            </SettingGroup>
            <GenerationDefaultsFooter
                typeName={t("settingsPanels.model.capabilities.audio")}
                summary={`${audioVoiceLabel(voice)} · ${audioFormatLabel(format)} · ${audioSpeedLabel(speed)}`}
                canSet={(() => {
                    const same = voice === normalizeAudioVoiceValue(defaults.audioVoice) && format === normalizeAudioFormatValue(defaults.audioFormat) && speed === normalizeAudioSpeedValue(defaults.audioSpeed);
                    return !same;
                })()}
                canReset={isOverridden}
                onSetDefault={() => {
                    updateConfig("audioVoice", voice);
                    updateConfig("audioSpeed", speed);
                    updateConfig("audioFormat", format);
                    updateConfig("audioInstructions", config.audioInstructions || "");
                }}
                onReset={onResetOverrides || (() => {})}
            />
        </div>
    );
}
