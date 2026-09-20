import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";

import i18n from "@/i18n";
import { SCRIPT_NODE_TYPE, createEmptyScriptData, type ScriptNodeData } from "@/types/script-node";
import type { CanvasNodeData } from "@/types/canvas";
import { ScriptStudio } from "./script-studio";

const node = (over: Partial<ScriptNodeData> = {}): CanvasNodeData => ({
    id: "n1",
    type: SCRIPT_NODE_TYPE,
    title: "猫咪厨房广告",
    position: { x: 0, y: 0 },
    width: 280,
    height: 190,
    metadata: { script: { ...createEmptyScriptData(), ...over } },
});

const baseProps = {
    projectId: "p1",
    canvasImageNodes: [],
    audioNodes: [],
    onImportAudio: vi.fn(),
    onClose: vi.fn(),
    onUpdateScript: vi.fn(),
    onGenerateRef: vi.fn(),
    onPickEntityRefLibrary: vi.fn(),
    onBatchGenerate: vi.fn(),
    storyboardFirst: false,
    storyboardImageState: {},
    onGenerateStoryboard: vi.fn(),
    onSelectStoryboard: vi.fn(),
    onBatchGenerateStoryboards: vi.fn(),
    onToast: vi.fn(),
};

const renderStudio = (scriptOver: Partial<ScriptNodeData> = {}) =>
    render(
        <I18nextProvider i18n={i18n}>
            <ScriptStudio node={node(scriptOver)} {...baseProps} />
        </I18nextProvider>,
    );

const renderStudioWithVideos = (scriptOver: Partial<ScriptNodeData>, canvasVideoNodes: CanvasNodeData[]) =>
    render(
        <I18nextProvider i18n={i18n}>
            <ScriptStudio node={node(scriptOver)} {...baseProps} canvasVideoNodes={canvasVideoNodes} />
        </I18nextProvider>,
    );

// 画布视频节点最小面（status 驱动 isVideoNodeGenerating）
const videoNode = (id: string, status: string): CanvasNodeData =>
    ({ id, type: "video", title: `视频 ${id}`, position: { x: 0, y: 0 }, width: 480, height: 270, metadata: { status } }) as CanvasNodeData;

// 最小可用镜头（ScriptShot 必填面）；空脚本受「恒落视图 1」规则约束，恢复 lastStep 需非空脚本
const makeShot = () => ({
    shotId: "s1",
    no: 1,
    origin: "manual" as const,
    shotSize: "",
    angle: "",
    movement: "",
    duration: 0,
    mood: "",
    descriptionRich: [] as ScriptNodeData["output"]["shots"][number]["descriptionRich"],
    description: "",
    entityRefs: [] as string[],
    composed: false,
});

describe("ScriptStudio lastStep 恢复", () => {
    // 视图信号：视图 2 渲染 AssetsStep 的「全局风格」输入（zh placeholder），视图 1 不含
    it("无记录时落在视图 1（确认镜头，无资产表单）", () => {
        renderStudio();
        expect(screen.getByRole("button", { name: /确认镜头/ })).toBeInTheDocument();
        expect(screen.queryByPlaceholderText("统一拼入最终提示词的风格描述")).not.toBeInTheDocument();
    });

    it("template.lastStep=2 时打开落在视图 2（资产表单出现）", () => {
        // 非空脚本（空脚本恒落 1）携带 lastStep=2，打开应恢复视图 2
        renderStudio({ template: { lastStep: 2 }, output: { status: "idle", shots: [makeShot()] } });
        expect(screen.getByPlaceholderText("统一拼入最终提示词的风格描述")).toBeInTheDocument();
    });

    it("切换视图写回 template.lastStep", async () => {
        renderStudio();
        // 向导 footer（下一步按钮链）删除后，「准备资产」仅剩头部步骤导航一个按钮
        fireEvent.click(screen.getByRole("button", { name: /准备资产/ }));
        // onUpdateScript 签名为 (nodeId, updater)，updater 在第二个参数位
        const updater = baseProps.onUpdateScript.mock.calls.at(-1)?.[1] as (d: ScriptNodeData) => ScriptNodeData;
        expect(updater(createEmptyScriptData()).template?.lastStep).toBe(2);
    });
});

describe("ScriptStudio 工作台化", () => {
    it("不存在「下一步」与「完成编辑」按钮", () => {
        renderStudio();
        expect(screen.queryByText(/下一步/)).not.toBeInTheDocument();
        expect(screen.queryByText(/完成脚本编辑/)).not.toBeInTheDocument();
    });

    it("关闭即离开：✕ 触发 onClose 且不弹确认", () => {
        renderStudio();
        // 精确名匹配 ✕ 关闭钮（aria-label），「← 返回画布」文字链接不含于内
        fireEvent.click(screen.getByRole("button", { name: "返回画布" }));
        expect(baseProps.onClose).toHaveBeenCalledTimes(1);
    });

    it("当前视图 tab 标记 aria-current=step", () => {
        renderStudio();
        expect(screen.getByRole("button", { name: /确认镜头/ })).toHaveAttribute("aria-current", "step");
    });

    it("分镜图先行开关在设置 popover 中，切换写回 template.storyboardFirst", () => {
        renderStudio();
        fireEvent.click(screen.getByRole("button", { name: "脚本设置" }));
        // brief 实现渲染 input[type=checkbox]（label 包裹提供可访问名），role 为 checkbox 而非 switch
        fireEvent.click(screen.getByRole("checkbox", { name: "分镜图先行" }));
        // onUpdateScript 签名为 (nodeId, updater)，updater 在第二个参数位
        const updater = baseProps.onUpdateScript.mock.calls.at(-1)?.[1] as (d: ScriptNodeData) => ScriptNodeData;
        expect(updater(createEmptyScriptData()).template?.storyboardFirst).toBe(true);
    });
});

describe("ScriptStudio 生成计数脚本域化", () => {
    // 视图 3 才渲染 ComposeActionsBar；脚本绑定 v1（展开节点）与 v2（视频版本），v9 为无关脚本节点
    const scriptWithVideos = {
        template: { lastStep: 3 as const },
        output: {
            status: "idle" as const,
            shots: [makeShot()],
            expandedShotNodes: { s1: "v1" },
            shotVideoVersions: { s1: [{ nodeId: "v1", no: 1 }, { nodeId: "v2", no: 2 }] },
        },
    };

    it("画布上无关视频节点生成中不计入动作条生成计数", () => {
        renderStudioWithVideos(scriptWithVideos, [videoNode("v9", "loading")]);
        expect(screen.queryByText("1 个镜头视频生成中…")).not.toBeInTheDocument();
        expect(screen.getByText("已合成 0/1 镜提示词")).toBeInTheDocument();
    });

    it("本脚本的展开节点 / 视频版本节点生成中才计入", () => {
        renderStudioWithVideos(scriptWithVideos, [videoNode("v9", "loading"), videoNode("v1", "loading"), videoNode("v2", "loading")]);
        expect(screen.getByText("2 个镜头视频生成中…")).toBeInTheDocument();
    });
});
