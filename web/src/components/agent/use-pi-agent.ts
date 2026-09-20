import { canUseAsAgent } from "@/lib/models/channel-model-metadata";
import { useAiSourceStore } from "@/stores/use-ai-source-store";
import { useChatGptStore } from "@/stores/use-chatgpt-store";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { AgentEvent, AgentFileContent, ResolvedTextModelConfig } from "@/lib/agent/pi-agent-types";
import { resolvePiModelConfig, resolvePiModelConfigForBridge } from "@/lib/agent/text-model-config";
import { attachmentToImageContent } from "@/lib/agent/agent-attachments";
import { agentOpRouter } from "@/lib/agent/agent-op-router";
import { normalizeSkillCommand } from "@/lib/skills/skill-format";
import { canvasTitleFromPrompt, generateCanvasTitle } from "@/lib/canvas/canvas-title";
import { managedCatalogSnapshot } from "@/lib/desktop/managed-catalog-cache";
import { findProject } from "@/lib/canvas/project-model";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { randomId } from "@/lib/utils";
import { configureLocalSkillSources } from "@/services/local-skill";
import { credentialModeFor, resolveModelChannel, resolveModelExecution, resolveModelForCapability, useConfigStore } from "@/stores/use-config-store";
import { useAgentStore, type AgentAttachment, type AgentChatItem } from "@/stores/use-agent-store";
import { useLocalSkillStore } from "@/stores/use-local-skill-store";
import { usePiHistoryStore } from "@/stores/use-pi-history-store";
import { useAgentSessionStore } from "@/stores/use-agent-session-store";
import { projectSessionEntries } from "@/lib/agent/pi-session-projection";
import { materializePendingAttachments } from "@/lib/agent/register-pending-attachments";
import type { PiSessionSummary } from "@/lib/agent/pi-agent-types";
import { toolAction, toolCallDetail, toolName, toolSummary } from "./agent-event-formatters";
import { applyLiveEnvelope } from "@/lib/agent/pi-session-projection";
import type { PiSessionEnvelope } from "@/lib/agent/pi-agent-types";
import { parseAgentApprovalEvent, parseAgentUserInputEvent, sessionStatusFromAgentEvent } from "@/lib/agent/pi-session-contract";

// pi agent 的渲染层 client：把 Electron 主进程里的 pi agent 接到 useAgentStore。
// 与旧 Codex SSE 面板不同，pi 是单会话、无技能/审批/多线程历史的本地执行者，
// 这里只驱动 chat + 事件日志 + token 用量 + 画布 op 回传，其余字段维持默认。

type PiEvent = AgentEvent | { type: "ops"; ops: unknown; requestId?: string } | { type: "attachment_import"; attachment: AgentFileContent } | { type: "error"; message: string };

const PROJECTION_EVENT_TYPES = new Set(["message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "entry_appended", "compaction_start", "compaction_end", "turn_end"]);

type ActiveSessionGate = {
    generation: number;
    inFlight: Promise<void> | null;
};

function piMessageKey(threadId: string, turnId: string, itemId: string): string {
    return `${threadId}\0${turnId}\0${itemId}`;
}

// 白板自动命名：画布标题仍为默认"未命名画布"、为空、或仍是首条提问的原文截断
// （首页提交的占位名）时，用 AI 生成的简短标题命名；生成失败回退原文截断。
// 用户手动改过的标题一律不覆盖。生成不阻塞发送，完成后画布若仍可命名才写入。
const canvasTitleInFlight = new Set<string>();

function scheduleCanvasAutoTitle(scopeKey: string, projectId: string, canvasId: string, question: string, placeholder: string, untitledLabel: string) {
    const allowed = (title: string) => title === "" || title === untitledLabel || title === placeholder;
    if (!projectId || !canvasId || canvasTitleInFlight.has(scopeKey)) return;
    const { projects } = useProjectStore.getState();
    const canvas = findProject(projects, projectId)?.canvases.find((item) => item.id === canvasId);
    if (!canvas || !allowed(canvas.title)) return;
    // 纯附件没有提问文本可总结，直接用附件名占位，不请求模型。
    if (!question.trim()) {
        if (placeholder && placeholder !== canvas.title) useProjectStore.getState().renameCanvas(projectId, canvasId, placeholder);
        return;
    }
    canvasTitleInFlight.add(scopeKey);
    void generateCanvasTitle(question)
        .catch(() => null)
        .then((title) => {
            canvasTitleInFlight.delete(scopeKey);
            const latest = findProject(useProjectStore.getState().projects, projectId)?.canvases.find((item) => item.id === canvasId);
            if (!latest || !allowed(latest.title)) return;
            const finalTitle = title || placeholder;
            if (finalTitle && finalTitle !== latest.title) useProjectStore.getState().renameCanvas(projectId, canvasId, finalTitle);
        });
}

function extractText(content: unknown): string {
    if (!Array.isArray(content)) return "";
    return content
        .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
        .map((part) => (part as { text?: string }).text || "")
        .join("");
}

function messageText(message: unknown): string {
    const content = (message as { content?: unknown } | undefined)?.content;
    return typeof content === "string" ? content : extractText(content);
}

function messageUsage(message: unknown): { input: number; cached: number; output: number } | null {
    const usage = (message as { usage?: { input?: number; cacheRead?: number; output?: number } } | undefined)?.usage;
    if (!usage) return null;
    return { input: usage.input || 0, cached: usage.cacheRead || 0, output: usage.output || 0 };
}

function lastAssistantText(messages: unknown[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as { role?: string };
        if (message?.role === "assistant") {
            const text = messageText(message);
            if (text) return text;
        }
    }
    return "";
}

function lastAssistantUsage(messages: unknown[]): { input: number; cached: number; output: number } | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as { role?: string };
        if (message?.role === "assistant") {
            const usage = messageUsage(message);
            if (usage) return usage;
        }
    }
    return null;
}

// 失败时 Agent 不抛异常，而是把原因编码进消息的 errorMessage（content 为空）。
// 渲染层必须显式读这个字段，否则 LLM 失败表现为「无回复、无报错」。
function messageError(message: unknown): string {
    const errorMessage = (message as { errorMessage?: unknown } | undefined)?.errorMessage;
    return typeof errorMessage === "string" ? errorMessage : "";
}

function lastAssistantError(messages: unknown[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as { role?: string };
        if (message?.role === "assistant") {
            const error = messageError(message);
            if (error) return error;
        }
    }
    return "";
}

export function modelNotReadyKey() {
    const state = useAiSourceStore.getState();
    if (state.preferences.selections.agent || state.status !== "ready" || state.error || state.applying) return "aiSources.sourceNotReady";
    const config = useConfigStore.getState().config;
    if (credentialModeFor(config, "agent") === "shotshot") {
        const snapshot = managedCatalogSnapshot();
        if (!snapshot || snapshot.status === "error") return "config.managed.fetchFailed";
        if (!snapshot.models.some((model) => model.capability === "text")) return "config.managed.agentMissingText";
        return "agent.pi.notConfigured";
    }
    if (credentialModeFor(config, "agent") !== "shotshot") {
        const value = resolveModelForCapability(config, config.agentModel, "text");
        const channel = resolveModelChannel(config, value);
        const model = resolveModelExecution(config, value);
        if (channel.provider === "openrouter" && (!model || !canUseAsAgent(channel, model))) return "config.catalog.agentRequiresTools";
    }
    return "agent.pi.notConfigured";
}

