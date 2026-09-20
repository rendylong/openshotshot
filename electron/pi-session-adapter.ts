import { resolve as resolvePath } from "node:path";

import { ensureMemorySnapshot, memoryRoot } from "./agent-memory";
import { parseAgentModelConfig } from "./agent-model-config";
import {
    createAgentSessionRuntime,
    SessionManager,
    type AgentSession,
    type AgentSessionEvent,
    type AgentSessionRuntime,
    type CreateAgentSessionRuntimeFactory,
    type CreateAgentSessionRuntimeResult,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";

import { buildModelsFromConfig } from "@/lib/agent/pi-provider-map";
import type {
    AgentFileInput,
    AgentUserFormAnswer,
    AgentUserInputResponse,
    PiAgentPromptFile,
    PiAgentPromptInput,
    PiSessionEntrySnapshot,
    PiSessionScope,
    PiSessionStatus,
    PiSessionSummary,
    PiSessionEnvelope,
    ResolvedTextModelConfig,
} from "@/lib/agent/pi-agent-types";
import { AGENT_ATTACHMENTS_CUSTOM_TYPE } from "@/lib/agent/pi-agent-types";
import { isValidSessionId, parseSessionEnvelope, parseSessionEntryRange, parseSessionScope, sessionStatusFromAgentEvent } from "@/lib/agent/pi-session-contract";
import { DEFAULT_AGENT_APPROVAL_MODE, isAgentApprovalMode } from "./pi-agent-approval";
import type { AgentApprovalDecision, AgentApprovalMode } from "@/lib/agent/pi-agent-types";
import { dispatchAgentPrompt } from "./agent-skill-request";
import { resolveWorkspaceCwd, restoreWorkspaceCwd } from "./agent-workspace";
import { createPiSessionStore, type PiSessionStore, type PiSessionSummaryListResult } from "./pi-session-store";
import { importLegacySessions, type LegacySessionImportResult } from "./pi-session-migration";
import { MIGRATION_MARKER } from "./app-data-paths";
import { attachmentsManifestData, attachmentManifestAbortData, createAgentFileRegistry, type AgentFileRegistry } from "./agent-files";
import type { SkillRuntime } from "./skill-runtime";

export { createShotshotSessionExtension } from "./pi-canvas-context";

type CreateRuntimeOptions = Parameters<CreateAgentSessionRuntimeFactory>[0];

export type PiSessionRuntimeFactory = (
    options: CreateRuntimeOptions & {
        model: Model<any> | null;
        runtimeState: SessionRuntimeState;
        files: AgentFileRegistry;
    },
) => Promise<CreateAgentSessionRuntimeResult>;

export type SessionRuntimeRegistryItem = {
    sessionId: string;
    runtime: AgentSessionRuntime;
    session: AgentSession;
    sessionManager: SessionManager;
    unsubscribe: () => void;
    scope: PiSessionScope;
    status: PiSessionStatus;
    turnBindings: Map<string, string>;
    title: string;
    createdAt: number;
    updatedAt: number;
    files: AgentFileRegistry;
    runtimeState: SessionRuntimeState;
};

export type SessionToolSummary = { name: string; label: string; promptSnippet?: string };

/**
 * SDK 内置工具的注册与系统提示词摘要。历史上只激活了 read；bash/edit/write
 * 服务于 codex 式审批模式（见 pi-agent-approval.ts），confirm_changes 模式下
 * 每次调用都要用户批准。
 */
export const BUILT_IN_TOOL_SUMMARIES: SessionToolSummary[] = [
    { name: "read", label: "Read File", promptSnippet: "读取本地文件内容（支持相对会话目录与绝对路径）。" },
    { name: "bash", label: "Run Command", promptSnippet: "在会话工作目录执行 shell 命令并返回输出；审批模式下每条命令需用户批准。" },
    { name: "edit", label: "Edit File", promptSnippet: "对现有文件做精确文本替换（edits[].oldText 必须与原文完全一致）；审批模式下需用户批准。" },
    { name: "write", label: "Write File", promptSnippet: "创建新文件或完整覆写已有文件；审批模式下需用户批准。" },
];

export type SessionRuntimeState = {
    sessionId: string;
    systemPrompt?: string;
    scope: PiSessionScope;
    files: AgentFileRegistry;
    activeExplicitSkillName?: string;
    queuedExplicitSkillNames: Array<string | undefined>;
    activeTurnId?: string;
    turnSequence: number;
    replacing?: boolean;
    allTools?: SessionToolSummary[];
    tools?: SessionToolSummary[];
    modelConfig?: ResolvedTextModelConfig | null;
    approvalMode: AgentApprovalMode;
    /** 会话绑定的工作区（realpath 规范路径）；undefined = 无工作区（cwd 为 agent-sessions）。 */
    workspacePath?: string;
    /** 会话级记忆快照；undefined = 未装载（首轮 prompt 装载一次），"" = 已装载且当前无记忆。 */
    memorySnapshot?: string;
};

const IMAGE_INPUT_TOOL_NAME = "view_image";
const CHATGPT_IMAGE_TOOL_NAME = "generate_chatgpt_image";

export function selectSessionToolsForModel(tools: SessionToolSummary[], supportsImageInput: boolean, provider?: string): SessionToolSummary[] {
    return tools.filter((tool) => (supportsImageInput || tool.name !== IMAGE_INPUT_TOOL_NAME)
        && (provider === "openai-codex" || tool.name !== CHATGPT_IMAGE_TOOL_NAME));
}

export function createSessionToolSelection(allTools: SessionToolSummary[], supportsImageInput: boolean, provider?: string) {
    const mergedTools = [...BUILT_IN_TOOL_SUMMARIES, ...allTools];
    const activeTools = selectSessionToolsForModel(mergedTools, supportsImageInput, provider);
    return {
        registeredNames: [...new Set(mergedTools.map((tool) => tool.name))],
        activeNames: [...new Set(activeTools.map((tool) => tool.name))],
        activeTools,
    };
}

function selectActiveToolNamesForModel(activeToolNames: string[], allTools: SessionToolSummary[], supportsImageInput: boolean, provider: string): string[] {
    const nextNames = activeToolNames.filter((name) => name !== IMAGE_INPUT_TOOL_NAME && name !== CHATGPT_IMAGE_TOOL_NAME);
    if (supportsImageInput && allTools.some((tool) => tool.name === IMAGE_INPUT_TOOL_NAME)) {
        nextNames.push(IMAGE_INPUT_TOOL_NAME);
    }
    if (provider === "openai-codex" && allTools.some((tool) => tool.name === CHATGPT_IMAGE_TOOL_NAME)) {
        nextNames.push(CHATGPT_IMAGE_TOOL_NAME);
    }
    return nextNames;
}

export type SessionRuntimeRegistry = {
    createSession(input: { scope: PiSessionScope; title?: string; workspacePath?: string }): Promise<PiSessionSummary>;
    openSession(sessionId: string): Promise<{ summary: PiSessionSummary; entries: PiSessionEntrySnapshot[] }>;
    closeSession(sessionId: string): Promise<void>;
    listSessions(scope?: PiSessionScope): PiSessionSummaryListResult;
    importLegacySessions(input: unknown): Promise<LegacySessionImportResult>;
    get(sessionId: string): SessionRuntimeRegistryItem | undefined;
    prompt(sessionId: string, input: PiAgentPromptInput | string, options?: { explicitSkillName?: string }): Promise<{ ok: true } | { ok: false; error: string }>;
    abort(sessionId: string): Promise<void>;
    compact(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }>;
    setWaitingForInput(sessionId: string, waiting: boolean): void;
    setWaitingForApproval(sessionId: string, waiting: boolean): void;
    abortProvider(providerId: string): Promise<void>;
    setModelConfig(config: ResolvedTextModelConfig): Promise<void>;
    waitForIdle(sessionId?: string): Promise<void>;
    dispose(): Promise<void>;
};

type SessionRuntimeRegistryOptions = {
    sessionDir: string;
    createRuntime: PiSessionRuntimeFactory;
    getWindow: () => BrowserWindow | null;
    skillRuntime: SkillRuntime;
    agentDir?: string;
    createFileRegistry?: typeof createAgentFileRegistry;
    sessionStore?: PiSessionStore;
    migrationMarker?: string;
    allowedRoots?: string[];
    onModelChanged?: (item: SessionRuntimeRegistryItem, model: Model<any>) => void;
    resolveModel?: (config: ResolvedTextModelConfig) => Model<any> | Promise<Model<any>>;
};

const UNKNOWN_SESSION = "Agent 会话不存在";
const STALE_SESSION = "Agent 会话已失效：目标会话已被替换或关闭";

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentApprovalDecision(value: unknown): value is AgentApprovalDecision {
    return value === "accept" || value === "acceptForSession" || value === "decline";
}

function messageText(content: unknown): string | undefined {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return undefined;
    const text = content
        .filter((block): block is { type: "text"; text: string } =>
            isPlainObject(block) && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("");
    return text || undefined;
}

function toEntrySnapshot(entry: SessionEntry): PiSessionEntrySnapshot {
    return {
        id: entry.id,
        parentId: entry.parentId,
        type: entry.type,
        // raw 必须带上：投影层（pi-session-projection）从 entry.raw.message.content
        // 解析 thinking / toolCall / text parts；丢了 raw 时 assistant 字符串兜底
        // 会被当成空 parts，恢复会话只剩 user 文本和空 turn 折叠条。
        raw: entry,
        ...(entry.type === "message" ? {
            role: entry.message.role,
            text: messageText(entry.message.role === "user" || entry.message.role === "assistant" ? entry.message.content : undefined),
        } : {}),
        ...(entry.type === "compaction" ? {
            compaction: {
                summary: entry.summary,
                firstKeptEntryId: entry.firstKeptEntryId,
                tokensBefore: entry.tokensBefore,
            },
        } : {}),
        ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
    };
}

function statusFromSession(session: AgentSession, fallback: PiSessionStatus): PiSessionStatus {
    if (session.isCompacting) return "compacting";
    if (session.isStreaming) return "running";
    if (session.pendingMessageCount > 0) return "queued";
    return fallback === "queued" || fallback === "running" || fallback === "compacting" ? "idle" : fallback;
}

function toSummary(item: SessionRuntimeRegistryItem): PiSessionSummary {
    return {
        sessionId: item.sessionId,
        title: item.title,
        scope: item.scope,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        status: item.status,
        hasUnfinishedOperation: item.status === "running" || item.status === "queued" || item.status === "waiting_approval" || item.status === "waiting_input" || item.status === "compacting",
    };
}

export function createSessionRuntimeRegistry(options: SessionRuntimeRegistryOptions): SessionRuntimeRegistry {
    const sessions = new Map<string, SessionRuntimeRegistryItem>();
    const agentDir = options.agentDir ?? options.sessionDir;
    const createFileRegistry = options.createFileRegistry ?? createAgentFileRegistry;
    const sessionStore = options.sessionStore ?? createPiSessionStore({ sessionDir: options.sessionDir });
    let modelConfig: ResolvedTextModelConfig | null = null;
    let configWrites: Promise<unknown> = Promise.resolve();
    const appliedConfigs = new WeakMap<SessionRuntimeRegistryItem, ResolvedTextModelConfig | null>();
    const preparations = new Map<string, Promise<SessionRuntimeRegistryItem>>();
    const resolve = (config: ResolvedTextModelConfig) => {
        if (options.resolveModel) return options.resolveModel(config);
        if (config.source === "chatgpt" || config.source === "platform") throw new Error("managed_agent_unavailable");
        return buildModelsFromConfig(config).model;
    };
    let generation = 0;
    let disposed = false;
    const pendingCreations = new Set<Promise<SessionRuntimeRegistryItem>>();
    const pendingOpens = new Map<string, Promise<SessionRuntimeRegistryItem>>();

    const send = (envelope: PiSessionEnvelope) => {
        if (!parseSessionEnvelope(envelope)) return;
        const win = options.getWindow();
        if (win && !win.isDestroyed()) win.webContents.send("agent:event", envelope);
    };

    const emitError = (item: SessionRuntimeRegistryItem, error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (sessions.get(item.sessionId) !== item) return;
        item.status = "error";
        item.updatedAt = Date.now();
        send({
            sessionId: item.sessionId,
            kind: "error",
            payload: { type: "error", message },
        });
    };

    const isCurrentItem = (item: SessionRuntimeRegistryItem) => sessions.get(item.sessionId) === item && !item.runtimeState.replacing;

    const bindSession = (runtime: AgentSessionRuntime, session: AgentSession, state: SessionRuntimeState) => {
        return session.subscribe((event) => {
            const item = sessions.get(state.sessionId);
            if (!item || item.session !== session) return;
            const nextStatus = sessionStatusFromAgentEvent("agent", event.type, event);
            if (nextStatus) item.status = nextStatus;
            item.status = statusFromSession(session, item.status);
            item.updatedAt = Date.now();
            if (event.type === "agent_settled") {
                state.activeExplicitSkillName = state.queuedExplicitSkillNames.shift();
            }
            if (event.type === "agent_start") {
                state.activeTurnId = `turn-${++state.turnSequence}`;
            }
            if (state.activeTurnId && (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end")) {
                item.turnBindings.set(event.toolCallId, state.activeTurnId);
            }
            if (event.type === "entry_appended") {
                item.updatedAt = Date.now();
                if (state.activeTurnId) item.turnBindings.set(event.entry.id, state.activeTurnId);
            }
            if (event.type === "agent_settled") {
                state.activeTurnId = undefined;
            }
            send({ sessionId: item.sessionId, kind: "agent", payload: event });
        });
    };

    const installReplacementHooks = (runtime: AgentSessionRuntime, state: SessionRuntimeState) => {
        runtime.setBeforeSessionInvalidate(() => {
            const item = sessions.get(state.sessionId);
            if (item?.runtime !== runtime) return;
            state.replacing = true;
            item.unsubscribe();
        });
        runtime.setRebindSession(async (nextSession) => {
            const previous = sessions.get(state.sessionId);
            if (!previous || previous.runtime !== runtime) return;

            const previousId = previous.sessionId;
            const unsubscribe = bindSession(runtime, nextSession, state);
            const replacement: SessionRuntimeRegistryItem = {
                ...previous,
                sessionId: nextSession.sessionId,
                session: nextSession,
                sessionManager: nextSession.sessionManager,
                unsubscribe,
                updatedAt: Date.now(),
                status: statusFromSession(nextSession, "idle"),
            };
            state.sessionId = nextSession.sessionId;
            state.replacing = false;
            sessions.delete(previousId);
            sessions.set(replacement.sessionId, replacement);
            appliedConfigs.set(replacement, state.modelConfig ?? null);

            send({
                sessionId: replacement.sessionId,
                kind: "agent",
                payload: {
                    type: "session_info_changed",
                    name: nextSession.sessionName,
                    replacedSessionId: previousId,
                    entries: nextSession.sessionManager.getEntries().map(toEntrySnapshot),
                },
            });
        });
    };

    const createRuntimeItem = async (
        sessionManager: SessionManager,
        input: { scope: PiSessionScope; title: string; createdAt: number; updatedAt: number; cwd: string; workspacePath?: string },
        creationGeneration: number,
    ): Promise<SessionRuntimeRegistryItem> => {
        const state: SessionRuntimeState = {
            sessionId: sessionManager.getSessionId(),
            scope: input.scope,
            files: createFileRegistry({ allowedRoots: options.allowedRoots ?? [options.sessionDir] }),
            queuedExplicitSkillNames: [],
            turnSequence: 0,
            approvalMode: DEFAULT_AGENT_APPROVAL_MODE,
            workspacePath: input.workspacePath,
        };
        let runtime: AgentSessionRuntime | null = null;
        try {
            runtime = await createAgentSessionRuntime(
                async (factoryOptions) => {
                    const selected = modelConfig;
                    const model = selected ? await resolve(selected) : null;
                    const created = await options.createRuntime({ ...factoryOptions, model, runtimeState: state, files: state.files });
                    state.modelConfig = selected;
                    return created;
                },
                { cwd: input.cwd, agentDir, sessionManager },
            );
            if (disposed || creationGeneration !== generation) {
                throw new Error("Agent runtime 已销毁，会话创建已取消");
            }
            const session = runtime.session;
            state.sessionId = session.sessionId;
            const item: SessionRuntimeRegistryItem = {
                sessionId: session.sessionId,
                runtime,
                session,
                sessionManager: session.sessionManager,
                unsubscribe: () => undefined,
                scope: input.scope,
                status: statusFromSession(session, "idle"),
                turnBindings: new Map(),
                title: input.title,
                createdAt: input.createdAt,
                updatedAt: input.updatedAt,
                files: state.files,
                runtimeState: state,
            };
            installReplacementHooks(runtime, state);
            item.unsubscribe = bindSession(runtime, session, state);
            sessions.set(item.sessionId, item);
            appliedConfigs.set(item, state.modelConfig ?? null);
            return item;
        } catch (error) {
            try {
                await runtime?.dispose();
            } finally {
                state.files.clear();
            }
            throw error;
        }
    };

    const prepare = (sessionId: string): Promise<SessionRuntimeRegistryItem> => {
        const pending = preparations.get(sessionId);
        if (pending) return pending;
        const task = (async () => {
            await configWrites;
            const item = sessions.get(sessionId);
            if (!item) throw new Error(`${UNKNOWN_SESSION}：${sessionId}`);
            if (!isCurrentItem(item)) throw new Error(STALE_SESSION);
            // Queued work remains on its current turn's provider, including auth checks.
            const busy = item.session.isStreaming || item.session.isCompacting || item.session.pendingMessageCount > 0;
            const desired = busy ? appliedConfigs.get(item) : modelConfig;
            if (!desired) return item;
            const model = await resolve(desired);
            if (!isCurrentItem(item)) throw new Error(STALE_SESSION);
            if (!busy && appliedConfigs.get(item) !== desired) {
                await item.session.setModel(model);
                if (!isCurrentItem(item)) throw new Error(STALE_SESSION);
                if (item.runtimeState.allTools?.some((tool) => tool.name === IMAGE_INPUT_TOOL_NAME || tool.name === CHATGPT_IMAGE_TOOL_NAME)) {
                    const supportsImageInput = model.input.includes("image");
                    item.session.setActiveToolsByName(selectActiveToolNamesForModel(
                        item.session.getActiveToolNames(),
                        item.runtimeState.allTools,
                        supportsImageInput,
                        model.provider,
                    ));
                    item.runtimeState.tools = selectSessionToolsForModel(item.runtimeState.allTools, supportsImageInput, model.provider);
                }
                options.onModelChanged?.(item, model);
                appliedConfigs.set(item, desired);
            }
            return item;
        })();
        preparations.set(sessionId, task);
        void task.finally(() => { if (preparations.get(sessionId) === task) preparations.delete(sessionId); }).catch(() => undefined);
        return task;
    };

    const registry: SessionRuntimeRegistry = {
        async createSession(input) {
            const now = Date.now();
            // 校验失败（相对路径 / 目录不存在）在这里抛错，会话创建整体失败。
            const workspacePath = await resolveWorkspaceCwd(input.workspacePath);
            const sessionManager = sessionStore.createSessionManager({
                scope: input.scope,
                title: input.title,
                ...(workspacePath ? { workspacePath } : {}),
            });
            const createdAt = Date.parse(sessionManager.getHeader()?.timestamp ?? "") || now;
            const completion = createRuntimeItem(
                sessionManager,
                {
                    scope: input.scope,
                    title: input.title?.trim() || "新 Agent 会话",
                    createdAt,
                    updatedAt: now,
                    cwd: workspacePath ?? options.sessionDir,
                    workspacePath,
                },
                generation,
            );
            pendingCreations.add(completion);
            try {
                return toSummary(await completion);
            } finally {
                pendingCreations.delete(completion);
            }
        },

        async openSession(sessionId) {
            const existing = sessions.get(sessionId);
            if (existing) {
                return {
                    summary: toSummary(existing),
                    entries: existing.sessionManager.buildContextEntries().map(toEntrySnapshot),
                };
            }

            const opening = pendingOpens.get(sessionId) ?? (async () => {
                let persisted = sessionStore.listSessionSummaries().sessions.find((summary) => summary.sessionId === sessionId);
                if (!persisted) throw new Error(`${UNKNOWN_SESSION}：${sessionId}`);
                const sessionManager = sessionStore.openSessionManager(sessionId);
                const appendedScope = sessionStore.ensureScopeEntry(sessionManager, persisted.scope);
                persisted = {
                    ...persisted,
                    updatedAt: appendedScope ? Date.now() : persisted.updatedAt,
                };
                // 打开路径永远不抛错：绑定的工作区已不存在时回退到 agent-sessions。
                const boundWorkspace = sessionStore.readSessionWorkspace(sessionManager);
                const runtimeCwd = await restoreWorkspaceCwd(boundWorkspace, options.sessionDir);
                const workspacePath = resolvePath(runtimeCwd) === resolvePath(options.sessionDir) ? undefined : runtimeCwd;
                const completion = createRuntimeItem(
                    sessionManager,
                    {
                        scope: persisted.scope,
                        title: persisted.title,
                        createdAt: persisted.createdAt,
                        updatedAt: persisted.updatedAt,
                        cwd: runtimeCwd,
                        workspacePath,
                    },
                    generation,
                );
                pendingCreations.add(completion);
                try {
                    return await completion;
                } finally {
                    pendingCreations.delete(completion);
                }
            })();
            pendingOpens.set(sessionId, opening);
            try {
                const item = await opening;
                return {
                    summary: toSummary(item),
                    entries: item.sessionManager.buildContextEntries().map(toEntrySnapshot),
                };
            } finally {
                if (pendingOpens.get(sessionId) === opening) pendingOpens.delete(sessionId);
            }
        },

        async closeSession(sessionId) {
            const opening = pendingOpens.get(sessionId);
            if (opening) await opening.catch(() => undefined);
            const item = sessions.get(sessionId);
            if (!item) throw new Error(`${UNKNOWN_SESSION}：${sessionId}`);
            sessions.delete(sessionId);
            item.unsubscribe();
            await item.runtime.dispose();
            item.files.clear();
        },

        listSessions(scope) {
            // 永远返回对象，保持与 IPC 契约 / 渲染层预期一致：
            // 老的实现里“unreadable 为空时退回裸数组”会让渲染层 spread undefined 触发 is not iterable。
            if (disposed) return { sessions: [], unreadable: [] };
            let persisted: PiSessionSummaryListResult;
            try {
                persisted = sessionStore.listSessionSummaries(scope);
            } catch (error) {
                return {
                    sessions: [...sessions.values()]
                        .filter((item) => !scope || (item.scope.projectId === scope.projectId && item.scope.canvasId === scope.canvasId))
                        .map(toSummary),
                    unreadable: [{
                        file: options.sessionDir,
                        error: error instanceof Error ? error.message : String(error),
                    }],
                };
            }

            const byId = new Map(persisted.sessions.map((summary) => [summary.sessionId, summary]));
            for (const item of sessions.values()) {
                if (scope && (item.scope.projectId !== scope.projectId || item.scope.canvasId !== scope.canvasId)) continue;
                byId.set(item.sessionId, toSummary(item));
            }
            const summaries = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
            return { sessions: summaries, unreadable: persisted.unreadable };
        },

        async importLegacySessions(input) {
            return importLegacySessions(input, {
                sessionDir: options.sessionDir,
                migrationMarker: options.migrationMarker ?? MIGRATION_MARKER,
            });
        },

        get(sessionId) {
            return sessions.get(sessionId);
        },

        async prompt(sessionId, input, promptOptions) {
            let item: SessionRuntimeRegistryItem;
            try { item = await prepare(sessionId); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
            if (!item) return { ok: false, error: `${UNKNOWN_SESSION}：${sessionId}` };
            if (item.runtimeState.replacing) return { ok: false, error: "Agent 会话正在替换，请稍后重试" };
            const explicitSkillName = promptOptions?.explicitSkillName;
            if (item.session.isStreaming) {
                item.runtimeState.queuedExplicitSkillNames.push(explicitSkillName);
            } else {
                item.runtimeState.activeExplicitSkillName = explicitSkillName;
            }
            const promptIsCurrent = () => isCurrentItem(item);
            try {
                const memoryBlock = await ensureMemorySnapshot(item.runtimeState, memoryRoot(), item.runtimeState.workspacePath);
                return await dispatchAgentPrompt({
                    input,
                    skillRuntime: options.skillRuntime,
                    tools: (item.runtimeState.tools ?? []).map((tool) => ({
                        name: tool.name,
                        label: tool.label,
                        ...(tool.promptSnippet ? { promptSnippet: tool.promptSnippet } : {}),
                    })),
                    workspacePath: item.runtimeState.workspacePath,
                    memoryBlock,
                    getController: () => ({
                        prompt: async (promptInput) => {
                            if (!promptIsCurrent()) throw new Error(STALE_SESSION);
                            const activeConfig = appliedConfigs.get(item);
                            if (activeConfig?.source === "chatgpt") await resolve(activeConfig);
                            if (!promptIsCurrent()) throw new Error(STALE_SESSION);
                            const prompt = typeof promptInput === "string" ? { text: promptInput } : promptInput;
                            // 附件清单先落 session（custom entry，不参与上下文），投影层恢复历史时按相邻用户消息归属；
                            // 必须在 Skill 校验通过、真正发起本轮 prompt 前写入，失败的发送不会留下孤儿清单。
                            let manifestEntryId: string | undefined;
                            if (prompt.files?.length) {
                                manifestEntryId = item.sessionManager.appendCustomEntry(AGENT_ATTACHMENTS_CUSTOM_TYPE, attachmentsManifestData(item.scope.projectId, prompt.files satisfies PiAgentPromptFile[]));
                            }
                            try {
                                await item.session.prompt(prompt.text, {
                                    images: prompt.images,
                                    streamingBehavior: "followUp",
                                    expandPromptTemplates: false,
                                });
                            } catch (error) {
                                // prompt 失败（用户消息可能没落盘）时把清单标记为已作废，
                                // 恢复历史时投影层不会把它附着到后续用户消息上。
                                if (manifestEntryId) {
                                    try {
                                        item.sessionManager.appendCustomEntry(AGENT_ATTACHMENTS_CUSTOM_TYPE, attachmentManifestAbortData(manifestEntryId));
                                    } catch {
                                        // 作废标记写失败也只影响下一次恢复时的附件归属，不掩盖原始错误。
                                    }
                                }
                                throw error;
                            }
                            if (!promptIsCurrent()) throw new Error(STALE_SESSION);
                        },
                        waitForIdle: async () => {
                            if (!promptIsCurrent()) throw new Error(STALE_SESSION);
                            await item.session.waitForIdle();
                            if (!promptIsCurrent()) throw new Error(STALE_SESSION);
                        },
                    }),
                    setSystemPrompt: (systemPrompt) => {
                        if (!promptIsCurrent()) throw new Error(STALE_SESSION);
                        // The SDK overwrites agent.state.systemPrompt before prompting and
                        // between tool turns. before_agent_start installs the supported override.
                        item.runtimeState.systemPrompt = systemPrompt;
                    },
                });
            } catch (error) {
                if (promptIsCurrent()) emitError(item, error);
                return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
        },

        async abort(sessionId) {
            const item = sessions.get(sessionId);
            if (!item) throw new Error(`${UNKNOWN_SESSION}：${sessionId}`);
            if (item.runtimeState.replacing) throw new Error("Agent 会话正在替换，请稍后重试");
            await item.session.abort();
            if (!isCurrentItem(item)) throw new Error(STALE_SESSION);
            item.status = statusFromSession(item.session, "interrupted");
            item.updatedAt = Date.now();
        },

        async compact(sessionId) {
            let item: SessionRuntimeRegistryItem;
            try { item = await prepare(sessionId); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
            if (!item) return { ok: false, error: `${UNKNOWN_SESSION}：${sessionId}` };
            if (item.runtimeState.replacing) return { ok: false, error: "Agent 会话正在替换，请稍后重试" };
            try {
                await item.session.compact();
                if (!isCurrentItem(item)) return { ok: false, error: STALE_SESSION };
                item.status = statusFromSession(item.session, "idle");
                item.updatedAt = Date.now();
                return { ok: true };
            } catch (error) {
                if (!isCurrentItem(item)) return { ok: false, error: STALE_SESSION };
                const message = error instanceof Error ? error.message : String(error);
                emitError(item, error);
                return { ok: false, error: message };
            }
        },

        setWaitingForInput(sessionId, waiting) {
            const item = sessions.get(sessionId);
            if (!item || item.runtimeState.replacing) return;
            if (waiting) {
                item.status = "waiting_input";
            } else if (item.status === "waiting_input") {
                item.status = statusFromSession(item.session, "idle");
            }
            item.updatedAt = Date.now();
        },

        setWaitingForApproval(sessionId, waiting) {
            const item = sessions.get(sessionId);
            if (!item || item.runtimeState.replacing) return;
            if (waiting) {
                item.status = "waiting_approval";
            } else if (item.status === "waiting_approval") {
                item.status = statusFromSession(item.session, "idle");
            }
            item.updatedAt = Date.now();
        },

        async abortProvider(providerId) {
            const matching = [...sessions.values()].filter(item => item.session.model?.provider === providerId);
            await Promise.all(matching.map(async item => { await item.session.abort(); await item.session.waitForIdle(); }));
        },

        async setModelConfig(config) {
            const task = configWrites.catch(() => undefined).then(async () => {
                await resolve(config);
                modelConfig = config;
            });
            configWrites = task;
            await task;
        },

        async waitForIdle(sessionId) {
            if (!sessionId) {
                await Promise.all([...sessions.values()].map((item) => item.session.waitForIdle()));
                return;
            }
            const item = sessions.get(sessionId);
            if (!item) throw new Error(`${UNKNOWN_SESSION}：${sessionId}`);
            if (item.runtimeState.replacing) throw new Error("Agent 会话正在替换，请稍后重试");
            await item.session.waitForIdle();
            if (!isCurrentItem(item)) throw new Error(STALE_SESSION);
        },

        async dispose() {
            generation += 1;
            disposed = true;
            const items = [...sessions.values()];
            sessions.clear();
            for (const item of items) {
                item.unsubscribe();
                item.files.clear();
            }
            await Promise.all([
                ...items.map((item) => item.runtime.dispose()),
                ...[...pendingCreations].map((creation) => creation.catch(() => undefined)),
            ]);
        },
    };

    return registry;
}

export type AgentChannelNames = {
    listSessions: string;
    createSession: string;
    openSession: string;
    closeSession: string;
    readSessionEntries: string;
    prompt: string;
    abort: string;
    compact: string;
    respondToUserInput: string;
    opsReceipt: string;
    setCanvasSnapshot: string;
    setProjects: string;
    setGenerationStatus: string;
    setModels: string;
    setScriptEntities: string;
    importLegacySessions: string;
    setModelConfig: string;
    event: string;
    waitForIdle: string;
    registerFiles: string;
    readFile: string;
    listFolder: string;
    setApprovalMode: string;
    respondToApproval: string;
};

function requireSessionId(raw: unknown): string {
    if (!isValidSessionId(raw)) throw new Error("非法 Agent sessionId");
    return raw;
}

function requireSnapshot(raw: unknown): Record<string, unknown> {
    if (!isPlainObject(raw)) throw new Error("非法画布快照");
    return raw;
}

export async function registerPiSessionAdapter(input: {
    isTrustedSender?: (event: IpcMainInvokeEvent) => boolean;
    registry: SessionRuntimeRegistry;
    channels: AgentChannelNames;
    setCanvasSnapshot?: (scope: PiSessionScope, snapshot: Record<string, unknown>) => void;
    setProjects?: (projects: unknown) => void;
    setGenerationStatus?: (tasks: unknown) => void;
    setModels?: (models: unknown) => void;
    setScriptEntities?: (entities: unknown) => void;
    respondToUserInput?: (sessionId: string, requestId: string, response: AgentUserInputResponse) => { ok: true } | { ok: false; error: string };
    disposeUserInputSession?: (sessionId: string) => void;
    resolveOpsReceipts?: (sessionId: string, requestId: string, receipts: unknown) => boolean;
    respondToApproval?: (sessionId: string, requestId: string, decision: AgentApprovalDecision) => { ok: true } | { ok: false; error: string };
    disposeApprovalSession?: (sessionId: string) => void;
}): Promise<() => void> {
    const { registry, channels } = input;
    const { ipcMain } = await import("electron");
    const handlers: Array<[string, (...args: unknown[]) => unknown]> = [
        [channels.listSessions, async (_event: unknown, scopeRaw: unknown) => {
            if (scopeRaw !== undefined && scopeRaw !== null) {
                const scope = parseSessionScope(scopeRaw);
                if (!scope) throw new Error("非法 Agent 会话范围");
                return registry.listSessions(scope);
            }
            return registry.listSessions();
        }],
        [channels.createSession, async (_event: unknown, raw: unknown) => {
            if (!isPlainObject(raw)) throw new Error("非法 Agent 会话创建请求");
            const scope = parseSessionScope(raw.scope);
            if (!scope) throw new Error("非法 Agent 会话范围");
            if (raw.title !== undefined && typeof raw.title !== "string") throw new Error("非法 Agent 会话标题");
            // 先校验工作区（相对路径 / 目录不存在直接抛给渲染层），再进入 registry。
            const workspacePath = await resolveWorkspaceCwd(raw.workspacePath);
            return registry.createSession({
                scope,
                ...(typeof raw.title === "string" ? { title: raw.title } : {}),
                ...(workspacePath !== undefined ? { workspacePath } : {}),
            });
        }],
        [channels.openSession, async (_event: unknown, raw: unknown) => registry.openSession(requireSessionId(raw))],
        [channels.closeSession, async (_event: unknown, raw: unknown) => {
            const sessionId = requireSessionId(raw);
            input.disposeUserInputSession?.(sessionId);
            input.disposeApprovalSession?.(sessionId);
            return registry.closeSession(sessionId);
        }],
        [channels.readSessionEntries, async (_event: unknown, sessionIdRaw: unknown, rangeRaw: unknown) => {
            const sessionId = requireSessionId(sessionIdRaw);
            const range = parseSessionEntryRange(rangeRaw);
            if (!range) throw new Error("非法 Agent 历史范围");
            const opened = await registry.openSession(sessionId);
            if (!range.fromEntryId && !range.toEntryId) return opened.entries;
            const from = range.fromEntryId ? opened.entries.findIndex((entry) => entry.id === range.fromEntryId) : 0;
            const to = range.toEntryId ? opened.entries.findIndex((entry) => entry.id === range.toEntryId) : opened.entries.length - 1;
            if (from < 0 || to < from) throw new Error("非法 Agent 历史范围");
            return opened.entries.slice(from, to + 1);
        }],
        [channels.prompt, async (_event: unknown, ...args: unknown[]) => {
            if (args.length < 2) return { ok: false as const, error: "v1 Agent prompt 已停用：请显式传入 sessionId" };
            const prompt = parseAgentPromptInput(args[1]);
            if (!prompt) throw new Error("非法 Agent prompt 输入");
            if (args[2] !== undefined && (!isPlainObject(args[2]) || typeof args[2].explicitSkillName !== "string")) throw new Error("非法 Agent prompt 选项");
            return registry.prompt(
                requireSessionId(args[0]),
                prompt,
                isPlainObject(args[2]) ? { explicitSkillName: args[2].explicitSkillName as string } : undefined,
            );
        }],
        [channels.abort, async (_event: unknown, raw: unknown) => registry.abort(requireSessionId(raw))],
        [channels.compact, async (_event: unknown, raw: unknown) => registry.compact(requireSessionId(raw))],
        [channels.respondToUserInput, async (_event: unknown, sessionIdRaw: unknown, requestIdRaw: unknown, responseRaw: unknown) => {
            const sessionId = requireSessionId(sessionIdRaw);
            if (typeof requestIdRaw !== "string" || !requestIdRaw.trim()) throw new Error("非法用户输入 requestId");
            const response = parseAgentUserInputResponse(responseRaw);
            if (!response) throw new Error("非法用户输入响应");
            return input.respondToUserInput?.(sessionId, requestIdRaw, response) ?? { ok: false as const, error: "用户输入能力不可用" };
        }],
        [channels.setApprovalMode, async (_event: unknown, sessionIdRaw: unknown, modeRaw: unknown) => {
            const sessionId = requireSessionId(sessionIdRaw);
            if (!isAgentApprovalMode(modeRaw)) throw new Error("非法审批模式");
            const item = registry.get(sessionId);
            if (!item) throw new Error(`${UNKNOWN_SESSION}：${sessionId}`);
            if (item.runtimeState.replacing) throw new Error("Agent 会话正在替换，请稍后重试");
            item.runtimeState.approvalMode = modeRaw;
            return undefined;
        }],
        [channels.respondToApproval, async (_event: unknown, sessionIdRaw: unknown, requestIdRaw: unknown, decisionRaw: unknown) => {
            const sessionId = requireSessionId(sessionIdRaw);
            if (typeof requestIdRaw !== "string" || !requestIdRaw.trim()) throw new Error("非法审批 requestId");
            if (!isAgentApprovalDecision(decisionRaw)) throw new Error("非法审批决策");
            return input.respondToApproval?.(sessionId, requestIdRaw, decisionRaw) ?? { ok: false as const, error: "审批能力不可用" };
        }],
        [channels.setCanvasSnapshot, async (_event: unknown, scopeRaw: unknown, snapshotRaw: unknown) => {
            const scope = parseSessionScope(scopeRaw);
            if (!scope) throw new Error("非法 Agent 会话范围");
            const snapshot = requireSnapshot(snapshotRaw);
            input.setCanvasSnapshot?.(scope, snapshot);
            return undefined;
        }],
        [channels.setProjects, async (_event: unknown, projectsRaw: unknown) => {
            input.setProjects?.(projectsRaw);
            return undefined;
        }],
        [channels.setGenerationStatus, async (_event: unknown, tasksRaw: unknown) => {
            input.setGenerationStatus?.(tasksRaw);
            return undefined;
        }],
        [channels.setModels, async (_event: unknown, modelsRaw: unknown) => {
            input.setModels?.(modelsRaw);
            return undefined;
        }],
        [channels.setScriptEntities, async (_event: unknown, entitiesRaw: unknown) => {
            input.setScriptEntities?.(entitiesRaw);
            return undefined;
        }],
        [channels.opsReceipt, async (_event: unknown, sessionIdRaw: unknown, requestIdRaw: unknown, receiptsRaw: unknown) => {
            const sessionId = requireSessionId(sessionIdRaw);
            if (typeof requestIdRaw !== "string" || !requestIdRaw.trim()) throw new Error("非法 ops 回执 requestId");
            if (!Array.isArray(receiptsRaw)) throw new Error("非法 ops 回执");
            return input.resolveOpsReceipts?.(sessionId, requestIdRaw, receiptsRaw) ?? false;
        }],
        [channels.importLegacySessions, async (_event: unknown, raw: unknown) => registry.importLegacySessions(raw)],
        [channels.setModelConfig, async (_event: unknown, raw: unknown) => {
            const config = parseResolvedModelConfig(raw);
            if (!config) throw new Error("非法模型配置");
            await registry.setModelConfig(config);
            return undefined;
        }],
        [channels.waitForIdle, async (_event: unknown, raw: unknown) => {
            if (raw === undefined || raw === null) return registry.waitForIdle();
            return registry.waitForIdle(requireSessionId(raw));
        }],
        [channels.registerFiles, async (_event: unknown, ...args: unknown[]) => {
            if (args.length < 2) throw new Error("v1 附件注册已停用：请显式传入 sessionId");
            const sessionId = requireSessionId(args[0]);
            const files = parseAgentFileInputs(args[1]);
            if (!files) throw new Error("非法附件输入");
            const item = registry.get(sessionId);
            if (!item) throw new Error(`${UNKNOWN_SESSION}：${sessionId}`);
            if (item.runtimeState.replacing) throw new Error("Agent 会话正在替换，请稍后重试");
            return item.files.register(files);
        }],
        [channels.readFile, async (_event: unknown, ...args: unknown[]) => {
            if (args.length < 2 || typeof args[1] !== "string") throw new Error("v1 附件读取已停用：请显式传入 sessionId");
            const sessionId = requireSessionId(args[0]);
            const item = registry.get(sessionId);
            if (!item) throw new Error(`${UNKNOWN_SESSION}：${sessionId}`);
            if (item.runtimeState.replacing) throw new Error("Agent 会话正在替换，请稍后重试");
            return item.files.read(args[1]);
        }],
        [channels.listFolder, async (_event: unknown, ...args: unknown[]) => {
            if (args.length < 3 || typeof args[1] !== "string" || typeof args[2] !== "boolean") throw new Error("v1 目录读取已停用：请显式传入 sessionId");
            const sessionId = requireSessionId(args[0]);
            const item = registry.get(sessionId);
            if (!item) throw new Error(`${UNKNOWN_SESSION}：${sessionId}`);
            if (item.runtimeState.replacing) throw new Error("Agent 会话正在替换，请稍后重试");
            return item.files.listFolder(args[1], args[2]);
        }],
    ];

    for (const [channel, handler] of handlers) ipcMain.handle(channel, (event, ...args) => {
        if (input.isTrustedSender && !input.isTrustedSender(event)) throw new Error("untrusted_sender");
        return handler(event, ...args);
    });

    return () => {
        for (const [channel] of handlers) ipcMain.removeHandler(channel);
    };
}

export function parseAgentPromptInput(raw: unknown): PiAgentPromptInput | null {
    if (typeof raw === "string") return { text: raw };
    if (!isPlainObject(raw) || typeof raw.text !== "string") return null;
    let images: Array<{ type: "image"; data: string; mimeType: string }> | undefined;
    if (raw.images !== undefined) {
        if (!Array.isArray(raw.images)) return null;
        images = [];
        for (const image of raw.images) {
            if (!isPlainObject(image) || image.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string") return null;
            images.push({ type: "image", data: image.data, mimeType: image.mimeType });
        }
    }
    let fileHandles: string[] | undefined;
    if (raw.fileHandles !== undefined) {
        if (!Array.isArray(raw.fileHandles)) return null;
        for (const handle of raw.fileHandles) {
            if (typeof handle !== "string") return null;
        }
        fileHandles = raw.fileHandles;
    }
    let files: PiAgentPromptFile[] | undefined;
    if (raw.files !== undefined) {
        if (!Array.isArray(raw.files)) return null;
        files = [];
        for (const file of raw.files) {
            if (!isPlainObject(file)) return null;
            if (typeof file.assetId !== "string" || !file.assetId) return null;
            if (typeof file.relativePath !== "string" || !file.relativePath) return null;
            if (typeof file.name !== "string" || !file.name) return null;
            if (typeof file.kind !== "string" || !file.kind) return null;
            if (typeof file.mimeType !== "string" || !file.mimeType) return null;
            if (typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0) return null;
            files.push({ assetId: file.assetId, relativePath: file.relativePath, name: file.name, kind: file.kind as PiAgentPromptFile["kind"], mimeType: file.mimeType, size: file.size });
        }
    }
    return {
        text: raw.text,
        ...(images?.length ? { images } : {}),
        ...(files?.length ? { files } : {}),
        ...(fileHandles?.length ? { fileHandles } : {}),
    };
}

export function parseAgentUserInputResponse(raw: unknown): AgentUserInputResponse | null {
    if (!isPlainObject(raw)) return null;
    const keys = Object.keys(raw);
    if (keys.length !== 1) return null;
    if (typeof raw.value === "string") return { value: raw.value };
    if (typeof raw.confirmed === "boolean") return { confirmed: raw.confirmed };
    if (raw.cancelled === true) return { cancelled: true };
    if (Array.isArray(raw.answers)) {
        const answers: AgentUserFormAnswer[] = [];
        for (const item of raw.answers) {
            if (!isPlainObject(item)) return null;
            if (typeof item.questionId !== "string" || !item.questionId.trim()) return null;
            if (!Array.isArray(item.values) || item.values.some((value) => typeof value !== "string")) return null;
            if (item.customText !== undefined && typeof item.customText !== "string") return null;
            if (item.comment !== undefined && typeof item.comment !== "string") return null;
            answers.push({
                questionId: item.questionId,
                values: [...item.values],
                ...(item.customText !== undefined ? { customText: item.customText } : {}),
                ...(item.comment !== undefined ? { comment: item.comment } : {}),
            });
        }
        return { answers };
    }
    return null;
}

export function parseAgentFileInputs(raw: unknown): AgentFileInput[] | null {
    if (!Array.isArray(raw)) return null;
    const files: AgentFileInput[] = [];
    for (const item of raw) {
        if (!isPlainObject(item)) return null;
        const { name, mimeType, size } = item;
        if (typeof name !== "string" || typeof mimeType !== "string" || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return null;
        if (item.dataUrl !== undefined && typeof item.dataUrl !== "string") return null;
        if (item.sourcePath !== undefined && typeof item.sourcePath !== "string") return null;
        files.push({
            name,
            mimeType,
            size,
            ...(item.dataUrl !== undefined ? { dataUrl: item.dataUrl } : {}),
            ...(item.sourcePath !== undefined ? { sourcePath: item.sourcePath } : {}),
        });
    }
    return files;
}

export function parseResolvedModelConfig(raw: unknown): ResolvedTextModelConfig | null {
    try { return parseAgentModelConfig(raw); } catch { return null; }
}
