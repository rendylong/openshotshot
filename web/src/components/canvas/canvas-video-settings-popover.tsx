import { credentialModeFor } from "@/stores/use-config-store";
import { useManagedCatalog } from "@/lib/desktop/use-managed-catalog";
import { selectedManagedVideoSpec } from "@/lib/canvas/managed-video-settings";
import { useTranslation } from "react-i18next";
import { configuredFalProfile } from "@/lib/canvas/fal-settings";
import type { ProviderOptions } from "@/lib/models/provider-options";
import type { CanvasNodeMetadata } from "@/types/canvas";
import { useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { Button } from "antd";

import { VideoSettingsPanel, videoResolutionLabel, videoSecondsLabel, videoSizeLabel } from "@/components/video-settings-panel";
import { getConfiguredAutodlWorkflow } from "@/lib/canvas/autodl-generation-input";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";

import { CanvasFloatingPanel } from "./canvas-floating-panel";

type CanvasVideoSettingsPopoverProps = {
    config: AiConfig;
    providerOptions?: ProviderOptions;
    onMetadataChange?: (patch: Partial<CanvasNodeMetadata>) => void;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    isOverridden?: boolean;
    onResetOverrides?: () => void;
};

export function CanvasVideoSettingsPopover({ config, providerOptions, onMetadataChange, onConfigChange, buttonClassName, placement = "topLeft", isOverridden, onResetOverrides }: CanvasVideoSettingsPopoverProps) {
    const managed = credentialModeFor(config, "video") === "shotshot";
    const catalog = useManagedCatalog(managed);
    const available = catalog?.models.filter(model => model.capability === "video") ?? [];
    const selectedModel = available.find(model => model.id === config.managedModels.video) ?? available[0];
    const selectedSpec = selectedManagedVideoSpec(config, selectedModel);
    const workflow = getConfiguredAutodlWorkflow(config);
    const { t } = useTranslation();
    const profile = configuredFalProfile(config);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const [open, setOpen] = useState(false);

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"} style={{ color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={() => setOpen((current) => !current)}>
                    <span className="truncate">
                        {managed ? selectedSpec ? `${selectedSpec.quality} · ${t(`settingsPanels.video.sizes.${selectedSpec.orientation}`)} · ${videoSecondsLabel(config.videoSeconds || String(selectedSpec.duration.default))}` : t("settingsPanels.video.title") : profile ? t("fal.settings.parameters") : workflow ? [config.vquality || workflow.resolution.default, ...(workflow.duration ? [videoSecondsLabel(config.videoSeconds || String(workflow.duration.default))] : [])].join(" · ") : `${videoResolutionLabel(config.vquality)} · ${videoSizeLabel(config.size)} · ${videoSecondsLabel(config.videoSeconds)}`}
                    </span>
                </Button>
            </span>
            <CanvasFloatingPanel open={open} anchorRef={buttonRef} placement={placement} ariaLabel="video settings panel" onOpenChange={setOpen}>
                <VideoSettingsPanel config={config} providerOptions={providerOptions} onMetadataChange={onMetadataChange} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} className="space-y-2.5" isOverridden={isOverridden} onResetOverrides={onResetOverrides} />
            </CanvasFloatingPanel>
        </>
    );
}
