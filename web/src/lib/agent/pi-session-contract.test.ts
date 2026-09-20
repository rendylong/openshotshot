import { describe, expect, it } from "vitest";

import type { PiSessionStatus } from "./pi-agent-types";
import {
    PI_SESSION_ENVELOPE_KINDS,
    PI_SESSION_STATUSES,
    isAgentApprovalMode,
    isPiSessionStatus,
    isValidSessionId,
    parseSessionEnvelope,
    parseSessionEntryRange,
    parseSessionScope,
    parseAgentApprovalEvent,
    parseAgentUserInputEvent,
    sessionStatusFromAgentEvent,
} from "./pi-session-contract";

const SESSION_ID = "0194f6c0-a8b1-7abc-9def-0123456789ab";

describe("pi session contract", () => {
    describe("parseSessionEnvelope", () => {
        it("locks the envelope kind union to the protocol set", () => {
            expect([...PI_SESSION_ENVELOPE_KINDS]).toEqual(["agent", "ops", "attachment_import", "user_input", "approval_request", "session_compact_failed", "error"]);
        });

        it.each([...PI_SESSION_ENVELOPE_KINDS])("accepts every envelope kind: %s", (kind) => {
            const payload = kind === "agent" ? { type: "compaction_start", reason: "manual" } : { message: "offline" };
            const raw = { sessionId: SESSION_ID, kind, payload, extra: "ignored" };

            const parsed = parseSessionEnvelope(raw);

            expect(parsed).toEqual({ sessionId: SESSION_ID, kind, payload });
            // 返回纯净投影：不是原对象引用，未知字段被剥离，payload 引用原样透传。
            expect(parsed).not.toBe(raw);
            expect(parsed?.payload).toBe(payload);
        });

        it("rejects non-object and malformed envelopes", () => {
            for (const raw of [null, undefined, "agent", 42, true, [], {}]) {
                expect(parseSessionEnvelope(raw)).toBeNull();
            }
        });

        it("rejects invalid session ids", () => {
            for (const sessionId of ["", " ", "-leading", "trailing-", ".leading", "trailing.", "has space", "slash/id", 42, null, undefined]) {
                expect(parseSessionEnvelope({ sessionId, kind: "agent", payload: { type: "agent_start" } })).toBeNull();
            }
        });

        it("rejects unknown kinds and missing payloads", () => {
            const payload = { type: "agent_start" };
            for (const kind of ["agent_event", "OPS", "", "compaction_start", undefined, null, 42]) {
                expect(parseSessionEnvelope({ sessionId: SESSION_ID, kind, payload })).toBeNull();
            }
            expect(parseSessionEnvelope({ sessionId: SESSION_ID, kind: "agent" })).toBeNull();
            expect(parseSessionEnvelope({ sessionId: SESSION_ID, kind: "agent", payload: undefined })).toBeNull();
            expect(parseSessionEnvelope({ sessionId: SESSION_ID, kind: "error", payload: null })).toBeNull();
        });
    });

    describe("parseSessionScope", () => {
        it("accepts a valid scope and strips unknown fields", () => {
            const raw = { projectId: "project-1", canvasId: "canvas-1", extra: "ignored" };

            const parsed = parseSessionScope(raw);

            expect(parsed).toEqual({ projectId: "project-1", canvasId: "canvas-1" });
            expect(parsed).not.toBe(raw);
        });

        it("rejects malformed scope field values", () => {
            for (const raw of [
                null,
                undefined,
                "project-1/canvas-1",
                42,
                [],
                {},
                { projectId: "project-1" },
                { canvasId: "canvas-1" },
                { projectId: 42, canvasId: "canvas-1" },
                { projectId: "project-1", canvasId: null },
                { projectId: ["project-1"], canvasId: "canvas-1" },
            ]) {
                expect(parseSessionScope(raw)).toBeNull();
            }
        });

        it("rejects empty or mixed-empty scope (skill conversations use the uncategorized canvas)", () => {
            expect(parseSessionScope({ projectId: "" })).toBeNull();
            expect(parseSessionScope({ canvasId: "" })).toBeNull();
            expect(parseSessionScope({ projectId: 1, canvasId: "" })).toBeNull();
            expect(parseSessionScope("")).toBeNull();
            expect(parseSessionScope({ projectId: "", canvasId: "" })).toBeNull();
            expect(parseSessionScope({ projectId: "", canvasId: "canvas-1" })).toBeNull();
            expect(parseSessionScope({ projectId: "project-1", canvasId: "" })).toBeNull();
        });
    });

    describe("session id contract", () => {
        it("accepts SDK-compatible session ids", () => {
            for (const id of [SESSION_ID, "a", "A-b_c.d-E", "0194f6c0a8b17abc9def0123456789ab"]) {
                expect(isValidSessionId(id)).toBe(true);
            }
        });

        it("rejects session ids outside the SDK alphabet", () => {
            for (const id of ["", ".abc", "abc.", "-abc", "abc-", "ab cd", "ab/cd", "ab:cd", 42, null, undefined, {}]) {
                expect(isValidSessionId(id)).toBe(false);
            }
        });
    });

    describe("PiSessionStatus contract", () => {
        it("exposes the complete status union", () => {
            expect([...PI_SESSION_STATUSES]).toEqual(["idle", "running", "queued", "waiting_approval", "waiting_input", "compacting", "interrupted", "error"]);
        });

        it("accepts every status value and rejects unknown ones", () => {
            const statuses: readonly PiSessionStatus[] = PI_SESSION_STATUSES;
            for (const status of statuses) {
                expect(isPiSessionStatus(status)).toBe(true);
            }
            for (const status of ["pending", "paused", "", "RUNNING", undefined, null, 1]) {
                expect(isPiSessionStatus(status)).toBe(false);
            }
        });
    });

    it("accepts session-scoped user input envelopes", () => {
        expect(parseSessionEnvelope({
            sessionId: "session-1",
            kind: "user_input",
            payload: {
                type: "request",
                request: { requestId: "request-1", method: "select", title: "Choose", options: ["A", "B"] },
            },
        })).toEqual({
            sessionId: "session-1",
            kind: "user_input",
            payload: {
                type: "request",
                request: { requestId: "request-1", method: "select", title: "Choose", options: ["A", "B"] },
            },
        });
    });

    it("validates user input event payloads before storing them", () => {
        expect(parseAgentUserInputEvent({ type: "request", request: { requestId: "r1", method: "input", title: "Details", placeholder: "Optional" } })).toEqual({
            type: "request",
            request: { requestId: "r1", method: "input", title: "Details", placeholder: "Optional" },
        });
        expect(parseAgentUserInputEvent({ type: "resolved", requestId: "r1" })).toEqual({ type: "resolved", requestId: "r1" });
        for (const value of [null, {}, { type: "resolved", requestId: "" }, { type: "request", request: { requestId: "r1", method: "select", title: "Choose", options: [1] } }]) {
            expect(parseAgentUserInputEvent(value)).toBeNull();
        }
    });

    it("accepts form requests with normalized questions and optional title/description", () => {
        const question = {
            id: "q1",
            type: "radio",
            prompt: "Which database?",
            label: "DB",
            options: [{ value: "postgres", label: "PostgreSQL", description: "default engine" }],
            allowOther: true,
            allowComment: false,
            required: true,
        };
        expect(parseAgentUserInputEvent({ type: "request", request: { requestId: "r2", method: "form", title: "Setup", questions: [question] } })).toEqual({
            type: "request",
            request: { requestId: "r2", method: "form", title: "Setup", questions: [question] },
        });
        expect(parseAgentUserInputEvent({
            type: "request",
            request: {
                requestId: "r3",
                method: "form",
                description: "Free text",
                questions: [{ ...question, type: "text", options: [], placeholder: "备注", default: "abc" }],
            },
        })).toEqual({
            type: "request",
            request: {
                requestId: "r3",
                method: "form",
                description: "Free text",
                questions: [{ ...question, type: "text", options: [], placeholder: "备注", default: "abc" }],
            },
        });
    });

    it("rejects malformed form requests without partial degradation", () => {
        const question = { id: "q1", type: "radio", prompt: "Q", label: "DB", options: [{ value: "a", label: "A" }], allowOther: true, allowComment: false, required: true };
        const base = { requestId: "r2", method: "form", questions: [question] as unknown[] };
        expect(parseAgentUserInputEvent({ type: "request", request: base })).not.toBeNull();
        const malformedQuestions = [
            [],
            [null],
            [{ ...question, id: "" }],
            [{ ...question, type: "dropdown" }],
            [{ ...question, prompt: 5 }],
            [{ ...question, options: "a" }],
            [{ ...question, options: [{ value: "a" }] }],
            [{ ...question, allowOther: 1 }],
            [{ ...question, default: 3 }],
        ];
        for (const questions of malformedQuestions) {
            expect(parseAgentUserInputEvent({ type: "request", request: { ...base, questions } })).toBeNull();
        }
        for (const title of ["", 3]) {
            expect(parseAgentUserInputEvent({ type: "request", request: { ...base, title } })).toBeNull();
        }
    });

    describe("sessionStatusFromAgentEvent", () => {
        it("maps terminal compaction, cleared queues, retries, and queued work consistently", () => {
            expect(sessionStatusFromAgentEvent("agent", "compaction_end", { willRetry: false })).toBe("idle");
            expect(sessionStatusFromAgentEvent("agent", "queue_update", { followUp: [], steering: [] })).toBe("idle");
            expect(sessionStatusFromAgentEvent("agent", "agent_end", { willRetry: true, messages: [] })).toBe("running");
            expect(sessionStatusFromAgentEvent("agent", "queue_update", { followUp: ["next"], steering: [] })).toBe("queued");
        });

        it("keeps malformed queue payloads and unrelated events neutral", () => {
            expect(sessionStatusFromAgentEvent("agent", "queue_update", { followUp: ["next"] })).toBeNull();
            expect(sessionStatusFromAgentEvent("agent", "message_end", { message: null })).toBeNull();
        });
    });

    describe("parseSessionEntryRange", () => {
        it("treats absent range as a valid empty range and accepts partial ranges", () => {
            expect(parseSessionEntryRange(undefined)).toEqual({});
            expect(parseSessionEntryRange({})).toEqual({});
            expect(parseSessionEntryRange({ fromEntryId: "e1" })).toEqual({ fromEntryId: "e1" });
            expect(parseSessionEntryRange({ toEntryId: "e9" })).toEqual({ toEntryId: "e9" });
            expect(parseSessionEntryRange({ fromEntryId: "e1", toEntryId: "e9", extra: "ignored" })).toEqual({ fromEntryId: "e1", toEntryId: "e9" });
        });

        it("rejects malformed ranges", () => {
            for (const raw of [null, "e1", 42, [], { fromEntryId: "" }, { fromEntryId: 3 }, { toEntryId: null }, { fromEntryId: undefined, toEntryId: "" }]) {
                expect(parseSessionEntryRange(raw)).toBeNull();
            }
        });
    });

    describe("approval protocol", () => {
        it("accepts the approval_request envelope kind", () => {
            const envelope = { sessionId: SESSION_ID, kind: "approval_request", payload: { type: "resolved", requestId: "r1" } };
            expect(parseSessionEnvelope(envelope)).toEqual(envelope);
            expect(PI_SESSION_ENVELOPE_KINDS).toContain("approval_request");
        });

        it("validates approval mode values", () => {
            expect(isAgentApprovalMode("confirm_changes")).toBe(true);
            expect(isAgentApprovalMode("full_access")).toBe(true);
            for (const value of ["confirm", "auto", "", null, undefined, 1]) {
                expect(isAgentApprovalMode(value)).toBe(false);
            }
        });

        it("parses command and fileChange approval requests and resolutions", () => {
            expect(parseAgentApprovalEvent({ type: "request", requestId: "r1", approval: { method: "exec/command/requestApproval", command: "ls -la" } })).toEqual({
                type: "request",
                requestId: "r1",
                approval: { method: "exec/command/requestApproval", command: "ls -la" },
            });
            expect(parseAgentApprovalEvent({ type: "request", requestId: "r2", approval: { method: "item/fileChange/requestApproval", path: "/tmp/a.md", reason: "请求编辑文件内容" } })).toEqual({
                type: "request",
                requestId: "r2",
                approval: { method: "item/fileChange/requestApproval", path: "/tmp/a.md", reason: "请求编辑文件内容" },
            });
            expect(parseAgentApprovalEvent({ type: "resolved", requestId: "r1" })).toEqual({ type: "resolved", requestId: "r1" });
        });

        it("preserves cwd on command approval requests", () => {
            expect(parseAgentApprovalEvent({ type: "request", requestId: "r3", approval: { method: "exec/command/requestApproval", command: "ls", cwd: "/tmp" } })).toEqual({
                type: "request",
                requestId: "r3",
                approval: { method: "exec/command/requestApproval", command: "ls", cwd: "/tmp" },
            });
        });

        it("rejects malformed approval events", () => {
            for (const raw of [
                null,
                42,
                { type: "resolved" },
                { type: "request", requestId: "" },
                { type: "request", requestId: "r1" },
                { type: "request", requestId: "r1", approval: { method: "exec/command/requestApproval" } },
                { type: "request", requestId: "r1", approval: { method: "exec/command/requestApproval", command: "" } },
                { type: "request", requestId: "r1", approval: { method: "item/fileChange/requestApproval" } },
                { type: "request", requestId: "r1", approval: { method: "custom/other", path: "/tmp/a.md" } },
            ]) {
                expect(parseAgentApprovalEvent(raw)).toBeNull();
            }
        });
    });
});
