import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SettingsManager,
    type AgentSessionServices,
    type AgentSession,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { net, safeStorage, shell, type BrowserWindow } from "electron";
import { createShotshotWaitExtension, WAIT_TOOL_SUMMARY, type WaitStatusProvider } from "./pi-agent-wait";
import { shotshotAskUserQuestion } from "./pi-agent-ask-user-question";
import { createApprovalGate, createPiApprovalBroker } from "./pi-agent-approval";
import { createShotshotMemoryExtension, MEMORY_TOOL_SUMMARY } from "./pi-agent-memory";
import { registerAgentMemoryIpc } from "./agent-memory-ipc";

import { installChatGptAuthFetch } from "./chatgpt-network";
import { createChatGptCredentialStore } from "./chatgpt-credentials";
import { createChatGptAuthController } from "./chatgpt-auth";
import { registerChatGptIpc, isTrustedChatGptSender, isTrustedRendererUrl } from "./chatgpt-ipc";
import { resolveAgentModel } from "./agent-model-config";
import { CHATGPT_CHANNELS } from "@/lib/agent/ai-source-types";
import { buildGenerationStatusReport } from "@/lib/agent/generation-status";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { createChatGptImageTool } from "./chatgpt-images";
import { prepareImageForView } from "./agent-files";
import { createDesktopChatGptProvider } from "./chatgpt-provider";
import { buildCanvasTools, type CanvasToolContext } from "@/lib/agent/pi-agent-tools";
import type { CanvasAgentSnapshot, CanvasOpReceipt } from "@/lib/canvas/canvas-agent-op-types";
import type { AgentAssetSummary, AgentGenerationTask, AgentModelSummary, AgentProjectSummary, AgentScriptEntitySummary, PiSessionEnvelope, PiSessionScope, ResolvedTextModelConfig } from "@/lib/agent/pi-agent-types";
import { APP_DATA_DIR, APP_SKILLS_DIR } from "./app-data-paths";
import { createCanvasSnapshotCache } from "./pi-canvas-context";
import {
    createShotshotSessionExtension,
    createSessionToolSelection,
    createSessionRuntimeRegistry,
    registerPiSessionAdapter,
    type PiSessionRuntimeFactory,
    type SessionRuntimeRegistry,
} from "./pi-session-adapter";
import { createPiExtensionUIBroker } from "./pi-extension-ui";
import type { SkillRuntime } from "./skill-runtime";
import { requestCanvasImage } from "./agent-canvas-image";
import { extForMimeType, type LibraryAssetStore } from "./library-asset-store";

const LIBRARY_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const LIBRARY_MAX_ASSET_BYTES = 500 * 1024 * 1024;
const LIBRARY_MAX_TEXT_BYTES = 1024 * 1024;

type LibraryAddAssetInput = { kind: "text" | "image" | "video"; title: string; content?: string; imageUrl?: string; videoUrl?: string; tags?: string[]; source?: string; note?: string };

function isLocalAssetPath(url: string): boolean {
    return !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) && !url.startsWith("data:") && (url.startsWith("/") || /^[A-Za-z]:[\\/]/.test(url));
}

function parseDataUrl(url: string): { bytes: Uint8Array; mimeType: string } | null {
    const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url);
    if (!match) return null;
    const mimeType = match[1] || "application/octet-stream";
    const bytes = match[2]
        ? new Uint8Array(Buffer.from(match[3], "base64"))
        : new Uint8Array(Buffer.from(decodeURIComponent(match[3]), "utf8"));
    return { bytes, mimeType };
}

async function downloadAssetBytes(url: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIBRARY_DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await net.fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > LIBRARY_MAX_ASSET_BYTES) throw new Error("素材超过 500MB 大小上限");
        return { bytes: new Uint8Array(buffer), mimeType: response.headers.get("content-type")?.split(";")[0] ?? "" };
    } finally {
        clearTimeout(timer);
    }
}

