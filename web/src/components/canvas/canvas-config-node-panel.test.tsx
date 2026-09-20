import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { getGenerationCount } from "@/lib/canvas/canvas-generation-helpers";
import { defaultConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeMetadata } from "@/types/canvas";
import { CanvasConfigNodePanel } from "./canvas-config-node-panel";
import { missingReasonKey } from "./canvas-config-node-panel";

const effective = vi.hoisted(() => ({ config: null as AiConfig | null }));
vi.mock("@/stores/use-config-store", async importOriginal => {
    const actual = await importOriginal<typeof import("@/stores/use-config-store")>();
    return { ...actual, useEffectiveConfig: () => effective.config || actual.defaultConfig };
});

afterEach(() => {
    delete window.shotshot;
    useConfigStore.setState({ config: defaultConfig });
    effective.config = null;
});

const baseNode = (metadata: Partial<CanvasNodeMetadata> = {}): CanvasNodeData => ({
    id: "config-node",
    type: CanvasNodeType.Config,
    title: "Config",
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: { generationMode: "image" as const, ...metadata },
});

function renderPanel(node: CanvasNodeData, overrides: Partial<Parameters<typeof CanvasConfigNodePanel>[0]> = {}) {
    const props = {
        node,
        inputs: [] as Parameters<typeof CanvasConfigNodePanel>[0]["inputs"],
        inputSummary: { textCount: 0, imageCount: 0, videoCount: 0, audioCount: 0 },
        isRunning: false,
        onConfigChange: vi.fn(),
        onGenerate: vi.fn(),
        onStop: vi.fn(),
        onComposerToggle: vi.fn(),
        ...overrides,
    };
    const view = render(
        <I18nextProvider i18n={i18n}><AntApp>
            <CanvasConfigNodePanel {...props} />
        </AntApp></I18nextProvider>,
    );
    return { view, props };
}

describe("CanvasConfigNodePanel evidence and CTA", () => {
    it("explains why generation is blocked and keeps the CTA disabled", () => {
        const { props } = renderPanel(baseNode());
        expect(screen.getByText("连接提示词或参考图后可生成")).toBeInTheDocument();
        const button = screen.getByRole("button", { name: /生成/ });
        expect(button).toBeDisabled();
        fireEvent.click(button);
        expect(props.onGenerate).not.toHaveBeenCalled();
    });

    it("shows the running state and stops on click", () => {
        const { props } = renderPanel(baseNode(), { isRunning: true });
        const button = screen.getByRole("button", { name: /生成中/ });
        fireEvent.click(button);
        expect(props.onStop).toHaveBeenCalledWith("config-node");
    });

    it("renders prompt evidence with composer priority and composer entry", () => {
        const { props } = renderPanel(baseNode({ prompt: "商业广告口播" }), {
            inputs: [{ nodeId: "text-1", type: "text" as const, title: "文本", text: "清晨厨房口播" }],
            inputSummary: { textCount: 1, imageCount: 0, videoCount: 0, audioCount: 0 },
        });
        expect(screen.getByText("商业广告口播")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "组装提示词" }));
        expect(props.onComposerToggle).toHaveBeenCalled();
    });

    it("falls back to connected text content when no prompt is authored", () => {
        renderPanel(baseNode(), {
            inputs: [{ nodeId: "text-1", type: "text" as const, title: "文本", text: "清晨厨房口播" }],
            inputSummary: { textCount: 1, imageCount: 0, videoCount: 0, audioCount: 0 },
        });
        expect(screen.getByText("清晨厨房口播")).toBeInTheDocument();
    });

    it("shows only mode-relevant reference groups", () => {
        const inputs = [
            { nodeId: "img-1", type: "image" as const, title: "图片" },
            { nodeId: "vid-1", type: "video" as const, title: "视频" },
        ];
        const { view } = renderPanel(baseNode({ generationMode: "video" as const }), {
            inputs,
            inputSummary: { textCount: 0, imageCount: 1, videoCount: 1, audioCount: 0 },
        });
        expect(screen.getByText("参考图")).toBeInTheDocument();
        expect(screen.getByText("参考视频")).toBeInTheDocument();
        view.rerender(
            <I18nextProvider i18n={i18n}><AntApp>
                <CanvasConfigNodePanel node={baseNode({ generationMode: "text" as const })} inputs={inputs} inputSummary={{ textCount: 0, imageCount: 1, videoCount: 1, audioCount: 0 }} isRunning={false} onConfigChange={vi.fn()} onGenerate={vi.fn()} onStop={vi.fn()} onComposerToggle={vi.fn()} />
            </AntApp></I18nextProvider>,
        );
        expect(screen.queryByText("参考图")).not.toBeInTheDocument();
        expect(screen.queryByText("参考视频")).not.toBeInTheDocument();
    });

    it("marks nodes that override the global defaults", () => {
        renderPanel(baseNode({ quality: "high" }));
        expect(screen.getByTestId("config-override-dot")).toBeInTheDocument();
    });

    it("does not flag a freshly seeded node whose values equal the defaults", () => {
        renderPanel(baseNode({
            size: defaultConfig.size,
            quality: defaultConfig.quality,
            count: getGenerationCount(defaultConfig.canvasImageCount || defaultConfig.count),
        }));
        expect(screen.queryByTestId("config-override-dot")).not.toBeInTheDocument();
    });

    it("flags a video node whose explicit duration deviates from the default", () => {
        renderPanel(baseNode({ generationMode: "video" as const, seconds: "10" }));
        expect(screen.getByTestId("config-override-dot")).toBeInTheDocument();
    });

    it("prefers the first unsatisfied required workflow slot for the video reason", () => {
        const workflow = { media: [{ kind: "image", required: true }, { kind: "image", required: false }, { kind: "video", required: true }] };
        expect(missingReasonKey("video", workflow, { textCount: 0, imageCount: 0, videoCount: 0, audioCount: 0 })).toBe("canvas.configNode.missingSlotImage");
        expect(missingReasonKey("video", workflow, { textCount: 0, imageCount: 1, videoCount: 0, audioCount: 0 })).toBe("canvas.configNode.missingSlotVideo");
        expect(missingReasonKey("image", undefined, { textCount: 0, imageCount: 0, videoCount: 0, audioCount: 0 })).toBe("canvas.configNode.missingReason.image");
    });
});
