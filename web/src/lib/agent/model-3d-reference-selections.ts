import { Type, type TSchema } from "@earendil-works/pi-ai";

import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-op-types";

export type Model3dReferenceView = "primary" | "left" | "right" | "top" | "all";

export type Model3dReferenceSelection = {
    nodeId: string;
    view: Model3dReferenceView;
};

// view 的字面量枚举依赖 agent 宿主在 execute 前的 TypeBox 参数校验（pi-agent-core
// validateToolArguments）；宿主绕过校验直接调用 execute 时不生效。
export const model3dReferenceSelectionsSchema: TSchema = Type.Optional(Type.Array(Type.Object({
    nodeId: Type.String({ minLength: 1, description: "canvas_get_state 返回的 3D 节点 id" }),
    view: Type.Union([
        Type.Literal("primary"),
        Type.Literal("left"),
        Type.Literal("right"),
        Type.Literal("top"),
        Type.Literal("all"),
    ], { description: "单个视角；all 表示 primary/left/right/top 四视角" }),
}, { additionalProperties: false }), {
    description: "每个被引用 3D 节点恰好一项；view 禁止数组，也不要使用 item 键",
}));

export function resolveModel3dReferenceSelections(
    snapshot: CanvasAgentSnapshot,
    referenceNodeIds: string[],
    selections?: Model3dReferenceSelection[],
): { value?: Record<string, Model3dReferenceView>; error?: string } {
    const model3dIds = [...new Set(referenceNodeIds.flatMap((id) => snapshot.nodes.flatMap((node) =>
        node.type === "3d" && (node.id === id || node.metadata?.groupId === id) ? [node.id] : [],
    )))];
    const selected = selections ?? [];
    if (!model3dIds.length && !selected.length) return { value: undefined };
    const duplicates = [...new Set(selected.map((item) => item.nodeId).filter((id, index, ids) => ids.indexOf(id) !== index))];
    if (duplicates.length) return { error: `reference3dSelections 存在重复 nodeId：${duplicates.join("、")}` };
    const model3dIdSet = new Set(model3dIds);
    const extras = [...new Set(selected.filter((item) => !model3dIdSet.has(item.nodeId)).map((item) => item.nodeId))];
    if (extras.length) return { error: `reference3dSelections 只能包含 referenceNodeIds 中实际引用的 3D 节点：${extras.join("、")}` };
    const missing = model3dIds.filter((id) => !selected.some((item) => item.nodeId === id));
    if (missing.length) return { error: `以下 3D 参考节点缺少视角选择：${missing.join("、")}；请为每个节点传入一项 { nodeId, view }，多视角使用 view: "all"` };
    return { value: Object.fromEntries(selected.map((item) => [item.nodeId, item.view])) };
}