async function importLibraryAssetFromUrl(store: LibraryAssetStore, url: string, input: LibraryAddAssetInput): Promise<string> {
    const meta = {
        title: input.title,
        tags: input.tags,
        ...(input.source ? { source: input.source } : { source: "Agent" }),
        ...(input.note ? { note: input.note } : {}),
    };
    if (isLocalAssetPath(url)) {
        const result = await store.importPath({ sourcePath: url, ...meta });
        return result.record.assetId;
    }
    const parsed = url.startsWith("data:") ? parseDataUrl(url) : await downloadAssetBytes(url);
    if (!parsed) throw new Error("无法解析 dataURL");
    if (parsed.bytes.byteLength > LIBRARY_MAX_ASSET_BYTES) throw new Error("素材超过 500MB 大小上限");
    const extensionFromUrl = url.startsWith("data:") ? "" : (url.split("?")[0].split(".").pop() ?? "").toLowerCase();
    const extension = /^[a-z0-9]{1,5}$/.test(extensionFromUrl) ? extensionFromUrl : extForMimeType(parsed.mimeType);
    const result = await store.write({ name: `${input.title || "asset"}.${extension}`, mimeType: parsed.mimeType || "application/octet-stream", bytes: parsed.bytes, ...meta });
    return result.record.assetId;
}

export const AGENT_CHANNELS = {
    listSessions: "agent:list-sessions",
    createSession: "agent:create-session",
    openSession: "agent:open-session",
    closeSession: "agent:close-session",
    readSessionEntries: "agent:read-session-entries",
    prompt: "agent:prompt",
    abort: "agent:abort",
    compact: "agent:compact",
    respondToUserInput: "agent:respond-to-user-input",
    opsReceipt: "agent:ops-receipt",
    setCanvasSnapshot: "agent:set-canvas-snapshot",
    setProjects: "agent:set-projects",
    setGenerationStatus: "agent:set-generation-status",
    setModels: "agent:set-models",
    setScriptEntities: "agent:set-script-entities",
    importLegacySessions: "agent:import-legacy-sessions",
    setModelConfig: "agent:set-model-config",
    event: "agent:event",
    waitForIdle: "agent:wait-for-idle",
    registerFiles: "agent:register-files",
    readFile: "agent:read-file",
    listFolder: "agent:list-folder",
    setApprovalMode: "agent:set-approval-mode",
    respondToApproval: "agent:respond-to-approval",
    canvasImageRequest: "agent:canvas-image-request",
} as const;

export const FETCH_CHANNEL = "fetch:request";
export const FETCH_ABORT_CHANNEL = "fetch:abort";

const EMPTY_SNAPSHOT: CanvasAgentSnapshot = {
    projectId: "",
    canvasId: "",
    title: "",
    nodes: [],
    connections: [],
    selectedNodeIds: [],
    viewport: { x: 0, y: 0, k: 1 },
};

