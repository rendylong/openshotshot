import type { FalField, FalMediaSlot } from "@/lib/models/fal/profile-types";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata, CanvasNodeTypeId, ViewportTransform } from "@/types/canvas";
import type { Model3dCameraPose } from "@/lib/canvas/model-3d-camera";
import type { ScriptImageGenParams, ScriptShot, ScriptVideoGenParams } from "@/types/script-node";

// 画布 agent 操作与快照的纯类型定义。刻意与 applyCanvasAgentOps 拆开：
// 主进程（Electron/pi）只依赖这些类型，不必拉进 i18n / node-registry / react。
// canvas-agent-ops.ts 从这里 re-export，保持既有 import 路径不变。
export type CanvasAgentOp =
    | { type: "add_node"; id?: string; nodeType?: CanvasNodeTypeId; title?: string; position?: { x: number; y: number }; x?: number; y?: number; width?: number; height?: number; metadata?: CanvasNodeMetadata; /** 无坐标时按这些锚点节点放置（renderer 解析）；省略时按选区/视口 */ anchorNodeIds?: string[] }
    | { type: "update_node"; id: string; patch?: Partial<CanvasNodeData>; metadata?: CanvasNodeMetadata }
    | { type: "delete_node"; id?: string; ids?: string[]; nodeType?: CanvasNodeTypeId }
    | { type: "delete_connections"; id?: string; ids?: string[]; all?: boolean }
    | { type: "connect_nodes"; id?: string; fromNodeId: string; toNodeId: string }
    | { type: "set_viewport"; viewport: ViewportTransform }
    | { type: "select_nodes"; ids: string[] }
    | { type: "set_3d_camera"; nodeId: string; camera: Model3dCameraPose }
    | { type: "script_set_instruction"; nodeId: string; instruction: string; globalStyle?: string; template?: { shotCount?: number; storyboardFirst?: boolean; imageGen?: ScriptImageGenParams; videoGen?: ScriptVideoGenParams } }
    | { type: "script_upsert_shot"; nodeId: string; shot: ScriptShot }
    | { type: "script_delete_shot"; nodeId: string; shotId: string }
    | { type: "script_reorder_shots"; nodeId: string; shotIds: string[] }
    | { type: "script_replace_shots"; nodeId: string; shots: ScriptShot[] }
    | { type: "script_entity_upsert"; entity: { id?: string; projectId: string; group: "character" | "scene" | "item"; name: string; role?: string; appearance?: string; consistency?: string; imagePrompt?: string; refs?: Array<{ id: string; label: string; state: "empty" | "queued" | "ready" }> } }
    | { type: "script_resolve_shot_refs"; nodeId: string; shotId: string; names: string[]; /** 工具期已解析的实体 id（bridge 直连采用，跳过名称匹配）；与 names 一一对应 */ entityIds?: string[] }
    | { type: "script_bind_entity"; nodeId: string; entityId: string }
    | { type: "script_assign_entity_ref"; entityId: string; refId: string; nodeId: string }
    | { type: "script_generate_storyboard"; nodeId: string; shotId: string; settings: { metadata: Partial<CanvasNodeMetadata> } }
    | { type: "add_text_nodes"; items: Array<{ text: string; title?: string; width?: number; height?: number }>; direction?: "row" | "column"; gap?: number }
    | { type: "run_generation"; nodeId: string; mode?: "text" | "image" | "video" | "audio"; prompt?: string; force?: boolean };

export type CanvasGenerationContract = {
    readonly endpointId: string;
    readonly profileId: string;
    readonly profileVersion: number;
    readonly fields: readonly FalField[];
    readonly media: readonly FalMediaSlot[];
};

export type CanvasAgentSnapshot = {
    projectId: string;
    canvasId: string;
    title: string;
    // referenceKind is a wire-level annotation (statically declared reference capability, e.g. 3d → image)
    // added when the snapshot is published to the agent; it is not part of persisted node data.
    nodes: Array<CanvasNodeData & { referenceKind?: string; referenceCount?: number; readonly generationContract?: CanvasGenerationContract }>;
    connections: CanvasConnection[];
    selectedNodeIds: string[];
    viewport: ViewportTransform;
    // Renderer viewport size in CSS pixels; used only to choose a sensible default position.
    viewportSize?: { width: number; height: number };
};

// 逐条 op 回执（可靠性 spec §1）：op 应用层产出，工具据此返回真实效果。
// 纯类型文件，主进程（electron/agent-host.ts）共享。
export type CanvasOpReceipt = {
    opIndex: number;
    opType: string;
    status: "applied" | "skipped" | "invalid";
    reason?: string;
    nodeIds?: string[];
    taskId?: string;
    taskStatus?: string;
};
