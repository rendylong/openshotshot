import { create } from "zustand";

import type { AgentApprovalDecision, AgentApprovalRequest, AgentUserInputRequest, PiSessionStatus, PiSessionSummary, PiSessionSummaryListResult } from "@/lib/agent/pi-agent-types";

export type AgentPendingApprovalItem = AgentApprovalRequest & { deciding?: AgentApprovalDecision };

// SDK session 的 renderer 视图状态：只保存列表与 active 指针，不复制消息内容。
// 消息权威在主进程 SessionManager 的 JSONL entries；切换页面不触发这里的状态清理。
export type AgentSessionStoreState = {
    sessions: PiSessionSummary[];
    unreadableSessions: PiSessionSummaryListResult["unreadable"];
    activeSessionId: string | null;
    pendingUserInputs: Record<string, AgentUserInputRequest>;
    pendingApprovals: Record<string, AgentPendingApprovalItem>;
    setActiveSession: (sessionId: string | null) => void;
    setSessions: (sessions: PiSessionSummary[], unreadable?: PiSessionSummaryListResult["unreadable"]) => void;
    upsertSession: (summary: PiSessionSummary) => void;
    setSessionStatus: (sessionId: string, status: PiSessionStatus, hasUnfinishedOperation?: boolean) => void;
    setPendingUserInput: (sessionId: string, request: AgentUserInputRequest) => void;
    clearPendingUserInput: (sessionId: string, requestId?: string) => void;
    setPendingApproval: (sessionId: string, approval: AgentPendingApprovalItem) => void;
    clearPendingApproval: (sessionId: string, requestId?: string) => void;
    setApprovalDeciding: (sessionId: string, requestId: string, deciding?: AgentApprovalDecision) => void;
    removeLocal: (sessionId: string) => void;
};

export const useAgentSessionStore = create<AgentSessionStoreState>()((set) => ({
    sessions: [],
    unreadableSessions: [],
    activeSessionId: null,
    pendingUserInputs: {},
    pendingApprovals: {},
    setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),
    setSessions: (sessions, unreadable = []) => set({ sessions: [...sessions].sort((a, b) => b.updatedAt - a.updatedAt), unreadableSessions: unreadable }),
    upsertSession: (summary) =>
        set((state) => ({
            sessions: [summary, ...state.sessions.filter((item) => item.sessionId !== summary.sessionId)].sort((a, b) => b.updatedAt - a.updatedAt),
        })),
    setSessionStatus: (sessionId, status, hasUnfinishedOperation) =>
        set((state) => ({
            sessions: state.sessions.map((item) =>
                item.sessionId === sessionId
                    ? { ...item, status, updatedAt: Date.now(), ...(hasUnfinishedOperation === undefined ? {} : { hasUnfinishedOperation }) }
                    : item,
            ),
        })),
    setPendingUserInput: (sessionId, request) =>
        set((state) => ({ pendingUserInputs: { ...state.pendingUserInputs, [sessionId]: request } })),
    clearPendingUserInput: (sessionId, requestId) =>
        set((state) => {
            const current = state.pendingUserInputs[sessionId];
            if (!current || (requestId !== undefined && current.requestId !== requestId)) return state;
            const pendingUserInputs = { ...state.pendingUserInputs };
            delete pendingUserInputs[sessionId];
            return { pendingUserInputs };
        }),
    setPendingApproval: (sessionId, approval) =>
        set((state) => ({ pendingApprovals: { ...state.pendingApprovals, [sessionId]: approval } })),
    clearPendingApproval: (sessionId, requestId) =>
        set((state) => {
            const current = state.pendingApprovals[sessionId];
            if (!current || (requestId !== undefined && current.requestId !== requestId)) return state;
            const pendingApprovals = { ...state.pendingApprovals };
            delete pendingApprovals[sessionId];
            return { pendingApprovals };
        }),
    setApprovalDeciding: (sessionId, requestId, deciding) =>
        set((state) => {
            const current = state.pendingApprovals[sessionId];
            if (!current || current.requestId !== requestId) return state;
            return { pendingApprovals: { ...state.pendingApprovals, [sessionId]: { ...current, deciding } } };
        }),
    removeLocal: (sessionId) =>
        set((state) => {
            const pendingUserInputs = { ...state.pendingUserInputs };
            delete pendingUserInputs[sessionId];
            const pendingApprovals = { ...state.pendingApprovals };
            delete pendingApprovals[sessionId];
            return {
                sessions: state.sessions.filter((item) => item.sessionId !== sessionId),
                activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId,
                pendingUserInputs,
                pendingApprovals,
            };
        }),
}));

/** 会话仍在「运作中」的状态全集：侧栏行首 loading 图标与后台任务 chip 同口径（spec 2026-09-18）。 */
export const ACTIVE_SESSION_STATUSES: ReadonlySet<PiSessionStatus> = new Set<PiSessionStatus>(["running", "queued", "compacting", "waiting_approval", "waiting_input"]);

export function backgroundSessionCount(sessions: PiSessionSummary[], activeSessionId: string | null): number {
    return sessions.filter((item) => item.sessionId !== activeSessionId && ACTIVE_SESSION_STATUSES.has(item.status)).length;
}
