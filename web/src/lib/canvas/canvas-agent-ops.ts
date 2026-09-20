import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { getNodeSpec, isRegisteredNodeType } from "@/lib/canvas/node-registry";
import { resolveAgentNodePosition } from "@/lib/canvas/canvas-agent-node-placement";
import { falDefaultMetadata } from "./fal-settings";
import { resolveModelForCapability, type AiConfig } from "@/stores/use-config-store";
import { normalizeShots } from "@/lib/canvas/script-node-model";
import type { ScriptNodeData } from "@/types/script-node";
import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";

// 类型定义拆到纯文件 canvas-agent-op-types.ts（供主进程共享）；这里 re-export 保持既有 import 路径不变。
import type { CanvasAgentOp, CanvasAgentSnapshot, CanvasOpReceipt } from "./canvas-agent-op-types";
export type { CanvasAgentOp, CanvasAgentSnapshot, CanvasOpReceipt } from "./canvas-agent-op-types";

const KNOWN_CANVAS_OP_TYPES = new Set<string>([
    "add_node", "update_node", "delete_node", "delete_connections", "connect_nodes",
    "set_viewport", "select_nodes", "set_3d_camera", "add_text_nodes",
    "script_set_instruction", "script_upsert_shot", "script_delete_shot", "script_reorder_shots",
    "script_replace_shots", "script_entity_upsert", "script_resolve_shot_refs", "script_bind_entity",
    "script_assign_entity_ref", "run_generation",
]);

