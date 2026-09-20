import { describe, expect, it } from "vitest";

import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-op-types";
import { resolveModel3dReferenceSelections, type Model3dReferenceSelection } from "./model-3d-reference-selections";

const snapshot: CanvasAgentSnapshot = {
    projectId: "project-1",
    canvasId: "canvas-1",
    title: "3d reference contract",
    nodes: [
        { id: "3d-a", type: "3d", title: "3d-a", position: { x: 0, y: 0 }, width: 1, height: 1 },
        { id: "3d-b", type: "3d", title: "3d-b", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { groupId: "3d-group" } },
        { id: "image-a", type: "image", title: "image-a", position: { x: 0, y: 0 }, width: 1, height: 1 },
    ],
    connections: [],
    selectedNodeIds: [],
    viewport: { x: 0, y: 0, k: 1 },
};

describe("resolveModel3dReferenceSelections", () => {
    it("把每个 3D selection 转成持久化 map", () => {
        expect(resolveModel3dReferenceSelections(snapshot, ["3d-a", "image-a"], [
            { nodeId: "3d-a", view: "all" },
        ])).toEqual({ value: { "3d-a": "all" } });
    });

    it("引用 metadata.groupId 命中的实际 3D 节点时仍能识别", () => {
        expect(resolveModel3dReferenceSelections(snapshot, ["3d-group"], [
            { nodeId: "3d-b", view: "top" },
        ])).toEqual({ value: { "3d-b": "top" } });
    });

    it("没有 3D 引用且没有 selections 时返回 { value: undefined }", () => {
        expect(resolveModel3dReferenceSelections(snapshot, ["image-a"])).toEqual({ value: undefined });
    });

    it.each([
        {
            name: "重复 nodeId",
            refs: ["3d-a"],
            selections: [
                { nodeId: "3d-a", view: "left" },
                { nodeId: "3d-a", view: "right" },
            ],
            message: "reference3dSelections 存在重复 nodeId：3d-a",
        },
        {
            name: "包含未引用的 3D 节点",
            refs: ["3d-a"],
            selections: [{ nodeId: "3d-b", view: "all" }],
            message: "reference3dSelections 只能包含 referenceNodeIds 中实际引用的 3D 节点：3d-b",
        },
        {
            name: "包含图片节点",
            refs: ["3d-a", "image-a"],
            selections: [{ nodeId: "image-a", view: "all" }],
            message: "reference3dSelections 只能包含 referenceNodeIds 中实际引用的 3D 节点：image-a",
        },
        {
            name: "缺少 3D 节点选择",
            refs: ["3d-a"],
            selections: [],
            message: "以下 3D 参考节点缺少视角选择：3d-a；请为每个节点传入一项 { nodeId, view }，多视角使用 view: \"all\"",
        },
    ])("拒绝$name", ({ refs, selections, message }) => {
        expect(resolveModel3dReferenceSelections(snapshot, refs, selections as Model3dReferenceSelection[])).toEqual({ error: message });
    });
});