export function registerAgentHost(getWindow: () => BrowserWindow | null, skillRuntime: SkillRuntime, rendererUrl: string, libraryAssets?: import("./library-asset-store").LibraryAssetStore) {
    const sessionDir = join(APP_DATA_DIR, "agent-sessions");
    const agentDir = join(APP_DATA_DIR, "agent");
    const restoreAuthFetch = installChatGptAuthFetch((input, init) => net.fetch(input instanceof URL ? input.href : input, init));
    const snapshots = createCanvasSnapshotCache();
    // Cache for renderer-pushed project / generation / model data (phase 2 tools).
    // Renderer pushes via agent:set-projects / agent:set-generation-status / agent:set-models IPC.
    const dataCache: {
        projects: AgentProjectSummary[];
        generationTasks: AgentGenerationTask[];
        // null = 模型目录尚未推送（spec D10）：models_list 返回不支持提示，model 参数降级透传
        models: AgentModelSummary[] | null;
        // null = 实体表尚未推送；数组 = 已同步（可为空数组，表示该项目确实无实体）
        scriptEntities: AgentScriptEntitySummary[] | null;
    } = { projects: [], generationTasks: [], models: null, scriptEntities: null };
    // emitOps 请求-响应（可靠性 spec §1 往返通道）：requestId → pending resolve。
    // 超时 5s 是新增行为边界（spec 已确认）；会话关闭后未决 promise 由超时兜底收敛。
    const pendingOpsReceipts = new Map<string, { sessionId: string; resolve: (receipts: CanvasOpReceipt[]) => void }>();
    const OPS_RECEIPT_TIMEOUT_MS = 5000;
    const settingsManager = SettingsManager.inMemory();
    let directoryError: unknown;
    const directoriesReady = Promise.all([sessionDir, agentDir].map((dir) => mkdir(dir, { recursive: true })))
        .catch((error: unknown) => {
            directoryError = error;
        });
    let modelRuntimePromise: Promise<ModelRuntime> | null = null;

    const send = (envelope: PiSessionEnvelope) => {
        const win = getWindow();
        if (win && !win.isDestroyed() && isTrustedRendererUrl(win.webContents.getURL(), rendererUrl)) win.webContents.send(AGENT_CHANNELS.event, envelope);
    };
    let registry: SessionRuntimeRegistry;
    const extensionUI = createPiExtensionUIBroker({
        send,
        onWaitingChange: (sessionId, waiting) => registry.setWaitingForInput(sessionId, waiting),
    });
    const approvalBroker = createPiApprovalBroker({
        send,
        onWaitingChange: (sessionId, waiting) => registry.setWaitingForApproval(sessionId, waiting),
    });

    const ensureModelRuntime = async () => {
        await directoriesReady;
        if (directoryError !== undefined) throw new Error(`Agent 目录初始化失败：${directoryError instanceof Error ? directoryError.message : String(directoryError)}`);
        modelRuntimePromise ??= ModelRuntime.create({
            credentials: createChatGptCredentialStore({
                path: join(agentDir, "chatgpt-auth.enc.json"),
                protection: {
                    available: () => safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
                    encrypt: value => safeStorage.encryptString(value),
                    decrypt: value => safeStorage.decryptString(value),
                },
            }),
            modelsPath: join(agentDir, "models.json"),
            refreshOnCreate: false,
        }).then(runtime => {
            // Public SDK bundle registration also works in Electron/Node: it retains
            // OAuth modules hidden behind variable imports in the normal lazy loader.
            registerBunOAuthFlows();
            runtime.registerNativeProvider(createDesktopChatGptProvider((input, init) => net.fetch(input instanceof URL ? input.href : input, init)));
            return runtime;
        });
        return modelRuntimePromise;
    };

    const chatgpt = createChatGptAuthController({
        getRuntime: ensureModelRuntime,
        checkStorage: async () => {
            if (!safeStorage.isEncryptionAvailable() || (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) throw new Error("chatgpt_protection_unavailable");
            try {
                const probe = "shotshot-secure-storage-check";
                if (safeStorage.decryptString(safeStorage.encryptString(probe)) !== probe) throw new Error();
            } catch { throw new Error("chatgpt_protection_unavailable"); }
        },
        openExternal: url => shell.openExternal(url),
        onStatus: status => { const win = getWindow(); if (win && !win.isDestroyed() && isTrustedRendererUrl(win.webContents.getURL(), rendererUrl)) win.webContents.send(CHATGPT_CHANNELS.changed, status); },
        beforeSignOut: () => registry.abortProvider("openai-codex"),
    });
    const unregisterChatGpt = registerChatGptIpc(getWindow, chatgpt, rendererUrl);
    const resolveModel = async (config: ResolvedTextModelConfig): Promise<Model<any>> => {
        if (config.source === "chatgpt" && !(await chatgpt.isReady())) throw new Error("chatgpt_auth_required");
        const model = await resolveAgentModel(config, await ensureModelRuntime());
        if (config.source === "chatgpt" && !(await chatgpt.isReady())) throw new Error("chatgpt_auth_required");
        return model;
    };

    const createRuntime: PiSessionRuntimeFactory = async ({
        cwd,
        agentDir: runtimeAgentDir,
        sessionManager,
        model,
        runtimeState,
        files,
    }) => {
        if (!model) throw new Error("模型未配置：请先调用 setModelConfig");
        const modelRuntime = await ensureModelRuntime();
        const extension = createShotshotSessionExtension({
            sessionId: () => runtimeState.sessionId,
            getSystemPrompt: () => runtimeState.systemPrompt,
            send,
        });
        const approvalGate = createApprovalGate({
            getMode: () => runtimeState.approvalMode,
            getCwd: () => cwd,
            request: (detail) => approvalBroker.request(runtimeState.sessionId, detail),
        });
        const memoryExtension = createShotshotMemoryExtension({ getWorkspacePath: () => runtimeState.workspacePath });
        let activeSession: AgentSession | undefined;
        const getCanvasSnapshot = () => snapshots.get(runtimeState.scope.canvasId) ?? EMPTY_SNAPSHOT;
        const getGenerationStatus: CanvasToolContext["getGenerationStatus"] = async (filter) => {
            const nodeIds = filter.nodeIds ? new Set(filter.nodeIds) : null;
            // sourceNodeId 别名命中必须在 provider 层保留，否则派生任务到不了报告层即被丢弃；
            // 不在此截断 limit：Task 5 的 prune 已封顶缓存条数，limit 由 buildGenerationStatusReport 收敛。
            const tasks = nodeIds
                ? dataCache.generationTasks.filter((t) => nodeIds.has(t.nodeId) || (t.sourceNodeId !== undefined && nodeIds.has(t.sourceNodeId)))
                : dataCache.generationTasks;
            return { ok: true, tasks };
        };
        const tools = buildCanvasTools({
            getSnapshot: getCanvasSnapshot,
            readCanvasImage: (request, signal) => {
                if (!activeSession?.model?.input.includes("image")) throw new Error("agent_image_input_unavailable");
                return requestCanvasImage(getWindow, AGENT_CHANNELS.canvasImageRequest, { scope: runtimeState.scope, ...request }, signal);
            },
            readAttachment: (handle) => files.read(handle),
            listFolder: (path, recursive) => files.listFolder(path, recursive),
            emitAttachmentImport: (attachment) => send({
                sessionId: runtimeState.sessionId,
                kind: "attachment_import",
                payload: { type: "attachment_import", attachment },
            }),
            emitOps: (ops) => {
                if (!ops.length) return Promise.resolve([]);
                const requestId = randomUUID();
                return new Promise<CanvasOpReceipt[]>((resolve) => {
                    const timer = setTimeout(() => {
                        pendingOpsReceipts.delete(requestId);
                        resolve([{ opIndex: -1, opType: "timeout", status: "skipped", reason: "无法确认画布是否已应用（超时）" }]);
                    }, OPS_RECEIPT_TIMEOUT_MS);
                    pendingOpsReceipts.set(requestId, {
                        sessionId: runtimeState.sessionId,
                        resolve: (receipts) => {
                            clearTimeout(timer);
                            resolve(receipts);
                        },
                    });
                    send({ sessionId: runtimeState.sessionId, kind: "ops", payload: { type: "ops", ops, requestId } });
                });
            },
            listProjects: async (filter) => {
                const keyword = filter.keyword?.trim().toLowerCase() ?? "";
                const filtered = keyword
                    ? dataCache.projects.filter((p) => p.title.toLowerCase().includes(keyword) || p.canvases.some((c) => c.title.toLowerCase().includes(keyword)))
                    : dataCache.projects;
                const page = Math.max(1, filter.page ?? 1);
                const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 20));
                const start = (page - 1) * pageSize;
                return { ok: true, projects: filtered.slice(start, start + pageSize), total: filtered.length };
            },
            listAssets: async (filter) => {
                if (!libraryAssets) return { ok: false, error: "素材库不可用" };
                try {
                    const { assets } = await libraryAssets.list();
                    const kind = filter.kind ?? "all";
                    const keyword = filter.keyword?.trim().toLowerCase() ?? "";
                    const mapped = assets
                        .map((record): AgentAssetSummary | null => (record.kind === "image" || record.kind === "video" || record.kind === "text" ? {
                            id: record.assetId,
                            kind: record.kind,
                            title: record.title,
                            tags: record.tags ?? [],
                            ...(record.source ? { source: record.source } : {}),
                            ...(record.note ? { note: record.note } : {}),
                            createdAt: record.createdAt,
                            updatedAt: record.updatedAt,
                        } : null))
                        .filter((asset): asset is AgentAssetSummary => asset !== null);
                    const filtered = mapped.filter((asset) =>
                        (kind === "all" || asset.kind === kind) &&
                        (!keyword || [asset.title, asset.note, asset.source, ...asset.tags].filter(Boolean).join(" ").toLowerCase().includes(keyword)));
                    const page = Math.max(1, filter.page ?? 1);
                    const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 20));
                    return { ok: true, assets: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length };
                } catch (error) {
                    return { ok: false, error: error instanceof Error ? error.message : String(error) };
                }
            },
            addAsset: async (input) => {
                if (!libraryAssets) return { ok: false, error: "素材库不可用" };
                try {
                    if (input.kind === "text") {
                        const content = input.content ?? "";
                        if (!content.trim()) return { ok: false, error: "content 为空" };
                        if (Buffer.byteLength(content, "utf8") > LIBRARY_MAX_TEXT_BYTES) return { ok: false, error: "文本素材超过 1MB 上限" };
                        const result = await libraryAssets.write({
                            name: `${input.title || "note"}.md`, mimeType: "text/markdown",
                            bytes: new Uint8Array(Buffer.from(content, "utf8")),
                            title: input.title, tags: input.tags,
                            ...(input.source ? { source: input.source } : { source: "Agent" }),
                            ...(input.note ? { note: input.note } : {}),
                        });
                        return { ok: true, assetId: result.record.assetId };
                    }
                    const url = input.kind === "image" ? input.imageUrl : input.videoUrl;
                    if (!url) return { ok: false, error: input.kind === "image" ? "imageUrl 为空" : "videoUrl 为空" };
                    const imported = await importLibraryAssetFromUrl(libraryAssets, url, input);
                    return { ok: true, assetId: imported };
                } catch (error) {
                    return { ok: false, error: error instanceof Error ? error.message : String(error) };
                }
            },
            getGenerationStatus,
            listModels: async () => dataCache.models === null
                ? { ok: false, error: "模型目录尚未推送" }
                : { ok: true, models: dataCache.models },
            listScriptEntities: async () => dataCache.scriptEntities === null
                ? { ok: false, error: "实体表尚未同步（画布页未推送）" }
                : { ok: true, entities: dataCache.scriptEntities },
        });
        tools.push(createChatGptImageTool({
            fetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
            getProvider: () => activeSession?.model?.provider,
            getAccessToken: async () => {
                if (!(await chatgpt.isReady())) throw new Error("chatgpt_auth_required");
                const auth = await modelRuntime.getAuth("openai-codex");
                if (!(await chatgpt.isReady())) throw new Error("chatgpt_auth_required");
                return auth?.auth.apiKey;
            },
            readImage: (request, signal) => requestCanvasImage(getWindow, AGENT_CHANNELS.canvasImageRequest, { scope: runtimeState.scope, ...request }, signal),
            saveImage: async (base64) => {
                const image = await prepareImageForView(`data:image/png;base64,${base64}`, "original");
                if ("error" in image) throw new Error("chatgpt_image_invalid_response");
                const directory = join(APP_DATA_DIR, "generated_images");
                await mkdir(directory, { recursive: true });
                const name = `${randomUUID()}.png`;
                const sourcePath = join(directory, name);
                await writeFile(sourcePath, Buffer.from(image.base64, "base64"), { flag: "wx", mode: 0o600 });
                const [file] = await files.register([{ name, mimeType: image.mimeType, size: image.sizeBytes, sourcePath }]);
                return file;
            },
            importImage: (file, dataUrl) => send({
                sessionId: runtimeState.sessionId,
                kind: "attachment_import",
                payload: { type: "attachment_import", attachment: { ...file, dataUrl } },
            }),
        }));
        // pi-agent-core's AgentTool type predates pi-coding-agent's ToolDefinition extras
        // (promptSnippet, promptGuidelines, renderCall, renderResult). Spread at runtime so
        // every field on our tool objects reaches the new SDK; cast through unknown to silence
        // the older type definition while preserving the spread.
        const customTools = tools.map((tool) => ({
            ...(tool as unknown as ToolDefinition),
            execute: async (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, _ctx: unknown) =>
                tool.execute(toolCallId, params, signal, onUpdate as never),
        }));
        // Persist the tool summaries on the per-session runtime state so dispatchAgentPrompt
        // can include an explicit "Available tools" section in the system prompt. Without
        // this the agent has no idea what tools exist (the SDK skips its own tool list when
        // a customPrompt is set) and ends up hallucinating tool names like "read".
        const allTools = tools.map((tool) => {
            const toolRecord = tool as unknown as { name: string; label: string; promptSnippet?: string };
            return {
                name: tool.name,
                label: tool.label,
                ...(toolRecord.promptSnippet ? { promptSnippet: toolRecord.promptSnippet } : {}),
            };
        });
        allTools.push({
            name: "ask_user_question",
            label: "Ask User",
            promptSnippet: "需要用户选择、补充需求或确认方向时，通过交互式问题表单提问；支持单选、多选和文本输入。",
        });
        allTools.push(WAIT_TOOL_SUMMARY);
        allTools.push(MEMORY_TOOL_SUMMARY);
        const toolSelection = createSessionToolSelection(allTools, model.input.includes("image"), model.provider);
        runtimeState.allTools = allTools;
        runtimeState.tools = toolSelection.activeTools;
        const waitStatusProvider: WaitStatusProvider = async (nodeIds) => {
            const result = await getGenerationStatus({ nodeIds, limit: nodeIds.length });
            if (!result.ok) return { ok: false as const, error: result.error };
            const report = buildGenerationStatusReport({
                tasks: result.tasks,
                snapshot: getCanvasSnapshot(),
                nodeIds,
                limit: nodeIds.length,
            });
            return { ok: true as const, entries: report.entries };
        };
        const resourceLoader = new DefaultResourceLoader({
            cwd,
            agentDir: runtimeAgentDir,
            settingsManager,
            extensionFactories: [extension, shotshotAskUserQuestion, createShotshotWaitExtension({ waitStatus: waitStatusProvider }), approvalGate, memoryExtension],
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            additionalSkillPaths: [APP_SKILLS_DIR],
        });
        await resourceLoader.reload();
        const created = await createAgentSession({
            cwd,
            agentDir: runtimeAgentDir,
            modelRuntime,
            settingsManager,
            resourceLoader,
            model,
            // Pass tool names explicitly instead of noTools:"all" — the SDK's
            // noTools:"all" creates an empty allowedToolNames Set, which means
            // customTools are registered but never activated (getActiveToolNames()
            // returns []), causing "Available tools: (none)" in the system prompt.
            // Register the complete tool set so a later setModelConfig call can activate
            // view_image without recreating the session. The active subset is applied
            // immediately below, before the session can receive its first prompt.
            tools: toolSelection.registeredNames,
            customTools,
            sessionManager,
        });
        activeSession = created.session;
        await created.session.bindExtensions({
            uiContext: extensionUI.createContext(() => runtimeState.sessionId),
            mode: "rpc",
            onError: (error) => console.error("[agent] Pi extension error:", error.error),
        });
        created.session.setActiveToolsByName(toolSelection.activeNames);
        const services: AgentSessionServices = {
            cwd,
            agentDir: runtimeAgentDir,
            modelRuntime,
            settingsManager,
            resourceLoader,
            diagnostics: [],
        };
        return { ...created, services, diagnostics: [] };
    };

    const unregisterMemoryIpc = registerAgentMemoryIpc();
    registry = createSessionRuntimeRegistry({
        sessionDir,
        agentDir,
        createRuntime,
        getWindow,
        skillRuntime,
        allowedRoots: [os.homedir()],
        resolveModel,
    });
    let unregisterAdapter: (() => void) | undefined;
    let shuttingDown = false;
    void registerPiSessionAdapter({
        registry,
        isTrustedSender: event => isTrustedChatGptSender(event, getWindow(), rendererUrl),
        channels: AGENT_CHANNELS,
        setCanvasSnapshot: (scope: PiSessionScope, snapshot) => {
            snapshots.set(scope, snapshot as CanvasAgentSnapshot);
        },
        setProjects: (projects: unknown) => {
            dataCache.projects = projects as AgentProjectSummary[];
        },
        setGenerationStatus: (tasks: unknown) => {
            dataCache.generationTasks = tasks as AgentGenerationTask[];
        },
        setModels: (models: unknown) => {
            dataCache.models = models as AgentModelSummary[];
        },
        setScriptEntities: (entities: unknown) => {
            dataCache.scriptEntities = entities as AgentScriptEntitySummary[];
        },
        resolveOpsReceipts: (sessionId, requestId, receipts) => {
            const pending = pendingOpsReceipts.get(requestId);
            if (!pending || pending.sessionId !== sessionId) return false;
            // renderer 回执不可信（可靠性裁决）：逐条形状校验，非法条目丢弃；全部非法时不 resolve，
            // 保留 pending 让 5s 超时兜底返回超时回执，工具侧拿到确定的失败语义。
            const valid = Array.isArray(receipts)
                ? receipts.filter((receipt): receipt is CanvasOpReceipt =>
                    typeof receipt === "object" && receipt !== null
                    && typeof receipt.opIndex === "number"
                    && typeof receipt.opType === "string"
                    && (receipt.status === "applied" || receipt.status === "skipped" || receipt.status === "invalid"))
                : [];
            if (!valid.length) return true;
            pendingOpsReceipts.delete(requestId);
            pending.resolve(valid);
            return true;
        },
        respondToUserInput: extensionUI.respond,
        disposeUserInputSession: extensionUI.disposeSession,
        respondToApproval: approvalBroker.respond,
        disposeApprovalSession: approvalBroker.disposeSession,
    }).then((unregister) => {
        if (shuttingDown) unregister();
        else unregisterAdapter = unregister;
    }).catch((error: unknown) => {
        console.error("[agent] IPC registration failed:", error instanceof Error ? error.message : String(error));
    });

    return () => {
        shuttingDown = true;
        unregisterAdapter?.();
        unregisterChatGpt();
        unregisterMemoryIpc();
        restoreAuthFetch();
        extensionUI.dispose();
        approvalBroker.dispose();
        void registry.dispose();
    };
}
