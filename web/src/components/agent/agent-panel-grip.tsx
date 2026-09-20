import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { GripVertical } from "lucide-react";

import type { ChatPanelSide } from "@/stores/use-config-store";
import { useAgentStore } from "@/stores/use-agent-store";

/** Drag this far toward the other side to dock the panel there. */
const DRAG_DOCK_THRESHOLD_PX = 30;

type GripProps = {
    side: ChatPanelSide;
    onSideChange: (side: ChatPanelSide) => void;
};

/**
 * Header drag handle that docks the chat panel to the other side. A short
 * drag (24px) toward the opposite side commits the switch immediately — the
 * panel then animates across and the canvas reflows around it. Dragging
 * further into the panel's own side does nothing.
 */
export function AgentPanelGrip({ side, onSideChange }: GripProps) {
    const { t } = useTranslation();
    const abortRef = useRef<AbortController | null>(null);
    const [dragging, setDragging] = useState(false);

    useEffect(
        () => () => {
            abortRef.current?.abort();
            useAgentStore.getState().setAgentState({ panelGrabbed: false });
        },
        [],
    );

    const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
        // Only respond to primary button presses so right-click / middle-click
        // interactions on the grip remain available to other handlers.
        if (event.button !== 0) return;
        event.preventDefault();
        // Capture so pointermove/up keep flowing even if the pointer leaves
        // the window mid-drag. Synthetic pointers (tests) cannot capture.
        try {
            event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
            /* pointer capture unavailable — window listeners still cover us */
        }
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        const startX = event.clientX;
        setDragging(true);
        // Grabbing lifts the panel off the canvas so the detach is visible
        // before the dock threshold is reached.
        useAgentStore.getState().setAgentState({ panelGrabbed: true });

        const finish = () => {
            controller.abort();
            abortRef.current = null;
            setDragging(false);
            useAgentStore.getState().setAgentState({ panelGrabbed: false });
        };
        const move = (moveEvent: PointerEvent) => {
            const dx = moveEvent.clientX - startX;
            const towardOtherSide = side === "right" ? -dx : dx;
            if (towardOtherSide >= DRAG_DOCK_THRESHOLD_PX) {
                onSideChange(side === "right" ? "left" : "right");
                finish();
            }
        };

        window.addEventListener("pointermove", move, { signal: controller.signal });
        window.addEventListener("pointerup", finish, { signal: controller.signal });
        window.addEventListener("pointercancel", finish, { signal: controller.signal });
    };

    return (
        <button
            type="button"
            aria-label={t("agent.panel.dragToSwitchSide")}
            title={t("agent.panel.dragToSwitchSide")}
            onPointerDown={handlePointerDown}
            className={`grid size-8 shrink-0 touch-none select-none place-items-center rounded-md transition ${dragging ? "cursor-grabbing" : "cursor-grab"} ${dragging ? "bg-stone-200/80 text-stone-700 dark:bg-stone-700/80 dark:text-stone-200" : "hover:bg-stone-200/60 dark:hover:bg-stone-700/60"}`}
        >
            <GripVertical className="size-4" aria-hidden="true" />
        </button>
    );
}