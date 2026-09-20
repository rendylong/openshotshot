import { describe, expect, it } from "vitest";

import { agentPanelOrderFor } from "./user-layout";

describe("agentPanelOrderFor", () => {
    it("keeps the left-docked panel with the default order so DOM order places it after the sidebar", () => {
        // The panel slot sits between sidebar and canvas in DOM order. All
        // three default to order 0 and ties keep DOM order, so left must stay
        // at 0 — a negative value would dock the panel BEFORE the sidebar.
        expect(agentPanelOrderFor("left")).toBe(0);
    });

    it("sorts the right-docked panel after the canvas", () => {
        expect(agentPanelOrderFor("right")).toBeGreaterThan(0);
    });
});