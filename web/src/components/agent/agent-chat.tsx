import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, type AppendMessage } from "@assistant-ui/react";
import { Tooltip } from "antd";
import { ChevronDown, ChevronRight } from "lucide-react";
import { motion, useSpring, useTransform } from "motion/react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { summarizeCanvasAgentOps } from "@/lib/canvas/canvas-agent-ops";
import { useAgentStore, type AgentChatItem, type AgentPendingApproval, type AgentPendingToolCall, type AgentTokenUsage } from "@/stores/use-agent-store";
import { AgentApprovalCard, AgentChatMessage, AgentCommandGroup, AgentPendingToolCard, AgentToolCard, AgentWorkingMessage } from "./agent-chat-message";
import { AgentCompactionCard } from "./agent-compaction-card";
import type { PiSessionEntryRange, PiSessionEntrySnapshot } from "@/lib/agent/pi-agent-types";
import type { AgentUserInputRequest, AgentUserInputResponse } from "@/lib/agent/pi-agent-types";
import { assistantTimelineMessage, buildAssistantTimeline, type AgentAssistantTimelineEntry } from "./agent-assistant-timeline";
import { agentMessageToChatMessage, currentPlanMessage, isRunningWaitItem, latestPlanMessage, toolCallDetail, toolName, workingActivity } from "./agent-event-formatters";
import { AgentUserInputCard } from "./agent-user-input-card";

const historyMessageStyle = { contentVisibility: "auto", containIntrinsicSize: "0 80px" } as const;

export function AgentChatTimeline({
    theme,
    pendingTool,
    pendingApprovals,
    pendingUserInput,
    sending,
    waiting,
    onRejectTool,
    onApproveTool,
    onApprovalDecision,
    onUserInputResponse,
}: {
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    pendingTool: AgentPendingToolCall | null;
    pendingApprovals: AgentPendingApproval[];
    pendingUserInput?: AgentUserInputRequest;
    sending: boolean;
    waiting: boolean;
    onRejectTool: () => void;
    onApproveTool: () => void;
    onApprovalDecision: (approval: AgentPendingApproval, decision: "accept" | "acceptForSession" | "decline") => void;
    onUserInputResponse?: (response: AgentUserInputResponse) => void | Promise<void>;
}) {
    const { t } = useTranslation();
    const messages = useAgentStore((state) => state.messages);
    const submitPrompt = useAgentStore((state) => state.submitPrompt);
    const timeline = useMemo(() => buildAssistantTimeline(messages), [messages]);
    const entriesById = useMemo(() => new Map(timeline.map((entry) => [entry.id, entry])), [timeline]);
    const streaming = messages.some((message) => message.streamId);
    const working = workingActivity(messages.at(-1));
    const longWaitExpected = isRunningWaitItem(messages.at(-1));
    const onNew = useCallback(async (message: AppendMessage) => {
        const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim();
        if (text) submitPrompt(text);
    }, [submitPrompt]);
    const runtime = useExternalStoreRuntime({
        messages: timeline,
        convertMessage: assistantTimelineMessage,
        isRunning: sending || waiting || streaming,
        onNew,
    });
    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <ThreadPrimitive.Root className="relative min-h-0 flex-1">
                <ThreadPrimitive.Viewport className="thin-scrollbar h-full select-text overflow-y-auto" autoScroll>
                    <div className="flex flex-col gap-4 px-6 pt-4">
                        <ThreadPrimitive.Messages>
                            {({ message }) => {
                                const entry = entriesById.get(message.id);
                                return entry ? <AgentAssistantTimelineRow entry={entry} theme={theme} /> : null;
                            }}
                        </ThreadPrimitive.Messages>
                        {pendingTool ? (
                            <AgentPendingToolCard
                                summary={summarizeCanvasAgentOps(pendingTool.input?.ops || []) || toolName(pendingTool.name)}
                                detail={toolCallDetail(pendingTool.name, pendingTool.input, "pending")}
                                theme={theme}
                                onReject={onRejectTool}
                                onApprove={onApproveTool}
                            />
                        ) : null}
                        {pendingApprovals.map((approval) => <AgentApprovalCard key={approval.requestId} approval={approval} theme={theme} onDecision={(decision) => onApprovalDecision(approval, decision)} />)}
                        {pendingUserInput && onUserInputResponse ? <AgentUserInputCard request={pendingUserInput} onRespond={onUserInputResponse} /> : null}
                        {(sending || waiting) && !streaming && !pendingTool && !pendingApprovals.length && !pendingUserInput ? <AgentWorkingMessage text={working.text} activityKey={working.key} expectLongWait={longWaitExpected} theme={theme} /> : null}
                    </div>
                </ThreadPrimitive.Viewport>
                <Tooltip title={t("agent.chat.latestMessages")} placement="top">
                    <ThreadPrimitive.ScrollToBottom
                        behavior="smooth"
                        aria-label={t("agent.chat.latestMessages")}
                        className="absolute bottom-6 left-1/2 z-10 grid size-8 -translate-x-1/2 place-items-center rounded-full border backdrop-blur transition hover:-translate-y-0.5 disabled:pointer-events-none disabled:opacity-0"
                        style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }}
                    >
                        <ChevronDown className="size-4" />
                    </ThreadPrimitive.ScrollToBottom>
                </Tooltip>
            </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
    );
}

