import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { Button, ConfigProvider } from "antd";
import { Box, Hand, Image as ImageIcon, MousePointer2, Music2, Plus, Puzzle, ScrollText, Type, Upload, Video } from "lucide-react";

import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { getNodePluginId, listNodeDefinitions, useNodeRegistryVersion } from "@/lib/canvas/node-registry";
import { useThemeStore } from "@/stores/use-theme-store";
import { useTranslation } from "react-i18next";

export function CanvasToolbar({
    canvasTool,
    onAddImage,
    onAddVideo,
    onAddModel3d,
    onAddAudio,
    onAddText,
    onAddScript,
    onAddExtensionNode,
    onUpload,
    onCanvasToolChange,
}: {
    canvasTool: "select" | "pan";
    onAddImage: () => void;
    onAddVideo: () => void;
    onAddModel3d: () => void;
    onAddAudio: () => void;
    onAddText: () => void;
    onAddScript: () => void;
    onAddExtensionNode: (type: string) => void;
    onUpload: () => void;
    onCanvasToolChange: (tool: "select" | "pan") => void;
}) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const { t } = useTranslation();
    const rootRef = useRef<HTMLDivElement>(null);
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const [hovered, setHovered] = useState<string | null>(null);
    const [tipX, setTipX] = useState(0);
    const [createOpen, setCreateOpen] = useState(false);
    const [createPanelX, setCreatePanelX] = useState(0);
    const [extensionsOpen, setExtensionsOpen] = useState(false);
    const [extPanelX, setExtPanelX] = useState(0);
    // Keep extension plugin nodes synchronized with registry changes.
    useNodeRegistryVersion();
    const extensionDefs = listNodeDefinitions().filter((def) => def.showInCreateMenu !== false && getNodePluginId(def.type) !== "builtin");
    const dockStyle = { background: theme.toolbar.panel, color: theme.toolbar.item, boxShadow: colorTheme === "dark" ? "0 18px 45px rgba(0,0,0,.32)" : "0 16px 40px rgba(28,25,23,.12)" };
    const hoverStyle = { background: theme.toolbar.itemHover, color: theme.toolbar.activeText };
    const activeStyle = { background: theme.toolbar.activeBg, color: theme.toolbar.activeText };
    const tip = hovered ? toolLabel(hovered, t) : "";

    // Close node-creation and extension-node popovers when clicking outside the toolbar and its panels.
    useEffect(() => {
        if (!createOpen && !extensionsOpen) return;
        const handlePointerDown = (event: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
                setCreateOpen(false);
                setExtensionsOpen(false);
            }
        };
        document.addEventListener("pointerdown", handlePointerDown, true);
        return () => document.removeEventListener("pointerdown", handlePointerDown, true);
    }, [createOpen, extensionsOpen]);

    return (
        <div ref={rootRef} className="pointer-events-none absolute inset-x-0 bottom-5 z-50 flex justify-center">
            {tip ? <DockTip label={tip} x={tipX} theme={theme} /> : null}
            <div ref={wrapRef} className="thin-scrollbar pointer-events-auto flex h-12 max-w-full items-center gap-1 overflow-x-auto rounded-xl px-2 shadow-lg backdrop-blur [&>*]:shrink-0" style={dockStyle}>
                <ToolbarButton id={`tool-${canvasTool}`} label={t(`canvas.toolbar.${canvasTool}`)} hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={() => onCanvasToolChange(canvasTool === "select" ? "pan" : "select")}>
                    {canvasTool === "select" ? <MousePointer2 className="size-4.5" /> : <Hand className="size-4.5" />}
                </ToolbarButton>
                <Divider theme={theme} />
                <ToolbarButton
                    id="tool-add"
                    label={t("canvas.toolbar.add")}
                    active={createOpen}
                    hovered={hovered && !createOpen && !extensionsOpen}
                    activeStyle={activeStyle}
                    hoverStyle={hoverStyle}
                    wrapRef={wrapRef}
                    onTipX={setTipX}
                    onHover={setHovered}
                    onClick={(event) => {
                        setCreatePanelX(getTipX(wrapRef.current, event.currentTarget));
                        setExtensionsOpen(false);
                        setCreateOpen((value) => !value);
                    }}
                >
                    <Plus className="size-4.5" />
                </ToolbarButton>
                {extensionDefs.length ? (
                    <ToolbarButton
                        id="tool-extensions"
                        label={t("canvas.toolbar.extensions")}
                        active={extensionsOpen}
                        hovered={hovered && !createOpen && !extensionsOpen}
                        activeStyle={activeStyle}
                        hoverStyle={hoverStyle}
                        wrapRef={wrapRef}
                        onTipX={setTipX}
                        onHover={setHovered}
                        onClick={(event) => {
                            setExtPanelX(getTipX(wrapRef.current, event.currentTarget));
                            setCreateOpen(false);
                            setExtensionsOpen((value) => !value);
                        }}
                    >
                        <Puzzle className="size-4.5" />
                    </ToolbarButton>
                ) : null}
                <ToolbarButton id="tool-upload" label={t("canvas.toolbar.upload")} hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onUpload}>
                    <Upload className="size-4.5" />
                </ToolbarButton>
            </div>

            {createOpen ? (
                <div
                    className="pointer-events-auto absolute bottom-[72px] z-30 w-[196px] -translate-x-1/2 rounded-xl border p-2 shadow-xl backdrop-blur"
                    style={{ left: createPanelX || "50%", background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item }}
                >
                    <div className="px-1.5 pb-1.5 text-[11px] font-medium opacity-50">{t("canvas.toolbar.add")}</div>
                    <div className="grid gap-0.5">
                        {[
                            { id: "text", label: t("canvas.toolbar.text"), icon: <Type className="size-4" />, onClick: onAddText },
                            { id: "image", label: t("canvas.toolbar.image"), icon: <ImageIcon className="size-4" />, onClick: onAddImage },
                            { id: "video", label: t("canvas.toolbar.video"), icon: <Video className="size-4" />, onClick: onAddVideo },
                            { id: "script", label: t("canvas.toolbar.script"), icon: <ScrollText className="size-4" />, onClick: onAddScript },
                            { id: "model3d", label: t("canvas.toolbar.model3d"), icon: <Box className="size-4" />, onClick: onAddModel3d },
                            { id: "audio", label: t("canvas.toolbar.audio"), icon: <Music2 className="size-4" />, onClick: onAddAudio },
                        ].map((item) => (
                            <button
                                key={item.id}
                                type="button"
                                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition"
                                style={{ color: theme.toolbar.item }}
                                onMouseEnter={(event) => (event.currentTarget.style.background = theme.toolbar.itemHover)}
                                onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
                                onClick={() => {
                                    item.onClick();
                                    setCreateOpen(false);
                                }}
                            >
                                <span className="grid size-7 shrink-0 place-items-center rounded-md text-base" style={{ background: theme.toolbar.itemHover }}>
                                    {item.icon}
                                </span>
                                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                            </button>
                        ))}
                    </div>
                </div>
            ) : null}

            {extensionsOpen && extensionDefs.length ? (
                <div
                    className="thin-scrollbar pointer-events-auto absolute bottom-[72px] z-30 max-h-[50vh] w-[240px] -translate-x-1/2 overflow-y-auto rounded-xl border p-2 shadow-xl backdrop-blur"
                    style={{ left: extPanelX || "50%", background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item }}
                >
                    <div className="px-1.5 pb-1.5 text-[11px] font-medium opacity-50">{t("canvas.toolbar.extensions")}</div>
                    <div className="grid gap-0.5">
                        {extensionDefs.map((def) => (
                            <button
                                key={def.type}
                                type="button"
                                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition"
                                style={{ color: theme.toolbar.item }}
                                onMouseEnter={(event) => (event.currentTarget.style.background = theme.toolbar.itemHover)}
                                onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
                                onClick={() => {
                                    onAddExtensionNode(def.type);
                                    setExtensionsOpen(false);
                                }}
                            >
                                <span className="grid size-7 shrink-0 place-items-center rounded-md text-base" style={{ background: theme.toolbar.itemHover }}>
                                    {def.icon}
                                </span>
                                <span className="min-w-0 flex-1 truncate">{def.title}</span>
                            </button>
                        ))}
                    </div>
                </div>
            ) : null}

        </div>
    );
}

