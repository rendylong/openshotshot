import { useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { Button } from "antd";
import { useTranslation } from "react-i18next";

import { reasoningEffortLabel, TextSettingsPanel } from "@/components/text-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig, ReasoningEffort } from "@/stores/use-config-store";

import { CanvasFloatingPanel } from "./canvas-floating-panel";

type CanvasTextSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: "reasoningEffort", value: ReasoningEffort) => void;
    count?: number;
    onCountChange?: (count: number) => void;
    isOverridden?: boolean;
    onResetOverrides?: () => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
};

export function CanvasTextSettingsPopover({ config, onConfigChange, count, onCountChange, isOverridden, onResetOverrides, buttonClassName, placement = "topLeft" }: CanvasTextSettingsPopoverProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const [open, setOpen] = useState(false);

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"} style={{ color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={() => setOpen((current) => !current)}>
                    <span className="truncate">{t("canvas.controls.reasoning")} · {reasoningEffortLabel(config.reasoningEffort)}{onCountChange ? ` · ${t("canvas.controls.generations", { count })}` : ""}</span>
                </Button>
            </span>
            <CanvasFloatingPanel open={open} anchorRef={buttonRef} placement={placement} ariaLabel="text settings panel" onOpenChange={setOpen}>
                <TextSettingsPanel config={config} onConfigChange={onConfigChange} count={count} onCountChange={onCountChange} isOverridden={isOverridden} onResetOverrides={onResetOverrides} />
            </CanvasFloatingPanel>
        </>
    );
}
