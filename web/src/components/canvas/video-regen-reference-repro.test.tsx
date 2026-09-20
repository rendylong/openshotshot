import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";

import { registerBuiltinNodes } from "@/components/canvas/nodes/builtin-nodes";
import { CanvasNodeReferenceBar } from "./canvas-node-reference-bar";
import { buildNodeGenerationContext } from "./canvas-node-generation";
import { buildVideoChildConnections, findRetrySourceNode } from "@/lib/canvas/canvas-generation-helpers";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

// 回归：已生成的视频节点 A 再次生成时，新节点 B 的引用应与 A 保持一致——
// 画布上 A→B 的血统连线（lineage）不得被当成"参考 A"，直接参考流下 B 还要继承 A 的参考入边。
// 拓扑构造走真实的 buildVideoChildConnections（与 project.tsx video 分支同一入口）。

function imageNode(id: string): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { content: `data:image/png;base64,${id}` } };
}

function videoNode(id: string, content?: string): CanvasNodeData {
    return { id, type: CanvasNodeType.Video, title: id, position: { x: 0, y: 0 }, width: 480, height: 270, metadata: content ? { content, mimeType: "video/mp4" } : { status: "loading" } };
}

function configNode(id: string): CanvasNodeData {
    return { id, type: CanvasNodeType.Config, title: id, position: { x: 0, y: 0 }, width: 300, height: 200, metadata: {} };
}

function edge(from: string, to: string): CanvasConnection {
    return { id: `${from}->${to}`, fromNodeId: from, toNodeId: to };
}

// project.tsx connectedNodesByNodeId 的等价实现：入边上游节点（血统边不算参考）
function connectedNodesOf(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return connections
        .filter((connection) => connection.toNodeId === nodeId && !connection.lineage)
        .map((connection) => nodes.find((node) => node.id === connection.fromNodeId))
        .filter((node): node is CanvasNodeData => Boolean(node));
}

function renderBarFor(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return render(<CanvasNodeReferenceBar nodeId={nodeId} nodes={nodes} connectedNodes={connectedNodesOf(nodeId, nodes, connections)} />);
}

describe("回归：已生成视频节点再次生成，新节点 B 的引用与 A 保持一致", () => {
    beforeEach(() => {
        registerBuiltinNodes();
        void i18n.changeLanguage("en-US");
    });

    it("直接参考流：A 的参考是 IMG，再生成后 B 继承 IMG，血统连线不显示为参考 A", () => {
        const img = imageNode("img1");
        const a = videoNode("videoA", "blob:video-a");
        const baseNodes = [img, a];
        const baseConnections = [edge("img1", "videoA")];

        const b = videoNode("videoB");
        const nodes = [...baseNodes, b];
        const connections = [...baseConnections, ...buildVideoChildConnections("videoA", "videoB", baseNodes, baseConnections)];
        expect(connections.some((connection) => connection.fromNodeId === "videoA" && connection.toNodeId === "videoB" && connection.lineage)).toBe(true);

        renderBarFor("videoB", nodes, connections);
        expect(document.querySelector("img[src='data:image/png;base64,img1']")).toBeTruthy();
        expect(document.querySelector("video[src='blob:video-a']")).toBeNull();

        // 连带：在 B 上再次生成时参考仍应是 IMG，而不是把 A 的视频当参考输入
        const context = buildNodeGenerationContext("videoB", nodes, connections, "p", { strictReferences: true, inputsSourceNodeId: findRetrySourceNode("videoB", nodes, connections)?.id });
        expect(context.referenceVideos).toHaveLength(0);
        expect(context.referenceImages.map((image) => image.dataUrl)).toContain("data:image/png;base64,img1");
    });

    it("config 祖先流：参考由 config 持有，B 的引用栏与 A 一致保持为空，再次生成仍回溯到 config", () => {
        const img = imageNode("img1");
        const config = configNode("cfg");
        const a = videoNode("videoA", "blob:video-a");
        const baseNodes = [img, config, a];
        const baseConnections = [edge("img1", "cfg"), edge("cfg", "videoA")];

        const b = videoNode("videoB");
        const nodes = [...baseNodes, b];
        const connections = [...baseConnections, ...buildVideoChildConnections("videoA", "videoB", baseNodes, baseConnections)];

        renderBarFor("videoB", nodes, connections);
        expect(document.querySelector("video[src='blob:video-a']")).toBeNull();
        expect(document.querySelector("img[src='data:image/png;base64,img1']")).toBeNull();

        expect(findRetrySourceNode("videoB", nodes, connections)?.id).toBe("cfg");
        const context = buildNodeGenerationContext("videoB", nodes, connections, "p", { strictReferences: true, inputsSourceNodeId: "cfg" });
        expect(context.referenceImages.map((image) => image.dataUrl)).toContain("data:image/png;base64,img1");
    });
});
