import { describe, expect, it } from "vitest";

import { stripReasoningTags } from "./strip-reasoning-tags";

describe("stripReasoningTags", () => {
    it("移除成对 <think> 段（含多段），保留正文", () => {
        expect(stripReasoningTags("<think>推理a</think>正文一<think>推理b</think>正文二")).toBe("正文一正文二");
    });
    it("未闭合且其后无正文 → 整段移除", () => {
        expect(stripReasoningTags("正文<think>未闭合")).toBe("正文");
    });
    it("未闭合且其后有正文 → 保留原文（无法判定推理边界）", () => {
        expect(stripReasoningTags("<think>未闭合\n后面像正文")).toBe("<think>未闭合\n后面像正文");
    });
    it("剥离后为空白 → 返回原文", () => {
        expect(stripReasoningTags("<think>只有推理</think>")).toBe("<think>只有推理</think>");
    });
    it("无标签原样返回", () => {
        expect(stripReasoningTags("普通正文")).toBe("普通正文");
    });
});
