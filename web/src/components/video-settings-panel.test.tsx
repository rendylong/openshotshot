import { fireEvent, render, screen } from "@testing-library/react";
import { message } from "antd";
import { useState, type ComponentProps } from "react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import { AUTODL_WORKFLOWS } from "@/lib/models/autodl-workflows";
import { defaultConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { CanvasNodePromptPanel } from "./canvas/canvas-node-prompt-panel";
import { CanvasConfigNodePanel } from "./canvas/canvas-config-node-panel";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { VideoSettingsPanel, videoModelSelectionPatch, videoResolutionLabel } from "./video-settings-panel";

const effective = vi.hoisted(() => ({ config: null as AiConfig | null }));
vi.mock("@/stores/use-config-store", async importOriginal => {
    const actual = await importOriginal<typeof import("@/stores/use-config-store")>();
    return { ...actual, useEffectiveConfig: () => effective.config || actual.defaultConfig };
});

function configFor(model: string, patch: Partial<AiConfig> = {}): AiConfig {
    return { ...defaultConfig, model, vquality: "736p竖", videoSeconds: "5", channels: [{ id: "autodl", name: "AutoDL", provider: "autodl", baseUrl: "https://autodl.art", apiKey: "", apiFormat: "openai", models: AUTODL_WORKFLOWS.map(workflow => ({ name: workflow.id, capability: "video" })) }], ...patch };
}

describe("AutoDL video settings", () => {
    beforeEach(() => { void i18n.changeLanguage("en-US"); });
    it("offers only the exact 736p enum and saves its complete value", () => {
        const onConfigChange = vi.fn();
        render(<VideoSettingsPanel config={configFor("minimax_h3_b99_001")} theme={canvasThemes.light} onConfigChange={onConfigChange} />);
        expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["736p竖", "736p横", "736p(1:1)", "5s", "10s", "15s", "Custom"]);
        expect(screen.queryByRole("spinbutton")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "736p横" }));
        expect(onConfigChange).toHaveBeenCalledWith("vquality", "736p横");
    });
    it("changes duration limits with the workflow and removes duration for motion retargeting", () => {
        const { rerender } = render(<VideoSettingsPanel config={configFor("minimax_h3_lightx2v_v5_15s")} theme={canvasThemes.dark} onConfigChange={vi.fn()} />);
        fireEvent.click(screen.getByRole("button", { name: "Custom" }));
        expect(screen.getByRole("spinbutton")).toHaveAttribute("max", "15");
        rerender(<VideoSettingsPanel config={configFor("minimax_h3_lightx2v_v5")} theme={canvasThemes.dark} onConfigChange={vi.fn()} />);
        expect(screen.getByRole("spinbutton")).toHaveAttribute("max", "10");
        rerender(<VideoSettingsPanel config={configFor("wan2.2animate-v4-motion_retargeting")} theme={canvasThemes.dark} onConfigChange={vi.fn()} />);
        expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
        expect(screen.getByText(/Prompt text is not submitted/)).toBeInTheDocument();
        expect(screen.getByText("Video 1 · Required")).toBeInTheDocument();
    });
    it("reports loaded invalid settings without silently saving defaults", () => {
        const onConfigChange = vi.fn();
        const { rerender } = render(<VideoSettingsPanel config={configFor("minimax_h3_b99_001", { vquality: "720" })} theme={canvasThemes.light} onConfigChange={onConfigChange} />);
        expect(screen.getByRole("alert")).toHaveTextContent("Choose a resolution supported by this workflow.");
        rerender(<VideoSettingsPanel config={configFor("minimax_h3_b99_001", { videoSeconds: "20" })} theme={canvasThemes.light} onConfigChange={onConfigChange} />);
        expect(screen.getByRole("alert")).toHaveTextContent("1–15");
        expect(screen.getByRole("button", { name: "Custom 20s" })).toBeInTheDocument();
        expect(onConfigChange).not.toHaveBeenCalled();
    });
    it("preserves compatible settings and resets invalid values only on explicit selection", () => {
        const config = configFor("minimax_h3_lightx2v_v5_15s", { vquality: "768p横", videoSeconds: "12" });
        expect(videoModelSelectionPatch(config, "minimax_h3_lightx2v_v5_15s")).toEqual({ model: "minimax_h3_lightx2v_v5_15s", vquality: "768p横", seconds: "12" });
        expect(videoModelSelectionPatch(config, "minimax_h3_lightx2v_v5")).toEqual({ model: "minimax_h3_lightx2v_v5", vquality: "768p横", seconds: "5" });
        expect(videoModelSelectionPatch(config, "minimax_h3_b99_001")).toEqual({ model: "minimax_h3_b99_001", vquality: "736p竖", seconds: "12" });
    });
    it("preserves full summary labels and retains generic controls for other providers", () => {
        expect(videoResolutionLabel("768p横")).toBe("768p横");
        expect(videoResolutionLabel("736p(1:1)")).toBe("736p(1:1)");
        expect(videoResolutionLabel("832*464px(横版)")).toBe("832*464px(横版)");
        expect(videoResolutionLabel("720p")).toBe("720p");
        render(<VideoSettingsPanel config={defaultConfig} theme={canvasThemes.light} onConfigChange={vi.fn()} />);
        expect(screen.getByRole("button", { name: "720p" })).toBeInTheDocument();
        expect(screen.queryByRole("spinbutton")).toBeNull();
    });
});


