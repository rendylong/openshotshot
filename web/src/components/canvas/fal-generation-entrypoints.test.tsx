import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { listFalProfiles } from "@/lib/models/fal/profiles";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { CanvasConfigNodePanel } from "./canvas-config-node-panel";
import { CanvasNodePromptPanel } from "./canvas-node-prompt-panel";
import { CanvasConfigComposer } from "./canvas-config-composer";
const effective = vi.hoisted(() => ({ config: null as AiConfig | null }));
vi.mock("@/stores/use-config-store", async importOriginal => {
    const actual = await importOriginal<typeof import("@/stores/use-config-store")>();
    return { ...actual, useEffectiveConfig: () => effective.config || actual.defaultConfig };
});
const kling = "fal-ai/kling-video/v3/pro/text-to-video";
const flux = "fal-ai/flux-2-pro";
const model = (endpoint: string) => `fal::${endpoint}`;
const nodeFor = (type: CanvasNodeData["type"], endpoint: string): CanvasNodeData => ({ id: "node", type, title: "Test", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { model: model(endpoint), prompt: "Create", generationMode: "video" } });
beforeEach(() => {
    void i18n.changeLanguage("zh-CN");
    effective.config = { ...defaultConfig, model: model(kling), imageModel: model(flux), videoModel: model(kling), channels: [{ id: "fal", name: "fal.ai", provider: "fal", baseUrl: "https://queue.fal.run", apiKey: "", apiFormat: "openai", models: listFalProfiles().map(profile => ({ name: profile.id, capability: profile.modality })) }] };
});
describe("three actual fal settings entrypoints", () => {
    it("config node opens profile controls and persists common audio", () => {
        const onConfigChange = vi.fn();
        render(<CanvasConfigNodePanel node={nodeFor(CanvasNodeType.Config, kling)} inputs={[]} inputSummary={{ textCount: 0, imageCount: 0, videoCount: 0, audioCount: 0 }} isRunning={false} onConfigChange={onConfigChange} onGenerate={vi.fn()} onStop={vi.fn()} onComposerToggle={vi.fn()} />);
        fireEvent.click(screen.getByRole("button", { name: "生成参数" }));
        fireEvent.click(screen.getByRole("switch", { name: "生成声音" }));
        expect(onConfigChange).toHaveBeenCalledWith("node", { generateAudio: "true" });
        expect(screen.queryByRole("button", { name: "480p" })).not.toBeInTheDocument();
        expect(screen.getByText("高级设置").closest("details")).not.toHaveAttribute("open");
        fireEvent.click(screen.getByText("高级设置"));
        fireEvent.change(screen.getByRole("spinbutton", { name: "提示词引导强度" }), { target: { value: "0.7" } });
        expect(onConfigChange).toHaveBeenCalledWith("node", expect.objectContaining({ providerOptions: expect.objectContaining({ version: 1 }) }));
    });
    it.each([CanvasNodeType.Image, CanvasNodeType.Video])("%s node exposes exact advanced params in its actual popover", type => {
        const endpoint = type === CanvasNodeType.Image ? flux : kling;
        const onConfigChange = vi.fn();
        render(<CanvasNodePromptPanel node={nodeFor(type, endpoint)} nodes={[]} isRunning={false} onConfigChange={onConfigChange} onGenerate={vi.fn()} onStop={vi.fn()} onPromptChange={vi.fn()} />);
        fireEvent.click(screen.getByRole("button", { name: /生成参数/ }));
        const field = type === CanvasNodeType.Image ? "随机种子" : "提示词引导强度";
        expect(screen.getByText("高级设置").closest("details")).not.toHaveAttribute("open");
        fireEvent.click(screen.getByText("高级设置"));
        fireEvent.change(screen.getByRole("spinbutton", { name: field }), { target: { value: type === CanvasNodeType.Image ? "17" : "0.8" } });
        expect(onConfigChange).toHaveBeenCalledWith("node", expect.objectContaining({ providerOptions: expect.objectContaining({ version: 1, models: expect.objectContaining({ [model(endpoint)]: expect.objectContaining({ profileId: endpoint }) }) }) }));
        expect(screen.queryByText("对齐 16 像素")).not.toBeInTheDocument();
    });
});
it("config composer displays required missing first frame before any submission", () => {
    const endpoint = "fal-ai/veo3.1/first-last-frame-to-video";
    render(<CanvasConfigComposer nodeId="config" nodes={[]} inputs={[]} value="Animate" falConfig={{ ...effective.config!, model: model(endpoint), size: "auto", vquality: "720p", videoSeconds: "8", videoGenerateAudio: "false" }} onChange={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("首帧 · 必需")).toBeInTheDocument();
    expect(screen.getByText("尾帧 · 必需")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("fal_missing_reference");
});
