import { describe, expect, it, vi } from "vitest";
import askUserQuestion from "pi-mono-ask-user-question/index";

import type { PiSessionEnvelope } from "@/lib/agent/pi-agent-types";
import { createPiExtensionUIBroker } from "./pi-extension-ui";

describe("createPiExtensionUIBroker", () => {
    it("runs the packaged ask_user_question extension through the Electron UI fallback", async () => {
        const envelopes: PiSessionEnvelope[] = [];
        const broker = createPiExtensionUIBroker({
            send: (envelope) => envelopes.push(envelope),
            createRequestId: () => "packaged-request",
        });
        let tool: { execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }> }> } | undefined;
        askUserQuestion({ registerTool: (registered: typeof tool) => { tool = registered; } } as never);

        const resultPromise = tool!.execute(
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
            { hasUI: true, ui: broker.createContext(() => "session-1") },
        );

        await vi.waitFor(() => expect(envelopes).toHaveLength(1));
        expect(envelopes[0]).toMatchObject({
            kind: "user_input",
            payload: { type: "request", request: { method: "select", title: "Which database? *", options: ["PostgreSQL"] } },
        });
        broker.respond("session-1", "packaged-request", { value: "PostgreSQL" });

        await expect(resultPromise).resolves.toMatchObject({ content: [{ type: "text", text: "Database: postgres" }] });
    });

    it("forwards a select request and resolves only an offered option", async () => {
        const envelopes: PiSessionEnvelope[] = [];
        const waiting = vi.fn();
        const broker = createPiExtensionUIBroker({
            send: (envelope) => envelopes.push(envelope),
            onWaitingChange: waiting,
            createRequestId: () => "request-1",
        });
        const context = broker.createContext(() => "session-1");

        const selected = context.select("Choose a direction", ["A", "B"]);

        expect(envelopes).toEqual([{
            sessionId: "session-1",
            kind: "user_input",
            payload: {
                type: "request",
                request: { requestId: "request-1", method: "select", title: "Choose a direction", options: ["A", "B"] },
            },
        }]);
        expect(waiting).toHaveBeenLastCalledWith("session-1", true);
        expect(broker.respond("session-1", "request-1", { value: "C" })).toEqual({ ok: false, error: "非法用户选项" });
        expect(broker.respond("session-1", "request-1", { value: "B" })).toEqual({ ok: true });
        await expect(selected).resolves.toBe("B");
        expect(envelopes.at(-1)).toEqual({
            sessionId: "session-1",
            kind: "user_input",
            payload: { type: "resolved", requestId: "request-1" },
        });
        expect(waiting).toHaveBeenLastCalledWith("session-1", false);
    });

    it("accepts an empty input value so the extension can interpret it", async () => {
        const broker = createPiExtensionUIBroker({
            send: () => undefined,
            createRequestId: () => "request-2",
        });
        const context = broker.createContext(() => "session-1");

        const answer = context.input("Anything else?", "Optional");
        expect(broker.respond("session-1", "request-2", { value: "" })).toEqual({ ok: true });
        await expect(answer).resolves.toBe("");
    });

    it("cancels a pending request when the tool aborts", async () => {
        const envelopes: PiSessionEnvelope[] = [];
        const controller = new AbortController();
        const broker = createPiExtensionUIBroker({
            send: (envelope) => envelopes.push(envelope),
            createRequestId: () => "request-3",
        });
        const context = broker.createContext(() => "session-1");

        const answer = context.select("Choose", ["A"], { signal: controller.signal });
        controller.abort();

        await expect(answer).resolves.toBeUndefined();
        expect(envelopes.at(-1)).toEqual({
            sessionId: "session-1",
            kind: "user_input",
            payload: { type: "resolved", requestId: "request-3" },
        });
        expect(broker.respond("session-1", "request-3", { value: "A" })).toEqual({ ok: false, error: "用户输入请求不存在或已结束" });
    });

    const formQuestions = [{
        id: "style",
        type: "radio" as const,
        prompt: "Which style?",
        label: "Style",
        options: [{ value: "minimal", label: "Minimal" }],
        allowOther: false,
        allowComment: false,
        required: true,
    }];

    it("round-trips a form request and validates the submitted answers", async () => {
        const envelopes: PiSessionEnvelope[] = [];
        const broker = createPiExtensionUIBroker({
            send: (envelope) => envelopes.push(envelope),
            createRequestId: () => "form-request",
        });
        const context = broker.createContext(() => "session-1");

        const submitted = context.form("Setup", "Context", formQuestions);

        expect(envelopes[0]).toMatchObject({
            sessionId: "session-1",
            kind: "user_input",
            payload: { type: "request", request: { requestId: "form-request", method: "form", title: "Setup", description: "Context", questions: formQuestions } },
        });
        expect(broker.respond("session-1", "form-request", { answers: [{ questionId: "missing", values: [] }] })).toEqual({ ok: false, error: "非法用户表单回答" });
        expect(broker.respond("session-1", "form-request", { answers: [{ questionId: "style", values: ["minimal", "detailed"] }] })).toEqual({ ok: false, error: "非法用户表单回答" });
        expect(broker.respond("session-1", "form-request", { answers: [{ questionId: "style", values: ["not-an-option"] }] })).toEqual({ ok: false, error: "非法用户表单回答" });

        const answers = [{ questionId: "style", values: ["minimal"] }];
        expect(broker.respond("session-1", "form-request", { answers })).toEqual({ ok: true });
        await expect(submitted).resolves.toBe(answers);
    });

    it("resolves a form with undefined when the request is cancelled or aborted", async () => {
        const envelopes: PiSessionEnvelope[] = [];
        const controller = new AbortController();
        const broker = createPiExtensionUIBroker({
            send: (envelope) => envelopes.push(envelope),
            createRequestId: () => "form-request",
        });
        const context = broker.createContext(() => "session-1");

        const cancelled = context.form(undefined, undefined, formQuestions);
        expect(broker.respond("session-1", "form-request", { cancelled: true })).toEqual({ ok: true });
        await expect(cancelled).resolves.toBeUndefined();
        expect(envelopes[0].payload).toMatchObject({ request: { method: "form", questions: formQuestions } });
        expect("title" in (envelopes[0].payload as { request: { title?: string } }).request).toBe(false);

        const aborted = context.form(undefined, undefined, formQuestions, { signal: controller.signal });
        controller.abort();
        await expect(aborted).resolves.toBeUndefined();
    });
});