export function applyCanvasAgentOpsWithReceipts(
    snapshot: CanvasAgentSnapshot,
    ops?: CanvasAgentOp[],
    config?: AiConfig,
): { next: CanvasAgentSnapshot; receipts: CanvasOpReceipt[] } {
    let nodes = snapshot.nodes.map(({ generationContract: _contract, ...node }) => node);
    let connections = snapshot.connections;
    let selectedNodeIds = snapshot.selectedNodeIds;
    let viewport = snapshot.viewport;
    const initialSelectedNodeIds = snapshot.selectedNodeIds;
    const receipts: CanvasOpReceipt[] = [];

    (Array.isArray(ops) ? ops : []).forEach((raw, index) => {
        const declaredType = raw && typeof raw === "object" && typeof (raw as { type?: unknown }).type === "string" ? (raw as { type: string }).type : "unknown";
        const receipt = (status: CanvasOpReceipt["status"], reason?: string, nodeIds?: string[]) =>
            receipts.push({ opIndex: index, opType: declaredType, status, ...(reason ? { reason } : {}), ...(nodeIds?.length ? { nodeIds } : {}) });
        const op = normalizeCanvasAgentOp(raw);
        if (!op?.type) {
            receipt("invalid", "op 结构无法解析");
            return;
        }
        if (!KNOWN_CANVAS_OP_TYPES.has(op.type)) {
            receipt("invalid", `不支持的 op 类型：${op.type}`);
            return;
        }
        if (op.type === "add_node") {
            const nodeType = op.nodeType && isRegisteredNodeType(op.nodeType) ? op.nodeType : CanvasNodeType.Text;
            const spec = getNodeSpec(nodeType);
            const width = op.width || spec.width;
            const height = op.height || spec.height;
            const position = op.position || (
                (typeof op.x === "number" || typeof op.y === "number")
                    ? { x: op.x ?? 0, y: op.y ?? 0 }
                    : resolveAgentNodePosition({ ...snapshot, nodes, selectedNodeIds: initialSelectedNodeIds, viewport }, { width, height }, { referenceNodeIds: op.anchorNodeIds })
            );
            const mode = op.metadata?.generationMode ?? (nodeType === "video" ? "video" : nodeType === "audio" ? "audio" : nodeType === "text" ? "text" : "image");
            const defaults = config && ["config", "image", "video", "audio", "text"].includes(nodeType)
                ? falDefaultMetadata({ ...config, model: op.metadata?.model ?? resolveModelForCapability(config, undefined, mode) })
                : {};
            const node: CanvasNodeData = {
                id: op.id || `${nodeType}-${Date.now()}-${index}`,
                type: nodeType,
                title: op.title || spec.title,
                position,
                width,
                height,
                metadata: { ...spec.metadata, ...defaults, ...op.metadata },
            };
            nodes = [...nodes, node];
            selectedNodeIds = [node.id];
            receipt("applied", undefined, [node.id]);
            return;
        }
        if (op.type === "update_node") {
            if (!op.id || !nodes.some((node) => node.id === op.id)) {
                receipt("skipped", `节点不存在：${op.id ?? "（缺少 id）"}`);
                return;
            }
            const { generationContract: _contract, ...patch } = (op.patch ?? {}) as Partial<CanvasAgentSnapshot["nodes"][number]>;
            nodes = nodes.map((node) => (node.id === op.id ? { ...node, ...patch, metadata: { ...node.metadata, ...op.patch?.metadata, ...op.metadata } } : node));
            receipt("applied", undefined, [op.id]);
            return;
        }
        if (op.type === "delete_node") {
            const ids = new Set(op.ids || (op.id ? [op.id] : op.nodeType ? nodes.filter((node) => node.type === op.nodeType).map((node) => node.id) : []));
            const hit = [...ids].filter((id) => nodes.some((node) => node.id === id));
            if (!hit.length) {
                receipt("skipped", `节点不存在：${[...ids].join("、") || "（未指定 id）"}`);
                return;
            }
            nodes = nodes.filter((node) => !ids.has(node.id));
            connections = connections.filter((conn) => !ids.has(conn.fromNodeId) && !ids.has(conn.toNodeId));
            selectedNodeIds = selectedNodeIds.filter((id) => !ids.has(id));
            receipt("applied", undefined, hit);
            return;
        }
        if (op.type === "delete_connections") {
            if (op.all) {
                connections = [];
                receipt("applied");
                return;
            }
            const ids = new Set(op.ids || (op.id ? [op.id] : []));
            if (!ids.size) {
                receipt("skipped", "未指定要删除的连线 id");
                return;
            }
            if (!connections.some((conn) => ids.has(conn.id))) {
                receipt("skipped", `连线不存在：${[...ids].join("、")}`);
                return;
            }
            connections = connections.filter((conn) => !ids.has(conn.id));
            receipt("applied");
            return;
        }
        if (op.type === "connect_nodes") {
            if (!op.fromNodeId || !op.toNodeId) {
                receipt("invalid", "connect_nodes 缺少 fromNodeId/toNodeId");
                return;
            }
            const missing = [op.fromNodeId, op.toNodeId].filter((id) => !nodes.some((node) => node.id === id));
            if (missing.length) {
                receipt("skipped", `节点不存在：${missing.join("、")}`);
                return;
            }
            if (connections.some((conn) => conn.fromNodeId === op.fromNodeId && conn.toNodeId === op.toNodeId)) {
                receipt("skipped", "连线已存在");
                return;
            }
            connections = [...connections, { id: op.id || nanoid(), fromNodeId: op.fromNodeId, toNodeId: op.toNodeId }];
            receipt("applied");
            return;
        }
        if (op.type === "set_viewport") {
            if (!op.viewport) {
                receipt("invalid", "set_viewport 缺少 viewport");
                return;
            }
            viewport = op.viewport;
            receipt("applied");
            return;
        }
        if (op.type === "select_nodes") {
            if (!Array.isArray(op.ids)) {
                receipt("invalid", "select_nodes 需要 ids 字段");
                return;
            }
            if (!op.ids.length) {
                selectedNodeIds = [];
                receipt("applied");
                return;
            }
            const hits = op.ids.filter((id) => nodes.some((node) => node.id === id));
            if (!hits.length) {
                receipt("skipped", "节点不存在");
                return;
            }
            selectedNodeIds = hits;
            receipt("applied", undefined, hits);
            return;
        }
        if (op.type === "set_3d_camera") {
            if (!nodes.some((node) => node.id === op.nodeId)) {
                receipt("skipped", `节点不存在：${op.nodeId}`);
                return;
            }
            if (nodes.find((node) => node.id === op.nodeId)?.type !== "3d") {
                receipt("skipped", `节点不是 3D 节点：${op.nodeId}`);
                return;
            }
            const camera = op.camera;
            const valid = camera && [camera.azimuth, camera.elevation, camera.distanceRatio].every(Number.isFinite) && camera.distanceRatio > 0;
            if (!valid) {
                receipt("skipped", "摄像机参数非法");
                return;
            }
            nodes = nodes.map((node) =>
                node.id === op.nodeId
                    ? { ...node, metadata: { ...node.metadata, model3d: { ...node.metadata?.model3d, camera } } }
                    : node,
            );
            receipt("applied", undefined, [op.nodeId]);
            return;
        }
        if (op.type === "add_text_nodes") {
            if (!Array.isArray(op.items) || !op.items.length) {
                receipt("invalid", "add_text_nodes.items 不能为空");
                return;
            }
            const direction = op.direction === "row" ? "row" : "column";
            const gap = typeof op.gap === "number" && op.gap >= 0 ? op.gap : 24;
            const textSpec = getNodeSpec(CanvasNodeType.Text);
            const origin = resolveAgentNodePosition({ ...snapshot, nodes, selectedNodeIds: initialSelectedNodeIds, viewport }, { width: textSpec.width, height: textSpec.height });
            let cursorX = origin.x;
            let cursorY = origin.y;
            const created: string[] = [];
            op.items.forEach((item, itemIndex) => {
                const width = typeof item.width === "number" && item.width > 0 ? item.width : textSpec.width;
                const height = typeof item.height === "number" && item.height > 0 ? item.height : textSpec.height;
                const id = `text-${Date.now()}-${index}-${itemIndex}`;
                const node: CanvasNodeData = {
                    id,
                    type: CanvasNodeType.Text,
                    title: item.title || textSpec.title,
                    position: direction === "row" ? { x: cursorX, y: origin.y } : { x: origin.x, y: cursorY },
                    width,
                    height,
                    metadata: { ...textSpec.metadata, content: item.text },
                };
                nodes = [...nodes, node];
                created.push(id);
                if (direction === "row") cursorX += width + gap;
                else cursorY += height + gap;
            });
            receipt("applied", undefined, created);
            return;
        }
        if (op.type === "run_generation") {
            // bridge 会在进纯函数前过滤 run_generation；走到这里说明是直连调用，如实标注。
            receipt("skipped", "run_generation 由生成派发分支处理（applyCanvasAgentOps 不触发生成）");
            return;
        }
        if (op.type === "script_entity_upsert" || op.type === "script_resolve_shot_refs" || op.type === "script_assign_entity_ref") {
            // 实体表 op 由 renderer bridge 消化（use-agent-bridge）；纯函数 no-op 兜底（现有语义）。
            receipt("applied");
            return;
        }
        const scriptOp = op as Extract<CanvasAgentOp, { type: "script_set_instruction" | "script_upsert_shot" | "script_delete_shot" | "script_reorder_shots" | "script_replace_shots" | "script_bind_entity" }>;
        const target = nodes.find((node) => node.id === scriptOp.nodeId);
        if (!target) {
            receipt("skipped", `节点不存在：${scriptOp.nodeId}`);
            return;
        }
        if (!target.metadata?.script) {
            receipt("skipped", `不是脚本节点：${scriptOp.nodeId}`);
            return;
        }
        if (op.type === "script_reorder_shots") {
            const shots = target.metadata.script.output.shots;
            const missingShots = op.shotIds.filter((id) => !shots.some((shot) => shot.shotId === id));
            if (missingShots.length) {
                receipt("skipped", `镜头 id 无效：${missingShots.join("、")}，顺序未变更`);
                return;
            }
        }
        nodes = applyScriptOp(nodes, scriptOp);
        receipt("applied", undefined, [scriptOp.nodeId]);
    });

    return { next: { ...snapshot, nodes, connections, selectedNodeIds, viewport }, receipts };
}

