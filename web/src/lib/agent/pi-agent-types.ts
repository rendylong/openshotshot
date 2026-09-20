import type { ChatGptBridge } from "./ai-source-types";
import type { AgentEvent, AgentToolResult } from "@earendil-works/pi-agent-core";

import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-op-types";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";
import type { RemoteMediaTaskStatus, RemoteTaskPhase } from "@/types/remote-media-task";
import type { SkillsBridge } from "@/lib/skills/skill-types";
import type { TaskLifecycleBridge } from "@/lib/desktop/task-lifecycle-types";
import type { ChannelProvider } from "@/stores/use-config-store";
import type { AgentAttachmentKind } from "./agent-attachments";

// 钉死 pi 运行时类型，后续工具层 / 事件适配 / IPC 契约都以这里为唯一来源。
export type { AgentEvent, AgentToolResult } from "@earendil-works/pi-agent-core";

/** 附件清单在 session 里的持久化载体（custom entry）；恢复历史时投影层把它归属到相邻的用户消息。 */
export const AGENT_ATTACHMENTS_CUSTOM_TYPE = "shotshot.attachments";

/** 发给 Agent 的有界文件清单项：只含相对路径与元数据，绝不含文件字节。 */
export type PiAgentPromptFile = { assetId: string; relativePath: string; name: string; kind: AgentAttachmentKind; mimeType: string; size: number };

/** 解析后的文本模型配置（来自 use-config-store.resolveModelRequestConfig）。 */
export type ResolvedTextModelConfig =
    | { source: "chatgpt"; model: string }
    | {
          source: "byok";
          model: string;
          baseUrl: string;
          apiKey: string;
          apiFormat: "openai" | "gemini";
          agentApiMode: "responses" | "chat_completions";
          /** OpenRouter requires confirmed catalog input modalities; never infer from its ID. */
          supportsImageInput: boolean;
          /** Model emits reasoning; enables reasoning request params in agent responses mode. */
          supportsReasoning?: boolean;
          provider?: ChannelProvider;
      };

export type ByokTextModelConfig = {
    source?: "byok";
    model: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: "openai" | "gemini";
    agentApiMode: "responses" | "chat_completions";
    /** OpenRouter requires confirmed catalog input modalities; never infer from its ID. */
    supportsImageInput: boolean;
    /** Model emits reasoning; enables reasoning request params in agent responses mode. */
    supportsReasoning?: boolean;
    provider?: ChannelProvider;
};

export type PiAgentPromptOptions = { explicitSkillName?: string };
export type PiAgentPromptInput = {
    text: string;
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
    /** 有界项目文件清单（相对路径 + 元数据）；为空或旧渲染端不传。 */
    files?: PiAgentPromptFile[];
    /** 旧版会话句柄：仅保留类型兼容，新发送链路不再注册 handle。 */
    fileHandles?: string[];
};
export type AgentFileDescriptor = { handle: string; name: string; kind: AgentAttachmentKind; mimeType: string; size: number; sourcePath?: string; assetRef?: CanvasAssetRef; relativePath?: string };
export type AgentFileInput = { name: string; mimeType: string; size: number; dataUrl?: string; sourcePath?: string };
export type AgentFileContent = AgentFileDescriptor & { dataUrl: string };

// ---------------------------------------------------------------------------
// Electron IPC 契约（preload 暴露给渲染进程，主进程实现）
// ---------------------------------------------------------------------------

/** 渲染进程 → 主进程的跨进程 fetch 请求（规避自定义 baseUrl 的 CORS，并把 key 留在主进程）。 */
export type MainFetchRequest = {
    id: string;
    url: string;
    method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD";
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    responseType?: "bytes";
};

export type MainFetchResponse = {
    id: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    bytes?: Uint8Array;
};

export type MainFetchError = {
    id: string;
    error: string;
};

/** 桥接层附件读取结果（保持既有 ok/error 形状）。 */
export type AgentFileReadResult = { ok: true; file: AgentFileContent } | { ok: false; error: string };
/** 桥接层附件目录列表结果（保持既有 ok/error 形状）。 */
export type AgentFileListResult = { ok: true; files: AgentFileDescriptor[] } | { ok: false; error: string };

export type AgentCanvasImageReadRequest = {
    scope: PiSessionScope;
    nodeId: string;
    imageId?: string;
};

export type AgentCanvasImageSource = {
    nodeId: string;
    imageId?: string;
    title: string;
    dataUrl: string;
    mimeType: string;
    width: number;
    height: number;
    sizeBytes: number;
};

