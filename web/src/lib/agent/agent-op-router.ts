import type { AgentFileContent } from "@/lib/agent/pi-agent-types";
import { agentAttachmentNodeType } from "@/lib/agent/agent-attachments";
import { applyCanvasAgentOpsWithReceipts } from "@/lib/canvas/canvas-agent-ops";
import { annotateCanvasAgentNodes } from "@/lib/canvas/canvas-agent-snapshot";
import type { CanvasAgentOp, CanvasAgentSnapshot, CanvasOpReceipt } from "@/lib/canvas/canvas-agent-op-types";
import { uploadMediaFile } from "@/services/file-storage";
import { uploadImage } from "@/services/image-storage";
import { storeCanvasImage, storeCanvasMedia, type CanvasAssetWriteInput } from "@/services/project-asset-storage";
import { useAgentStore, type AgentCanvasContext } from "@/stores/use-agent-store";
import { useAgentSessionStore } from "@/stores/use-agent-session-store";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { useScriptEntityStore } from "@/stores/use-script-entity-store";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { randomId } from "@/lib/utils";
import { createCanvasMutationQueue } from "./canvas-mutation-queue";

// 背景（非活动）画布的 Agent ops 路由器（spec 2026-09-18 D4）：
//   活动画布 → 页面路径（canvasContext.applyOps，undo/联动完整）
//   背景画布 → 持久化 op 走 store 级立即应用 + 主进程快照推送；
//              页面态 op（select_nodes）/script_resolve_shot_refs 与附件导入缓冲待挂载回放；
//              页面回调 op（run_generation/script_generate_storyboard）显式 skip。
// 同画布所有应用/回放经 canvasMutationQueue 串行；store 级应用 bump agentOpsRevision
// 供画布页 re-sync（防 read-once-write-whole 的整包写回丢更新）。

export type AgentOpRouterDeps = {
    getContext: () => AgentCanvasContext | null;
    getSessionScope: (sessionId: string) => { projectId: string; canvasId: string } | null;
    refreshSessions: () => Promise<unknown>;
    setCanvasSnapshot: (scope: { projectId: string; canvasId: string }, snapshot: CanvasAgentSnapshot) => void;
    sendReceipts: (sessionId: string, requestId: string, receipts: CanvasOpReceipt[]) => Promise<unknown> | unknown;
    applyOpsOnPage: (canvasId: string, ops: CanvasAgentOp[]) => Promise<CanvasOpReceipt[]>;
    listProjects: () => ReturnType<typeof useProjectStore.getState>["projects"];
    /** 附件导入失败（直通或回放）的用户可见出口：默认写 useAgentStore 错误卡片。 */
    onImportError: (error: unknown, scope: { projectId: string; canvasId: string }) => void;
};

export type AgentOpRouter = {
    routeOps: (sessionId: string, ops: unknown, requestId?: string) => Promise<void>;
    routeAttachmentImport: (sessionId: string, attachment: AgentFileContent) => void;
    notifyCanvasMounted: (canvasId: string) => void;
};

const MAX_BUFFERED_ATTACHMENTS = 20;
const PAGE_ONLY_OPS = new Set(["select_nodes", "script_resolve_shot_refs"]);
const SKIP_ON_BACKGROUND_OPS = new Set(["run_generation", "script_generate_storyboard"]);
const ENTITY_OPS = new Set(["script_entity_upsert", "script_assign_entity_ref"]);

// store 级应用与页面 re-sync 共用的「已同步 revision」基线：op-router 应用后写入，
// 页面挂载时读取比对，落後即从 store 重读（takeFreshCanvasStateIfStale）。
const seenRevisions = new Map<string, number>();

function storeRevisionOf(canvasId: string): number {
    return useProjectStore.getState().agentOpsRevisions[canvasId] ?? 0;
}

