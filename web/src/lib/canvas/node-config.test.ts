import { describe, expect, it } from "vitest";

import { audioConfigPatch, buildNodeConfig, clearMetadataPatch, hasMetadataOverride, videoConfigPatch } from "./node-config";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

// 断言以搬移时的真实实现为准：patch 值为字符串透传（不做布尔转换），
// count 回退链为 node.metadata.count → (image 模式: canvasImageCount → count) → count → defaultConfig.count。
const emptyNode = { metadata: {} } as unknown as CanvasNodeData;
const baseConfig = { channels: [], count: "5", canvasImageCount: "3", imageModel: "img-x" } as unknown as AiConfig;

describe("node-config（从两个 panel 去重出的纯函数）", () => {
    it("videoConfigPatch 键映射（值为字符串透传）", () => {
        expect(videoConfigPatch("videoSeconds", "8")).toEqual({ seconds: "8" });
        expect(videoConfigPatch("videoGenerateAudio", "true")).toEqual({ generateAudio: "true" });
        expect(videoConfigPatch("videoWatermark", "false")).toEqual({ watermark: "false" });
    });
    it("未知键 fallback 透传 { [key]: value }", () => {
        expect(videoConfigPatch("unknown" as never, "x")).toEqual({ unknown: "x" });
    });
    it("audioConfigPatch 分支与 fallback（fallback 固定落到 audioInstructions）", () => {
        expect(audioConfigPatch("audioVoice", "alloy")).toEqual({ audioVoice: "alloy" });
        expect(audioConfigPatch("audioFormat", "mp3")).toEqual({ audioFormat: "mp3" });
        expect(audioConfigPatch("audioSpeed", "1.5")).toEqual({ audioSpeed: "1.5" });
        expect(audioConfigPatch("audioInstructions" as never, "语气轻快")).toEqual({ audioInstructions: "语气轻快" });
    });
    it("count 回退链 node.metadata.count 优先", () => {
        const node = { metadata: { count: "2" } } as unknown as CanvasNodeData;
        expect(buildNodeConfig(baseConfig, node, "image").count).toBe("2");
    });
    it("count 回退链 image 模式取 canvasImageCount（值为 String）", () => {
        expect(buildNodeConfig(baseConfig, emptyNode, "image").count).toBe("3");
    });
    it("count 回退链非 image 模式跳过 canvasImageCount", () => {
        expect(buildNodeConfig(baseConfig, emptyNode, "video").count).toBe("5");
    });
    it("count 全部缺失时回退 defaultConfig.count", () => {
        expect(buildNodeConfig({ channels: [] } as unknown as AiConfig, emptyNode, "video").count).toBe("1");
    });
});

const node = (metadata: Record<string, unknown>) =>
    ({ id: "n1", type: "text", metadata }) as never;

describe("buildNodeConfig textCount 回退（D7）", () => {
    it("节点 textCount 优先", () => {
        const config = buildNodeConfig(defaultConfig, node({ textCount: 5 }), "text");
        expect(config.textCount).toBe("5");
    });
    it("无覆盖时回退 canvasTextCount", () => {
        const config = buildNodeConfig({ ...defaultConfig, canvasTextCount: "4" }, node({}), "text");
        expect(config.textCount).toBe("4");
    });
    it("都没有时落默认 1", () => {
        const config = buildNodeConfig(defaultConfig, node({}), "text");
        expect(config.textCount).toBe("1");
    });
});

describe("override helpers（D3）", () => {
    it("hasMetadataOverride：undefined 值不算覆盖", () => {
        expect(hasMetadataOverride({ quality: undefined }, ["quality"])).toBe(false);
        expect(hasMetadataOverride({ quality: "high" }, ["quality"])).toBe(true);
        expect(hasMetadataOverride(undefined, ["quality"])).toBe(false);
    });
    it("clearMetadataPatch：全键置 undefined（applyNodeConfigPatch spread 后等效清除）", () => {
        expect(clearMetadataPatch(["quality", "size"])).toEqual({ quality: undefined, size: undefined });
    });
});