export type AgentCanvasImageReadResult = { ok: true; image: AgentCanvasImageSource } | { ok: false; error: string };

/** ask_user_question 表单协议：渲染端一次性呈现完整表单并批量回填。 */
export type AgentUserFormOption = { value: string; label: string; description?: string };

export type AgentUserFormQuestion = {
    id: string;
    type: "radio" | "checkbox" | "text";
    prompt: string;
    label: string;
    options: AgentUserFormOption[];
    allowOther: boolean;
    allowComment: boolean;
    required: boolean;
    placeholder?: string;
    default?: string | string[];
};

/** 渲染端提交的逐题回答；values 存 option.value（text 题为 [文本]）。 */
export type AgentUserFormAnswer = {
    questionId: string;
    values: string[];
    customText?: string;
    comment?: string;
};

/** Pi 扩展在主进程等待 renderer 用户输入时使用的窄协议。 */
export type AgentUserInputRequest =
    | { requestId: string; method: "select"; title: string; options: string[] }
    | { requestId: string; method: "input"; title: string; placeholder?: string }
    | { requestId: string; method: "confirm"; title: string; message: string }
    | { requestId: string; method: "form"; title?: string; description?: string; questions: AgentUserFormQuestion[] };

export type AgentUserInputResponse =
    | { value: string }
    | { confirmed: boolean }
    | { answers: AgentUserFormAnswer[] }
    | { cancelled: true };

export type AgentUserInputEvent =
    | { type: "request"; request: AgentUserInputRequest }
    | { type: "resolved"; requestId: string };

// ---------------------------------------------------------------------------
// 审批模式（对齐 codex 的确认语义）：confirm_changes 下 bash/edit/write 每次
// 调用都要用户批准；full_access 直接放行。read 与画布域工具不受影响。
// ---------------------------------------------------------------------------

export type AgentApprovalMode = "confirm_changes" | "full_access";

export type AgentApprovalDecision = "accept" | "acceptForSession" | "decline";

/** method 与渲染端 AgentApprovalCard 的既有分支键一致：command → 命令审批，fileChange → 文件审批。 */
export type AgentApprovalRequest = {
    requestId: string;
    method: "exec/command/requestApproval" | "item/fileChange/requestApproval";
    command?: string;
    path?: string;
    /** 仅 bash：审批卡片在命令旁回退显示工作目录。 */
    cwd?: string;
    reason?: string;
};

export type AgentApprovalEvent =
    | { type: "request"; requestId: string; approval: Omit<AgentApprovalRequest, "requestId"> }
    | { type: "resolved"; requestId: string };

// ---------------------------------------------------------------------------
// Session-scoped Pi 契约（sessionId 是所有命令与事件的归属键）
// ---------------------------------------------------------------------------

/** 会话归属的画布范围；主进程用 custom entry 持久化，renderer 用于筛选与恢复。 */
export type PiSessionScope = {
    projectId: string;
    canvasId: string;
};

export type PiSessionStatus = "idle" | "running" | "queued" | "waiting_approval" | "waiting_input" | "compacting" | "interrupted" | "error";
/** 主进程 listSessions 的完整结果：可读会话 + 显式跳过的损坏文件。 */
export type PiSessionSummaryListResult = {
    sessions: PiSessionSummary[];
    unreadable: Array<{ file: string; error: string }>;
};

/** 会话列表 / 当前会话的摘要视图，状态权威在主进程 runtime。 */
export type PiSessionSummary = {
    sessionId: string;
    title: string;
    scope: PiSessionScope;
    createdAt: number;
    updatedAt: number;
    status: PiSessionStatus;
    hasUnfinishedOperation: boolean;
};

/** `readSessionEntries` 的可选读取范围（entry id 区间，闭区间语义由主进程实现）。 */
export type PiSessionEntryRange = {
    fromEntryId?: string;
    toEntryId?: string;
};

/**
 * SDK `SessionEntry` 的只读、可序列化投影，只保留 renderer 恢复历史与
 * compaction 卡片需要的字段；SDK 特有细节留在 `raw`，由消费方按需窄化，
 * 不在这里复制 SDK schema。
 */