export function createAgentOpRouter(deps: AgentOpRouterDeps): AgentOpRouter {
    const queue = createCanvasMutationQueue();
    const bufferedAttachments = new Map<string, AgentFileContent[]>();
    const pageOnlyBatches = new Map<string, CanvasAgentOp[][]>();
    const scopeRefresh = new Map<string, Promise<{ projectId: string; canvasId: string } | null>>();

    const resolveScope = async (sessionId: string): Promise<{ projectId: string; canvasId: string } | null> => {
        const direct = deps.getSessionScope(sessionId);
        if (direct) return direct;
        const pending = scopeRefresh.get(sessionId);
        if (pending) return pending;
        const task = (async () => {
            try {
                await deps.refreshSessions();
            } catch {
                // 刷新失败按「仍找不到」处理，走 skipped 回执。
            }
            return deps.getSessionScope(sessionId);
        })();
        scopeRefresh.set(sessionId, task);
        try {
            return await task;
        } finally {
            scopeRefresh.delete(sessionId);
        }
    };

    const applyAtStoreLevel = (scope: { projectId: string; canvasId: string }, ops: CanvasAgentOp[], config: AiConfig): CanvasOpReceipt[] => {
        const projects = deps.listProjects();
        const found = projects.map((project) => ({ project, canvas: project.canvases.find((item) => item.id === scope.canvasId) })).find((item) => item.canvas);
        if (!found?.canvas) {
            return ops.map((op, opIndex) => ({ opIndex, opType: op.type, status: "skipped" as const, reason: "目标白板数据不可用" }));
        }
        const before: CanvasAgentSnapshot = {
            projectId: scope.projectId,
            canvasId: scope.canvasId,
            title: found.canvas.title,
            nodes: found.canvas.nodes,
            connections: found.canvas.connections,
            selectedNodeIds: [],
            viewport: found.canvas.viewport,
            viewportSize: { width: 1280, height: 800 },
        };
        const { next, receipts } = applyCanvasAgentOpsWithReceipts(before, ops, config);
        useProjectStore.getState().updateCanvas(scope.projectId, scope.canvasId, { nodes: next.nodes, connections: next.connections, viewport: next.viewport });
        seenRevisions.set(scope.canvasId, useProjectStore.getState().bumpAgentOpsRevision(scope.canvasId));
        deps.setCanvasSnapshot(scope, { ...next, nodes: annotateCanvasAgentNodes(next.nodes, config) });
        return receipts;
    };

    const applyEntityOpsAtStoreLevel = (ops: CanvasAgentOp[]): CanvasOpReceipt[] =>
        ops.map((op, opIndex) => {
            const entityStore = useScriptEntityStore.getState();
            if (op.type === "script_entity_upsert") {
                entityStore.upsertEntity({ ...op.entity });
                return { opIndex, opType: op.type, status: "applied" as const };
            }
            if (op.type === "script_assign_entity_ref") {
                entityStore.assignRefSource(op.entityId, op.refId, { state: "ready", source: "canvas", nodeId: op.nodeId });
                return { opIndex, opType: op.type, status: "applied" as const };
            }
            return { opIndex, opType: op.type, status: "skipped" as const, reason: "不支持的后台操作" };
        });

    const contextMatches = (context: AgentCanvasContext | null, scope: { projectId: string; canvasId: string }): context is AgentCanvasContext =>
        Boolean(context && context.snapshot.projectId === scope.projectId && context.snapshot.canvasId === scope.canvasId);

    const routeOps = async (sessionId: string, rawOps: unknown, requestId?: string): Promise<void> => {
        const ops = Array.isArray(rawOps) ? (rawOps as CanvasAgentOp[]).filter((op) => op?.type) : [];
        if (!ops.length) return;
        const scope = await resolveScope(sessionId);
        if (!scope) {
            await deps.sendReceipts(sessionId, requestId ?? "", ops.map((op, opIndex) => ({ opIndex, opType: op.type, status: "skipped" as const, reason: "无法定位会话画布" })));
            return;
        }
        // 应用时重查（TOCTOU）：路由与队列执行之间画布可能已挂载，页面路径语义更完整。
        const receipts = await queue.enqueue(scope.canvasId, async () => {
            const context = deps.getContext();
            if (contextMatches(context, scope)) {
                return deps.applyOpsOnPage(scope.canvasId, ops);
            }
            const config = useConfigStore.getState().config;
            const storeLevel: CanvasAgentOp[] = [];
            const entityLevel: CanvasAgentOp[] = [];
            const skipped: CanvasOpReceipt[] = [];
            ops.forEach((op, opIndex) => {
                if (ENTITY_OPS.has(op.type)) {
                    entityLevel.push(op);
                    return;
                }
                if (SKIP_ON_BACKGROUND_OPS.has(op.type)) {
                    skipped.push({ opIndex, opType: op.type, status: "skipped", reason: `目标白板未打开，无法执行 ${op.type}；请让用户打开该白板后重试` });
                    return;
                }
                if (PAGE_ONLY_OPS.has(op.type)) {
                    const batches = pageOnlyBatches.get(scope.canvasId) ?? [];
                    batches.push([op]);
                    pageOnlyBatches.set(scope.canvasId, batches);
                    skipped.push({ opIndex, opType: op.type, status: "skipped", reason: "目标白板未打开，操作已排队，将在打开白板时应用；请勿重试该操作" });
                    return;
                }
                storeLevel.push(op);
            });
            const applied: CanvasOpReceipt[] = [];
            if (storeLevel.length) applied.push(...applyAtStoreLevel(scope, storeLevel, config));
            if (entityLevel.length) applied.push(...applyEntityOpsAtStoreLevel(entityLevel));
            // 回执 opIndex 必须对齐调用方原始数组：store/entity 两组各自持有子集下标，
            // 分别映射回原下标（entity 组的 opIndex 是 entityLevel 内的下标，不能与
            // storeLevel 拼接后按位查找）。
            const originalIndex = new Map<CanvasAgentOp, number>();
            ops.forEach((op, index) => originalIndex.set(op, index));
            const remapped = applied.map((receipt, groupIndex) => {
                const group = groupIndex < storeLevel.length ? storeLevel : entityLevel;
                const op = group[receipt.opIndex];
                const mapped = op === undefined ? receipt.opIndex : originalIndex.get(op);
                return mapped === undefined ? receipt : { ...receipt, opIndex: mapped };
            });
            return [...remapped, ...skipped].sort((a, b) => a.opIndex - b.opIndex);
        });
        if (requestId) await deps.sendReceipts(sessionId, requestId, receipts);
    };

    const runImportOnPage = async (scope: { projectId: string; canvasId: string }, attachment: AgentFileContent): Promise<void> => {
        try {
            await queue.enqueue(scope.canvasId, async () => {
                const live = deps.getContext();
                if (!contextMatches(live, scope)) {
                    // 入队后画布已切走：附件不属于任何已打开画布，显式失败而非静默丢弃。
                    throw new Error("画布已切换，附件导入已取消");
                }
                if (live.importAttachment) {
                    await live.importAttachment(attachment);
                    return;
                }
                const writeContext = window.shotshot?.projectAssets ? {
                    projectId: scope.projectId,
                    canvasId: scope.canvasId,
                    source: { type: "agent-attachment" as const, canvasId: scope.canvasId },
                } : undefined;
                await live.applyOps([await attachmentImportOp(attachment, live.snapshot.nodes.length, live.snapshot.viewport, writeContext)]);
            });
        } catch (error) {
            deps.onImportError(error, scope);
        }
    };

    const routeAttachmentImport = (sessionId: string, attachment: AgentFileContent): void => {
        void (async () => {
            const scope = await resolveScope(sessionId);
            if (!scope) return;
            if (contextMatches(deps.getContext(), scope)) {
                await runImportOnPage(scope, attachment);
                return;
            }
            const list = bufferedAttachments.get(scope.canvasId) ?? [];
            if (list.length >= MAX_BUFFERED_ATTACHMENTS) return; // 上限溢出：丢弃（附件无回执通道）
            list.push(attachment);
            bufferedAttachments.set(scope.canvasId, list);
        })();
    };

    const flushAttachments = (canvasId: string): void => {
        const context = deps.getContext();
        if (!context || context.snapshot.canvasId !== canvasId) return;
        const scope = { projectId: context.snapshot.projectId, canvasId };
        const buffered = bufferedAttachments.get(canvasId);
        if (!buffered?.length) return;
        bufferedAttachments.delete(canvasId);
        void (async () => {
            for (const attachment of buffered) {
                await runImportOnPage(scope, attachment);
            }
        })();
    };

    return {
        routeOps,
        routeAttachmentImport,
        notifyCanvasMounted: (canvasId: string) => {
            seenRevisions.set(canvasId, storeRevisionOf(canvasId));
            flushAttachments(canvasId);
        },
    };
}

