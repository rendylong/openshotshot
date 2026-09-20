import { useCallback, useEffect, useMemo, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { App } from "antd";

import i18n from "@/i18n";
import { useConfigStore } from "@/stores/use-config-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { applyCanvasAgentOpsWithReceipts, type CanvasAgentOp, type CanvasAgentSnapshot, type CanvasOpReceipt } from "@/lib/canvas/canvas-agent-ops";
import { annotateCanvasAgentNodes } from "@/lib/canvas/canvas-agent-snapshot";
import { resolveCanvasImageForAgent } from "@/lib/canvas/canvas-resource-references";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata, ContextMenuState, ViewportTransform } from "@/types/canvas";
import type { AgentFileContent, AgentProjectSummary, AgentGenerationTask, AgentScriptEntitySummary } from "@/lib/agent/pi-agent-types";
import type { RemoteMediaTask, RemoteMediaTaskStatus } from "@/types/remote-media-task";
import { buildAgentModelSummaries } from "@/lib/agent/model-summary";
import { ensureManagedCatalog, managedCatalogSnapshot, subscribeManagedCatalog } from "@/lib/desktop/managed-catalog-cache";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { agentOpRouter, takeFreshCanvasStateIfStale } from "@/lib/agent/agent-op-router";
import { useScriptEntityStore } from "@/stores/use-script-entity-store";
import { useRemoteMediaTaskStore } from "@/stores/use-remote-media-task-store";

type GenerateNodeRef = MutableRefObject<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => Promise<void>) | null>;
type GenerateStoryboardRef = MutableRefObject<((scriptNodeId: string, shotId: string, settings: { metadata: Partial<CanvasNodeMetadata>; managedImageModel?: string }) => void) | null>;

type AgentBridgeParams = {
    projectId: string;
    canvasId: string;
    title: string | undefined;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: Set<string>;
    viewport: ViewportTransform;
    viewportSize: { width: number; height: number };
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    selectedNodeIdsRef: MutableRefObject<Set<string>>;
    viewportRef: MutableRefObject<ViewportTransform>;
    generateNodeRef: GenerateNodeRef;
    generateStoryboardRef: GenerateStoryboardRef;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
    setViewport: Dispatch<SetStateAction<ViewportTransform>>;
    setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
    importAttachment?: (attachment: AgentFileContent) => Promise<CanvasNodeData | null>;
};

/**
 * Bridge between the canvas and local Agent: publish the current snapshot and apply/undo capabilities
 * to the Agent store for the local Codex panel. All members except applyAgentOps are internal.
 */