export function summarizeCanvasAgentOps(ops?: CanvasAgentOp[]) {
    const counts = (Array.isArray(ops) ? ops : []).reduce<Record<string, number>>((acc, op) => {
        const normalized = normalizeCanvasAgentOp(op as Record<string, unknown>);
        if (!normalized?.type) return acc;
        acc[normalized.type] = (acc[normalized.type] || 0) + 1;
        return acc;
    }, {});
    return Object.entries(counts)
        .map(([type, count]) => `${opLabel(type)} ${count}`)
        .join("，");
}

// Coerce strings/booleans to numbers — LLM tool calls frequently serialize coordinates as
// JSON strings (e.g. { x: "-1200", y: "-300" }); the canvas store expects numeric values.
function coerceNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
    return undefined;
}

function coercePosition(value: unknown): Position | undefined {
    if (!value || typeof value !== "object") return undefined;
    const { x, y } = value as { x?: unknown; y?: unknown };
    const nx = coerceNumber(x);
    const ny = coerceNumber(y);
    if (nx === undefined || ny === undefined) return undefined;
    return { x: nx, y: ny };
}

// canvas_apply_ops accepts a permissive `Type.Array(Type.Unknown())` schema, so the LLM
// invents its own wrapper format ({ op: "addText", textNode: {...} }) instead of the
// canonical flat schema ({ type: "add_node", ... }). Without normalization every op
// silently fails the `op?.type` guard and the canvas never changes. Translate the
// wrapper shapes the agent actually emits into the flat form before dispatching.
export function normalizeCanvasAgentOp(raw: unknown): CanvasAgentOp | null {
    if (!raw || typeof raw !== "object") return null;
    const op = raw as Record<string, unknown>;
    if (typeof op.type === "string") {
        // Flat schema — only patch the coordinate fields that arrive as strings.
        if (op.type === "add_node") {
            const position = coercePosition(op.position);
            const width = coerceNumber(op.width);
            const height = coerceNumber(op.height);
            const x = coerceNumber(op.x);
            const y = coerceNumber(op.y);
            return {
                ...op,
                ...(position ? { position } : {}),
                ...(typeof width === "number" ? { width } : {}),
                ...(typeof height === "number" ? { height } : {}),
                ...(typeof x === "number" ? { x } : {}),
                ...(typeof y === "number" ? { y } : {}),
            } as CanvasAgentOp;
        }
        if (op.type === "update_node") {
            const patch = (op.patch && typeof op.patch === "object") ? op.patch as Record<string, unknown> : undefined;
            const patchPosition = patch ? coercePosition(patch.position) : undefined;
            return {
                ...op,
                ...(patch && patchPosition ? { patch: { ...patch, position: patchPosition } } : {}),
            } as CanvasAgentOp;
        }
        if (op.type === "set_viewport") {
            const viewport = op.viewport as Record<string, unknown> | undefined;
            if (!viewport) return op as CanvasAgentOp;
            const x = coerceNumber(viewport.x);
            const y = coerceNumber(viewport.y);
            const k = coerceNumber(viewport.k);
            return {
                ...op,
                viewport: {
                    x: x ?? (viewport.x as number),
                    y: y ?? (viewport.y as number),
                    k: k ?? (viewport.k as number),
                },
            } as CanvasAgentOp;
        }
        return op as CanvasAgentOp;
    }
    if (typeof op.op !== "string") return null;
    const action = op.op;
    if (action === "addNode" || action === "addText") {
        const textNode = (op.textNode && typeof op.textNode === "object") ? op.textNode as Record<string, unknown> : {};
        const nodeType = (typeof textNode.type === "string" ? textNode.type : undefined) ?? (action === "addText" ? CanvasNodeType.Text : undefined);
        const position = coercePosition(textNode.position);
        const width = coerceNumber(textNode.width);
        const height = coerceNumber(textNode.height);
        return {
            type: "add_node",
            ...(typeof op.id === "string" ? { id: op.id } : {}),
            ...(nodeType ? { nodeType } : {}),
            ...(typeof textNode.title === "string" ? { title: textNode.title } : {}),
            ...(position ? { position } : {}),
            ...(typeof width === "number" ? { width } : {}),
            ...(typeof height === "number" ? { height } : {}),
            metadata: { ...(typeof textNode.content === "string" ? { content: textNode.content } : {}) },
        };
    }
    if (action === "updateNode" || action === "moveNode") {
        const id = typeof op.nodeId === "string" ? op.nodeId : undefined;
        if (!id) return null;
        const patch: Record<string, unknown> = {};
        const position = coercePosition(op.position);
        if (position) patch.position = position;
        const width = coerceNumber(op.width);
        const height = coerceNumber(op.height);
        if (typeof width === "number") patch.width = width;
        if (typeof height === "number") patch.height = height;
        if (typeof op.title === "string") patch.title = op.title;
        if (typeof op.content === "string") patch.metadata = { ...(patch.metadata as object | undefined), content: op.content };
        return { type: "update_node", id, patch };
    }
    if (action === "addConnection") {
        const connection = (op.connection && typeof op.connection === "object") ? op.connection as Record<string, unknown> : {};
        const fromNodeId = typeof connection.fromNodeId === "string" ? connection.fromNodeId : undefined;
        const toNodeId = typeof connection.toNodeId === "string" ? connection.toNodeId : undefined;
        if (!fromNodeId || !toNodeId) return null;
        const id = typeof connection.id === "string" ? connection.id : undefined;
        return { type: "connect_nodes", ...(id ? { id } : {}), fromNodeId, toNodeId };
    }
    if (action === "deleteConnection") {
        const id = typeof op.connectionId === "string" ? op.connectionId : undefined;
        return { type: "delete_connections", ...(id ? { id } : {}) };
    }
    if (action === "select") {
        const nodeIds = Array.isArray(op.nodeIds) ? op.nodeIds.filter((id): id is string => typeof id === "string") : [];
        return { type: "select_nodes", ids: nodeIds };
    }
    if (action === "fitView") {
        // No native fit_view op yet — drop on the floor but keep the call observable so
        // the UI can decide whether to honor it later. Today the bridge ignores it.
        return null;
    }
    if (action === "setViewport") {
        const viewport = coercePosition(op.viewport);
        const k = coerceNumber((op.viewport as { k?: unknown } | undefined)?.k);
        if (!viewport || typeof k !== "number") return null;
        return { type: "set_viewport", viewport: { ...viewport, k } };
    }
    if (action === "deleteNode") {
        const ids = Array.isArray(op.nodeIds) ? op.nodeIds.filter((id): id is string => typeof id === "string") : [];
        if (typeof op.nodeId === "string") ids.unshift(op.nodeId);
        return { type: "delete_node", ids: Array.from(new Set(ids)) };
    }
    return null;
}

