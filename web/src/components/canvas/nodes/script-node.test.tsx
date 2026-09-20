import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";

import i18n from "@/i18n";
import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeContext } from "@/types/canvas-plugin";
import { SCRIPT_NODE_TYPE, createEmptyScriptData, type ScriptOutputStatus, type ScriptShot } from "@/types/script-node";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { registerBuiltinNodes } from "./builtin-nodes";
import { ScriptNodeContent } from "./script-node";

const shot = (shotId: string, no: number): ScriptShot => ({
    shotId, no, origin: "manual", shotSize: "中景", angle: "平视", movement: "固定",
    duration: 4, mood: "温暖", sfx: "", dialogue: "", descriptionRich: [], description: "", entityRefs: [], composed: false,
});

function makeCtx(status: ScriptOutputStatus, nodeId = "script-node-1"): { ctx: CanvasNodeContext; emit: ReturnType<typeof vi.fn> } {
    const empty = createEmptyScriptData();
    const node: CanvasNodeData = {
        id: nodeId,
        type: SCRIPT_NODE_TYPE,
        title: "",
        position: { x: 0, y: 0 },
        width: 280,
        height: 190,
        metadata: { script: { ...empty, output: { ...empty.output, status, shots: [shot("a", 1), shot("b", 2)] } } },
    };
    const emit = vi.fn();
    // ScriptNodeContent / onDoubleClick 只消费 node、isSelected、getNodes、emit；其余成员按类型补齐空实现。
    const ctx = {
        node,
        theme: {},
        scale: 1,
        isSelected: false,
        updateMetadata: vi.fn(),
        updateNode: vi.fn(),
        getNode: vi.fn(),
        getNodes: vi.fn(() => []),
        getConnections: vi.fn(() => []),
        getUpstream: vi.fn(() => []),
        getDownstream: vi.fn(() => []),
        applyOps: vi.fn(),
        open3dPreview: vi.fn(),
        emit,
        on: vi.fn(() => () => {}),
        openPanel: vi.fn(),
        closePanel: vi.fn(),
        storage: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
    } as unknown as CanvasNodeContext;
    return { ctx, emit };
}

function renderContent(ctx: CanvasNodeContext) {
    return render(
        <I18nextProvider i18n={i18n}>
            <ScriptNodeContent ctx={ctx} />
        </I18nextProvider>,
    );
}

describe("ScriptNodeContent（场记板摘要卡）", () => {
    it("完成态渲染摘要：镜头数与双击提示", () => {
        const { ctx } = makeCtx("done");
        renderContent(ctx);
        expect(screen.getByText("2")).toBeInTheDocument();
        expect(screen.getByText("双击进入 Script Studio")).toBeInTheDocument();
    });

    it("生成中渲染正在编排与已写入数", () => {
        const { ctx } = makeCtx("generating");
        renderContent(ctx);
        expect(screen.getByText("正在编排")).toBeInTheDocument();
        expect(screen.getByText("镜头已写入")).toBeInTheDocument();
    });

    it("异常态渲染失败状态与错误摘要", () => {
        const { ctx } = makeCtx("error");
        (ctx.node.metadata!.script!.output as { errorMessage?: string }).errorMessage = "模型返回超时";
        renderContent(ctx);
        expect(screen.getByText("生成失败")).toBeInTheDocument();
        expect(screen.getByText("模型返回超时")).toBeInTheDocument();
    });
});

describe("ScriptNode 双击打开 studio", () => {
    registerBuiltinNodes();
    const definition = getNodeDefinition(SCRIPT_NODE_TYPE);
    expect(definition?.onDoubleClick).toBeTruthy();

    it("generating 时双击：同样 emit open-script-studio（生成中允许查看、编辑）", () => {
        const { ctx, emit } = makeCtx("generating", "script-dblclick-gen");
        expect(definition!.onDoubleClick!(ctx)).toBe(true);
        expect(emit).toHaveBeenCalledWith("open-script-studio", { nodeId: "script-dblclick-gen" });
    });

    it("done 时双击：正常 emit open-script-studio（现状不回归）", () => {
        const { ctx, emit } = makeCtx("done", "script-dblclick-done");
        expect(definition!.onDoubleClick!(ctx)).toBe(true);
        expect(emit).toHaveBeenCalledWith("open-script-studio", { nodeId: "script-dblclick-done" });
    });
});
