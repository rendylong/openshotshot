import { describe, expect, test } from "vitest";

import { EMPTY_PENDING_PROMPT, pendingPromptReducer } from "@/lib/canvas/pending-prompt";

describe("pendingPromptReducer", () => {
    test("SUBMIT sets the prompt and project id", () => {
        const result = pendingPromptReducer(EMPTY_PENDING_PROMPT, { type: "SUBMIT", prompt: "画一只猫", projectId: "p1" });
        expect(result.pendingPrompt).toBe("画一只猫");
        expect(result.pendingProjectId).toBe("p1");
    });

    test("SUBMIT trims whitespace off the prompt", () => {
        const result = pendingPromptReducer(EMPTY_PENDING_PROMPT, { type: "SUBMIT", prompt: "  画一只猫  ", projectId: "p1" });
        expect(result.pendingPrompt).toBe("画一只猫");
    });

    test("SUBMIT with an empty prompt is a no-op", () => {
        const result = pendingPromptReducer(EMPTY_PENDING_PROMPT, { type: "SUBMIT", prompt: "   ", projectId: "p1" });
        expect(result.pendingPrompt).toBeNull();
        expect(result.pendingProjectId).toBeNull();
    });

    test("SUBMIT with a missing project id is a no-op", () => {
        const result = pendingPromptReducer(EMPTY_PENDING_PROMPT, { type: "SUBMIT", prompt: "x", projectId: "" });
        expect(result.pendingPrompt).toBeNull();
        expect(result.pendingProjectId).toBeNull();
    });

    test("CONSUME clears the pending prompt so a second visit does not re-trigger", () => {
        const submitted = pendingPromptReducer(EMPTY_PENDING_PROMPT, { type: "SUBMIT", prompt: "x", projectId: "p1" });
        const consumed = pendingPromptReducer(submitted, { type: "CONSUME" });
        expect(consumed.pendingPrompt).toBeNull();
        expect(consumed.pendingProjectId).toBeNull();
    });

    test("an unknown action keeps the state", () => {
        const state = { pendingPrompt: "x", pendingProjectId: "p1" };
        const result = pendingPromptReducer(state, { type: "UNKNOWN" } as never);
        expect(result.pendingPrompt).toBe("x");
        expect(result.pendingProjectId).toBe("p1");
    });
});
