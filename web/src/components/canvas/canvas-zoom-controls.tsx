import type { ReactNode } from "react";
import { HelpCircle, LocateFixed, Map } from "lucide-react";
import { useState } from "react";
import { Button, Modal, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { CanvasAppearanceSettings } from "@/components/canvas/canvas-appearance-settings";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

type CanvasZoomControlsProps = {
    scale: number;
    onReset: () => void;
    isMiniMapOpen: boolean;
    onToggleMiniMap: () => void;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    onBackgroundModeChange: (mode: CanvasBackgroundMode) => void;
    onShowImageInfoChange: (show: boolean) => void;
};

export function CanvasZoomControls({
    scale,
    onReset,
    isMiniMapOpen,
    onToggleMiniMap,
    backgroundMode,
    showImageInfo,
    onBackgroundModeChange,
    onShowImageInfoChange,
}: CanvasZoomControlsProps) {
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const { t } = useTranslation();
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const activeStyle = { background: theme.toolbar.activeBg, color: theme.toolbar.activeText };

    return (
        <div className="flex items-center" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <div className="flex h-9 items-center gap-1 px-1">
                <Tooltip mouseLeaveDelay={0} title={isMiniMapOpen ? t("canvas.miniMapClose") : t("canvas.miniMapOpen")}>
                    <Button
                        type="text"
                        className="!h-8 !w-8 !min-w-8 !p-0"
                        style={isMiniMapOpen ? activeStyle : { color: theme.toolbar.item }}
                        icon={<Map className="size-4" />}
                        onClick={onToggleMiniMap}
                        aria-label={isMiniMapOpen ? t("canvas.miniMapClose") : t("canvas.miniMapOpen")}
                    />
                </Tooltip>
                <CanvasAppearanceSettings
                    backgroundMode={backgroundMode}
                    showImageInfo={showImageInfo}
                    onBackgroundModeChange={onBackgroundModeChange}
                    onShowImageInfoChange={onShowImageInfoChange}
                />
                <Tooltip mouseLeaveDelay={0} title={t("canvas.resetView")}>
                    <Button type="text" className="!h-8 !w-8 !min-w-8 !p-0" style={{ color: theme.toolbar.item }} icon={<LocateFixed className="size-4" />} onClick={onReset} aria-label={t("canvas.resetView")} />
                </Tooltip>
                <Tooltip mouseLeaveDelay={0} title={t("canvas.zoom")}>
                    <span className="min-w-12 text-center text-xs tabular-nums" style={{ color: theme.node.muted }} aria-label={t("canvas.zoom")}>
                        {Math.round(scale * 100)}%
                    </span>
                </Tooltip>
                <Tooltip mouseLeaveDelay={0} title={t("canvas.shortcuts")}>
                    <Button type="text" className="!h-8 !w-8 !min-w-8 !p-0" style={shortcutsOpen ? activeStyle : { color: theme.toolbar.item }} icon={<HelpCircle className="size-4" />} onClick={() => setShortcutsOpen(true)} aria-label={t("canvas.shortcuts")} />
                </Tooltip>
            </div>
            <Modal title={t("canvas.shortcuts")} open={shortcutsOpen} onCancel={() => setShortcutsOpen(false)} footer={null} centered>
                <div className="space-y-3 border-t pt-4 text-sm" style={{ borderColor: theme.node.stroke }}>
                    <Shortcut label={`Ctrl / Space + ${t("canvas.shortcut.drag")}`} value={t("canvas.shortcut.toggleTool")} />
                    <Shortcut label={t("canvas.shortcut.twoFingerPan")} value={t("canvas.shortcut.pan")} />
                    <Shortcut label={t("canvas.shortcut.pinch")} value={t("canvas.shortcut.zoom")} />
                    <Shortcut label={t("canvas.shortcut.drag")} value={t("canvas.shortcut.boxSelect")} />
                    <Shortcut label={`Shift / Cmd + ${t("canvas.shortcut.click")}`} value={t("canvas.shortcut.addSelection")} />
                    <Shortcut label="Ctrl / Cmd + C / V" value={t("canvas.shortcut.copyPasteNodes")} />
                    <Shortcut label="Delete / Backspace" value={t("canvas.shortcut.delete")} />
                </div>
            </Modal>
        </div>
    );
}

function Shortcut({ label, value }: { label: ReactNode; value: string }) {
    return (
        <div className="flex items-center justify-between gap-4">
            <span className="text-base font-medium">{label}</span>
            <span className="opacity-60">{value}</span>
        </div>
    );
}
