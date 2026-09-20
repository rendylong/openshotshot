import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";

import { PiAgentPanel } from "./pi-agent-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { CANVAS_AGENT_PANEL_MOTION_MS, useAgentStore } from "@/stores/use-agent-store";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

const PANEL_MOTION_SECONDS = CANVAS_AGENT_PANEL_MOTION_MS / 1000;

// The Pi agent host only exists behind the Electron preload bridge; without it
// the panel shell would render as an empty docked column.
const AGENT_BRIDGE_AVAILABLE = typeof window !== "undefined" && Boolean(window.shotshot?.agent);

export function AgentPanel() {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const width = useAgentStore((state) => state.width);
    const [resizing, setResizing] = useState(false);
    const panelMounted = useAgentStore((state) => state.panelMounted);
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const panelClosing = useAgentStore((state) => state.panelClosing);
    const panelGrabbed = useAgentStore((state) => state.panelGrabbed);
    const setAgentState = useAgentStore((state) => state.setAgentState);
    // Side changes are animated by UserLayout (FLIP on the panel slot and the
    // canvas), so the panel itself renders the stored side directly.
    const side = useConfigStore((state) => state.config.chatPanelSide);

    const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        let nextWidth = startWidth;
        const onMove = (moveEvent: PointerEvent) => {
            // When the panel sits on the right, dragging the handle inward
            // (to the left) shrinks the panel width. On the left side the
            // direction is reversed so the drag still feels intuitive.
            const delta = side === "right" ? startX - moveEvent.clientX : moveEvent.clientX - startX;
            nextWidth = Math.min(760, Math.max(360, startWidth + delta));
            setAgentState({ width: nextWidth });
        };
        const onUp = () => {
            localStorage.setItem("canvas-agent-panel-width", String(nextWidth));
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            setResizing(false);
        };
        setResizing(true);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    if (!panelMounted || !AGENT_BRIDGE_AVAILABLE) return null;

    const borderClass = side === "right" ? "border-l" : "border-r";
    // Grabbing detaches the panel as a rounded card with a full light border;
    // docked, it is a flat column with a single divider on its inner edge.
    const frameClass = panelGrabbed ? "border" : borderClass;
    const resizeClass =
        side === "right"
            ? "absolute inset-y-0 left-0 z-40 w-4 -translate-x-1/2 cursor-col-resize"
            : "absolute inset-y-0 right-0 z-40 w-4 translate-x-1/2 cursor-col-resize";
    const slideClosingX = side === "right" ? 28 : -28;

    return (
        <motion.div
            className="relative z-[70] flex h-full shrink-0"
            initial={false}
            animate={{ width: panelOpen ? width + 1 : 0, opacity: panelOpen ? 1 : 0 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "clip", pointerEvents: panelOpen && !panelClosing ? undefined : "none" }}
        >
            <motion.aside
                className={`relative flex h-full shrink-0 flex-col ${frameClass}`}
                data-canvas-shortcuts-ignore
                initial={false}
                animate={{
                    x: panelClosing ? slideClosingX : 0,
                    // Grabbing the grip lifts the panel off the canvas.
                    scale: panelGrabbed ? 0.98 : 1,
                    boxShadow: panelGrabbed ? "0 18px 48px rgba(0,0,0,0.22)" : "0 0 0 rgba(0,0,0,0)",
                    borderRadius: panelGrabbed ? 12 : 0,
                }}
                transition={{
                    x: { duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] },
                    scale: { duration: 0.18 },
                    boxShadow: { duration: 0.18 },
                    borderRadius: { duration: 0.18 },
                }}
                style={{ width, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            >
                <button type="button" className={resizeClass} onPointerDown={startResize} aria-label={t("agent.panel.resize")} />
                <PiAgentPanel />
            </motion.aside>
        </motion.div>
    );
}