export function AgentTaskProgress({ theme, busy }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; busy: boolean }) {
    const { t } = useTranslation();
    const plan = useAgentStore((state) => busy ? currentPlanMessage(state.messages) : latestPlanMessage(state.messages));
    if (!plan) return null;
    return (
        <div className="shrink-0 px-4 pt-2">
            <AgentToolCard key={plan.id} title={plan.title || t("agent.events.progress")} text={plan.text} detail={plan.detail} theme={theme} />
        </div>
    );
}

const AgentAssistantTimelineRow = memo(function AgentAssistantTimelineRow({ entry, theme }: { entry: AgentAssistantTimelineEntry; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const streaming = entry.items.some((item) => item.streamId);
    const single = entry.items.length === 1 ? entry.items[0] : undefined;
    return (
        <MessagePrimitive.Root style={streaming ? undefined : historyMessageStyle}>
            {entry.kind === "duration"
                ? <AgentTurnDuration item={entry.items[0]} theme={theme} />
                : entry.kind === "process" && entry.turn
                    ? <AgentTurnProcess item={entry.turn} items={entry.items} theme={theme} />
                : single && single.role === "compaction"
                    ? <AgentCompactionRow item={single} theme={theme} />
                : entry.items.length > 1
                    ? <AgentCommandGroupRow items={entry.items} theme={theme} />
                    : entry.items.length === 1 && entry.items[0].role !== "compaction"
                        ? <AgentChatMessageRow item={entry.items[0] as AgentRenderedChatItem} theme={theme} />
                        : null}
        </MessagePrimitive.Root>
    );
});

const AgentCompactionRow = memo(function AgentCompactionRow({ item, theme }: { item: AgentChatItem; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const readSessionEntries = useCallback((sessionId: string, range?: PiSessionEntryRange): Promise<PiSessionEntrySnapshot[]> => {
        const bridge = typeof window === "undefined" ? undefined : window.shotshot?.agent;
        if (!bridge?.readSessionEntries || !sessionId) return Promise.resolve([]);
        return bridge.readSessionEntries(sessionId, range);
    }, []);
    return <AgentCompactionCard item={item} readSessionEntries={readSessionEntries} theme={theme} />;
});

function AgentTurnProcess({ item, items, theme }: { item: AgentChatItem; items: AgentChatItem[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const milliseconds = item.durationMs ?? Math.max(0, (item.completedAt ?? item.startedAt ?? 0) - (item.startedAt ?? 0));
    const seconds = Math.floor(milliseconds / 1_000);
    const label = seconds < 60
        ? t("agent.message.turnDurationSeconds", { seconds })
        : t("agent.message.turnDurationMinutes", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
    const groups = processItemGroups(items);
    return (
        <div className="min-w-0 text-left">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
                className="aicss-processToggle tabular-nums"
                style={{ color: theme.node.muted }}
            >
                <span>{label}</span>
                <ChevronRight className="aicss-processChevron" />
            </button>
            {open && groups.length ? (
                <div className="aicss-processList">
                    {groups.map((group) => group.items[0].role === "compaction"
                        ? <AgentCompactionRow key={group.items[0].id} item={group.items[0]} theme={theme} />
                        : group.command
                            ? <AgentCommandGroupRow key={group.items[0].id} items={group.items} theme={theme} />
                            : <AgentChatMessageRow key={group.items[0].id} item={group.items[0] as AgentRenderedChatItem} theme={theme} />)}
                </div>
            ) : null}
        </div>
    );
}

function processItemGroups(items: AgentChatItem[]) {
    const groups: Array<{ command: boolean; items: AgentChatItem[] }> = [];
    items.forEach((item) => {
        const command = item.role === "tool" && item.detail && typeof item.detail === "object" && (item.detail as { kind?: unknown }).kind === "command";
        const previous = groups.at(-1);
        if (command && previous?.command) previous.items.push(item);
        else groups.push({ command: Boolean(command), items: [item] });
    });
    return groups;
}

function AgentTurnDuration({ item, theme }: { item: AgentChatItem; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const { t } = useTranslation();
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (typeof item.durationMs === "number") return;
        const timer = setInterval(() => setNow(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, [item.durationMs]);
    const milliseconds = typeof item.durationMs === "number" ? item.durationMs : Math.max(0, now - (item.startedAt ?? now));
    const seconds = Math.floor(milliseconds / 1_000);
    const label = seconds < 60
        ? t("agent.message.turnDurationSeconds", { seconds })
        : t("agent.message.turnDurationMinutes", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
    return (
        <div className="flex min-w-0 items-center gap-3 py-0.5 text-xs tabular-nums" style={{ color: theme.node.muted }}>
            <span className="shrink-0">{label}</span>
            <span className="h-px min-w-0 flex-1 opacity-60" style={{ background: theme.node.stroke }} />
        </div>
    );
}

type AgentRenderedChatItem = AgentChatItem & { role: "user" | "assistant" | "system" | "tool" | "error" };

const AgentChatMessageRow = memo(function AgentChatMessageRow({ item, theme }: { item: AgentRenderedChatItem; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    return <AgentChatMessage item={agentMessageToChatMessage(item)} theme={theme} />;
});

const AgentCommandGroupRow = memo(function AgentCommandGroupRow({ items, theme }: { items: AgentChatItem[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    return <AgentCommandGroup items={items} theme={theme} />;
});

export function AgentUsageBar({ usage, theme }: { usage: AgentTokenUsage; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center justify-center gap-4 px-4 pt-1 text-[11px] tabular-nums" style={{ color: theme.node.muted }}>
            <span className="opacity-70">{t("agent.chat.latestCall")}</span>
            <UsageNumber label={t("agent.chat.input")} value={usage.input} color={theme.node.text} />
            <UsageNumber label={t("agent.chat.cached")} value={usage.cached} color={theme.node.text} />
            <UsageNumber label={t("agent.chat.output")} value={usage.output} color={theme.node.text} />
        </div>
    );
}

function UsageNumber({ label, value, color }: { label: string; value: number; color: string }) {
    const spring = useSpring(value, { stiffness: 110, damping: 24, mass: 0.7 });
    const text = useTransform(spring, (current) => Math.round(current).toLocaleString());
    useEffect(() => spring.set(value), [spring, value]);
    return (
        <span className="inline-flex items-baseline gap-1" aria-label={`${label} ${value.toLocaleString()}`}>
            <span>{label}</span>
            <motion.span aria-hidden className="font-medium" style={{ color }}>
                {text}
            </motion.span>
        </span>
    );
}
