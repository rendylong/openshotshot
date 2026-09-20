import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import { EntityRefThumb } from "./entity-ref-thumb";
import type { CanvasNodeData } from "@/types/canvas";

vi.mock("@/hooks/use-project-asset-url", () => ({
    useProjectAssetUrl: (assetRef: { assetId?: string } | undefined, fallback: string) => ({ url: assetRef ? `resolved:${assetRef.assetId}` : fallback, status: assetRef ? "ready" : "ready" }),
}));

const nodeWithAssetRef: CanvasNodeData = { id: "n1", type: "image", title: "t", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { content: "blob:dead", assetRef: { backend: "project-file", projectId: "p1", assetId: "a1", revision: 1, relativePath: "x.png" } } };

describe("EntityRefThumb", () => {
    it("nodeId 命中且节点带 assetRef：解析项目资产而非死 blob", () => {
        const { container } = render(<EntityRefThumb refSlot={{ id: "r1", label: "l", state: "ready", source: "library", nodeId: "n1" } as never} canvasImageNodes={[nodeWithAssetRef]} />);
        expect(container.querySelector("img")?.getAttribute("src")).toBe("resolved:a1");
    });
    it("节点无 assetRef：回退原始 content（旧行为回归）", () => {
        const plain = { ...nodeWithAssetRef, metadata: { content: "blob:live-only" } };
        const { container } = render(<EntityRefThumb refSlot={{ id: "r1", label: "l", state: "ready", source: "canvas", nodeId: "n1" } as never} canvasImageNodes={[plain]} />);
        expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:live-only");
    });
});
