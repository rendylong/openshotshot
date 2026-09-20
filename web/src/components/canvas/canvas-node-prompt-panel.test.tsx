// web/src/components/canvas/canvas-node-prompt-panel.test.tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { defaultConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { CanvasNodePromptPanel } from "./canvas-node-prompt-panel";

const effective = vi.hoisted(() => ({ config: null as AiConfig | null }));
vi.mock("@/stores/use-config-store", async importOriginal => {
    const actual = await importOriginal<typeof import("@/stores/use-config-store")>();
    return { ...actual, useEffectiveConfig: () => effective.config || actual.defaultConfig };
});

const videoNode: CanvasNodeData = { id: "node", type: CanvasNodeType.Video, title: "Test", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { model: "chan::minimax-video", prompt: "Create", generationMode: "video" } };

function renderPanel() {
    return render(
        <I18nextProvider i18n={i18n}><AntApp>
            <CanvasNodePromptPanel node={videoNode} nodes={[]} isRunning={false} onConfigChange={vi.fn()} onGenerate={vi.fn()} onStop={vi.fn()} onPromptChange={vi.fn()} />
        </AntApp></I18nextProvider>,
    );
}

afterEach(() => {
    delete window.shotshot;
    useConfigStore.setState({ config: defaultConfig });
    effective.config = null;
});

describe("CanvasNodePromptPanel channel picker", () => {
    it("keeps the channel picker in BYOK mode", () => {
        useConfigStore.setState({ config: defaultConfig });
        const onConfigChange = vi.fn();
        render(
            <I18nextProvider i18n={i18n}><AntApp>
                <CanvasNodePromptPanel node={videoNode} nodes={[]} isRunning={false} onConfigChange={onConfigChange} onGenerate={vi.fn()} onStop={vi.fn()} onPromptChange={vi.fn()} />
            </AntApp></I18nextProvider>,
        );
        // 触发器/选项文本以实际渲染为准：节点引用的 chan::minimax-video 在默认渠道配置下
        // 经 resolveModelForCapability 回退为 default::grok-imagine-video，选项标签带渠道名后缀。
        expect(screen.getByText(/grok-imagine-video/)).toBeInTheDocument();
        fireEvent.click(screen.getByText(/grok-imagine-video/));
        fireEvent.click(screen.getByText(/grok-imagine-video（默认渠道）/));
        expect(onConfigChange).toHaveBeenCalledWith("node", { model: "default::grok-imagine-video" });
    });
});

describe("CanvasNodePromptPanel expand editor button", () => {
    it("pins the expand editor button to the panel top-right corner", () => {
        renderPanel();
        const button = screen.getByRole("button", { name: "放大编辑" });
        // 面板根的第一个子元素：不随底行/参考栏排布，恒定在右上角
        const panel = button.closest("[data-canvas-no-zoom]");
        expect(panel).not.toBeNull();
        expect(button.parentElement).toBe(panel);
        expect(button.previousElementSibling).toBeNull();
        expect(button.className).toContain("absolute");
        expect(button.className).toContain("top-2");
        expect(button.className).toContain("right-2");
    });

    it("opens the expanded editor modal from the corner button", async () => {
        renderPanel();
        fireEvent.click(screen.getByRole("button", { name: "放大编辑" }));
        expect(await screen.findByText("编辑提示词")).toBeInTheDocument();
    });
});
