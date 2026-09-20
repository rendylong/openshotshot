import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button, Segmented, Switch, Tooltip } from "antd";
import { CircleDot, Grid2x2, Info, Moon, Palette, Square, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { canvasThemes, type CanvasBackgroundMode, type CanvasColorTheme, type CanvasTheme } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export function CanvasAppearanceSettings({
    backgroundMode,
    showImageInfo,
    onBackgroundModeChange,
    onShowImageInfoChange,
}: {
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    onBackgroundModeChange: (mode: CanvasBackgroundMode) => void;
    onShowImageInfoChange: (show: boolean) => void;
}) {
    const rootRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const { t } = useTranslation();
    const colorTheme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const theme = canvasThemes[colorTheme];

    useEffect(() => {
        if (!open) return;
        const handlePointerDown = (event: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener("pointerdown", handlePointerDown, true);
        return () => document.removeEventListener("pointerdown", handlePointerDown, true);
    }, [open]);

    return (
        <div ref={rootRef} className="relative">
            <Tooltip title={t("canvas.toolbar.appearance")} open={open ? false : undefined}>
                <Button
                    type="text"
                    className="!h-8 !w-8 !min-w-8 !p-0"
                    style={open ? { background: theme.toolbar.activeBg, color: theme.toolbar.activeText } : { color: theme.toolbar.item }}
                    icon={<Palette className="size-4" />}
                    onClick={() => setOpen((value) => !value)}
                    aria-label={t("canvas.toolbar.appearance")}
                />
            </Tooltip>

            {open ? (
                <div
                    className="absolute right-0 top-11 z-50 w-[248px] rounded-xl border p-2.5 shadow-xl backdrop-blur"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item }}
                >
                    <div className="px-1 pb-2 text-sm font-medium opacity-65">{t("canvas.toolbar.appearance")}</div>
                    <div className="px-1 pb-1.5 text-[11px] font-medium opacity-50">{t("canvas.toolbar.themeMode")}</div>
                    <div className="grid grid-cols-2 gap-1 rounded-lg p-1" style={{ background: theme.toolbar.itemHover }}>
                        <CanvasThemeButton colorTheme={colorTheme} targetTheme="light" onThemeChange={setTheme}>
                            <Sun className="size-4" />
                            {t("canvas.toolbar.light")}
                        </CanvasThemeButton>
                        <CanvasThemeButton colorTheme={colorTheme} targetTheme="dark" onThemeChange={setTheme}>
                            <Moon className="size-4" />
                            {t("canvas.toolbar.dark")}
                        </CanvasThemeButton>
                    </div>
                    <div className="mt-3 px-1 pb-1.5 text-[11px] font-medium opacity-50">{t("canvas.toolbar.gridStyle")}</div>
                    <Segmented
                        className="w-full !p-1 [&_.ant-segmented-group]:!flex [&_.ant-segmented-item]:!min-h-8 [&_.ant-segmented-item]:!flex-1 [&_.ant-segmented-item-label]:!min-h-8 [&_.ant-segmented-item-label]:!leading-8"
                        value={backgroundMode}
                        onChange={(value) => onBackgroundModeChange(value as CanvasBackgroundMode)}
                        options={[
                            {
                                value: "dots",
                                label: (
                                    <span className="inline-flex items-center gap-1.5">
                                        <CircleDot className="size-4" />{t("canvas.toolbar.dots")}
                                    </span>
                                ),
                            },
                            {
                                value: "lines",
                                label: (
                                    <span className="inline-flex items-center gap-1.5">
                                        <Grid2x2 className="size-4" />{t("canvas.toolbar.lines")}
                                    </span>
                                ),
                            },
                            {
                                value: "blank",
                                label: (
                                    <span className="inline-flex items-center gap-1.5">
                                        <Square className="size-4" />
                                        {t("canvas.toolbar.blank")}
                                    </span>
                                ),
                            },
                        ]}
                    />
                    <div className="mt-3 flex items-center justify-between gap-3 rounded-lg px-1.5 py-1">
                        <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-medium opacity-65">
                            <Info className="size-3.5" />
                            {t("canvas.toolbar.imageInfo")}
                        </span>
                        <Switch size="small" checked={showImageInfo} onChange={onShowImageInfoChange} />
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function CanvasThemeButton({ colorTheme, targetTheme, onThemeChange, children }: { colorTheme: CanvasColorTheme; targetTheme: CanvasColorTheme; onThemeChange: (theme: CanvasColorTheme) => void; children: ReactNode }) {
    const theme = canvasThemes[colorTheme];
    const active = colorTheme === targetTheme;
    const activeStyle = colorTheme === "light" ? { background: "var(--foreground)", color: "var(--background)" } : { background: theme.toolbar.activeBg, color: theme.toolbar.activeText };
    const { t } = useTranslation();
    const label = targetTheme === "dark" ? t("topNav.darkTheme") : t("topNav.lightTheme");

    return (
        <AnimatedThemeToggler
            theme={colorTheme}
            targetTheme={targetTheme}
            onThemeChange={onThemeChange}
            className={`flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-xs font-medium transition ${active ? "" : "hover:opacity-75"}`}
            style={active ? activeStyle : undefined}
            aria-label={label}
        >
            {children}
        </AnimatedThemeToggler>
    );
}
