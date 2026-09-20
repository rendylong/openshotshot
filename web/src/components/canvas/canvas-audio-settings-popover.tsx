import { useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { Button } from "antd";

import { AudioSettingsPanel } from "@/components/audio-settings-panel";
import { audioFormatLabel, audioSpeedLabel, audioVoiceLabel } from "@/lib/audio-generation";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";

import { CanvasFloatingPanel } from "./canvas-floating-panel";

export type CanvasAudioSettingKey = "audioVoice" | "audioFormat" | "audioSpeed" | "audioInstructions";

type CanvasAudioSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: CanvasAudioSettingKey, value: string) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    isOverridden?: boolean;
    onResetOverrides?: () => void;
};

export function CanvasAudioSettingsPopover({ config, onConfigChange, buttonClassName, placement = "topLeft", isOverridden, onResetOverrides }: CanvasAudioSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const [open, setOpen] = useState(false);

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"} style={{ color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={() => setOpen((current) => !current)}>
                    <span className="truncate">
                        {audioVoiceLabel(config.audioVoice)} · {audioFormatLabel(config.audioFormat)} · {audioSpeedLabel(config.audioSpeed)}
                    </span>
                </Button>
            </span>
            <CanvasFloatingPanel open={open} anchorRef={buttonRef} placement={placement} ariaLabel="audio settings panel" onOpenChange={setOpen}>
                <AudioSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} isOverridden={isOverridden} onResetOverrides={onResetOverrides} className="space-y-4" />
            </CanvasFloatingPanel>
        </>
    );
}