export async function attachmentImportOp(attachment: AgentFileContent, nodeIndex: number, viewport: { x: number; y: number }, writeContext?: CanvasAssetWriteInput): Promise<CanvasAgentOp> {
    const nodeType = agentAttachmentNodeType(attachment.kind);
    // 桌面：附件直接入库项目工作区（与 register-pending-attachments 对齐，spec §4）；Web/无上下文：既有 IDB 直写。
    const uploaded = !writeContext
        ? attachment.kind === "image" ? await uploadImage(attachment.dataUrl) : await uploadMediaFile(attachment.dataUrl, attachment.kind)
        : attachment.kind === "image"
            ? await storeCanvasImage(attachment.dataUrl, { ...writeContext, name: attachment.name })
            : await storeCanvasMedia(attachment.dataUrl, { ...writeContext, name: attachment.name, mimeType: attachment.mimeType });
    const assetRef = uploaded.assetRef;
    const intrinsicWidth = attachment.kind === "image" || attachment.kind === "video" ? uploaded.width || 360 : 0;
    const intrinsicHeight = attachment.kind === "image" || attachment.kind === "video" ? uploaded.height || 240 : 0;
    const width = attachment.kind === "glb" ? 640 : intrinsicWidth || 360;
    const height = attachment.kind === "glb" ? 480 : intrinsicHeight || 240;
    const mediaMetadata = {
        status: "success" as const,
        content: uploaded.url,
        ...(uploaded.storageKey ? { storageKey: uploaded.storageKey } : {}),
        ...(assetRef ? { assetRef } : {}),
        mimeType: uploaded.mimeType,
        bytes: uploaded.bytes,
        ...(uploaded.width ? { naturalWidth: uploaded.width } : {}),
        ...(uploaded.height ? { naturalHeight: uploaded.height } : {}),
    };
    return {
        type: "add_node",
        id: `agent-${attachment.kind}-${attachment.handle}`,
        nodeType,
        title: attachment.name,
        position: { x: viewport.x + nodeIndex * 48 - width / 2, y: viewport.y + nodeIndex * 48 - height / 2 },
        width,
        height,
        metadata: attachment.kind === "glb"
            ? {
                model3d: {
                    content: uploaded.url,
                    ...(uploaded.storageKey ? { storageKey: uploaded.storageKey } : {}),
                    ...(assetRef ? { assetRef } : {}),
                    mimeType: uploaded.mimeType,
                    bytes: uploaded.bytes,
                },
            }
            : mediaMetadata,
    };
}

