import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { AgentChatItem } from "./use-agent-store";

// pi agent 会话历史的本地持久化（localStorage）。pi 是单会话执行者，主进程
// 不保存转录；渲染层把每个「新建对话」之前的内容快照成一条 session，供
// history 标签页回看。scope 用 projectId（或 canvasId）把历史按画布隔离。

export type PiSession = {
    id: string;
    /** 会话归属的画布（projectId || canvasId || "default"）。 */
    scope: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: AgentChatItem[];
};

type PiHistoryStore = {
    sessions: PiSession[];
    activeSessionId: string | null;
    saveSession: (session: PiSession) => void;
    setActiveSessionId: (id: string | null) => void;
    removeSession: (id: string) => void;
};

export const usePiHistoryStore = create<PiHistoryStore>()(
    persist(
        (set) => ({
            sessions: [],
            activeSessionId: null,
            saveSession: (session) =>
                set((state) => ({
                    sessions: [session, ...state.sessions.filter((item) => item.id !== session.id)].sort((a, b) => b.updatedAt - a.updatedAt),
                })),
            setActiveSessionId: (id) => set({ activeSessionId: id }),
            removeSession: (id) =>
                set((state) => ({
                    sessions: state.sessions.filter((item) => item.id !== id),
                    activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
                })),
        }),
        { name: "shotshot:pi-agent-history" },
    ),
);