export function useAgentBridge(params: AgentBridgeParams) {
    const { projectId, canvasId, title, nodes, connections, selectedNodeIds, viewport, viewportSize, nodesRef, connectionsRef, selectedNodeIdsRef, viewportRef, generateNodeRef, generateStoryboardRef, setNodes, setConnections, setSelectedNodeIds, setSelectedConnectionId, setViewport, setContextMenu, importAttachment } =
        params;
    const { message } = App.useApp();
    const config = useConfigStore(state => state.config);
    const setAgentCanvasContext = useAgentStore((state) => state.setCanvasContext);
    const [agentUndoSnapshot, setAgentUndoSnapshot] = useState<CanvasAgentSnapshot | null>(null);
    const projectTitle = title || i18n.t("canvas.project.untitled");

    // Annotate each node with its statically declared referenceKind so the Agent can see that 3d
    // (and other image-reference plugin nodes) can be passed as referenceNodeIds — derived from the
    // definition, never from resource(), which reads a cache that is cold until the node mounts.
    const agentSnapshot = useMemo<CanvasAgentSnapshot>(
        () => ({ projectId, canvasId, title: projectTitle, nodes: annotateCanvasAgentNodes(nodes, config), connections, selectedNodeIds: Array.from(selectedNodeIds), viewport, viewportSize }),
        [canvasId, config, connections, projectTitle, nodes, projectId, selectedNodeIds, viewport, viewportSize],
    );
    const applyAgentOps = useCallback(
        async (ops?: CanvasAgentOp[]): Promise<CanvasAgentSnapshot & { receipts: CanvasOpReceipt[] }> => {
            const safeOps = Array.isArray(ops) ? ops.filter((op) => op?.type) : [];
            const before = { projectId, canvasId, title: projectTitle, nodes: nodesRef.current, connections: connectionsRef.current, selectedNodeIds: Array.from(selectedNodeIdsRef.current), viewport: viewportRef.current, viewportSize };
            // "script" 模式已从类型中移除；ops 来自 Agent 输出，运行时仍可能幻觉出旧值，用 cast 做运行时甄别。
            const generationOps = safeOps.filter((op): op is Extract<CanvasAgentOp, { type: "run_generation" }> => op.type === "run_generation" && Boolean(op.nodeId) && (op.mode as string | undefined) !== "script");
            const legacyScriptGenOps = safeOps.filter((op): op is Extract<CanvasAgentOp, { type: "run_generation" }> => op.type === "run_generation" && Boolean(op.nodeId) && (op.mode as string | undefined) === "script");
            // 实体表是 renderer 侧 store，纯函数 applyCanvasAgentOps 处理不了，在这里消化。
            const entityOps = safeOps.filter((op): op is Extract<CanvasAgentOp, { type: "script_entity_upsert" }> => op.type === "script_entity_upsert");
            // 名称→实体引用解析（v0.5）：查 renderer 实体表（按当前项目过滤）把镜头描述中的实体名转为 descriptionRich 内联段。
            const resolveOps = safeOps.filter((op): op is Extract<CanvasAgentOp, { type: "script_resolve_shot_refs" }> => op.type === "script_resolve_shot_refs");
            // 实体槽位绑定（refNodeIds）：写入 renderer 实体表，纯函数 applyCanvasAgentOps 处理不了。
            const assignOps = safeOps.filter((op): op is Extract<CanvasAgentOp, { type: "script_assign_entity_ref" }> => op.type === "script_assign_entity_ref");
            const storyboardOps = safeOps.filter((op): op is Extract<CanvasAgentOp, { type: "script_generate_storyboard" }> => op.type === "script_generate_storyboard");
            // 回执 opIndex 以调用方传入的数组为准：纯函数只处理画布子集，这里把子集下标映射回原数组。
            const handledByBridge = new Set(["run_generation", "script_entity_upsert", "script_resolve_shot_refs", "script_assign_entity_ref", "script_generate_storyboard"]);
            const filtered: CanvasAgentOp[] = [];
            const filteredToOriginal = new Map<number, number>();
            const deleteGuardReceipts: CanvasOpReceipt[] = [];
            safeOps.forEach((op, index) => {
                if (op.type === "delete_node") {
                    const targetIds = op.ids?.length ? op.ids : op.id ? [op.id] : op.nodeType ? before.nodes.filter((node) => node.type === op.nodeType).map((node) => node.id) : [];
                    const recoverableIds = targetIds.filter((id) => {
                        const latest = latestStoreTaskForNode(useRemoteMediaTaskStore.getState().tasks, id);
                        return latest !== undefined && GUARD_RECOVERABLE_STATUSES.has(latest.status);
                    });
                    if (recoverableIds.length) {
                        deleteGuardReceipts.push({
                            opIndex: index, opType: "delete_node", status: "skipped",
                            reason: `节点 ${recoverableIds.join("、")} 存在失败/超时的远端任务（failed/timed_out）：远端可能仍在执行或结果待交付，删除节点会丢失「重新获取结果」的恢复入口、已付费产物将无法取回；请保留节点，引导用户在节点上手动「重新获取结果」，确认远端失败后由用户手动删除`,
                        });
                        return;
                    }
                }
                if (!handledByBridge.has(op.type)) {
                    filteredToOriginal.set(filtered.length, index);
                    filtered.push(op);
                }
            });
            const applied = applyCanvasAgentOpsWithReceipts(before, filtered, config);
            const receipts: CanvasOpReceipt[] = applied.receipts.map((receipt) => {
                const originalIndex = filteredToOriginal.get(receipt.opIndex);
                return originalIndex === undefined ? receipt : { ...receipt, opIndex: originalIndex };
            });
            receipts.push(...deleteGuardReceipts);
            // bridge 自行消化的 op 也要有回执（spec §1"逐条"）；run_generation 回执在派发段追加（Task 8）。
            safeOps.forEach((op, index) => {
                if (op.type === "script_entity_upsert" || op.type === "script_resolve_shot_refs" || op.type === "script_assign_entity_ref" || op.type === "script_generate_storyboard") {
                    receipts.push({ opIndex: index, opType: op.type, status: "applied" });
                }
            });
            const next = applied.next;
            nodesRef.current = next.nodes;
            connectionsRef.current = next.connections;
            selectedNodeIdsRef.current = new Set(next.selectedNodeIds);
            viewportRef.current = next.viewport;
            setAgentUndoSnapshot(before);
            setNodes(next.nodes);
            setConnections(next.connections);
            setSelectedNodeIds(new Set(next.selectedNodeIds));
            setSelectedConnectionId(null);
            setViewport(next.viewport);
            setContextMenu(null);
            if (entityOps.length) {
                queueMicrotask(() =>
                    entityOps.forEach((op) => {
                        useScriptEntityStore.getState().upsertEntity({ ...op.entity });
                    }),
                );
            }
            if (legacyScriptGenOps.length) {
                // 旧管线脚本生成已移除（分镜改由 Agent 直接创作）：对幻觉出的旧 op 显式拒绝并提示（按批去重只弹一条），而非静默丢弃。
                queueMicrotask(() => {
                    message.warning(i18n.t("canvas.agent.scriptGenerationRemoved"));
                });
            }
            if (resolveOps.length) {
                queueMicrotask(() => {
                    const entities = useScriptEntityStore.getState().entitiesByProject(projectId);
                    const nameToId = new Map(entities.map((e) => [e.name, e.id]));
                    const validIds = new Set(entities.map((e) => e.id));
                    const missingNames: string[] = [];
                    resolveOps.forEach((op) => {
                        // 工具期已解析：entityIds 直连（过滤已不存在的实体）；否则回退名称匹配
                        const rich = op.entityIds
                            ? op.entityIds.filter((id) => validIds.has(id)).map((entityId) => ({ t: "ref" as const, entityId }))
                            : op.names.map((name) => nameToId.get(name)).filter((id): id is string => Boolean(id)).map((entityId) => ({ t: "ref" as const, entityId }));
                        if (!op.entityIds) {
                            for (const name of op.names) if (!nameToId.has(name)) missingNames.push(name);
                        }
                        if (!rich.length) return;
                        nodesRef.current = nodesRef.current.map((n) => {
                            if (n.id !== op.nodeId || !n.metadata?.script) return n;
                            const shots = n.metadata.script.output.shots.map((s) =>
                                s.shotId === op.shotId
                                    ? { ...s, descriptionRich: [...s.descriptionRich.filter((seg) => seg.t === "text"), ...rich], entityRefs: rich.map((r) => r.entityId) }
                                    : s,
                            );
                            return { ...n, metadata: { ...n.metadata, script: { ...n.metadata.script, output: { ...n.metadata.script.output, shots } } } };
                        });
                    });
                    setNodes(nodesRef.current);
                    if (missingNames.length) {
                        // op 路径的兜底可见性（工具期已报错，这里只接 canvas_apply_ops 等原始来源）
                        message.warning(i18n.t("canvas.agent.entityRefsUnresolved", { names: Array.from(new Set(missingNames)).join("、") }));
                    }
                });
            }
            if (assignOps.length) {
                queueMicrotask(() =>
                    assignOps.forEach((op) => {
                        useScriptEntityStore.getState().assignRefSource(op.entityId, op.refId, { state: "ready", source: "canvas", nodeId: op.nodeId });
                    }),
                );
            }
            const generationReceipts: CanvasOpReceipt[] = [];
            if (generationOps.length) {
                const originalIndex = new Map<CanvasAgentOp, number>();
                safeOps.forEach((op, index) => { if (op.type === "run_generation") originalIndex.set(op, index); });
                for (const op of generationOps) {
                    const opIndex = originalIndex.get(op) ?? -1;
                    const target = nodesRef.current.find((node) => node.id === op.nodeId);
                    // spec §7 边界（fix round 2）：mode=text 不查任务 store——文本生成不产生远端任务，
                    // 护栏（含 submission_unknown 拒绝与 force 打断）整体不适用；target 缺失时按 op.mode 兜底。
                    const effectiveMode = op.mode || target?.metadata?.generationMode || "image";
                    let note = "";
                    if (effectiveMode !== "text") {
                        const latest = latestStoreTaskForNode(useRemoteMediaTaskStore.getState().tasks, op.nodeId);
                        if (latest?.status === "submission_unknown") {
                            // 双计费防护核心（fix round 1）：submission_unknown 的重试只能走 runner 幂等键路径；
                            // force 也不放行——该状态不在 store ACTIVE_STATUSES 内，打断是 no-op，放行即两路出结果。
                            generationReceipts.push({
                                opIndex, opType: "run_generation", status: "skipped",
                                reason: `节点 ${op.nodeId} 的提交结果未知（submission_unknown），系统将凭幂等键自动重试至截止时间后自动放行；禁止手动重跑，只能继续用 generation_get_status 查询`,
                            });
                            continue;
                        }
                        if (latest && GUARD_ACTIVE_STATUSES.has(latest.status) && !op.force) {
                            const waitedSeconds = Math.max(0, Math.round((Date.now() - latest.submittedAt) / 1000));
                            generationReceipts.push({
                                opIndex, opType: "run_generation", status: "skipped",
                                reason: `节点 ${op.nodeId} 已有进行中任务（${latest.status}，已等待 ${waitedSeconds} 秒）。请先用 generation_get_status 查询该节点；确要放弃当前任务重跑，传 force=true`,
                            });
                            continue;
                        }
                        if (latest && GUARD_ACTIVE_STATUSES.has(latest.status) && op.force) {
                            useRemoteMediaTaskStore.getState().interruptTasksForNode(projectId, canvasId, op.nodeId);
                            note = `已打断旧任务（${latest.status}）。`;
                        }
                        if (latest && GUARD_RECOVERABLE_STATUSES.has(latest.status)) {
                            // 恢复态拒绝重跑（force 不放行）：重跑=新的付费提交；删节点/换节点重跑都会
                            // 丢失「重新获取结果」恢复入口。原任务可能是交付类失败或远端仍在执行。
                            generationReceipts.push({
                                opIndex, opType: "run_generation", status: "skipped",
                                reason: `节点 ${op.nodeId} 的上一个远端任务为 ${latest.status}：timed_out 只是本地停止跟踪，远端可能仍在执行或结果待交付；重跑会产生新的付费提交（force 也不放行），删除节点或新建节点重跑同一内容同样被禁止。请保留节点并告知用户在节点上点击「重新获取结果」恢复原任务拉取产物；远端确认失败后由用户手动决定是否重试`,
                            });
                            continue;
                        }
                    }
                    const beforeIds = new Set(useRemoteMediaTaskStore.getState().tasks.map((task) => task.id));
                    const prompt = op.prompt?.trim() ? op.prompt : (target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                    await generateNodeRef.current?.(op.nodeId, effectiveMode, prompt);
                    // 新任务判定按 id 集合差（对象引用在 patch 后必然变化，不可用作判定）
                    const created = useRemoteMediaTaskStore.getState().tasks.find((task) =>
                        !beforeIds.has(task.id) && (task.target.nodeId === op.nodeId || task.target.sourceNodeId === op.nodeId));
                    if (created) {
                        generationReceipts.push({ opIndex, opType: "run_generation", status: "applied", ...(note ? { reason: note } : {}), taskId: created.id, taskStatus: created.status });
                    } else {
                        generationReceipts.push({ opIndex, opType: "run_generation", status: "applied", reason: `${note}该模式不产生远端任务记录（文本生成或同步链路），可用 generation_get_status 以 node_status 来源观察` });
                    }
                }
            }
            if (storyboardOps.length) {
                queueMicrotask(() =>
                    storyboardOps.forEach((op) => void generateStoryboardRef.current?.(op.nodeId, op.shotId, op.settings)),
                );
            }
            const allReceipts = [...receipts, ...generationReceipts].sort((a, b) => a.opIndex - b.opIndex);
            return { ...next, projectId, canvasId, title: projectTitle, receipts: allReceipts };
        },
        [canvasId, config, projectTitle, projectId],
    );
    const undoAgentOps = useCallback(() => {
        if (!agentUndoSnapshot) return null;
        nodesRef.current = agentUndoSnapshot.nodes;
        connectionsRef.current = agentUndoSnapshot.connections;
        selectedNodeIdsRef.current = new Set(agentUndoSnapshot.selectedNodeIds);
        viewportRef.current = agentUndoSnapshot.viewport;
        setNodes(agentUndoSnapshot.nodes);
        setConnections(agentUndoSnapshot.connections);
        setSelectedNodeIds(new Set(agentUndoSnapshot.selectedNodeIds));
        setSelectedConnectionId(null);
        setViewport(agentUndoSnapshot.viewport);
        setContextMenu(null);
        setAgentUndoSnapshot(null);
        return { ...agentUndoSnapshot, projectId, canvasId, title: projectTitle };
    }, [agentUndoSnapshot, canvasId, projectTitle, projectId]);

    useEffect(() => {
        // 背景 op 的 store 级应用可能落在页面挂载读取之后：revision 落後即从 store 重读，
        // 防止页面随后的整包写回覆盖 agent ops（spec 2026-09-18 D4 双写权威防护）。
        const fresh = takeFreshCanvasStateIfStale(canvasId);
        if (fresh) {
            nodesRef.current = fresh.nodes;
            connectionsRef.current = fresh.connections;
            viewportRef.current = fresh.viewport;
            setNodes(nodesRef.current);
            setConnections(connectionsRef.current);
            setViewport(viewportRef.current);
        }
        setAgentCanvasContext({ snapshot: agentSnapshot, applyOps: applyAgentOps, undoOps: undoAgentOps, canUndo: Boolean(agentUndoSnapshot), importAttachment });
        // 通知 op-router 该画布已挂载：刷新 revision 基线并回放缓冲的附件/页面态 op。
        agentOpRouter.notifyCanvasMounted(canvasId);
        // 快照/undo 状态更新时只做替换，不能闪断成 null：use-pi-agent 的切画布
        // 会话恢复依赖 canvasContext 连续，闪断会打断进行中的 restore。
    }, [agentSnapshot, applyAgentOps, agentUndoSnapshot, importAttachment, setAgentCanvasContext, undoAgentOps, canvasId]);

    // 仅在画布页卸载时清除 Agent 的画布上下文。
    useEffect(() => () => setAgentCanvasContext(null), [setAgentCanvasContext]);

    useEffect(() => {
        const bridge = typeof window !== "undefined" ? window.shotshot?.agent : undefined;
        if (!bridge?.setCanvasImageReader) return;
        return bridge.setCanvasImageReader((request) => resolveCanvasImageForAgent(request, { projectId, canvasId }, nodesRef.current));
    }, [canvasId, nodesRef, projectId]);

    // Phase 2: push project / asset / generation data to main process for agent tools.
    // Same pattern as setCanvasSnapshot — renderer is the source of truth, main caches.
    useEffect(() => {
        const bridge = typeof window !== "undefined" ? window.shotshot?.agent : undefined;
        if (!bridge?.setProjects) return;

        const push = () => {
            const { projects } = useProjectStore.getState();
            const summaries: AgentProjectSummary[] = projects.map((project) => ({
                projectId: project.id,
                title: project.title,
                canvases: project.canvases.map((canvas) => ({
                    canvasId: canvas.id,
                    title: canvas.title,
                    nodeCount: canvas.nodes.length,
                    connectionCount: canvas.connections.length,
                    updatedAt: canvas.updatedAt,
                })),
            }));
            bridge.setProjects!(summaries);
        };
        push();
        const unsubscribe = useProjectStore.subscribe(push);
        return unsubscribe;
    }, []);

    useEffect(() => {
        const bridge = typeof window !== "undefined" ? window.shotshot?.agent : undefined;
        if (!bridge?.setModels) return;

        const push = () => {
            const config = useConfigStore.getState().config;
            const needsManagedCatalog = (["text", "image", "video", "audio"] as const)
                .some((capability) => config.credentialModes[capability] === "shotshot");
            const catalog = managedCatalogSnapshot();
            // 冷启动保持主进程目录为“尚未推送”，让工具沿既有降级路径处理；不要把暂时的空数组
            // 发布成权威空目录。ready 快照由 TTL 决定是否后台刷新，error 不在订阅回调中自旋重试。
            if (needsManagedCatalog && !catalog) {
                void ensureManagedCatalog().catch(() => undefined);
                return;
            }
            bridge.setModels!(buildAgentModelSummaries(config, catalog?.models ?? []));
            if (needsManagedCatalog && catalog?.status === "ready") void ensureManagedCatalog().catch(() => undefined);
        };
        push();
        const unsubscribeConfig = useConfigStore.subscribe(push);
        const unsubscribeCatalog = subscribeManagedCatalog(push);
        return () => { unsubscribeConfig(); unsubscribeCatalog(); };
    }, []);

    useEffect(() => {
        const bridge = typeof window !== "undefined" ? window.shotshot?.agent : undefined;
        if (!bridge?.setGenerationStatus) return;

        // 可靠性 spec §3.4：状态直传（9 值 RemoteMediaTaskStatus），废除归并映射——
        // submission_unknown 不是 queued、timed_out 不是 failed，Agent 的重跑决策依赖这一真实性。
        const terminalFor = (status: RemoteMediaTaskStatus) =>
            status === "succeeded" || status === "failed" || status === "timed_out" || status === "interrupted";
        const push = () => {
            const { tasks } = useRemoteMediaTaskStore.getState();
            const summaries: AgentGenerationTask[] = tasks.map((task) => ({
                nodeId: task.target?.nodeId ?? task.id,
                ...(task.target?.sourceNodeId ? { sourceNodeId: task.target.sourceNodeId } : {}),
                source: "remote_media" as const,
                status: task.status,
                ...(task.target ? { projectId: task.target.projectId, canvasId: task.target.canvasId } : {}),
                ...(task.phase !== undefined ? { phase: task.phase } : {}),
                ...(task.progress !== undefined ? { progress: task.progress } : {}),
                ...(task.remoteTaskId ? { remoteTaskId: task.remoteTaskId } : {}),
                ...(task.error ? { error: task.error } : {}),
                ...(task.submittedAt !== undefined ? { submittedAt: new Date(task.submittedAt).toISOString() } : {}),
                ...(task.deadlineAt !== undefined ? { deadlineAt: new Date(task.deadlineAt).toISOString() } : {}),
                terminal: terminalFor(task.status),
                updatedAt: new Date(task.lastPolledAt ?? task.submittedAt).toISOString(),
            }));
            bridge.setGenerationStatus!(summaries);
        };
        push();
        const unsubscribe = useRemoteMediaTaskStore.subscribe(push);
        return unsubscribe;
    }, []);

    // Phase 2: push script entity summaries for agent tools (dedup / ref validation).
    // Same pattern as setProjects — renderer is the source of truth, main caches.
    useEffect(() => {
        const bridge = typeof window !== "undefined" ? window.shotshot?.agent : undefined;
        if (!bridge?.setScriptEntities) return;
        const push = () => {
            const summaries: AgentScriptEntitySummary[] = useScriptEntityStore
                .getState()
                .entities.filter((entity) => entity.projectId === projectId)
                .map((entity) => ({
                    id: entity.id,
                    projectId: entity.projectId,
                    group: entity.group,
                    name: entity.name,
                    refs: entity.refs.map((ref) => ({
                        id: ref.id,
                        label: ref.label,
                        state: ref.state,
                        ...(ref.source ? { source: ref.source } : {}),
                        ...(ref.nodeId ? { nodeId: ref.nodeId } : {}),
                    })),
                }));
            bridge.setScriptEntities(summaries);
        };
        push();
        const unsubscribe = useScriptEntityStore.subscribe(push);
        return unsubscribe;
    }, [projectId]);

    return { applyAgentOps };
}

// 防重护栏（可靠性 spec §7）：这些状态下再触发 = 新的付费提交；submission_unknown 的双计费防护
// 是其存在目的，幂等重试是唯一 sanctioned 路径。submission_unknown 在派发循环中先行单独拦截
// （force 也不放行）；其余 4 状态无 force 拒绝、force 打断重跑。failed/timed_out 是恢复态而非
// 重跑态（GUARD_RECOVERABLE_STATUSES）：远端可能仍在执行或结果待交付，「重新获取结果」是唯一
// sanctioned 路径，重跑（force 也不放行）与删除节点都在派发循环中拒绝。
const GUARD_ACTIVE_STATUSES = new Set<RemoteMediaTask["status"]>(["submitting", "pending", "waiting_network", "waiting_configuration", "submission_unknown"]);
const GUARD_RECOVERABLE_STATUSES = new Set<RemoteMediaTask["status"]>(["failed", "timed_out"]);

function latestStoreTaskForNode(tasks: RemoteMediaTask[], nodeId: string): RemoteMediaTask | undefined {
    const hits = tasks.filter((task) => task.target.nodeId === nodeId || task.target.sourceNodeId === nodeId);
    return [...hits].sort((a, b) => b.submittedAt - a.submittedAt)[0];
}
