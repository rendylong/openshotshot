// Pending-prompt handoff: composer home submits a prompt, creates a project,
// and hands the prompt to the canvas route so it can auto-run the Agent.
// The reducer is pure so it can be unit-tested without a store or DOM.

export type PendingPromptState = {
    pendingPrompt: string | null;
    pendingProjectId: string | null;
};

export type PendingPromptAction =
    | { type: "SUBMIT"; prompt: string; projectId: string }
    | { type: "CONSUME" };

export const EMPTY_PENDING_PROMPT: PendingPromptState = { pendingPrompt: null, pendingProjectId: null };

export function pendingPromptReducer(state: PendingPromptState, action: PendingPromptAction): PendingPromptState {
    switch (action.type) {
        case "SUBMIT": {
            const prompt = action.prompt.trim();
            if (!prompt || !action.projectId) return state;
            return { pendingPrompt: prompt, pendingProjectId: action.projectId };
        }
        case "CONSUME":
            return EMPTY_PENDING_PROMPT;
        default:
            return state;
    }
}