// —— 模块级单例（面板全局唯一，队列与缓冲随之单例）——

const singletonDeps: AgentOpRouterDeps = {
    getContext: () => useAgentStore.getState().canvasContext,
    getSessionScope: (sessionId) => useAgentSessionStore.getState().sessions.find((item) => item.sessionId === sessionId)?.scope ?? null,
    refreshSessions: async () => {
        const bridge = typeof window !== "undefined" ? window.shotshot?.agent : undefined;
        if (!bridge?.listSessions) return;
        const listed = await bridge.listSessions();
        useAgentSessionStore.getState().setSessions(listed.sessions, listed.unreadable);
    },
    setCanvasSnapshot: (scope, snapshot) => {
        window.shotshot?.agent?.setCanvasSnapshot(scope, snapshot);
    },
    sendReceipts: (sessionId, requestId, receipts) => window.shotshot?.agent?.sendOpsReceipts?.(sessionId, requestId, receipts),
    applyOpsOnPage: async (canvasId, ops) => {
        const context = useAgentStore.getState().canvasContext;
        if (!context || context.snapshot.canvasId !== canvasId) return [];
        const result = await context.applyOps(ops);
        return result.receipts;
    },
    listProjects: () => useProjectStore.getState().projects,
    onImportError: (error, scope) => {
        const text = error instanceof Error ? error.message : String(error);
        const state = useAgentStore.getState();
        const threadId = useAgentSessionStore.getState().activeSessionId ?? "";
        state.setAgentState({
            messages: [...state.messages, { id: `${threadId}:import-error:${randomId()}`, threadId, role: "error" as const, title: text, text, detail: { canvasId: scope.canvasId } }],
        });
    },
};

export const agentOpRouter = createAgentOpRouter(singletonDeps);

const singletonQueue = createCanvasMutationQueue();
export function enqueueCanvasMutation<T>(canvasId: string, mutation: () => Promise<T>): Promise<T> {
    return singletonQueue.enqueue(canvasId, mutation);
}

// —— 页面 re-sync（spec D4 双写权威防护）——
// 画布页挂载读取与 op-router 的 store 级应用之间存在 read-once-write-whole 竞态窗口；
// 以上次同步过的 revision 为基线，落後即从 store 重读。随 use-agent-bridge 的
// setCanvasContext effect 调用；首挂载基线未建立时返回数据等价于让页面以 store 为准。
export function takeFreshCanvasStateIfStale(canvasId: string): { nodes: CanvasAgentSnapshot["nodes"]; connections: CanvasAgentSnapshot["connections"]; viewport: CanvasAgentSnapshot["viewport"] } | null {
    const projects = useProjectStore.getState().projects;
    const found = projects.map((project) => ({ canvas: project.canvases.find((item) => item.id === canvasId) })).find((item) => item.canvas);
    if (!found?.canvas) return null;
    const current = storeRevisionOf(canvasId);
    const seen = seenRevisions.has(canvasId) ? (seenRevisions.get(canvasId) as number) : -1;
    seenRevisions.set(canvasId, current);
    if (current === seen) return null;
    return { nodes: found.canvas.nodes, connections: found.canvas.connections, viewport: found.canvas.viewport };
}