describe("AutoDL node generation controls", () => {
    beforeEach(() => {
        void i18n.changeLanguage("en-US");
        effective.config = configFor("minimax_h3_image_audio_to_video", { vquality: "768p竖" });
    });
    const node: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "Video", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { model: "autodl::minimax_h3_image_audio_to_video", prompt: "", generationMode: "video" } };
    it("submits a lip-sync request from the ordinary node with empty prompt", () => {
        const onGenerate = vi.fn();
        render(<CanvasNodePromptPanel node={node} nodes={[node]} isRunning={false} onPromptChange={vi.fn()} onConfigChange={vi.fn()} onGenerate={onGenerate} onStop={vi.fn()} />);
        const generate = screen.getByRole("button", { name: "Generate" });
        expect(generate).toBeEnabled();
        fireEvent.click(generate);
        expect(onGenerate).toHaveBeenCalledWith("video", "video", "");
        expect(screen.getByText(/Prompt text is not submitted/)).toBeInTheDocument();
    });
    it("requires actual image and audio inputs for empty-prompt configuration-node generation", () => {
        const props = { node: { ...node, type: CanvasNodeType.Config }, inputs: [], isRunning: false, onConfigChange: vi.fn(), onGenerate: vi.fn(), onStop: vi.fn(), onComposerToggle: vi.fn() };
        const { rerender } = render(<CanvasConfigNodePanel {...props} inputSummary={{ textCount: 0, imageCount: 1, audioCount: 0, videoCount: 0 }} />);
        expect(screen.getByRole("button", { name: "Generate video" })).toBeDisabled();
        rerender(<CanvasConfigNodePanel {...props} inputSummary={{ textCount: 0, imageCount: 1, audioCount: 1, videoCount: 0 }} />);
        fireEvent.click(screen.getByRole("button", { name: "Generate video" }));
        expect(props.onGenerate).toHaveBeenCalledWith("video");
    });
});

/** 面板是受控组件：自定义秒数用例需要 onConfigChange 真正回写 config，才能驱动 QuickPillRow 呈现新值。 */
function RefactorHarness({ initialConfig, isOverridden, onConfigChange, onResetOverrides }: {
    initialConfig: AiConfig;
    isOverridden: boolean;
    onConfigChange: ComponentProps<typeof VideoSettingsPanel>["onConfigChange"];
    onResetOverrides: () => void;
}) {
    const [config, setConfig] = useState(initialConfig);
    return (
        <I18nextProvider i18n={i18n}>
            <VideoSettingsPanel
                config={config}
                theme={canvasThemes.light}
                isOverridden={isOverridden}
                onResetOverrides={onResetOverrides}
                onConfigChange={(key, value) => {
                    setConfig((current) => ({ ...current, [key]: value }));
                    onConfigChange(key, value);
                }}
            />
        </I18nextProvider>
    );
}

describe("VideoSettingsPanel 重构（D9/D12/D20）", () => {
    beforeEach(() => {
        void i18n.changeLanguage("zh-CN");
        useConfigStore.setState({ config: { ...defaultConfig } });
    });
    function renderPanel(configOverrides: Partial<AiConfig> = {}, onConfigChange: ComponentProps<typeof VideoSettingsPanel>["onConfigChange"] = vi.fn()) {
        return render(
            <RefactorHarness
                initialConfig={{ ...defaultConfig, ...configOverrides } as AiConfig}
                isOverridden
                onConfigChange={onConfigChange}
                onResetOverrides={vi.fn()}
            />,
        );
    }
    it("顺序：画幅 → 画质 → 时长", () => {
        renderPanel();
        const labels = screen.getAllByText(/^(比例|清晰度|秒数)$/).map((el) => el.textContent);
        expect(labels.indexOf("比例")).toBeLessThan(labels.indexOf("清晰度"));
        expect(labels.indexOf("清晰度")).toBeLessThan(labels.indexOf("秒数"));
    });
    it("画幅 tile 无形状图标，只留名称+像素", () => {
        renderPanel();
        const tile = screen.getByText("横屏").closest("button")!;
        expect(tile.querySelector("svg")).toBeNull();
        expect(tile.textContent).toContain("1280×720");
    });
    it("时长行有「自定义」按钮；点击变输入框提交", () => {
        renderPanel();
        fireEvent.click(screen.getByText("自定义"));
        fireEvent.change(screen.getByDisplayValue("6"), { target: { value: "8" } });
        fireEvent.blur(screen.getByDisplayValue("8"));
        expect(screen.getByText("自定义 8s")).toBeTruthy();
    });
    it("footer：设为默认写入 vquality", () => {
        const spy = vi.spyOn(useConfigStore.getState(), "updateConfig");
        renderPanel({ vquality: "480" });
        fireEvent.click(screen.getByRole("button", { name: /设为默认/ }));
        expect(spy.mock.calls).toContainEqual(["vquality", "480"]);
        spy.mockRestore();
    });
});
