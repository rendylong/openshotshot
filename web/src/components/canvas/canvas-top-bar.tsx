import type { ReactNode } from "react";
import { Bot, LibraryBig } from "lucide-react";
import { Button, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useCanvasSidePanelStore } from "@/stores/use-canvas-side-panel-store";
import { useThemeStore } from "@/stores/use-theme-store";

// The Pi agent host only exists behind the Electron preload bridge.
const AGENT_BRIDGE_AVAILABLE = typeof window !== "undefined" && Boolean(window.shotshot?.agent);

const RESOURCES_DRAWER_WIDTH = 320;

export function CanvasTopBar({
    agentOpen,
    onToggleAgent,
    viewportControls,
}: {
    agentOpen: boolean;
    onToggleAgent: () => void;
    viewportControls?: ReactNode;
}) {
    const colorTheme = useThemeStore((state) => state.theme);
    const { t } = useTranslation();
    const theme = canvasThemes[colorTheme];
    const isMacDesktop = window.shotshot?.platform === "darwin";
    const resourcesOpen = useCanvasSidePanelStore((state) => state.panelOpen);
    const toggleResources = useCanvasSidePanelStore((state) => state.togglePanel);
    const resourcesLabel = t(resourcesOpen ? "canvas.resourcesClose" : "canvas.resources");
    const agentLabel = t(agentOpen ? "topNav.closeAgent" : "canvas.openAgent");

    return (
        <div
            className={`pointer-events-none absolute top-0 z-50 flex h-16 items-center pr-4 ${isMacDesktop ? "pt-1" : ""}`}
            style={{ right: resourcesOpen ? RESOURCES_DRAWER_WIDTH : 0, transition: "right 300ms ease" }}
        >
            <div className="pointer-events-auto flex items-center gap-1" role="toolbar" aria-label={t("canvas.topControls")}>
                {viewportControls}
                <Tooltip title={resourcesLabel}>
                    <Button
                        type="text"
                        className="!h-9 !w-9 !min-w-9 !rounded-lg !p-0"
                        style={resourcesOpen ? { background: theme.toolbar.activeBg, color: theme.toolbar.activeText } : { color: theme.node.text }}
                        icon={<LibraryBig className="size-4" />}
                        onClick={toggleResources}
                        aria-label={resourcesLabel}
                    />
                </Tooltip>
                {AGENT_BRIDGE_AVAILABLE ? (
                    <Tooltip title={agentLabel}>
                        <Button
                            type="text"
                            className="!h-9 !w-9 !min-w-9 !rounded-lg !p-0"
                            style={agentOpen ? { background: theme.toolbar.activeBg, color: theme.toolbar.activeText } : { color: theme.node.text }}
                            icon={<Bot className="size-4" />}
                            onClick={onToggleAgent}
                            aria-label={agentLabel}
                        />
                    </Tooltip>
                ) : null}
            </div>
        </div>
    );
}
