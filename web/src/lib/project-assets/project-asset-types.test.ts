import { describe, expect, it } from "vitest";
import { classifyProjectAsset, projectAssetDirectory } from "./project-asset-types";

describe("project asset contracts", () => {
    it.each([
        ["hero.png", "image/png", "image"],
        ["clip.mp4", "video/mp4", "video"],
        ["brief.pdf", "application/pdf", "pdf"],
        ["deck.pptx", "", "presentation"],
        ["budget.xlsx", "", "spreadsheet"],
        ["bottle.glb", "model/gltf-binary", "model3d"],
        ["notes.md", "text/markdown", "text"],
        ["archive.bin", "application/octet-stream", "other"],
    ] as const)("classifies %s", (name, mimeType, expected) => {
        expect(classifyProjectAsset(name, mimeType)).toBe(expected);
    });

    it("routes by source and media kind without using canvas ids", () => {
        expect(projectAssetDirectory({ type: "canvas-import", canvasId: "c1" }, "image")).toBe("assets/imported");
        expect(projectAssetDirectory({ type: "generated", canvasId: "c1", scriptNodeId: "s1" }, "video")).toBe("assets/generated/videos");
        expect(projectAssetDirectory({ type: "derived", canvasId: "c1" }, "image")).toBe("assets/derived/images");
    });
});
