import { describe, expect, it } from "vitest";

import { createEmptyScriptData, type ScriptNodeData, type ScriptOutputStatus, type ScriptShot } from "@/types/script-node";
import { buildScriptNodeSummary } from "./script-node-model";

const shot = (no: number, over: Partial<ScriptShot> = {}): ScriptShot => ({
    shotId: `s${no}`,
    no,
    origin: "manual",
    shotSize: "中景",
    angle: "平视",
    movement: "固定",
    duration: 4,
    mood: "",
    sfx: "",
    dialogue: "",
    descriptionRich: [],
    description: "",
    entityRefs: [],
    composed: false,
    ...over,
});

const scriptWith = (shots: ScriptShot[], over: { status?: ScriptOutputStatus; errorMessage?: string } = {}): ScriptNodeData => {
    const empty = createEmptyScriptData();
    return {
        ...empty,
        output: { ...empty.output, status: over.status ?? "done", errorMessage: over.errorMessage, shots },
    };
};

describe("buildScriptNodeSummary", () => {
    it("完成态：汇总镜头数/总时长/合成数，进度 = (资产就绪 + 已合成) / (资产总数 + 镜头数)", () => {
        const summary = buildScriptNodeSummary(
            scriptWith([shot(1, { duration: 5, composed: true }), shot(2, { duration: 3 })]),
            { assetsReady: 4, assetsTotal: 5 },
        );
        expect(summary.shotCount).toBe(2);
        expect(summary.totalDuration).toBe(8);
        expect(summary.promptsComposed).toBe(1);
        expect(summary.progress).toBeCloseTo(5 / 7);
        expect(summary.frames).toHaveLength(2);
        expect(summary.extraCount).toBe(0);
    });

    it("生成中：progress 恒 -1（UI 渲染不确定态）", () => {
        const summary = buildScriptNodeSummary(scriptWith([shot(1)], { status: "generating" }), { assetsReady: 0, assetsTotal: 0 });
        expect(summary.progress).toBe(-1);
    });

    it("maxFrames 截断胶片带并统计余量；hasStoryboard 只认已水合节点 id", () => {
        const data = scriptWith([shot(1), shot(2), shot(3), shot(4), shot(5)]);
        data.output.storyboardNodes = { s1: "node-1", s2: "node-missing" };
        const summary = buildScriptNodeSummary(data, {
            assetsReady: 0,
            assetsTotal: 0,
            hydratedStoryboardIds: new Set(["node-1"]),
        });
        expect(summary.frames.map((f) => f.no)).toEqual([1, 2, 3, 4]);
        expect(summary.extraCount).toBe(1);
        expect(summary.frames[0].hasStoryboard).toBe(true);
        expect(summary.frames[1].hasStoryboard).toBe(false);
    });

    it("空脚本：progress 0、无 frames", () => {
        const summary = buildScriptNodeSummary(createEmptyScriptData(), { assetsReady: 0, assetsTotal: 0 });
        expect(summary.shotCount).toBe(0);
        expect(summary.progress).toBe(0);
        expect(summary.frames).toHaveLength(0);
    });
});