export type PiSessionEntrySnapshot = {
    readonly id: string;
    readonly parentId: string | null;
    /** SDK entry `type` 原值（message / compaction / custom / …）。 */
    readonly type: string;
    /** message 类 entry 的角色摘要。 */
    readonly role?: string;
    /** 文本摘要（消息文本 / compaction summary 等），不含 base64 或完整媒体。 */
    readonly text?: string;
    /** SDK entry 的原始 ISO 时间戳。 */
    readonly timestamp?: string;
    /** 仅 compaction entry 存在：摘要与压缩边界。 */
    readonly compaction?: {
        readonly summary: string;
        readonly firstKeptEntryId: string;
        readonly tokensBefore: number;
    };
    /** 未投影的 SDK 原始 entry（已过 IPC 序列化），消费方按需窄化读取。 */
    readonly raw?: unknown;
};

/**
 * 主进程 → renderer 的统一事件信封。
 * `agent` payload 为 SDK `AgentSessionEvent`；`session_compact_failed` 由
 * shotshot extension 转发；payload 的按 kind 校验由消费方负责。
 */
export type PiSessionEnvelope = {
    sessionId: string;
    kind: "agent" | "ops" | "attachment_import" | "user_input" | "approval_request" | "session_compact_failed" | "error";
    payload: unknown;
};

/** pi 事件 + 画布 op 的统一事件联合，经 `agent:event` 通道推给渲染进程。 */
export type PiAgentEvent = AgentEvent | { type: "ops"; ops: CanvasAgentOp[]; requestId?: string } | { type: "attachment_import"; attachment: AgentFileContent } | { type: "error"; message: string };

/**
 * preload 暴露到 `window.shotshot.agent` 的桥，renderer 与主进程 pi agent 的唯一入口。
 *
 * v2 契约显式携带 sessionId，并由 preload / 主进程实现。
 */
export type AgentBridge = {
    listSessions(scope?: PiSessionScope): Promise<PiSessionSummaryListResult>;
    // workspacePath 为可选的 Agent 会话工作区；未设置时不得携带该键，主进程侧负责校验。
    createSession(input: { scope: PiSessionScope; title?: string; workspacePath?: string }): Promise<PiSessionSummary>;
    openSession(sessionId: string): Promise<{ summary: PiSessionSummary; entries: PiSessionEntrySnapshot[] }>;
    closeSession(sessionId: string): Promise<void>;
    readSessionEntries(sessionId: string, range?: PiSessionEntryRange): Promise<PiSessionEntrySnapshot[]>;
    abort(sessionId: string): Promise<void>;
    compact(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }>;
    setCanvasSnapshot(scope: PiSessionScope, snapshot: CanvasAgentSnapshot): void;
    importLegacySessions(sessions: unknown): Promise<{ ok: true; imported: number; sessions: PiSessionSummary[] } | { ok: false; error: string }>;
    registerFiles(sessionId: string, files: AgentFileInput[]): Promise<AgentFileDescriptor[]>;
    readFile(sessionId: string, handle: string): Promise<AgentFileReadResult>;
    listFolder(sessionId: string, sourcePath: string, recursive: boolean): Promise<AgentFileListResult>;
    prompt(sessionId: string, input: PiAgentPromptInput | string, options?: PiAgentPromptOptions): Promise<{ ok: true } | { ok: false; error: string }>;
    respondToUserInput(sessionId: string, requestId: string, response: AgentUserInputResponse): Promise<{ ok: true } | { ok: false; error: string }>;
    /** emitOps 请求-响应回执通道（可靠性 spec §1）：renderer 把 applyOps 逐条回执按 requestId 回传主进程。 */
    sendOpsReceipts?(sessionId: string, requestId: string, receipts: unknown): Promise<boolean>;
    setApprovalMode(sessionId: string, mode: AgentApprovalMode): Promise<void>;
    respondToApproval(sessionId: string, requestId: string, decision: AgentApprovalDecision): Promise<{ ok: true } | { ok: false; error: string }>;
    /** 幂等创建项目工作区目录并返回 realpath；失败返回 {ok:false,error}，不抛错。 */
    ensureProjectWorkspace(projectId: string, projectTitle: string): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
    setModelConfig(config: ResolvedTextModelConfig): Promise<void>;
    // 过渡期保持 v1 事件回调（现有 renderer 只按 PiAgentEvent 判别）；
    // Task 3/5 迁移 preload 与消费方后改为 (event: PiSessionEnvelope) => void。
    onEvent(cb: (event: PiAgentEvent) => void): () => void;
    /** v2：按 sessionId 包装的会话事件流；主进程发送前已校验 envelope。 */
    onSessionEvent?(cb: (event: PiSessionEnvelope) => void): () => void;
    /** 无参等价于等待全部 session；v2 显式等待指定 session。 */
    waitForIdle(sessionId?: string): Promise<void>;
    fetch(req: MainFetchRequest): Promise<MainFetchResponse | MainFetchError>;
    abortFetch?(id: string): Promise<void>;
    /** Phase 2: renderer pushes data for agent tools (fire-and-forget). */
    setProjects(projects: AgentProjectSummary[]): void;
    setGenerationStatus(tasks: AgentGenerationTask[]): void;
    setModels(models: AgentModelSummary[]): void;
    setScriptEntities(entities: AgentScriptEntitySummary[]): void;
    setCanvasImageReader?(handler: (request: AgentCanvasImageReadRequest) => Promise<AgentCanvasImageReadResult>): () => void;

};

