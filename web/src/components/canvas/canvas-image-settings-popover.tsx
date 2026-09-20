import { configuredFalProfile } from "@/lib/canvas/fal-settings";
import type { ProviderOptions } from "@/lib/models/provider-options";
import type { CanvasNodeMetadata } from "@/types/canvas";
import { useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { Button } from "antd";
import { useTranslation } from "react-i18next";

import { ImageSettingsPanel, imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";

import { CanvasFloatingPanel } from "./canvas-floating-panel";

type CanvasImageSettingsPopoverProps = {
    config: AiConfig;
    providerOptions?: ProviderOptions;
    onMetadataChange?: (patch: Partial<CanvasNodeMetadata>) => void;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    onMissingConfig?: () => void;
    onOpenChange?: (open: boolean) => void;
    buttonClassName?: string;
    getPopupContainer?: (triggerNode: HTMLElement) => HTMLElement;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    autoAdjustOverflow?: boolean;
    isOverridden?: boolean;
    onResetOverrides?: () => void;
};

export function CanvasImageSettingsPopover({ config, providerOptions, onMetadataChange, onConfigChange, onOpenChange, buttonClassName, placement = "topLeft", isOverridden, onResetOverrides }: CanvasImageSettingsPopoverProps) {
    const { t } = useTranslation();
    const profile = configuredFalProfile(config);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const [open, setOpen] = useState(false);
    const quality = config.quality || "auto";
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = config.size || "auto";
    const updateOpen = (nextOpen: boolean) => {
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
    };

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[180px] !justify-start !rounded-full !px-2.5"} style={{ color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={() => updateOpen(!open)}>
                    <span className="truncate">
                        {profile ? t("fal.settings.parameters") : `${imageQualityLabel(quality)} · ${imageSizeLabel(activeSize)}`} · {t("canvas.controls.images", { count })}
                    </span>
                </Button>
            </span>
            <CanvasFloatingPanel open={open} anchorRef={buttonRef} placement={placement} ariaLabel="image settings panel" onOpenChange={updateOpen}>
                <ImageSettingsPanel config={config} providerOptions={providerOptions} onMetadataChange={onMetadataChange} onConfigChange={onConfigChange} theme={theme} className="space-y-2.5" isOverridden={isOverridden} onResetOverrides={onResetOverrides} />
            </CanvasFloatingPanel>
        </>
    );
}