export function applyCanvasAgentOps(snapshot: CanvasAgentSnapshot, ops?: CanvasAgentOp[], config?: AiConfig): CanvasAgentSnapshot & { receipts?: CanvasOpReceipt[] } {
    return applyCanvasAgentOpsWithReceipts(snapshot, ops, config).next;
}

/** 镜头写入 op（replace/upsert）落库后的状态收尾：
    generating/error + 有镜头 → done；error 同时清理过期 errorMessage/raw/generatedAt。
    空镜头（如被清空）与 idle/done 保持不变（error + 空镜头 = 保留错误可见）。 */
function finalizeStatus(data: ScriptNodeData): ScriptNodeData {
    const status = data.output.status;
    if (data.output.shots.length === 0 || (status !== "generating" && status !== "error")) return data;
    const output: ScriptNodeData["output"] = { ...data.output, status: "done" };
    if (status === "error") {
        delete output.errorMessage;
        delete output.raw;
        delete output.generatedAt;
    }
    return { ...data, output };
}

/** 脚本节点纯数据 op：只修改 metadata.script，节点不存在或非脚本节点时静默跳过。 */
function applyScriptOp(
    nodes: CanvasNodeData[],
    op: Extract<CanvasAgentOp, { type: "script_set_instruction" | "script_upsert_shot" | "script_delete_shot" | "script_reorder_shots" | "script_replace_shots" | "script_bind_entity" }>,
): CanvasNodeData[] {
    const patch = (updater: (data: ScriptNodeData) => ScriptNodeData) =>
        nodes.map((node) =>
            node.id === (op as { nodeId?: string }).nodeId && node.metadata?.script
                ? { ...node, metadata: { ...node.metadata, script: updater(node.metadata.script) } }
                : node,
        );
    switch (op.type) {
        case "script_set_instruction":
            // template 顶层键 spread 合并（不覆盖既有 shotCount/storyboardFirst，final-review Important 2）；
            // imageGen/videoGen 参数块整体替换（spec D3：{} 清除语义必须 IPC 安全，不依赖 undefined 序列化）
            return patch((data) => ({
                ...data,
                instruction: op.instruction,
                globalStyle: op.globalStyle ?? data.globalStyle,
                ...(op.template ? {
                    template: {
                        ...data.template,
                        ...op.template,
                        ...(op.template.imageGen !== undefined ? { imageGen: op.template.imageGen } : {}),
                        ...(op.template.videoGen !== undefined ? { videoGen: op.template.videoGen } : {}),
                    },
                } : {}),
            }));
        case "script_upsert_shot":
            return patch((data) => {
                const exists = data.output.shots.some((s) => s.shotId === op.shot.shotId);
                const shots = exists ? data.output.shots.map((s) => (s.shotId === op.shot.shotId ? { ...op.shot, no: s.no } : s)) : [...data.output.shots, op.shot];
                return finalizeStatus({ ...data, output: { ...data.output, shots: normalizeShots(shots) } });
            });
        case "script_delete_shot":
            return patch((data) => ({ ...data, output: { ...data.output, shots: normalizeShots(data.output.shots.filter((s) => s.shotId !== op.shotId)) } }));
        case "script_reorder_shots":
            return patch((data) => {
                const order = new Map(op.shotIds.map((id, i) => [id, i]));
                const present = data.output.shots.filter((s) => order.has(s.shotId));
                if (present.length !== op.shotIds.length) return data;
                const shots = [...data.output.shots].sort((a, b) => (order.get(a.shotId) ?? a.no) - (order.get(b.shotId) ?? b.no));
                return { ...data, output: { ...data.output, shots: normalizeShots(shots) } };
            });
        case "script_replace_shots":
            return patch((data) => finalizeStatus({ ...data, output: { ...data.output, shots: normalizeShots(op.shots) } }));
        case "script_bind_entity":
            return patch((data) =>
                data.entityIds.includes(op.entityId) ? data : { ...data, entityIds: [...data.entityIds, op.entityId] },
            );
    }
}

function opLabel(type: string) {
    return i18n.t(`canvas.agentOps.${type}`, { defaultValue: type });
}
