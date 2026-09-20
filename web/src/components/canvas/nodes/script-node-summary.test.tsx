import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";

import i18n from "@/i18n";
import { createEmptyScriptData, type ScriptNodeData } from "@/types/script-node";
import { buildScriptNodeSummary } from "@/lib/canvas/script-node-model";
import { ScriptNodeSummaryCard } from "./script-node-summary";

const renderCard = (summary: ReturnType<typeof buildScriptNodeSummary>, thumbs: Record<string, string> = {}) =>
    render(
        <I18nextProvider i18n={i18n}>
            <ScriptNodeSummaryCard title="猫咪厨房广告" summary={summary} storyboardThumbs={thumbs} />
        </I18nextProvider>,
    );

const scriptWith = (over: Partial<ScriptNodeData>): ScriptNodeData => ({ ...createEmptyScriptData(), ...over });

describe("ScriptNodeSummaryCard", () => {
    it("空脚本：居中空态（还没有镜头）", () => {
        renderCard(buildScriptNodeSummary(createEmptyScriptData(), { assetsReady: 0, assetsTotal: 0 }));
        expect(screen.getByText("还没有镜头")).toBeInTheDocument();
        expect(screen.getByText("让 Agent 创建，或双击手动添加")).toBeInTheDocument();
    });

    it("完成态：大数字、辅助指标、进度百分比、双击提示", () => {
        const data = scriptWith({
            output: {
                status: "done",
                shots: Array.from({ length: 12 }, (_, i) => ({
                    shotId: `s${i}`, no: i + 1, origin: "manual" as const, shotSize: "中景", angle: "平视",
                    movement: "固定", duration: 4, mood: "", sfx: "", dialogue: "", descriptionRich: [],
                    description: "", entityRefs: [], composed: i < 10,
                })),
            },
        });
        renderCard(buildScriptNodeSummary(data, { assetsReady: 4, assetsTotal: 5 }));
        expect(screen.getByText("12")).toBeInTheDocument();
        expect(screen.getByText("48")).toBeInTheDocument(); // 12 × 4s
        expect(screen.getByText("资产 4/5")).toBeInTheDocument();
        expect(screen.getByText("提示词 10/12")).toBeInTheDocument();
        expect(screen.getByText("82%")).toBeInTheDocument(); // (4+10)/(5+12)
        expect(screen.getByText("双击进入 Script Studio")).toBeInTheDocument();
        expect(screen.getByText("+8")).toBeInTheDocument(); // 12 镜只显 4 格
    });

    it("异常态：danger 状态字 + 一行摘要 + 专属提示，不渲染胶片带", () => {
        const data = scriptWith({ output: { status: "error", errorMessage: "模型返回超时", shots: [] } });
        renderCard(buildScriptNodeSummary(data, { assetsReady: 0, assetsTotal: 0 }));
        expect(screen.getByText("生成失败")).toBeInTheDocument();
        expect(screen.getByText("模型返回超时")).toBeInTheDocument();
        expect(screen.getByText("双击进入 Script Studio 查看完整信息")).toBeInTheDocument();
    });

    it("compact（语义缩放）：隐藏辅助指标与双击提示，保留大数字", () => {
        const data = scriptWith({
            output: {
                status: "done",
                shots: [{ shotId: "s1", no: 1, origin: "manual", shotSize: "中景", angle: "平视", movement: "固定", duration: 4, mood: "", sfx: "", dialogue: "", descriptionRich: [], description: "", entityRefs: [], composed: true }],
            },
        });
        render(
            <I18nextProvider i18n={i18n}>
                <ScriptNodeSummaryCard title="t" summary={buildScriptNodeSummary(data, { assetsReady: 1, assetsTotal: 1 })} storyboardThumbs={{}} compact />
            </I18nextProvider>,
        );
        expect(screen.getByText("1")).toBeInTheDocument();
        expect(screen.queryByText("资产 1/1")).not.toBeInTheDocument();
        expect(screen.queryByText("双击进入 Script Studio")).not.toBeInTheDocument();
    });
});
