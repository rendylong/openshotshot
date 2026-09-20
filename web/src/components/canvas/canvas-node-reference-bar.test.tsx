import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

import { registerBuiltinNodes } from "@/components/canvas/nodes/builtin-nodes";
import { CanvasNodeReferenceBar } from "./canvas-node-reference-bar";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { SCRIPT_NODE_TYPE, createEmptyScriptData } from "@/types/script-node";

// 项目文件资产节点：assetRef 存在时经 hook 解析出可用的展示 URL（对齐 canvas-node.tsx 显示层）
vi.mock("@/hooks/use-project-asset-url", () => ({
    useProjectAssetUrl: (assetRef: { assetId?: string } | undefined, fallback: string) => ({ url: assetRef ? `resolved:${assetRef.assetId}` : fallback, status: "ready" as const }),
}));

// 引用条按生成同源资格过滤：脚本从属边不得渲染为参考芯片（spec 2026-09-08）。
// 资格判定依赖节点注册表（script 定义无 referenceKind/resource），测试环境需显式注册内置节点。
function imageNode(id: string, content?: string): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 300, height: 200, metadata: content ? { content: `data:image/png;base64,${id}` } : {} };
}

function scriptNode(id: string): CanvasNodeData {
    return { id, type: SCRIPT_NODE_TYPE, title: "脚本", position: { x: 0, y: 0 }, width: 250, height: 170, metadata: { script: createEmptyScriptData() } };
}

function groupNode(id: string): CanvasNodeData {
    return { id, type: CanvasNodeType.Group, title: id, position: { x: 0, y: 0 }, width: 200, height: 200, metadata: {} };
}

function renderBar(connectedNodes: CanvasNodeData[], nodes: CanvasNodeData[], onDisconnect?: (fromNodeId: string, toNodeId: string) => void) {
    return render(<CanvasNodeReferenceBar nodeId="target" nodes={nodes} connectedNodes={connectedNodes} onDisconnect={onDisconnect} />);
}

describe("CanvasNodeReferenceBar assetRef-aware thumbnails", () => {
    beforeEach(() => {
        registerBuiltinNodes();
    });
    it("带 assetRef 的连接节点：芯片用解析后的 URL 而非死 objectURL", () => {
        const node: CanvasNodeData = { id: "img1", type: CanvasNodeType.Image, title: "场景图", position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { content: "blob:file:///dead", assetRef: { backend: "project-file", projectId: "p1", assetId: "a1", revision: 1, relativePath: "x.png" } } };
        renderBar([node], [node]);
        const img = document.querySelector("img");
        expect(img?.getAttribute("src")).toBe("resolved:a1");
    });
    it("无 assetRef 的节点：回退原始 content（旧行为回归）", () => {
        const node = imageNode("img2", "x");
        renderBar([node], [node]);
        const img = document.querySelector("img");
        expect(img?.getAttribute("src")).toBe(`data:image/png;base64,${"img2"}`);
    });
});

describe("CanvasNodeReferenceBar script ownership edge filtering", () => {
    beforeEach(() => {
        registerBuiltinNodes();
        void i18n.changeLanguage("en-US");
    });

    it("shows no reference chips when the only upstream is a script node", () => {
        const nodes = [scriptNode("script1")];
        renderBar([nodes[0]], nodes);
        expect(screen.queryAllByRole("button", { name: "Disconnect reference" })).toHaveLength(0);
        expect(screen.getByTitle("Select references from canvas")).toBeInTheDocument();
    });

    it("renders only the image chip when a script edge and an image reference coexist", () => {
        const nodes = [scriptNode("script1"), imageNode("img1", "content")];
        const onDisconnect = vi.fn();
        renderBar(nodes, nodes, onDisconnect);
        const disconnects = screen.getAllByRole("button", { name: "Disconnect reference" });
        expect(disconnects).toHaveLength(1);
        expect(document.querySelector("img[src^='data:image']")).toBeTruthy();
        fireEvent.click(disconnects[0]);
        expect(onDisconnect).toHaveBeenCalledWith("img1", "target");
    });

    it("keeps an empty image chip under the strict eligibility superset", () => {
        const nodes = [scriptNode("script1"), imageNode("imgEmpty")];
        renderBar(nodes, nodes);
        expect(screen.getAllByRole("button", { name: "Disconnect reference" })).toHaveLength(1);
    });

    it("expands resource groups and hides empty ones", () => {
        const emptyGroup = groupNode("groupEmpty");
        const filledGroup = groupNode("groupFilled");
        const child = { ...imageNode("imgChild", "content"), metadata: { ...imageNode("imgChild", "content").metadata, groupId: "groupFilled" } };
        const nodes = [emptyGroup, filledGroup, child];
        const onDisconnect = vi.fn();
        renderBar([emptyGroup, filledGroup], nodes, onDisconnect);
        const disconnects = screen.getAllByRole("button", { name: "Disconnect reference" });
        expect(disconnects).toHaveLength(1);
        fireEvent.click(disconnects[0]);
        expect(onDisconnect).toHaveBeenCalledWith("groupFilled", "target");
    });
});
