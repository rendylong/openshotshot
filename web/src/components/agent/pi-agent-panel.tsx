import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Dropdown, Popover, Tooltip } from "antd";
import { ArrowRight, FolderOpen, History, Loader2, Plus, Settings, Square, Terminal, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { canvasThemes } from "@/lib/canvas-theme";
import { SkillDraftCapture } from "@/components/skills/skill-draft-capture";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { useAgentSessionStore } from "@/stores/use-agent-session-store";
import type { AgentAttachment } from "@/stores/use-agent-store";
import type { AgentApprovalMode, AgentUserInputResponse } from "@/lib/agent/pi-agent-types";
import type { AgentPendingApprovalItem } from "@/stores/use-agent-session-store";
import { classifyAgentAttachment, isSupportedAgentAttachment } from "@/lib/agent/agent-attachments";
import { randomId } from "@/lib/utils";
import { readFileAsDataUrl, readImageMeta } from "@/lib/image-utils";
import { AgentChatTimeline, AgentUsageBar } from "./agent-chat";
import { AgentChatComposer } from "./agent-chat-composer";
import { AgentLogView } from "./agent-log-view";
import { AgentPanelGrip } from "./agent-panel-grip";
import { PiAgentHistoryView, SESSION_STATUS_KEYS } from "./pi-agent-history-view";
import { usePiAgent } from "./use-pi-agent";
import "./agent-aicss.css";

const WORKSPACE_RELOCATE_MESSAGE_KEY = "workspace-relocate";
// 调试日志入口（隐藏）：2 秒窗口内连点标题 5 次切换，点击过程无任何可见提示。
const DEBUG_TITLE_CLICK_COUNT = 5;
const DEBUG_TITLE_CLICK_WINDOW_MS = 2000;

export function PiAgentPanel() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const prompt = useAgentStore((state) => state.prompt);
    const pendingAttachments = useAgentStore((state) => state.pendingAttachments);
    const submitRequest = useAgentStore((state) => state.submitRequest);
    const sending = useAgentStore((state) => state.sending);
    const waiting = useAgentStore((state) => state.waiting);
    const activity = useAgentStore((state) => state.activity);
    const connectError = useAgentStore((state) => state.connectError);
    const messages = useAgentStore((state) => state.messages);
    const eventLogs = useAgentStore((state) => state.eventLogs);
    const tokenUsage = useAgentStore((state) => state.tokenUsage);
    const approvalMode = useAgentStore((state) => state.approvalMode);
    // 工作区改为项目维度展示：跟随当前画布所属项目，不再使用全局 localStorage 配置。
    const projectId = useAgentStore((state) => state.canvasContext?.snapshot.projectId ?? "");
    const project = useProjectStore((state) => (projectId ? state.projects.find((p) => p.id === projectId) : undefined));
    const workspacePath = project?.workspacePath;
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const clearEventLogs = useAgentStore((state) => state.clearEventLogs);
    const activeSessionId = useAgentSessionStore((state) => state.activeSessionId);
    const pendingUserInput = useAgentSessionStore((state) => activeSessionId ? state.pendingUserInputs[activeSessionId] : undefined);
    const pendingApproval = useAgentSessionStore((state) => activeSessionId ? state.pendingApprovals[activeSessionId] : undefined);
    const chatPanelSide = useConfigStore((state) => state.config.chatPanelSide);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const { available, modelConfig, sendPrompt, stop, newSession, continueSession, closeSession, abortSession } = usePiAgent();
    const [composerValue, setComposerValue] = useState(prompt);
    const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
    const [relocatingWorkspace, setRelocatingWorkspace] = useState(false);
    // 调试态只属于面板生命周期：面板卸载（收起/换项目）后自然复位，不进 store。
    const [debugMode, setDebugMode] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    // 背景任务（spec 2026-09-18 D5）：跨画布的未完成会话，历史列表按画布过滤看不到，
    // 用头部 chip + 浮层提供停止/跳转入口。
    const navigate = useNavigate();
    const sessions = useAgentSessionStore((state) => state.sessions);
    const [backgroundOpen, setBackgroundOpen] = useState(false);
    const [stoppingId, setStoppingId] = useState<string | null>(null);
    const backgroundSessions = useMemo(() => sessions.filter((item) => item.sessionId !== activeSessionId && item.hasUnfinishedOperation), [sessions, activeSessionId]);
    const stopBackground = useCallback((sessionId: string) => {
        setStoppingId(sessionId);
        abortSession(sessionId);
        window.setTimeout(() => setStoppingId((current) => (current === sessionId ? null : current)), 1500);
    }, [abortSession]);
    const canvasTitleForSession = useCallback((session: typeof sessions[number]) => {
        const project = useProjectStore.getState().projects.find((item) => item.id === session.scope.projectId);
        return project?.canvases.find((item) => item.id === session.scope.canvasId)?.title || session.title;
    }, []);
    const titleClicksRef = useRef({ count: 0, lastAt: 0, timer: 0 });

    useEffect(() => () => window.clearTimeout(titleClicksRef.current.timer), []);

    const onTitleClick = useCallback(() => {
        const clicks = titleClicksRef.current;
        const now = Date.now();
        if (now - clicks.lastAt > DEBUG_TITLE_CLICK_WINDOW_MS) clicks.count = 0;
        clicks.lastAt = now;
        clicks.count += 1;
        window.clearTimeout(clicks.timer);
        clicks.timer = window.setTimeout(() => {
            clicks.count = 0;
        }, DEBUG_TITLE_CLICK_WINDOW_MS);
        if (clicks.count < DEBUG_TITLE_CLICK_COUNT) return;
        window.clearTimeout(clicks.timer);
        clicks.count = 0;
        setDebugMode((current) => !current);
    }, []);

    useEffect(() => {
        if ((!prompt && !pendingAttachments.length) || submitRequest) return;
        setComposerValue(prompt);
        setAttachments(pendingAttachments);
        setAgentState({ prompt: "", pendingAttachments: [] });
    }, [prompt, pendingAttachments, setAgentState, submitRequest]);

    const busy = sending || waiting;
    // 挑选阶段只生成本地预览（Data URL + 分类），不注册最终会话句柄；
    // 持久化统一发生在 sendPrompt：写入项目资产并回填 assetRef/relativePath。
    const onAddFiles = useCallback(async (input: FileList | File[] | null) => {
        const files = Array.from(input || []);
        if (!files.length) return;
        const supported = files.filter((file) => isSupportedAgentAttachment(file.name, file.type));
        if (supported.length !== files.length) message.warning(t("agent.composer.addAttachment"));
        if (!supported.length) return;
        try {
            const registered = await Promise.all(supported.map(async (file) => {
                const dataUrl = await readFileAsDataUrl(file);
                const kind = classifyAgentAttachment(file.name, file.type);
                if (!kind) return null;
                const dimensions = kind === "image" ? await readImageMeta(dataUrl) : null;
                return { id: randomId(), name: file.name, kind, mimeType: file.type || dimensions?.mimeType || "application/octet-stream", size: file.size, url: dataUrl, dataUrl, width: dimensions?.width, height: dimensions?.height } satisfies AgentAttachment;
            }));
            setAttachments((current) => [...current, ...registered.filter(Boolean) as AgentAttachment[]]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        }
    }, [message, t]);
    if (!available) return null;

    const submit = () => {
        const draft = composerValue;
        const text = draft.trim();
        if ((!text && !attachments.length) || busy) return;
        const pending = attachments;
        setComposerValue("");
        setAttachments([]);
        void sendPrompt(text, pending).then((accepted) => {
            if (!accepted) {
                // 发送被拒（含附件落盘失败）：恢复草稿与附件，让用户可以直接重试，不丢输入。
                setComposerValue((current) => (current ? current : draft));
                setAttachments((current) => (current.length ? current : pending));
                const reason = useAgentStore.getState().connectError || t("agent.pi.failed");
                void message.error(reason);
            }
        });
    };
    const openSettings = () => {
        useConfigStore.getState().openConfigDialog(true);
    };
    const startNewSession = () => {
        newSession();
        setComposerValue("");
    };
    const continueHistory = (session: Parameters<typeof continueSession>[0]) => {
        continueSession(session);
        setComposerValue("");
    };
    const respondToUserInput = async (response: AgentUserInputResponse) => {
        if (!activeSessionId || !pendingUserInput) return;
        try {
            const result = await window.shotshot?.agent.respondToUserInput(activeSessionId, pendingUserInput.requestId, response);
            if (!result) return;
            if (!result.ok) throw new Error(result.error || t("agent.userInput.failed"));
        } catch (error) {
            const detail = error instanceof Error ? error.message : t("agent.userInput.failed");
            void message.error(detail);
            throw error;
        }
    };
    // AgentApprovalRequest → 既有 AgentApprovalCard 的字段约定：fileChange 走 grantRoot，command 走 command。
    const toTimelineApproval = (approval: AgentPendingApprovalItem) => ({
        requestId: approval.requestId,
        method: approval.method,
        reason: approval.reason,
        ...(approval.command !== undefined ? { command: approval.command } : {}),
        ...(approval.cwd !== undefined ? { cwd: approval.cwd } : {}),
        ...(approval.path !== undefined ? { grantRoot: approval.path } : {}),
        ...(approval.deciding !== undefined ? { deciding: approval.deciding } : {}),
    } as const);
    const onApprovalDecision = async (approval: { requestId: string; deciding?: "accept" | "acceptForSession" | "decline" }, decision: "accept" | "acceptForSession" | "decline") => {
        if (!activeSessionId || approval.deciding) return;
        useAgentSessionStore.getState().setApprovalDeciding(activeSessionId, approval.requestId, decision);
        try {
            const result = await window.shotshot?.agent.respondToApproval(activeSessionId, approval.requestId, decision);
            if (!result) return;
            if (!result.ok) throw new Error(result.error || t("agent.userInput.failed"));
        } catch (error) {
            useAgentSessionStore.getState().setApprovalDeciding(activeSessionId, approval.requestId, undefined);
            void message.error(error instanceof Error ? error.message : t("agent.userInput.failed"));
        }
    };
    const changeApprovalMode = (mode: AgentApprovalMode) => {
        if (mode === approvalMode) return;
        setAgentState({ approvalMode: mode });
        if (activeSessionId) void window.shotshot?.agent.setApprovalMode(activeSessionId, mode).catch(() => {
            void message.error(t("agent.approval.switchFailed"));
        });
    };
    const copyWorkspacePath = async () => {
        if (!workspacePath) return;
        try {
            await navigator.clipboard.writeText(workspacePath);
            void message.success(t("agent.workspace.copied"));
        } catch {
            void message.error(t("agent.workspace.copyFailed"));
        }
    };
    // 更改目录 = 非破坏性迁移：主进程先复制源工作区并逐条校验 manifest，成功才绑定新路径；
    // 进行中的 Agent 会话仍绑定旧目录，直到开启新对话（会话在创建时解析 cwd）。
    const changeWorkspaceDirectory = async () => {
        if (!projectId || relocatingWorkspace) return;
        try {
            const picked = await window.shotshot?.skills.pickFolder();
            if (!picked) return;
            if (!workspacePath) {
                // 尚无工作区：没有可迁移的数据，直接绑定所选目录。
                useProjectStore.getState().setProjectWorkspacePath(projectId, picked);
                return;
            }
            setRelocatingWorkspace(true);
            void message.loading({ content: t("agent.workspace.relocating"), key: WORKSPACE_RELOCATE_MESSAGE_KEY, duration: 0 });
            const result = await window.shotshot?.projectAssets?.relocateWorkspace({ projectId, sourcePath: workspacePath, targetPath: picked });
            if (!result) throw new Error(t("agent.workspace.relocateFailed"));
            if (!result.ok) throw new Error(result.error || t("agent.workspace.relocateFailed"));
            useProjectStore.getState().setProjectWorkspacePath(projectId, result.path);
            void message.success({ content: t("agent.workspace.relocated", { path: result.path }), key: WORKSPACE_RELOCATE_MESSAGE_KEY, duration: 6 });
        } catch (error) {
            void message.error({ content: error instanceof Error ? error.message : t("agent.workspace.relocateFailed"), key: WORKSPACE_RELOCATE_MESSAGE_KEY, duration: 6 });
        } finally {
            setRelocatingWorkspace(false);
        }
    };
    const historyContent = (
        <div className="flex w-80 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2" style={{ borderColor: theme.node.stroke }}>
                <div className="min-w-0 flex-1 truncate text-sm font-medium" style={{ color: theme.node.text }}>{t("agent.panel.history")}</div>
                <Button
                    size="small"
                    type="primary"
                    icon={<Plus className="size-3.5" />}
                    onClick={() => {
                        startNewSession();
                        setHistoryOpen(false);
                    }}
                >
                    {t("agent.history.newThread")}
                </Button>
            </div>
            <div className="flex h-96 min-h-0 flex-col overflow-hidden">
                <PiAgentHistoryView
                    theme={theme}
                    onNewSession={() => {
                        startNewSession();
                        setHistoryOpen(false);
                    }}
                    onContinue={(session) => {
                        continueHistory(session);
                        setHistoryOpen(false);
                    }}
                    onCloseSession={closeSession}
                />
            </div>
        </div>
    );
    return (
        <div className="flex h-full min-h-0 flex-col">
            <SkillDraftCapture />
            <div className="@container border-b px-2" style={{ borderColor: theme.node.stroke }}>
                {/* pt-2 reserves 8px at the top so the size-8 controls center at y=32,
                    matching the icon baseline of the canvas top bar (h-16 / h-9 buttons). */}
                <div className="flex h-14 items-center gap-1 pt-2">
                    <div className="flex min-w-0 flex-1 items-center gap-1">
                        <AgentPanelGrip side={chatPanelSide} onSideChange={(next) => updateConfig("chatPanelSide", next)} />
                        {/* 无标题；这块空白是连点 5 次切换调试日志的隐藏入口。 */}
                        <div className="flex h-8 min-w-0 flex-1 items-center" data-testid="agent-panel-debug-zone" onClick={onTitleClick}>
                            {debugMode ? (
                                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium leading-4" style={{ borderColor: theme.node.stroke, background: theme.node.panel, color: theme.node.text }}>
                                    <Terminal className="size-3" />
                                    {t("agent.panel.debugMode")}
                                </span>
                            ) : null}
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        <Dropdown
                            trigger={["click"]}
                            menu={{
                                items: [
                                    ...(workspacePath ? [{ key: "copy", label: t("agent.workspace.copyPath") }] : []),
                                    ...(projectId ? [{ key: "change", label: t("agent.workspace.changeDirectory") }] : []),
                                ],
                                onClick: ({ key }) => {
                                    if (key === "copy") void copyWorkspacePath();
                                    if (key === "change") void changeWorkspaceDirectory();
                                },
                            }}
                        >
                            <Tooltip title={workspacePath ? t("agent.workspace.tooltipProjectSet", { path: workspacePath }) : t("agent.workspace.tooltipProjectUnset")}>
                                <Button type="text" aria-label={t("agent.workspace.label")} className="!h-8 !px-2 max-w-44" style={{ color: theme.node.muted }} icon={<FolderOpen className="size-4" />}>
                                    <span className="truncate text-xs">{workspacePath ? workspacePath.split("/").filter(Boolean).at(-1) : t("agent.workspace.label")}</span>
                                </Button>
                            </Tooltip>
                        </Dropdown>
                        {backgroundSessions.length ? (
                            <Popover
                                trigger={["click"]}
                                placement="bottomRight"
                                open={backgroundOpen}
                                onOpenChange={setBackgroundOpen}
                                styles={{ container: { padding: 0 } }}
                                content={
                                    <div className="w-72 p-2">
                                        <div className="px-1 pb-2 text-xs font-medium" style={{ color: theme.node.text }}>{t("agent.background.title")}</div>
                                        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
                                            {backgroundSessions.map((session) => (
                                                <div key={session.sessionId} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5" style={{ background: theme.node.panel }}>
                                                    <span className="min-w-0 flex-1 truncate text-xs" style={{ color: theme.node.text }}>{canvasTitleForSession(session)}</span>
                                                    <span className="shrink-0 text-[10px] leading-3" style={{ color: theme.node.muted }}>{t(SESSION_STATUS_KEYS[session.status])}</span>
                                                    <Button type="text" size="small" className="!h-6 !w-6 !min-w-6" aria-label={t("agent.background.stop")} loading={stoppingId === session.sessionId} icon={<Square className="size-3.5" />} onClick={() => stopBackground(session.sessionId)} />
                                                    <Button type="text" size="small" className="!h-6 !w-6 !min-w-6" aria-label={t("agent.background.open")} icon={<ArrowRight className="size-3.5" />} onClick={() => { setBackgroundOpen(false); void navigate(`/canvas/${session.scope.projectId}/${session.scope.canvasId}`); }} />
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                }
                            >
                                <Tooltip title={t("agent.background.title")}>
                                    <Button type="text" className="!h-8 !px-2" aria-label={t("agent.background.title")} style={{ color: theme.node.muted }} icon={<span className="flex items-center gap-1"><Loader2 className="size-4 animate-spin" /><span className="text-xs">{backgroundSessions.length}</span></span>} />
                                </Tooltip>
                            </Popover>
                        ) : null}
                        <Popover
                            trigger={["click"]}
                            placement="bottomRight"
                            open={historyOpen}
                            onOpenChange={setHistoryOpen}
                            styles={{ container: { padding: 0 } }}
                            content={historyContent}
                        >
                            <Tooltip title={t("agent.panel.history")}>
                                <Button
                                    type="text"
                                    aria-label={t("agent.panel.history")}
                                    className="!h-8 !w-8 !min-w-8 data-[open]:bg-black/5 dark:data-[open]:bg-white/10"
                                    data-open={historyOpen ? "" : undefined}
                                    style={{ color: theme.node.muted }}
                                    icon={<History className="size-4" />}
                                />
                            </Tooltip>
                        </Popover>
                        <Tooltip title={t("agent.history.newThread")}>
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" aria-label={t("agent.history.newThread")} style={{ color: theme.node.muted }} icon={<Plus className="size-4" />} onClick={startNewSession} />
                        </Tooltip>
                        <Tooltip title={t("topNav.closeAgent")}>
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" aria-label={t("topNav.closeAgent")} style={{ color: theme.node.muted }} icon={<X className="size-4" />} onClick={() => useAgentStore.getState().closePanel()} />
                        </Tooltip>
                    </div>
                </div>
            </div>

            {debugMode ? (
                <AgentLogView
                    logs={eventLogs}
                    theme={theme}
                    context={{ endpoint: "pi-agent", connected: Boolean(modelConfig), enabled: true, activity, waiting, sending, messages: messages.length }}
                    onClear={clearEventLogs}
                    onCopied={(text) => message.success(text)}
                    onCopyBlocked={(text) => message.warning(text)}
                />
            ) : (
                <>
                    {connectError ? (
                        <div className="flex items-start gap-2 border-b px-3 py-2 text-xs" style={{ borderColor: theme.node.stroke, color: theme.node.muted }} role="alert">
                            <span className="mt-0.5 inline-block size-1.5 shrink-0 rounded-full" style={{ background: theme.node.muted }} aria-hidden />
                            <span className="min-w-0 flex-1 break-words">{connectError}</span>
                            <button
                                type="button"
                                className="shrink-0 underline"
                                onClick={() => useAgentStore.getState().setAgentState({ connectError: "" })}
                            >
                                {t("common.close")}
                            </button>
                        </div>
                    ) : null}
                    <AgentChatTimeline
                        theme={theme}
                        pendingTool={null}
                        pendingApprovals={pendingApproval ? [toTimelineApproval(pendingApproval)] : []}
                        pendingUserInput={pendingUserInput}
                        sending={sending}
                        waiting={waiting}
                        onRejectTool={() => undefined}
                        onApproveTool={() => undefined}
                        onApprovalDecision={(approval, decision) => void onApprovalDecision(approval, decision)}
                        onUserInputResponse={respondToUserInput}
                    />
                    {tokenUsage ? <AgentUsageBar usage={tokenUsage} theme={theme} /> : null}
                    <div className="shrink-0">
                        {modelConfig ? (
                            <AgentChatComposer prompt={composerValue} onPromptChange={setComposerValue} onSubmit={submit} onStop={stop} sending={busy} placeholder={t("agent.pi.placeholder")} theme={theme} attachments={attachments} onAddFiles={onAddFiles} onRemoveAttachment={(id) => setAttachments((current) => current.filter((item) => item.id !== id))} approvalMode={approvalMode} onApprovalModeChange={changeApprovalMode} />
                        ) : (
                            <div className="flex items-center gap-2 p-3 text-sm" style={{ color: theme.node.muted }}>
                                <span className="flex-1">{t("agent.pi.configureHint")}</span>
                                <Button size="small" type="link" icon={<Settings className="size-3.5" />} onClick={openSettings}>
                                    {t("agent.pi.openSettings")}
                                </Button>
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
