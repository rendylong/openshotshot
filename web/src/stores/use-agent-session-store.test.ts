import { beforeEach, describe, expect, it } from "vitest";

import type { PiSessionSummary } from "@/lib/agent/pi-agent-types";
import { backgroundSessionCount, useAgentSessionStore } from "./use-agent-session-store";

function summary(sessionId: string, status: PiSessionSummary["status"], updatedAt = 0): PiSessionSummary {
    return { sessionId, title: sessionId, scope: { projectId: "p", canvasId: "c" }, createdAt: 0, updatedAt, status, hasUnfinishedOperation: false };
}

describe("useAgentSessionStore", () => {
    beforeEach(() => {
        useAgentSessionStore.setState({ sessions: [], activeSessionId: null, unreadableSessions: [], pendingUserInputs: {}, pendingApprovals: {} });
    });

    it("upserts sessions ordered by recency without duplicating ids", () => {
        const store = useAgentSessionStore.getState();
        store.upsertSession(summary("a", "idle", 1));
        store.upsertSession(summary("b", "idle", 3));
        store.upsertSession(summary("a", "running", 2));

        const sessions = useAgentSessionStore.getState().sessions;
        expect(sessions.map((item) => item.sessionId)).toEqual(["b", "a"]);
        expect(sessions[1]?.status).toBe("running");
    });

    it("updates one session status without touching others", () => {
        useAgentSessionStore.getState().setSessions([summary("a", "idle"), summary("b", "idle")]);
        useAgentSessionStore.getState().setSessionStatus("a", "compacting", true);

        const sessions = useAgentSessionStore.getState().sessions;
        expect(sessions[0]).toMatchObject({ sessionId: "a", status: "compacting", hasUnfinishedOperation: true });
        expect(sessions[1]).toMatchObject({ sessionId: "b", status: "idle", hasUnfinishedOperation: false });
    });

    it("stores unreadable session diagnostics alongside readable sessions", () => {
        const unreadable = [{ file: "broken.jsonl", error: "invalid JSON" }];
        useAgentSessionStore.getState().setSessions([summary("a", "idle")], unreadable);
        expect(useAgentSessionStore.getState().unreadableSessions).toEqual(unreadable);

        useAgentSessionStore.getState().upsertSession(summary("b", "idle"));
        expect(useAgentSessionStore.getState().unreadableSessions).toEqual(unreadable);
    });

    it("removes a local session and clears the active pointer only for that session", () => {
        useAgentSessionStore.getState().setSessions([summary("a", "idle"), summary("b", "idle")]);
        useAgentSessionStore.getState().setActiveSession("a");
        useAgentSessionStore.getState().removeLocal("a");
        expect(useAgentSessionStore.getState().sessions.map((item) => item.sessionId)).toEqual(["b"]);
        expect(useAgentSessionStore.getState().activeSessionId).toBeNull();

        useAgentSessionStore.getState().setActiveSession("b");
        useAgentSessionStore.getState().removeLocal("a");
        expect(useAgentSessionStore.getState().activeSessionId).toBe("b");
    });

    it("counts only non-active running sessions as background work", () => {
        const sessions = [summary("a", "running"), summary("b", "compacting"), summary("c", "idle"), summary("d", "error"), summary("e", "waiting_input")];
        expect(backgroundSessionCount(sessions, "a")).toBe(2);
        expect(backgroundSessionCount(sessions, "c")).toBe(3);
        expect(backgroundSessionCount(sessions, null)).toBe(3);
    });

    it("keeps one pending user input request per session and clears it after resolution", () => {
        const store = useAgentSessionStore.getState();
        store.setPendingUserInput("a", { requestId: "r1", method: "select", title: "Choose", options: ["A"] });
        store.setPendingUserInput("b", { requestId: "r2", method: "input", title: "Explain" });

        expect(useAgentSessionStore.getState().pendingUserInputs).toEqual({
            a: { requestId: "r1", method: "select", title: "Choose", options: ["A"] },
            b: { requestId: "r2", method: "input", title: "Explain" },
        });

        store.clearPendingUserInput("a", "r1");
        expect(useAgentSessionStore.getState().pendingUserInputs).toEqual({
            b: { requestId: "r2", method: "input", title: "Explain" },
        });
    });

    it("tracks pending approvals per session with deciding state and requestId guard", () => {
        const store = useAgentSessionStore.getState();
        store.setPendingApproval("a", { requestId: "ar1", method: "exec/command/requestApproval", command: "ls -la" });
        store.setPendingApproval("b", { requestId: "ar2", method: "item/fileChange/requestApproval", path: "/tmp/x.md" });

        expect(useAgentSessionStore.getState().pendingApprovals).toEqual({
            a: { requestId: "ar1", method: "exec/command/requestApproval", command: "ls -la" },
            b: { requestId: "ar2", method: "item/fileChange/requestApproval", path: "/tmp/x.md" },
        });

        store.setApprovalDeciding("a", "wrong-id", "accept");
        expect(useAgentSessionStore.getState().pendingApprovals.a?.deciding).toBeUndefined();

        store.setApprovalDeciding("a", "ar1", "acceptForSession");
        expect(useAgentSessionStore.getState().pendingApprovals.a?.deciding).toBe("acceptForSession");

        store.clearPendingApproval("b", "wrong-id");
        expect(useAgentSessionStore.getState().pendingApprovals.b).toBeDefined();

        store.clearPendingApproval("b", "ar2");
        expect(useAgentSessionStore.getState().pendingApprovals.b).toBeUndefined();

        store.removeLocal("a");
        expect(useAgentSessionStore.getState().pendingApprovals).toEqual({});
    });
});
