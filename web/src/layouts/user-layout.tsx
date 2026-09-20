import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

import { AgentPanel } from "@/components/agent/agent-panel";
import { AccountRuntime } from "@/components/layout/account-runtime";
import { AppConfigModal } from "@/components/layout/app-config-modal";
import { AppReleaseForceModal } from "@/components/layout/app-release-force-modal";
import { AppReleaseRuntime } from "@/components/layout/app-release-runtime";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { useConfigStore, type ChatPanelSide } from "@/stores/use-config-store";
import { VersionReleaseModal } from "@/components/layout/version-release-modal";

/**
 * The panel slot sits between the sidebar and the canvas in DOM order. Every
 * flex item defaults to `order: 0` and ties keep DOM order, so `0` docks the
 * panel right after the sidebar (left dock); `1` sorts it after the canvas
 * (right dock). Left must never be negative — that would place the panel
 * before the sidebar.
 */
export function agentPanelOrderFor(side: ChatPanelSide) {
    return side === "left" ? 0 : 1;
}

const PANEL_DOCK_MOTION_MS = 300;
const PANEL_DOCK_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

export default function UserLayout({ children }: { children: ReactNode }) {
    const { pathname } = useLocation();
    const isMacDesktop = window.shotshot?.platform === "darwin";
    // AgentPanel is canvas-route-only (canvas-restructure D3; skill conversations
    // open on their uncategorized canvas — see
    // docs/superpowers/specs/2026-09-14-skill-create-agent-handoff-design.md §10).
    const isAgentSurface = /^\/canvas\/[^/]+/.test(pathname);
    const chatPanelSide = useConfigStore((state) => state.config.chatPanelSide);
    const agentPanelOrder = agentPanelOrderFor(chatPanelSide);
    const panelSlotRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLDivElement>(null);
    const flipFromRef = useRef<{ panelLeft: number; canvasLeft: number } | null>(null);
    const flipGenRef = useRef(0);

    // Capture the pre-flip positions synchronously when the docked side
    // changes, before React re-renders with the new order.
    useEffect(
        () =>
            useConfigStore.subscribe((state, prev) => {
                if (state.config.chatPanelSide === prev.config.chatPanelSide) return;
                flipFromRef.current = {
                    panelLeft: panelSlotRef.current?.getBoundingClientRect().left ?? 0,
                    canvasLeft: canvasRef.current?.getBoundingClientRect().left ?? 0,
                };
            }),
        [],
    );

    // FLIP: the order swap re-positions both columns instantly; park them at
    // their pre-flip spot with an inverse transform, then glide to rest. The
    // panel travels across and the canvas is pushed aside — no re-appear.
    // The slot itself carries z-[70]: the FLIP transform creates a stacking
    // context, so the inner panel's z-index alone would let the (later in
    // tree order) canvas paint over the gliding panel.
    useLayoutEffect(() => {
        const from = flipFromRef.current;
        flipFromRef.current = null;
        if (!from) return;
        const targets: Array<[HTMLElement | null, number]> = [
            [panelSlotRef.current, from.panelLeft],
            [canvasRef.current, from.canvasLeft],
        ];
        const gen = ++flipGenRef.current;
        for (const [el, fromLeft] of targets) {
            if (!el) continue;
            const dx = fromLeft - el.getBoundingClientRect().left;
            if (!dx) continue;
            el.style.transition = "none";
            el.style.transform = `translateX(${dx}px)`;
        }
        const raf = requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (gen !== flipGenRef.current) return;
                for (const [el] of targets) {
                    if (!el) continue;
                    el.style.transition = `transform ${PANEL_DOCK_MOTION_MS}ms ${PANEL_DOCK_EASE}`;
                    el.style.transform = "";
                }
            });
        });
        return () => cancelAnimationFrame(raf);
    }, [chatPanelSide]);

    return (
        <div className="relative flex h-dvh overflow-hidden bg-background text-foreground">
            <AccountRuntime />
            <AppReleaseRuntime />
            {isMacDesktop ? <div className="native-titlebar-drag-region" aria-hidden="true" /> : null}
            <AppSidebar />
            {isAgentSurface ? (
                <div ref={panelSlotRef} className="relative z-[70] flex h-full shrink-0" style={{ order: agentPanelOrder }}>
                    <AgentPanel />
                </div>
            ) : null}
            <div ref={canvasRef} className="min-w-0 flex-1 overflow-hidden">
                {children}
            </div>
            <AppConfigModal />
            <AppReleaseForceModal />
            <VersionReleaseModal />
        </div>
    );
}