/** Agent 记忆读写结果（保持既有 ok/error 形状）。 */
export type AgentMemoryResult<T> = { ok: true; content: T } | { ok: false; error: string };

/** preload 暴露到 `window.shotshot.agentMemory` 的窄桥，renderer 读写 Agent 记忆的唯一入口。 */
export type AgentMemoryBridge = {
    readUser(): Promise<AgentMemoryResult<string>>;
    writeUser(content: string): Promise<{ ok: true } | { ok: false; error: string }>;
    readProject(workspacePath: string): Promise<AgentMemoryResult<string>>;
    writeProject(workspacePath: string, content: string): Promise<{ ok: true } | { ok: false; error: string }>;
};

declare global {
    interface Window {
        shotshot?: {
            chatgpt?: ChatGptBridge;
            agent: AgentBridge;
            skills: SkillsBridge;
            agentMemory?: AgentMemoryBridge;
            tasks?: TaskLifecycleBridge;
            projectAssets?: import("../project-assets/project-asset-types").ProjectAssetsBridge;
            libraryAssets?: import("../library-assets/library-asset-types").LibraryAssetsBridge;
            platform: string;
        };
    }
}


// === Phase 2 tool data types (canvas_list_projects, assets_list, etc.) ===

export type AgentProjectSummary = {
    projectId: string;
    title: string;
    canvases: Array<{
        canvasId: string;
        title: string;
        nodeCount: number;
        connectionCount: number;
        updatedAt: string;
    }>;
};

export type AgentAssetSummary = {
    id: string;
    kind: "text" | "image" | "video";
    title: string;
    coverUrl?: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
};

export type AgentGenerationTask = {
    nodeId: string;
    /** 发起节点（config/源节点）；Agent 用 sourceNodeId 也能查到派生任务 */
    sourceNodeId?: string;
    source: "remote_media" | "node_status";
    /** 直传 RemoteMediaTaskStatus；node_status 来源的文本节点用 running/succeeded/failed */
    status: RemoteMediaTaskStatus | "running";
    projectId?: string;
    canvasId?: string;
    phase?: RemoteTaskPhase;
    progress?: number;
    prompt?: string;
    remoteTaskId?: string;
    error?: string;
    submittedAt?: string;
    deadlineAt?: string;
    /** 派生字段：终态（succeeded/failed/timed_out/interrupted）为 true，提示 Agent 停止轮询 */
    terminal?: boolean;
    updatedAt: string;
};

export type AgentModelSummary = {
    /** encodeChannelModel(channelId, name)：agent 生成工具 model 参数的合法取值，逐字传递 */
    id: string;
    name: string;
    capability: "text" | "image" | "video" | "audio";
    channelName: string;
    provider?: string;
    /** 图片生成所需输入；unknown 表示渠道目录未声明，生成前保持现有兼容行为。 */
    inputMode?: "text" | "image" | "text-and-image" | "unknown";
    /** true 表示缺少参考图时不能提交。 */
    requiresReference?: boolean;
    /** 等于该能力当前默认（不指定 model 时实际使用的模型） */
    isDefault: boolean;
};

/** 脚本实体参考槽位摘要（不含 storageKey/assetId——工具不需要，控制通道体积）。 */
export type AgentScriptEntityRefSummary = {
    id: string;
    label: string;
    state: "empty" | "queued" | "ready";
    source?: "generated" | "canvas" | "library";
    nodeId?: string;
};

/** 脚本实体摘要：agent 工具查重/引用校验的数据源（renderer 推送，主进程只缓存）。 */
export type AgentScriptEntitySummary = {
    id: string;
    projectId: string;
    group: "character" | "scene" | "item";
    name: string;
    refs: AgentScriptEntityRefSummary[];
};
