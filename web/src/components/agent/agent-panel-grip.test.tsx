import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import type { ChatPanelSide } from "@/stores/use-config-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { AgentPanelGrip } from "./agent-panel-grip";

function renderGrip(side: ChatPanelSide) {
    const onSideChange = vi.fn();
    render(
        <I18nextProvider i18n={i18n}>
            <AgentPanelGrip side={side} onSideChange={onSideChange} />
        </I18nextProvider>,
    );
    return { grip: screen.getByRole("button", { name: i18n.t("agent.panel.dragToSwitchSide") }), onSideChange };
}

describe("AgentPanelGrip threshold dock", () => {
    beforeEach(() => {
        i18n.changeLanguage("zh-CN");
        useAgentStore.getState().setAgentState({ panelGrabbed: false });
    });

    it("docks left when a right-docked panel is dragged 30px left", () => {
        const { grip, onSideChange } = renderGrip("right");
        fireEvent.pointerDown(grip, { button: 0, clientX: 900 });
        fireEvent.pointerMove(window, { clientX: 870 });
        expect(onSideChange).toHaveBeenCalledTimes(1);
        expect(onSideChange).toHaveBeenCalledWith("left");
    });

    it("docks right when a left-docked panel is dragged 30px right", () => {
        const { grip, onSideChange } = renderGrip("left");
        fireEvent.pointerDown(grip, { button: 0, clientX: 100 });
        fireEvent.pointerMove(window, { clientX: 130 });
        expect(onSideChange).toHaveBeenCalledTimes(1);
        expect(onSideChange).toHaveBeenCalledWith("right");
    });

    it("does not dock before the threshold", () => {
        const { grip, onSideChange } = renderGrip("right");
        fireEvent.pointerDown(grip, { button: 0, clientX: 900 });
        fireEvent.pointerMove(window, { clientX: 871 });
        expect(onSideChange).not.toHaveBeenCalled();
        fireEvent.pointerUp(window, { clientX: 871 });
        expect(onSideChange).not.toHaveBeenCalled();
    });

    it("does not dock when dragged further into the panel's own side", () => {
        const { grip, onSideChange } = renderGrip("right");
        fireEvent.pointerDown(grip, { button: 0, clientX: 900 });
        fireEvent.pointerMove(window, { clientX: 950 });
        fireEvent.pointerUp(window, { clientX: 950 });
        expect(onSideChange).not.toHaveBeenCalled();
    });

    it("commits at most one dock per drag", () => {
        const { grip, onSideChange } = renderGrip("right");
        fireEvent.pointerDown(grip, { button: 0, clientX: 900 });
        fireEvent.pointerMove(window, { clientX: 800 });
        fireEvent.pointerMove(window, { clientX: 700 });
        fireEvent.pointerUp(window, { clientX: 100 });
        expect(onSideChange).toHaveBeenCalledTimes(1);
    });

    it("lifts the panel while grabbed and settles it on release", () => {
        const { grip } = renderGrip("right");
        fireEvent.pointerDown(grip, { button: 0, clientX: 900 });
        expect(useAgentStore.getState().panelGrabbed).toBe(true);
        fireEvent.pointerUp(window, { clientX: 890 });
        expect(useAgentStore.getState().panelGrabbed).toBe(false);
    });

    it("settles the panel when a drag commits the dock", () => {
        const { grip } = renderGrip("right");
        fireEvent.pointerDown(grip, { button: 0, clientX: 900 });
        fireEvent.pointerMove(window, { clientX: 860 });
        expect(useAgentStore.getState().panelGrabbed).toBe(false);
    });

    it("settles the panel on a cancelled drag", () => {
        const { grip, onSideChange } = renderGrip("right");
        fireEvent.pointerDown(grip, { button: 0, clientX: 900 });
        fireEvent.pointerCancel(window, { clientX: 800 });
        expect(onSideChange).not.toHaveBeenCalled();
        expect(useAgentStore.getState().panelGrabbed).toBe(false);
        expect(grip.className).not.toContain("cursor-grabbing");
    });
});

describe("AgentPanelGrip side", () => {
    it.each<[string, ChatPanelSide]>([
        ["right", "right"],
        ["left", "left"],
    ])("renders for side %s", (label, side) => {
        const { grip } = renderGrip(side);
        expect(grip).toBeInTheDocument();
    });
});