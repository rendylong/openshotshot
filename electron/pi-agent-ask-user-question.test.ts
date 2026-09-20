import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { PiSessionEnvelope } from "@/lib/agent/pi-agent-types";
import { shotshotAskUserQuestion } from "./pi-agent-ask-user-question";
import { createPiExtensionUIBroker } from "./pi-extension-ui";

function setupBroker(createRequestId: () => string) {
    const envelopes: PiSessionEnvelope[] = [];
    const broker = createPiExtensionUIBroker({ send: (envelope) => envelopes.push(envelope), createRequestId });
    let tool: { execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }> } | undefined;
    shotshotAskUserQuestion({ registerTool: (registered: typeof tool) => { tool = registered; } } as never);
    return { envelopes, broker, tool: tool! };
}

const questions = [
    {
        id: "style",
        type: "radio" as const,
        prompt: "Which style?",
        label: "Style",
        options: [
            { value: "minimal", label: "Minimal" },
            { value: "detailed", label: "Detailed" },
        ],
        allowOther: false,
    },
    {
        id: "tags",
        type: "checkbox" as const,
        prompt: "Which tags?",
        label: "Tags",
        options: [{ value: "alpha", label: "Alpha" }],
        allowOther: true,
        allowComment: true,
    },
];

describe("shotshotAskUserQuestion", () => {
    it("drives the full form through the host form channel and formats upstream-compatible answers", async () => {
        const { envelopes, broker, tool } = setupBroker(() => "form-request");
        const context = broker.createContext(() => "session-1");

        const resultPromise = tool.execute("tool-call", { title: "Setup", questions }, undefined, undefined, { hasUI: true, ui: context });

        await vi.waitFor(() => expect(envelopes).toHaveLength(1));
        expect(envelopes[0]).toMatchObject({
            kind: "user_input",
            payload: { type: "request", request: { method: "form", title: "Setup" } },
        });
        broker.respond("session-1", "form-request", {
            answers: [
                { questionId: "style", values: ["minimal"] },
                { questionId: "tags", values: ["alpha"], customText: "Custom", comment: " Note " },
            ],
        });

        const result = await resultPromise;
        expect(result).toMatchObject({
            content: [{ type: "text", text: "Style: minimal\nTags: alpha, Custom\n  Comment: Note" }],
        });
        expect(result.details).toMatchObject({ cancelled: false, title: "Setup" });
    });

    it("keeps the upstream rephrase escape hatch for a blank Other submission", async () => {
        const { envelopes, broker, tool } = setupBroker(() => "form-request");
        const context = broker.createContext(() => "session-1");

        const resultPromise = tool.execute("tool-call", { questions }, undefined, undefined, { hasUI: true, ui: context });
        await vi.waitFor(() => expect(envelopes).toHaveLength(1));
        broker.respond("session-1", "form-request", {
            answers: [{ questionId: "tags", values: [], customText: "" }],
        });

        const result = await resultPromise;
        expect(result).toMatchObject({
            content: [{
                type: "text",
                text: [
                    "Style: ",
                    "Tags: (user asked to rephrase, split, or follow up on this question)",
                    "",
                    "Note: rephrase or split the flagged question(s) instead of asking again as written.",
                ].join("\n"),
            }],
        });
    });

    it("reports cancellation with the upstream text", async () => {
        const { envelopes, broker, tool } = setupBroker(() => "form-request");
        const context = broker.createContext(() => "session-1");

        const resultPromise = tool.execute("tool-call", { questions }, undefined, undefined, { hasUI: true, ui: context });
        await vi.waitFor(() => expect(envelopes).toHaveLength(1));
        broker.respond("session-1", "form-request", { cancelled: true });

        await expect(resultPromise).resolves.toMatchObject({
            content: [{ type: "text", text: "User cancelled the form" }],
            details: { cancelled: true },
        });
    });

    it("falls back to the packaged sequential dialogs when the host has no form channel", async () => {
        const { envelopes, broker, tool } = setupBroker(() => "fallback-request");
        const context = { ...broker.createContext(() => "session-1"), form: undefined };

        const resultPromise = tool.execute(
            "tool-call",
            {
                questions: [{
                    id: "database",
                    type: "radio",
                    prompt: "Which database?",
                    label: "Database",
                    options: [{ value: "postgres", label: "PostgreSQL" }],
                    allowOther: false,
                }],
            },
            undefined,
            undefined,
            { hasUI: true, ui: context },
        );

        await vi.waitFor(() => expect(envelopes).toHaveLength(1));
        expect(envelopes[0]).toMatchObject({
            kind: "user_input",
            payload: { type: "request", request: { method: "select", title: "Which database? *", options: ["PostgreSQL"] } },
        });
        broker.respond("session-1", "fallback-request", { value: "PostgreSQL" });

        await expect(resultPromise).resolves.toMatchObject({ content: [{ type: "text", text: "Database: postgres" }] });
    });
});
