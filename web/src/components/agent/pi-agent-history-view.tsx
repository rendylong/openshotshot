import { useCallback, useEffect, useState } from "react";
import { Button, Tooltip } from "antd";
import { ArrowLeft, Loader2, MessageSquare, Play, Plus, TriangleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import type { PiSessionEntrySnapshot, PiSessionSummary } from "@/lib/agent/pi-agent-types";
import { projectSessionEntries } from "@/lib/agent/pi-session-projection";
import { useAgentStore } from "@/stores/use-agent-store";
import { useAgentSessionStore } from "@/stores/use-agent-session-store";
import { AgentChatMessage } from "./agent-chat-message";
import { agentMessageToChatMessage } from "./agent-event-formatters";

export const SESSION_STATUS_KEYS: Record<PiSessionSummary["status"], string> = {
    idle: "agent.sessions.statusIdle",
    running: "agent.sessions.statusRunning",
    queued: "agent.sessions.statusQueued",
    waiting_approval: "agent.sessions.statusWaiting",
    waiting_input: "agent.sessions.statusWaitingInput",
    compacting: "agent.sessions.statusCompacting",
    interrupted: "agent.sessions.statusInterrupted",
    error: "agent.sessions.statusError",
};

export function PiAgentHistoryView({ theme, onNewSession, onContinue, onCloseSession }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onNewSession: () => void; onContinue: (session: PiSessionSummary) => void; onCloseSession: (sessionId: string) => void }) {
    const { i18n, t } = useTranslation();
    const canvasContext = useAgentStore((state) => state.canvasContext);
    const sessions = useAgentSessionStore((state) => state.sessions);
    const unreadableSessions = useAgentSessionStore((state) => state.unreadableSessions);
    const activeSessionId = useAgentSessionStore((state) => state.activeSessionId);
    const [openId, setOpenId] = useState<string | null>(null);

    const projectId = canvasContext?.snapshot.projectId || "";
    const canvasId = canvasContext?.snapshot.canvasId || "";
    // 会话严格归属白板：只列当前画布自己的会话，与进画布的自动恢复同口径；
    // 同项目其他画布的历史不在这里展示，避免“白板是新的、对话是旧的”。
    const scoped = sessions.filter((session) => session.scope.projectId === projectId && session.scope.canvasId === canvasId);
    const open = scoped.find((session) => session.sessionId === openId);
    const firstUnreadable = unreadableSessions[0];

    if (open) {
        return <SdkSessionDetail session={open} theme={theme} onBack={() => setOpenId(null)} onContinue={() => onContinue(open)} />;
    }

    return (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
            {firstUnreadable ? (
                <div
                    className="mb-2 flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11px] leading-4"
                    role="status"
                    style={{ borderColor: theme.node.stroke, color: theme.node.muted }}
                    title={unreadableSessions.map((item) => `${item.file}: ${item.error}`).join("\n")}
                >
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" style={{ color: theme.node.text }} />
                    <span>{t("agent.sessions.unreadable", { count: unreadableSessions.length, message: firstUnreadable.error })}</span>
                </div>
            ) : null}
            {scoped.length ? (
                <div className="space-y-2">
                    {scoped.map((session) => {
                        const active = session.sessionId === activeSessionId;
                        return (
                            <div
                                key={session.sessionId}
                                role="button"
                                tabIndex={0}
                                className="group cursor-pointer rounded-lg border px-2.5 py-2 transition hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current/20 dark:hover:bg-white/10"
                                style={{ borderColor: active ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                                onClick={() => setOpenId(session.sessionId)}
                                onKeyDown={(event) => {
                                    if (event.key !== "Enter" && event.key !== " ") return;
                                    event.preventDefault();
                                    setOpenId(session.sessionId);
                                }}
                            >
                                <div className="flex items-start gap-2">
                                    <MessageSquare className="mt-0.5 size-3.5 shrink-0 opacity-55" />
                                    <div className="min-w-0 flex-1">
                                        <div className="flex min-w-0 items-center gap-1.5">
                                            {active ? <span className="shrink-0 text-[10px] font-medium" style={{ color: theme.node.text }}>{t("agent.history.current")}</span> : null}
                                            <div className="truncate text-sm font-medium leading-5">{session.title || t("agent.history.untitled")}</div>
                                        </div>
                                        <div className="text-[11px] leading-4 opacity-55">{t(SESSION_STATUS_KEYS[session.status])}{session.hasUnfinishedOperation ? ` · ${t("agent.sessions.unfinished")}` : ""}</div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                        <span className="text-[10px] opacity-55">{formatSessionTime(session.updatedAt, i18n.language)}</span>
                                        <Tooltip title={t("agent.history.continue")}>
                                            <Button type="text" size="small" className="!h-6 !w-6 !min-w-6 !px-0" icon={<Play className="size-3.5" />} aria-label={t("agent.history.continue")} onClick={(event) => { event.stopPropagation(); onContinue(session); }} />
                                        </Tooltip>
                                        <Tooltip title={t("agent.sessions.close")}>
                                            <Button type="text" size="small" className="!h-6 !w-6 !min-w-6 !px-0" icon={<X className="size-3.5" />} aria-label={t("agent.sessions.close")} onClick={(event) => { event.stopPropagation(); onCloseSession(session.sessionId); }} />
                                        </Tooltip>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : (
                <div className="flex flex-col items-center gap-3 px-3 py-10 text-center">
                    <div className="text-sm" style={{ color: theme.node.muted }}>{t("agent.pi.historyEmpty")}</div>
                    <div className="text-xs" style={{ color: theme.node.muted, opacity: 0.65 }}>{t("agent.pi.historyHint")}</div>
                    <Button size="small" type="primary" icon={<Plus className="size-3.5" />} onClick={onNewSession}>
                        {t("agent.history.newThread")}
                    </Button>
                </div>
            )}
        </div>
    );
}

function SdkSessionDetail({ session, theme, onBack, onContinue }: { session: PiSessionSummary; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onBack: () => void; onContinue: () => void }) {
    const { i18n, t } = useTranslation();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [entries, setEntries] = useState<PiSessionEntrySnapshot[]>([]);

    const readEntries = useCallback(async () => {
        const bridge = typeof window === "undefined" ? undefined : window.shotshot?.agent;
        if (!bridge?.readSessionEntries) {
            setError(t("agent.sessions.unavailable"));
            setLoading(false);
            return;
        }
        try {
            setEntries(await bridge.readSessionEntries(session.sessionId));
            setError("");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setLoading(false);
        }
    }, [session.sessionId, t]);

    useEffect(() => {
        void readEntries();
    }, [readEntries]);

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2" style={{ borderColor: theme.node.stroke }}>
                <Button type="text" size="small" className="!h-7 !w-7 !min-w-7 !px-0" icon={<ArrowLeft className="size-4" />} aria-label={t("agent.pi.back")} onClick={onBack} />
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium" style={{ color: theme.node.text }}>{session.title || t("agent.history.untitled")}</div>
                    <div className="text-[10px] opacity-55" style={{ color: theme.node.muted }}>{t(SESSION_STATUS_KEYS[session.status])} · {formatSessionTime(session.updatedAt, i18n.language)}</div>
                </div>
                <Button size="small" type="primary" icon={<Play className="size-3.5" />} onClick={onContinue}>
                    {t("agent.history.continue")}
                </Button>
            </div>
            <div className="thin-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
                {loading ? (
                    <div className="flex items-center gap-2 text-xs" style={{ color: theme.node.muted }}>
                        <Loader2 className="size-3.5 animate-spin" />
                        {t("agent.sessions.loading")}
                    </div>
                ) : null}
                {error ? <div className="text-xs" style={{ color: theme.node.muted }}>{t("agent.sessions.readFailed", { message: error })}</div> : null}
                {projectSessionEntries(session.sessionId, entries, {}).map((item) => (
                    <AgentChatMessage key={item.id} item={agentMessageToChatMessage(item)} theme={theme} />
                ))}
            </div>
        </div>
    );
}

function formatSessionTime(value: number, locale: string) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString(locale);
}