// 解析逻辑下沉到 lib/agent/text-model-config.ts（services 层可用且不反向依赖组件层），
// hook 内部仍直接调用，这里显式 re-export 兼容既有 import。
export { resolvePiModelConfig, resolvePiModelConfigForBridge };

// 会话工作区从项目解析：已有路径直用（不 ensure、不重建自定义路径）；缺失则幂等 ensure 并写回项目。
// 无 bridge、无 projectId 或 ensure 失败时返回空对象，createSession 入参不出现 workspacePath 键。
const resolveWorkspaceForSession = async (projectId: string): Promise<{ workspacePath: string } | {}> => {
    const bridge = typeof window === "undefined" ? null : window.shotshot?.agent ?? null;
    if (!bridge || !projectId) return {};
    const project = findProject(useProjectStore.getState().projects, projectId);
    if (project?.workspacePath) return { workspacePath: project.workspacePath };
    const ensured = await bridge.ensureProjectWorkspace(projectId, project?.title ?? "").catch(() => null);
    if (!ensured?.ok) return {};
    useProjectStore.getState().setProjectWorkspacePath(projectId, ensured.path);
    return { workspacePath: ensured.path };
};

export function usePiAgent() {
    const { t } = useTranslation();
    const config = useConfigStore((state) => state.config);
    const sources = useAiSourceStore();
    const connection = useChatGptStore();
    const bridge = useMemo(() => (typeof window === "undefined" ? null : window.shotshot?.agent ?? null), []);
    const runIdRef = useRef(0);
    const activeSessionGateRef = useRef<ActiveSessionGate>({ generation: 0, inFlight: null });
    const modelConfigSyncRef = useRef<Promise<void> | null>(null);
    const migrationAttemptedRef = useRef(false);
    const assistantSequenceRef = useRef(0);
    const assistantMessageStartedAtRef = useRef(0);
    const assistantKeyRef = useRef("");
    const turnIdRef = useRef("");
    const turnSettledRef = useRef(true);
    const sessionIdRef = useRef<string | null>(null);
    const sessionTitleRef = useRef("");
    const sessionCreatedAtRef = useRef(0);
    const scopeRef = useRef<string | null>(null);
    // 解析前同步闸门：session 尚未解析时没有可作锁键的 sessionId，纯 per-session Map
    // 覆盖不了「同一空白画布双重提交 → 双 createSession 孤儿会话」的窗口（面板 busy 是
    // 渲染闭包值，同 tick 双击读旧值）。占位建立或发送结束后释放（spec 2026-09-18 D1）。
    const resolvingRef = useRef(false);
    // per-session 发送占位：同会话串行（turn 归属假设），跨会话并发。
    const inFlightPromptsRef = useRef<Map<string, Promise<boolean>>>(new Map());
    const anySendInFlight = useCallback(() => resolvingRef.current || inFlightPromptsRef.current.size > 0, []);
    // D9 TTFB：sendPrompt 通过全部发送门禁后起表（performance.now），首个 assistant text delta 结算一次，
    // 下次发送重置；NaN 表示未起表（performance.now 可能合法地返回 0，不能用作哨兵）。
    const turnTtfbStartedAtRef = useRef(Number.NaN);
    const turnTtfbRecordedRef = useRef(false);
    // User navigation invalidates draft recovery; initial send-created sessions do not.
    const draftOwnerRef = useRef(0);
    const sourceConfigureRequestRef = useRef(0);
    const messages = useAgentStore((state) => state.messages);
    const canvasContext = useAgentStore((state) => state.canvasContext);
    const sourcePreferences = useLocalSkillStore((state) => state.sourcePreferences);

    // 每轮 prompt 前把渲染端的审批模式推给主进程 runtime；主进程默认
    // confirm_changes，渲染端不推就保持最严格档，安全方向不会漂移。
    const syncApprovalMode = useCallback((sessionId: string) => {
        bridge?.setApprovalMode(sessionId, useAgentStore.getState().approvalMode).catch(() => undefined);
    }, [bridge]);

    const reportFailure = useCallback((error: unknown, ownerSessionId?: string) => {
        const text = error instanceof Error ? error.message : String(error);
        const state = useAgentStore.getState();
        // 晚到/后台失败：会话已不是当前活动会话时只留诊断日志，不污染当前画布视图。
        if (ownerSessionId !== undefined && sessionIdRef.current !== ownerSessionId) {
            state.addEventLog({ id: `${Date.now()}-${Math.random()}`, time: new Date().toLocaleString(), title: t("agent.pi.failed"), text });
            return;
        }
        const completedAt = Date.now();
        state.setAgentState({
            sending: false,
            waiting: false,
            activity: t("agent.pi.failed"),
            connectError: text,
            messages: [
                ...state.messages.map((item) => item.role === "user" && item.threadId === sessionIdRef.current && item.turnId === turnIdRef.current && item.completedAt === undefined
                    ? { ...item, completedAt, durationMs: Math.max(0, completedAt - (item.startedAt ?? completedAt)) }
                    : item),
                { id: randomId(), role: "error" as const, title: t("agent.pi.failed"), text },
            ],
        });
    }, [t]);

    const reportSourceConfigureFailure = useCallback((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        const state = useAgentStore.getState();
        state.addEventLog({ id: `${Date.now()}-${Math.random()}`, time: new Date().toLocaleString(), title: t("agent.pi.failed"), text });
        if (!anySendInFlight()) state.setAgentState({ connectError: text });
    }, [t]);

    // 主进程的模型配置是会话创建/恢复的前置状态。序列化推送，避免配置 effect
    // 和发送动作并发时，旧 IPC 尚未完成就创建新 session。
    const syncModelConfig = useCallback(async (override?: ResolvedTextModelConfig) => {
        if (!bridge) throw new Error(t(modelNotReadyKey()));
        const modelConfig = override ?? await resolvePiModelConfigForBridge();
        if (!modelConfig) throw new Error(t(modelNotReadyKey()));
        const previous = modelConfigSyncRef.current ?? Promise.resolve();
        const request = (async () => {
            await previous.catch(() => undefined);
            await bridge.setModelConfig(modelConfig);
        })();
        modelConfigSyncRef.current = request;
        void request.finally(() => {
            if (modelConfigSyncRef.current === request) modelConfigSyncRef.current = null;
        }).catch(() => undefined);
        return request;
    }, [bridge, t]);

    // active session 的读取/创建/切换只能有一个世代生效；晚到的旧结果不得覆盖新会话。
    const runActiveSessionTransition = useCallback((operation: (generation: number) => Promise<void>) => {
        const gate = activeSessionGateRef.current;
        const generation = gate.generation + 1;
        let settle: () => void = () => undefined;
        const inFlight = new Promise<void>((resolve) => {
            settle = resolve;
        });
        activeSessionGateRef.current = { generation, inFlight };
        void (async () => {
            try {
                await operation(generation);
            } catch (error) {
                if (activeSessionGateRef.current.generation === generation) reportFailure(error);
            } finally {
                if (activeSessionGateRef.current.generation === generation) activeSessionGateRef.current = { generation, inFlight: null };
                settle();
            }
        })();
        return inFlight;
    }, [reportFailure]);

    const waitForActiveSessionTransition = useCallback(async () => {
        for (;;) {
            const gate = activeSessionGateRef.current;
            if (!gate.inFlight) return gate.generation;
            await gate.inFlight;
        }
    }, []);

    // 文本模型配置 → 主进程。配置变化时 setModelConfig 会销毁并重建控制器，下次 prompt 才生效。
    useEffect(() => {
        if (!bridge) return;
        void syncModelConfig().catch(() => undefined);
    }, [bridge, config, sources, connection, syncModelConfig]);

    useEffect(() => {
        if (!bridge) return;
        const request = ++sourceConfigureRequestRef.current;
        let disposed = false;
        void configureLocalSkillSources(sourcePreferences)
            .then((result) => {
                if (result && !result.fresh) throw new Error(result.error);
            })
            .catch((error) => {
                if (!disposed && request === sourceConfigureRequestRef.current) reportSourceConfigureFailure(error);
            });
        return () => {
            disposed = true;
            if (request === sourceConfigureRequestRef.current) sourceConfigureRequestRef.current += 1;
        };
    }, [bridge, reportSourceConfigureFailure, sourcePreferences]);

    // 画布快照 → 主进程（debounce，避免拖拽时每帧都推）。
    useEffect(() => {
        if (!bridge) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const unsubscribe = useAgentStore.subscribe((state) => {
            const snapshot = state.canvasContext?.snapshot;
            if (!snapshot) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                bridge.setCanvasSnapshot({ projectId: snapshot.projectId, canvasId: snapshot.canvasId }, snapshot);
            }, 300);
        });
        return () => {
            unsubscribe();
            if (timer) clearTimeout(timer);
        };
    }, [bridge]);

    // 事件 → store。
    useEffect(() => {
        if (!bridge) return;
        const setState = useAgentStore.getState().setAgentState;
        const addEventLog = useAgentStore.getState().addEventLog;
        const log = (title: string, text: string, raw?: unknown) =>
            addEventLog({ id: `${Date.now()}-${Math.random()}`, time: new Date().toLocaleString(), title, text, raw });

        // D9 首字延迟：仅 assistant 的 text delta 计入；thinking 与工具事件不算，一轮至多记一条。
        const recordTtfb = (message: unknown) => {
            if (turnTtfbRecordedRef.current || !Number.isFinite(turnTtfbStartedAtRef.current)) return;
            if ((message as { role?: string } | undefined)?.role !== "assistant" || !messageText(message)) return;
            turnTtfbRecordedRef.current = true;
            const elapsed = Math.round(performance.now() - turnTtfbStartedAtRef.current);
            addEventLog({ id: randomId(), time: new Date().toLocaleString(), title: t("agent.ttfb"), text: `${elapsed}ms` });
        };

        const upsertScopedItem = (item: AgentChatItem) => {
            const current = useAgentStore.getState();
            const existing = current.messages.find((entry) => entry.id === item.id);
            setState({ messages: existing ? current.messages.map((entry) => entry.id === item.id ? { ...entry, ...item } : entry) : [...current.messages, item] });
        };

        const ensureAssistantSequence = () => {
            if (!assistantSequenceRef.current) assistantSequenceRef.current = 1;
            if (!assistantMessageStartedAtRef.current) assistantMessageStartedAtRef.current = Date.now();
            return assistantSequenceRef.current;
        };

        // Pi 的每个 message_start 都是时间线中的一个新阶段。按 contentIndex 拆分
        // thinking / text，避免后续回复覆盖工具调用之前已经出现的内容。
        const upsertAssistantMessage = (message: unknown, streaming: boolean) => {
            const content = (message as { content?: unknown } | undefined)?.content;
            if (!Array.isArray(content)) return;
            // thinking 的 status 只在整轮结束后才标 completed（折叠）；单次 LLM
            // 消息的 message_end 不折叠，保持展示直到 agent_end。
            const turnSettled = turnSettledRef.current;
            const sequence = ensureAssistantSequence();
            const threadId = sessionIdRef.current || "";
            const turnId = turnIdRef.current;
            const completedAt = streaming ? undefined : Date.now();
            content.forEach((part, contentIndex) => {
                if (!part || typeof part !== "object") return;
                const type = (part as { type?: unknown }).type;
                if (type === "thinking") {
                    const text = String((part as { thinking?: unknown }).thinking || "");
                    if (!text) return;
                    const itemId = `assistant:${sequence}:thinking:${contentIndex}`;
                    upsertScopedItem({
                        id: `${threadId}:${turnId}:${itemId}`,
                        itemId,
                        threadId,
                        turnId,
                        role: "tool",
                        title: t("agent.events.reasoning"),
                        text,
                        detail: {
                            kind: "reasoning",
                            status: (streaming || !turnSettled) ? "running" : "completed",
                            startedAt: assistantMessageStartedAtRef.current,
                            ...(completedAt ? { completedAt, durationMs: Math.max(0, completedAt - assistantMessageStartedAtRef.current) } : {}),
                        },
                    });
                    return;
                }
                if (type !== "text") return;
                const text = String((part as { text?: unknown }).text || "");
                if (!text) return;
                const itemId = `assistant:${sequence}:text:${contentIndex}`;
                const id = `${threadId}:${turnId}:${itemId}`;
                assistantKeyRef.current = piMessageKey(threadId, turnId, itemId);
                upsertScopedItem({ id, itemId, threadId, turnId, role: "assistant", title: t("agent.pi.title"), text, streamId: streaming ? String(runIdRef.current) : undefined });
            });
        };

        const upsertAssistantFallback = (text: string) => {
            if (!text) return;
            const sequence = ensureAssistantSequence();
            const threadId = sessionIdRef.current || "";
            const turnId = turnIdRef.current;
            const itemId = `assistant:${sequence}:text:0`;
            const id = `${threadId}:${turnId}:${itemId}`;
            assistantKeyRef.current = piMessageKey(threadId, turnId, itemId);
            upsertScopedItem({ id, itemId, threadId, turnId, role: "assistant", title: t("agent.pi.title"), text });
        };

        const appendError = (text: string) => {
            const id = randomId();
            setState({
                activity: t("agent.pi.failed"),
                messages: [...useAgentStore.getState().messages, { id, role: "error", title: t("agent.pi.failed"), text }],
            });
            log(t("agent.pi.failed"), text);
        };

        const finishTurn = (completedAt = Date.now()) => {
            turnSettledRef.current = true;
            const current = useAgentStore.getState();
            setState({
                messages: current.messages.map((item) => item.role === "user" && item.threadId === sessionIdRef.current && item.turnId === turnIdRef.current && item.completedAt === undefined
                    ? { ...item, completedAt, durationMs: Math.max(0, completedAt - (item.startedAt ?? completedAt)) }
                    : item),
            });
        };

        const upsertTool = (toolCallId: string, patch: Partial<AgentChatItem>, detailPatch: Record<string, unknown>) => {
            const threadId = sessionIdRef.current || "";
            const turnId = turnIdRef.current;
            const id = `${threadId}:${turnId}:tool:${toolCallId}`;
            const current = useAgentStore.getState();
            const existing = current.messages.find((item) => item.id === id);
            const detail = { ...(existing?.detail && typeof existing.detail === "object" ? existing.detail : {}), ...detailPatch };
            const next: AgentChatItem = existing
                ? { ...existing, ...patch, detail }
                : { id, itemId: `tool:${toolCallId}`, threadId, turnId, role: "tool", title: patch.title, text: patch.text || "", detail };
            setState({ messages: existing ? current.messages.map((item) => item.id === id ? next : item) : [...current.messages, next] });
        };

        const handleEvent = (event: PiEvent) => {
            switch (event.type) {
                case "agent_start":
                    setState({ waiting: true, activity: t("agent.pi.started"), connectError: "" });
                    log(t("agent.pi.started"), t("agent.pi.started"));
                    break;
                case "message_start": {
                    const message = (event as { message: unknown }).message;
                    if ((message as { role?: string })?.role !== "assistant") break;
                    assistantSequenceRef.current += 1;
                    assistantMessageStartedAtRef.current = Date.now();
                    break;
                }
                case "message_update": {
                    const message = (event as { message: unknown }).message;
                    if ((message as { role?: string })?.role !== "assistant") break;
                    recordTtfb(message);
                    upsertAssistantMessage(message, true);
                    break;
                }
                case "message_end": {
                    const message = (event as { message: unknown }).message;
                    // prompt 与工具回执也会发 message_end，只收 assistant 的收尾，避免把用户的话/工具结果回显成回复。
                    if ((message as { role?: string })?.role !== "assistant") break;
                    const text = messageText(message);
                    const error = messageError(message);
                    const usage = messageUsage(message);
                    if (error) appendError(error);
                    else if (text || Array.isArray((message as { content?: unknown }).content)) upsertAssistantMessage(message, false);
                    if (usage) setState({ tokenUsage: usage });
                    break;
                }
                case "tool_execution_start": {
                    const { toolCallId, toolName: name, args } = event as { toolCallId: string; toolName: string; args: unknown };
                    const startedAt = Date.now();
                    upsertTool(toolCallId, { title: toolName(name), text: toolAction(name) }, {
                        ...toolCallDetail(name, args, "running"),
                        input: formatToolPayload(args),
                        startedAt,
                    });
                    setState({ activity: t("agent.pi.toolCalling", { tool: name }) });
                    log(t("agent.events.toolCalled"), t("agent.pi.toolCalling", { tool: name }), event);
                    break;
                }
                case "tool_execution_update": {
                    const { toolCallId, toolName: name, args, partialResult } = event as { toolCallId: string; toolName: string; args: unknown; partialResult: unknown };
                    upsertTool(toolCallId, { title: toolName(name), text: toolAction(name) }, {
                        ...toolCallDetail(name, args, "running"),
                        input: formatToolPayload(args),
                        output: formatToolPayload(partialResult),
                    });
                    break;
                }
                case "tool_execution_end": {
                    const { toolCallId, toolName: name, result, isError } = event as { toolCallId: string; toolName: string; result: unknown; isError: boolean };
                    const completedAt = Date.now();
                    const id = `${sessionIdRef.current || ""}:${turnIdRef.current}:tool:${toolCallId}`;
                    const current = useAgentStore.getState().messages.find((item) => item.id === id);
                    const detailStartedAt = current?.detail && typeof current.detail === "object" ? (current.detail as Record<string, unknown>).startedAt : undefined;
                    const startedAt = typeof detailStartedAt === "number" ? detailStartedAt : completedAt;
                    upsertTool(toolCallId, {
                        title: toolName(name),
                        text: isError ? t("agent.events.toolFailed") : toolSummary({ tool: name, result }) || t("agent.events.toolCompleted"),
                    }, {
                        status: isError ? "failed" : "completed",
                        output: formatToolPayload(result),
                        completedAt,
                        durationMs: Math.max(0, completedAt - startedAt),
                    });
                    log(
                        isError ? t("agent.events.toolFailed") : t("agent.events.toolCompleted"),
                        t("agent.pi.toolCalling", { tool: name }),
                        event,
                    );
                    break;
                }
                case "error": {
                    appendError((event as { message: string }).message);
                    finishTurn();
                    setState({ waiting: false, sending: false });
                    break;
                }
                case "agent_end": {
                    const messages = (event as { messages: unknown[] }).messages || [];
                    const error = lastAssistantError(messages);
                    const usage = lastAssistantUsage(messages);
                    let completedAssistantKey = "";
                    if (error) {
                        appendError(error);
                    } else {
                        const finalText = lastAssistantText(messages) || extractCurrentAssistantText(useAgentStore.getState());
                        if (finalText) {
                            const finalMessage = [...messages].reverse().find((message) => (message as { role?: string })?.role === "assistant");
                            if (finalMessage) upsertAssistantMessage(finalMessage, false);
                            else upsertAssistantFallback(finalText);
                            completedAssistantKey = assistantKeyRef.current;
                        }
                    }
                    if (usage) setState({ tokenUsage: usage });
                    finishTurn();
                    const current = useAgentStore.getState();
                    setState({
                        waiting: false,
                        sending: false,
                        activity: error ? t("agent.pi.failed") : t("agent.pi.completed"),
                        piLifecycle: { ...current.piLifecycle, completedAssistantKey },
                    });
                    log(error ? t("agent.pi.failed") : t("agent.pi.completed"), error || lastAssistantText(messages));
                    break;
                }
                default:
                    break;
            }
        };

        const projectionContext = () => ({
            activeTurnId: turnIdRef.current || undefined,
            now: () => Date.now(),
            labels: {
                assistantTitle: t("agent.pi.title"),
                reasoningTitle: t("agent.events.reasoning"),
            },
            format: {
                toolTitle: (name: string) => toolName(name),
                toolText: (name: string) => toolAction(name),
                toolDetail: (name: string, input: unknown, status: string) => toolCallDetail(name, input, status),
            },
        });

        // v2 envelope 路径：item 级事件走 session 投影（entry id 权威、去重、compaction 卡片），
        // 状态事件只更新运行状态；Task 7 会把会话生命周期迁到 session registry。
        const handleSessionEnvelope = (envelope: PiSessionEnvelope) => {
            if (envelope.kind === "approval_request") {
                const event = parseAgentApprovalEvent(envelope.payload);
                if (!event) return;
                const sessions = useAgentSessionStore.getState();
                if (event.type === "request") {
                    sessions.setPendingApproval(envelope.sessionId, { requestId: event.requestId, ...event.approval });
                    sessions.setSessionStatus(envelope.sessionId, "waiting_approval", true);
                } else {
                    sessions.clearPendingApproval(envelope.sessionId, event.requestId);
                    sessions.setSessionStatus(envelope.sessionId, "running", true);
                }
                return;
            }
            if (envelope.kind === "user_input") {
                const event = parseAgentUserInputEvent(envelope.payload);
                if (!event) return;
                const sessions = useAgentSessionStore.getState();
                if (event.type === "request") {
                    sessions.setPendingUserInput(envelope.sessionId, event.request);
                    sessions.setSessionStatus(envelope.sessionId, "waiting_input", true);
                } else {
                    sessions.clearPendingUserInput(envelope.sessionId, event.requestId);
                    sessions.setSessionStatus(envelope.sessionId, "running", true);
                }
                return;
            }
            const envelopeType = envelope.kind === "agent" ? String((envelope.payload as { type?: unknown })?.type || "") : "";
            if (envelope.kind === "ops") {
                const payload = envelope.payload as { ops?: unknown; requestId?: string };
                void agentOpRouter.routeOps(envelope.sessionId, payload.ops, payload.requestId);
                return;
            }
            if (envelope.kind === "attachment_import") {
                const attachment = (envelope.payload as { attachment?: AgentFileContent }).attachment;
                if (attachment?.dataUrl) agentOpRouter.routeAttachmentImport(envelope.sessionId, attachment);
                return;
            }
            const sessionStatus = sessionStatusFromAgentEvent(envelope.kind, envelopeType, envelope.payload);
            if (sessionStatus) {
                useAgentSessionStore.getState().setSessionStatus(
                    envelope.sessionId,
                    sessionStatus,
                    sessionStatus === "running" || sessionStatus === "queued" || sessionStatus === "compacting",
                );
            }
            // 严格归属：无活动会话（null）同样拦截——后台会话的消息/错误绝不进入当前视图；
            // 其状态已由上方 sessionStatusFromAgentEvent 更新到 session store（spec D2）。
            if (envelope.sessionId !== sessionIdRef.current) return;
            if (envelope.kind === "agent") {
                const payload = envelope.payload as { type?: string } & Record<string, unknown>;
                const type = typeof payload?.type === "string" ? payload.type : "";
                if (PROJECTION_EVENT_TYPES.has(type)) {
                    if (type === "message_update") recordTtfb(payload.message);
                    setState({ messages: applyLiveEnvelope(useAgentStore.getState().messages, envelope, projectionContext()) });
                    if (type === "compaction_start") setState({ activity: t("agent.events.compactingContext") });
                    if (type === "compaction_end") setState({ activity: t("agent.events.contextCompacted") });
                    return;
                }
                if (type === "agent_start") {
                    setState({ waiting: true, activity: t("agent.pi.started"), connectError: "" });
                    log(t("agent.pi.started"), t("agent.pi.started"));
                    return;
                }
                if (type === "turn_start") {
                    setState({ waiting: true, activity: t("agent.pi.started") });
                    log(t("agent.pi.started"), t("agent.pi.started"), payload);
                    return;
                }
                if (type === "agent_end" || type === "agent_settled") {
                    if (type === "agent_end" && payload.willRetry === true) return;
                    useAgentSessionStore.getState().clearPendingUserInput(envelope.sessionId);
                    const messages = (payload.messages as unknown[]) || [];
                    const usage = lastAssistantUsage(messages);
                    const lastAssistant = [...useAgentStore.getState().messages].reverse().find((item) => item.role === "assistant" && item.threadId === envelope.sessionId);
                    if (usage) setState({ tokenUsage: usage });
                    finishTurn();
                    setState({
                        waiting: false,
                        sending: false,
                        activity: t("agent.pi.completed"),
                        piLifecycle: { ...useAgentStore.getState().piLifecycle, completedAssistantKey: lastAssistant ? piMessageKey(lastAssistant.threadId || "", lastAssistant.turnId || "", lastAssistant.itemId || "") : "" },
                    });
                    return;
                }
                if (type === "queue_update") {
                    setState({ activity: t("agent.pi.started") });
                    return;
                }
                log(t("agent.pi.started"), type, payload);
                return;
            }
            if (envelope.kind === "error") {
                handleEvent(envelope.payload as PiEvent);
                return;
            }
            if (envelope.kind === "session_compact_failed") {
                const payload = envelope.payload as { errorMessage?: unknown; message?: unknown };
                const message = String(payload?.errorMessage || payload?.message || t("agent.events.compactContext"));
                setState({ messages: applyLiveEnvelope(useAgentStore.getState().messages, envelope, projectionContext()) });
                appendError(message);
            }
        };

        if (bridge.onSessionEvent) return bridge.onSessionEvent(handleSessionEnvelope);
        return bridge.onEvent(handleEvent);
    }, [bridge, t]);

    // 画布切换：只切换 renderer 的 active session 视图（detach/attach），
    // 绝不 interrupt/reset 后台会话；历史从 SDK session entries 重建。
    // 只在 scope 真正变化时执行；canvasContext 短暂为 null 时不处理，避免误切。
    useEffect(() => {
        const snapshot = canvasContext?.snapshot;
        const projectId = snapshot?.projectId || "";
        const canvasId = snapshot?.canvasId || "";
        // 组合键：同一项目下切换不同画布也必须视为 scope 变化。
        // 旧的 `projectId || canvasId` 键会把同项目所有画布折叠成同一个 scope，
        // 导致切换画布时 early return，面板继续显示上一个画布的会话而不是恢复
        // 当前画布上一次对话的 session。
        const scopeKey = `${projectId}::${canvasId}`;
        if ((!projectId && !canvasId) || scopeRef.current === scopeKey || !bridge) return;
        const previousScope = scopeRef.current;
        const isFirstScope = !previousScope;
        scopeRef.current = scopeKey;
        draftOwnerRef.current += 1;

        // scope 切换同步先把上一个画布的 messages 清掉、sessionIdRef 置空，避免 async transition 还没
        // 跑完时用户看到的是上一个画布的对话。面板重新挂载时 store 仍可能保留旧画布
        // 的消息，所以首个有效 scope 也要先清空；后续 applySummary 再恢复当前画布历史。
        if (previousScope || isFirstScope) {
            sessionIdRef.current = null;
            sessionTitleRef.current = "";
            sessionCreatedAtRef.current = 0;
            const state = useAgentStore.getState();
            state.setAgentState({
                messages: [],
                piLifecycle: { ...state.piLifecycle, completedAssistantKey: "", historyRestoreRevision: state.piLifecycle.historyRestoreRevision + 1 },
                eventLogs: [],
                tokenUsage: null,
                sending: false,
                waiting: false,
                activity: t("agent.state.ready"),
                connectError: "",
            });
            useAgentSessionStore.getState().setActiveSession(null);
        }

        const applySummary = (summary: PiSessionSummary, generation: number, messages: AgentChatItem[]) => {
            if (activeSessionGateRef.current.generation !== generation) return;
            const state = useAgentStore.getState();
            sessionIdRef.current = summary.sessionId;
            sessionTitleRef.current = summary.title;
            sessionCreatedAtRef.current = summary.createdAt;
            useAgentSessionStore.getState().upsertSession(summary);
            useAgentSessionStore.getState().setActiveSession(summary.sessionId);
            // attach 到未完成会话：UI 呈现真实忙态；turn 观测窗口重建，避免沿用
            // 上一画布残留 turnId 把实时事件错误归组（spec 2026-09-18 D1/D3）。
            const unfinished = summary.status === "running" || summary.status === "queued" || summary.status === "compacting" || summary.status === "waiting_approval" || summary.status === "waiting_input";
            turnSettledRef.current = !unfinished;
            turnIdRef.current = unfinished ? `pi:${randomId()}` : "";
            assistantSequenceRef.current = 0;
            assistantMessageStartedAtRef.current = 0;
            assistantKeyRef.current = "";
            turnTtfbStartedAtRef.current = Number.NaN;
            turnTtfbRecordedRef.current = false;
            state.setAgentState({
                messages,
                piLifecycle: { completedAssistantKey: "", historyRestoreRevision: state.piLifecycle.historyRestoreRevision + 1 },
                eventLogs: [],
                tokenUsage: null,
                sending: false,
                waiting: unfinished,
                activity: t("agent.state.ready"),
                connectError: "",
            });
        };

        void runActiveSessionTransition(async (generation) => {
            // 自动恢复也必须排在模型配置后面；持久化配置晚于首帧就绪时，
            // 否则 openSession 会用未配置的 registry 创建 runtime。
            const modelConfig = await resolvePiModelConfigForBridge();
            if (modelConfig) await syncModelConfig(modelConfig);
            // 全局列表保留所有 scope，面板负责按当前画布过滤展示。
            const listed = await bridge.listSessions();
            if (activeSessionGateRef.current.generation !== generation) return;
            useAgentSessionStore.getState().setSessions(listed.sessions, listed.unreadable);
            // 只恢复当前画布自己的最近会话；白板（该画布从无会话）不加载任何
            // 会话、也不自动新建——面板保持空，首次发问时才为当前画布创建。
            const latest = listed.sessions.find((session) => session.scope.projectId === projectId && session.scope.canvasId === canvasId);
            if (latest && modelConfig) {
                const opened = await bridge.openSession(latest.sessionId);
                applySummary(opened.summary, generation, projectSessionEntries(opened.summary.sessionId, opened.entries, {}));
            }
        });
        // 注意：这里不能在 cleanup 里 bump generation——同画布内 snapshot 引用
        // 变化（节点移动/选中/视口）会让 canvasContext 换新对象，effect 重跑但
        // scopeKey 相同走 early return；若此时 cleanup 打断进行中的 restore，
        // applySummary 会被 generation gate 丢弃，表现为“进画布不加载最近会话”。
        // 旧 transition 的失效由 runActiveSessionTransition 的 generation 自增保证。
    }, [canvasContext, bridge, runActiveSessionTransition, syncModelConfig, t]);

    // 仅面板卸载时打断进行中的会话切换。
    useEffect(() => () => {
        draftOwnerRef.current += 1;
        const gate = activeSessionGateRef.current;
        activeSessionGateRef.current = { generation: gate.generation + 1, inFlight: null };
    }, []);

    // 全新升级后不再尝试迁移旧 localStorage 中的会话快照：直接清空老数据，
    // 并让主进程按"no-op"写一次 marker；之后每次重挂载看到空 legacy 就跳过。
    // 不读旧消息、不写旧消息、不打 user-visible 报错，避免每次进会话都弹顶部错误条。
    useEffect(() => {
        if (!bridge) return;
        if (migrationAttemptedRef.current) return;
        const legacy = usePiHistoryStore.getState().sessions;
        if (!legacy.length) return;
        migrationAttemptedRef.current = true;
        usePiHistoryStore.setState({ sessions: [], activeSessionId: null });
        let cancelled = false;
        void bridge.importLegacySessions([])
            .then((result) => {
                if (cancelled) return;
                if (!result.ok) throw new Error(result.error);
                return bridge.listSessions().then((listed) => {
                    if (!cancelled) useAgentSessionStore.getState().setSessions(listed.sessions, listed.unreadable);
                });
            })
            .catch((error: unknown) => {
                if (cancelled) return;
                const message = error instanceof Error ? error.message : String(error);
                const diagnostic = t("agent.sessions.migrationFailed", { message });
                const state = useAgentStore.getState();
                state.addEventLog({ id: `${Date.now()}-${Math.random()}`, time: new Date().toLocaleString(), title: t("agent.pi.failed"), text: diagnostic });
                if (!anySendInFlight()) state.setAgentState({ connectError: diagnostic, activity: diagnostic });
            });
        return () => {
            cancelled = true;
        };
    }, [bridge, anySendInFlight, t]);

    // 单次发送的执行段：附件物化 → prompt settle。视图状态写入仅当会话仍是当前活动
    // 会话时进行——后台会话的任务（用户已切走）不得污染当前画布视图（spec D1 晚到隔离）。
    const dispatchPromptTask = useCallback(
        async (sessionId: string, normalized: string, attachments: AgentAttachment[]): Promise<boolean> => {
            if (!bridge) return false;
            const isActiveSession = () => sessionIdRef.current === sessionId;
            const attachmentScope = scopeRef.current;
            const attachmentGeneration = activeSessionGateRef.current.generation;
            const ownsAttachmentRegistration = () => isActiveSession()
                && useAgentSessionStore.getState().activeSessionId === sessionId
                && scopeRef.current === attachmentScope
                && activeSessionGateRef.current.generation === attachmentGeneration;
            try {
                const [refProjectId = "", refCanvasId = ""] = (scopeRef.current ?? "").split("::");
                let prepared: AgentAttachment[];
                try {
                    const project = findProject(useProjectStore.getState().projects, refProjectId);
                    prepared = await materializePendingAttachments(attachments, {
                        projectId: refProjectId,
                        projectTitle: project?.title ?? "",
                        workspacePath: project?.workspacePath,
                        canvasId: refCanvasId,
                        source: { type: "agent-attachment" },
                    });
                } catch (error) {
                    if (ownsAttachmentRegistration()) throw error;
                    return false;
                }
                if (!ownsAttachmentRegistration()) return false;
                runIdRef.current += 1;
                turnIdRef.current = `pi:${randomId()}`;
                turnSettledRef.current = false;
                assistantSequenceRef.current = 0;
                assistantMessageStartedAtRef.current = 0;
                assistantKeyRef.current = "";
                const snapshot = useAgentStore.getState().canvasContext?.snapshot;
                if (snapshot) {
                    bridge.setCanvasSnapshot({ projectId: snapshot.projectId, canvasId: snapshot.canvasId }, snapshot);
                }
                const importAttachment = useAgentStore.getState().canvasContext?.importAttachment;
                if (importAttachment) {
                    for (const attachment of prepared) {
                        if (!attachment.kind || !attachment.assetRef) continue;
                        await importAttachment({
                            // assetId/storageKey 同时充当去重句柄（metadata.sourceHandle）；画布侧改为消费 assetRef 由画布导入任务接管。
                            handle: attachment.assetRef.backend === "project-file" ? attachment.assetRef.assetId : attachment.assetRef.storageKey,
                            name: attachment.name,
                            kind: attachment.kind,
                            mimeType: attachment.mimeType || "application/octet-stream",
                            size: attachment.size,
                            dataUrl: attachment.dataUrl,
                            assetRef: attachment.assetRef,
                            relativePath: attachment.relativePath,
                        });
                    }
                }
                const userMessage: AgentChatItem = {
                    id: `${sessionId}:${turnIdRef.current}:user`,
                    itemId: "user",
                    threadId: sessionId,
                    turnId: turnIdRef.current,
                    role: "user",
                    text: normalized || t("agent.eventMore.attachmentPrompt"),
                    attachments: prepared.map(({ id, name, url, handle, kind, mimeType, size, width, height, assetRef, relativePath }) => ({ id, name, url, handle, kind, mimeType, size, width, height, assetRef, relativePath })),
                    startedAt: Date.now(),
                };
                useAgentStore.getState().setAgentState({ messages: [...useAgentStore.getState().messages, userMessage] });
                syncApprovalMode(sessionId);
                const promptFiles = prepared.flatMap((attachment) => {
                    const assetRef = attachment.assetRef;
                    if (!assetRef || assetRef.backend !== "project-file" || !attachment.kind) return [];
                    return [{
                        assetId: assetRef.assetId,
                        relativePath: assetRef.relativePath,
                        name: attachment.name,
                        kind: attachment.kind,
                        mimeType: attachment.mimeType || "application/octet-stream",
                        size: attachment.size,
                    }];
                });
                const result = await bridge.prompt(sessionId, {
                    text: normalized || t("agent.eventMore.attachmentPrompt"),
                    images: prepared.map(attachmentToImageContent).filter((image): image is NonNullable<ReturnType<typeof attachmentToImageContent>> => Boolean(image)),
                    files: promptFiles,
                });
                if (!result.ok) {
                    reportFailure(new Error(result.error), sessionId);
                    return false;
                }
                if (isActiveSession()) useAgentStore.getState().setAgentState({ sending: false });
                return true;
            } catch (error) {
                reportFailure(error, sessionId);
                return false;
            }
        },
        [bridge, reportFailure, syncApprovalMode, t],
    );

    const sendPrompt = useCallback(
        async (text: string, attachments: AgentAttachment[] = []): Promise<boolean> => {
            if (!bridge || (!text.trim() && !attachments.length) || resolvingRef.current) return false;
            resolvingRef.current = true;
            let promptTask: Promise<boolean> | null = null;
            try {
                let normalized: string;
                let parsed: ReturnType<typeof normalizeSkillCommand>;
                try {
                    parsed = text.trim() ? normalizeSkillCommand(text) : { text: "" };
                    normalized = parsed.text;
                } catch (error) {
                    reportFailure(error);
                    return false;
                }
                const modelConfig = await resolvePiModelConfigForBridge();
                if (!modelConfig) {
                    // D9 TTFB：被拒绝的发送不得留下残留的起表状态，否则后续无关 delta 会被误计成 TTFB。
                    turnTtfbStartedAtRef.current = Number.NaN;
                    useAgentStore.getState().setAgentState({ connectError: t(modelNotReadyKey()), activity: t(modelNotReadyKey()) });
                    return false;
                }
                // D9 TTFB：起表必须放在全部发送门禁之后——在途发送拒绝重入时不得覆盖/重置进行中的测量。
                turnTtfbStartedAtRef.current = performance.now();
                turnTtfbRecordedRef.current = false;
                const setState = useAgentStore.getState().setAgentState;
                const lifecycle = useAgentStore.getState().piLifecycle;
                setState({
                    sending: true,
                    waiting: true,
                    activity: t("agent.pi.thinking"),
                    connectError: "",
                    piLifecycle: { ...lifecycle, completedAssistantKey: "" },
                });
                try {
                    await syncModelConfig(modelConfig);
                    await waitForActiveSessionTransition();
                    const expectedSessionId = sessionIdRef.current;
                    const configured = await configureLocalSkillSources(useLocalSkillStore.getState().sourcePreferences);
                    if (!configured) throw new Error(t("agent.pi.skillRefreshFailed"));
                    if (!configured.fresh) throw new Error(configured.error);
                    await waitForActiveSessionTransition();
                    if (sessionIdRef.current !== expectedSessionId) return false;
                    // 校验缓存会话确实属于当前画布 scope：用 scopeRef（由 scope effect 维护）
                    // 而非 canvasContext，避免首页跳转时残留上一次画布的 stale snapshot。
                    const snapshot = useAgentStore.getState().canvasContext?.snapshot;
                    const scopeKey = scopeRef.current ?? "";
                    const [refProjectId = "", refCanvasId = ""] = scopeKey.split("::");
                    const scope = {
                        projectId: refProjectId || snapshot?.projectId || "",
                        canvasId: refCanvasId || snapshot?.canvasId || "",
                    };
                    const placeholder = canvasTitleFromPrompt(normalized, attachments[0]?.name || "");
                    // 裸 skill 命令（整条 prompt 就是 /命令）无可总结内容，跳过画布自动改名（spec §10 D13）。
                    const bareSkillCommand = Boolean(parsed.skillName) && normalized === `/${parsed.skillName}`;
                    if (!bareSkillCommand) {
                        scheduleCanvasAutoTitle(`${scope.projectId}::${scope.canvasId}`, scope.projectId, scope.canvasId, normalized, placeholder, t("canvas.canvas.untitled"));
                    }
                    const cachedSession = sessionIdRef.current
                        ? useAgentSessionStore.getState().sessions.find((item) => item.sessionId === sessionIdRef.current)
                        : undefined;
                    const scopeMatches = cachedSession
                        && cachedSession.scope.projectId === scope.projectId
                        && cachedSession.scope.canvasId === scope.canvasId;
                    if (!sessionIdRef.current || !scopeMatches) {
                        sessionIdRef.current = null;
                        await runActiveSessionTransition(async (generation) => {
                            const created = await bridge.createSession({ scope, title: normalized.slice(0, 60), ...(await resolveWorkspaceForSession(scope.projectId)) });
                            if (activeSessionGateRef.current.generation !== generation) return;
                            sessionIdRef.current = created.sessionId;
                            sessionTitleRef.current = created.title || normalized.slice(0, 60);
                            sessionCreatedAtRef.current = created.createdAt;
                            useAgentSessionStore.getState().upsertSession(created);
                            useAgentSessionStore.getState().setActiveSession(created.sessionId);
                        });
                    }
                    await waitForActiveSessionTransition();
                    const sessionId = sessionIdRef.current!;
                    if (!sessionId || useAgentSessionStore.getState().activeSessionId !== sessionId) return false;
                    // per-session 准入：检查与占位之间不得插入 await（单线程下同步即原子）。
                    if (inFlightPromptsRef.current.has(sessionId)) {
                        reportFailure(new Error(t("agent.pi.sessionBusy")), sessionId);
                        return false;
                    }
                    const promptTaskLocal = dispatchPromptTask(sessionId, normalized, attachments);
                    inFlightPromptsRef.current.set(sessionId, promptTaskLocal);
                    void promptTaskLocal.finally(() => {
                        if (inFlightPromptsRef.current.get(sessionId) === promptTaskLocal) inFlightPromptsRef.current.delete(sessionId);
                    });
                    // 对话活跃触碰：发送被受理即刷新画布 updatedAt，画布列表按「最后活跃」置顶（spec 2026-09-18）。
                    // 放在准入检查之后——被门禁拒绝的发送不置顶；空 scope / 画布已删由 touchCanvas no-op 兜住。
                    useProjectStore.getState().touchCanvas(scope.projectId, scope.canvasId);
                    // 占位已建立：先释放入口闸门（在 finally），执行段在闸门外等待——
                    // 否则 resolvingRef 会贯穿整个 turn，退化为全局锁。
                    promptTask = promptTaskLocal;
                } catch (error) {
                    reportFailure(error);
                    return false;
                }
            } catch (error) {
                reportFailure(error);
                return false;
            } finally {
                resolvingRef.current = false;
            }
            // 占位已建立、入口闸门已释放（finally）后才等待执行段——否则 resolvingRef
            // 会贯穿整个 turn，退化为全局锁（spec D1）。
            return promptTask ? await promptTask : false;
        },
        [bridge, dispatchPromptTask, reportFailure, runActiveSessionTransition, syncModelConfig, waitForActiveSessionTransition, t],
    );

    const stop = useCallback(() => {
        const sessionId = sessionIdRef.current;
        if (sessionId) void bridge?.abort(sessionId).catch(() => undefined);
        const completedAt = Date.now();
        const state = useAgentStore.getState();
        state.setAgentState({
            sending: false,
            waiting: false,
            activity: t("agent.pi.stopped"),
            messages: state.messages.map((item) => item.role === "user" && item.threadId === sessionIdRef.current && item.turnId === turnIdRef.current && item.completedAt === undefined
                ? { ...item, completedAt, durationMs: Math.max(0, completedAt - (item.startedAt ?? completedAt)) }
                : item),
        });
    }, [bridge, t]);

    // 新建对话：创建新的 SDK session 并切换视图。旧会话留在主进程后台运行，不中断、不删除。
    const newSession = useCallback(() => {
        draftOwnerRef.current += 1;
        if (!bridge) return Promise.resolve();
        const snapshot = useAgentStore.getState().canvasContext?.snapshot;
        const scope = { projectId: snapshot?.projectId || "", canvasId: snapshot?.canvasId || "" };
        return runActiveSessionTransition(async (generation) => {
            const modelConfig = await resolvePiModelConfigForBridge();
            if (!modelConfig) throw new Error(t(modelNotReadyKey()));
            await syncModelConfig(modelConfig);
            const summary = await bridge.createSession({ scope, ...(await resolveWorkspaceForSession(scope.projectId)) });
            if (activeSessionGateRef.current.generation !== generation) return;
            sessionIdRef.current = summary.sessionId;
            sessionTitleRef.current = summary.title;
            sessionCreatedAtRef.current = summary.createdAt;
            useAgentSessionStore.getState().upsertSession(summary);
            useAgentSessionStore.getState().setActiveSession(summary.sessionId);
            const state = useAgentStore.getState();
            state.setAgentState({
                messages: [],
                piLifecycle: { ...state.piLifecycle, completedAssistantKey: "" },
                eventLogs: [],
                tokenUsage: null,
                sending: false,
                waiting: false,
                activity: t("agent.state.ready"),
                connectError: "",
            });
        });
    }, [bridge, runActiveSessionTransition, syncModelConfig, t]);

    // 切换到某个 SDK session：从主进程 entries 重建时间线；不中断其它会话。
    const continueSession = useCallback(
        (summary: PiSessionSummary) => {
            // 会话严格归属白板：跨 scope 的“继续”一律拒绝（与进画布的自动恢复同口径），
            // 防止把其他画布的对话绑成当前画布的活动会话、把当前白板快照喂给旧对话。
            const [activeProjectId = "", activeCanvasId = ""] = (scopeRef.current ?? "").split("::");
            if (summary.scope.projectId !== activeProjectId || summary.scope.canvasId !== activeCanvasId) return Promise.resolve();
            draftOwnerRef.current += 1;
            if (!bridge) return Promise.resolve();
            return runActiveSessionTransition(async (generation) => {
                const modelConfig = await resolvePiModelConfigForBridge();
                if (!modelConfig) throw new Error(t(modelNotReadyKey()));
                await syncModelConfig(modelConfig);
                const opened = await bridge.openSession(summary.sessionId);
                if (activeSessionGateRef.current.generation !== generation) return;
                sessionIdRef.current = opened.summary.sessionId;
                sessionTitleRef.current = opened.summary.title;
                sessionCreatedAtRef.current = opened.summary.createdAt;
                useAgentSessionStore.getState().upsertSession(opened.summary);
                useAgentSessionStore.getState().setActiveSession(opened.summary.sessionId);
                const state = useAgentStore.getState();
                state.setAgentState({
                    messages: projectSessionEntries(opened.summary.sessionId, opened.entries, {}),
                    piLifecycle: { completedAssistantKey: "", historyRestoreRevision: state.piLifecycle.historyRestoreRevision + 1 },
                    eventLogs: [],
                    tokenUsage: null,
                    sending: false,
                    waiting: false,
                    activity: t("agent.state.ready"),
                    connectError: "",
                });
            });
        },
        [bridge, runActiveSessionTransition, syncModelConfig, t],
    );

    // 关闭一个会话：只释放主进程 runtime/订阅，session 文件保留；renderer 移除本地入口。
    // 关闭在途会话走 abort → waitForIdle → close：主进程 abort() 只发起中断不等待 idle，
    // 直接 dispose 会与在途 turn 竞争（spec 2026-09-18 D5）。
    const closeSession = useCallback((sessionId: string) => {
        if (!bridge) return;
        if (sessionIdRef.current === sessionId) {
            draftOwnerRef.current += 1;
            activeSessionGateRef.current = { generation: activeSessionGateRef.current.generation + 1, inFlight: null };
        }
        void (async () => {
            await bridge.abort(sessionId).catch(() => undefined);
            await bridge.waitForIdle(sessionId).catch(() => undefined);
            await bridge.closeSession(sessionId);
        })()
            .then(() => {
                useAgentSessionStore.getState().removeLocal(sessionId);
                if (sessionIdRef.current === sessionId) {
                    sessionIdRef.current = null;
                    sessionTitleRef.current = "";
                    sessionCreatedAtRef.current = 0;
                    const state = useAgentStore.getState();
                    state.setAgentState({
                        messages: [],
                        eventLogs: [],
                        tokenUsage: null,
                        sending: false,
                        waiting: false,
                        activity: t("agent.state.ready"),
                        connectError: "",
                    });
                }
            })
            .catch((error: unknown) => reportFailure(error));
    }, [bridge, reportFailure, t]);

    const modelConfig = useMemo(() => resolvePiModelConfig(config), [config, sources, connection]);

    // 自动发送首页转交过来的 prompt（submitPrompt）。模型解析交给 sendPrompt 的门禁
    // （shotshot 模式会先注水目录快照再解析，memo 只作展示），失败时由其提示并恢复草稿。
    const submitRequest = useAgentStore((state) => state.submitRequest);
    useEffect(() => {
        if (!submitRequest || sources.status === "loading" || sources.applying) return;
        const text = useAgentStore.getState().prompt.trim();
        const pendingAttachments = useAgentStore.getState().pendingAttachments;
        const submitScope = scopeRef.current;
        const submitOwner = draftOwnerRef.current;
        useAgentStore.getState().setAgentState({ submitRequest: null, prompt: "", pendingAttachments: [] });
        if (text || pendingAttachments.length) void sendPrompt(text, pendingAttachments).then((accepted) => {
            if (!accepted && scopeRef.current === submitScope && draftOwnerRef.current === submitOwner) useAgentStore.getState().setAgentState({ prompt: text, pendingAttachments });
        });
    }, [submitRequest, sendPrompt, t, sources.status, sources.applying]);

    const abortSession = useCallback((sessionId: string) => {
        void bridge?.abort(sessionId).catch(() => undefined);
    }, [bridge]);

    return { available: Boolean(bridge), modelConfig, sendPrompt, stop, newSession, continueSession, closeSession, abortSession };
}

function extractCurrentAssistantText(state: { messages: AgentChatItem[] }): string {
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
        if (state.messages[index].role === "assistant") return state.messages[index].text;
    }
    return "";
}

function formatToolPayload(value: unknown): string {
    if (value == null) return "";
    if (typeof value === "string") return value.trim();
    if (value && typeof value === "object") {
        const content = (value as { content?: unknown }).content;
        if (Array.isArray(content)) {
            const text = content.flatMap((item) => item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string" ? [(item as { text: string }).text] : []).join("\n");
            if (text) return text;
        }
    }
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}