function ToolbarButton({
    id,
    label,
    active,
    hovered,
    activeStyle,
    hoverStyle,
    wrapRef,
    onTipX,
    onHover,
    onClick,
    disabled = false,
    danger = false,
    children,
}: {
    id: string;
    label: string;
    active?: boolean;
    hovered: string | null;
    activeStyle?: CSSProperties;
    hoverStyle: CSSProperties;
    wrapRef: RefObject<HTMLDivElement | null>;
    onTipX: (x: number) => void;
    onHover: (id: string | null) => void;
    onClick?: (event: ReactMouseEvent<HTMLElement>) => void;
    disabled?: boolean;
    danger?: boolean;
    children: ReactNode;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    // Dock 按钮保持扁平：关闭 antd 点击波纹（以按钮底色渲染的按下阴影光环）。
    return (
        <ConfigProvider wave={{ disabled: true }}>
            <Button
                type="text"
                aria-label={label}
                className="!h-8 !w-8 !min-w-8 !p-0"
                disabled={disabled}
                style={active ? activeStyle : hovered === id && !disabled ? hoverStyle : { color: danger ? "var(--danger)" : theme.toolbar.item, opacity: disabled ? 0.35 : 1 }}
                icon={children}
                onMouseEnter={(event) => {
                    onHover(id);
                    onTipX(getTipX(wrapRef.current, event.currentTarget));
                }}
                onMouseLeave={() => onHover(null)}
                onClick={onClick}
            />
        </ConfigProvider>
    );
}

function Divider({ theme }: { theme: CanvasTheme }) {
    return <div className="mx-1 h-6 w-px" style={{ background: theme.toolbar.border }} />;
}

function DockTip({ label, x, theme }: { label: string; x: number; theme: CanvasTheme }) {
    return (
        <span className="absolute bottom-[calc(100%+8px)] -translate-x-1/2 rounded-md px-2 py-1 text-xs shadow-lg" style={{ left: x, background: theme.node.text, color: theme.node.panel }}>
            {label}
        </span>
    );
}

function toolLabel(id: string, t: (key: string) => string) {
    if (id === "tool-select") return t("canvas.toolbar.select");
    if (id === "tool-pan") return t("canvas.toolbar.pan");
    if (id === "tool-add") return t("canvas.toolbar.add");
    if (id === "tool-extensions") return t("canvas.toolbar.extensions");
    if (id === "tool-upload") return t("canvas.toolbar.upload");
    return "";
}

function getTipX(wrap: HTMLDivElement | null, target: HTMLElement) {
    if (!wrap) return 0;
    const wrapBox = wrap.parentElement?.getBoundingClientRect() || wrap.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    return box.left - wrapBox.left + box.width / 2;
}
