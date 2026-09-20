import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { getFalProfile } from "@/lib/models/fal/profiles";
import { FalGenerationMedia, FalGenerationSettings } from "./fal-generation-settings";

function configFor(endpoint: string, patch: Partial<AiConfig> = {}): AiConfig {
    return { ...defaultConfig, model: `fal::${endpoint}`, size: "", quality: "", vquality: "", videoSeconds: "", videoGenerateAudio: "", channels: [{ id: "fal", name: "fal.ai", provider: "fal", baseUrl: "https://queue.fal.run", apiKey: "", apiFormat: "openai", models: [{ name: endpoint, capability: "video" }] }], ...patch };
}
describe("fal generation controls", () => {
    beforeEach(() => { void i18n.changeLanguage("zh-CN"); });
    it("shows Kling default five seconds and disabled audio, writing common audio", () => {
        const profile = getFalProfile("fal-ai/kling-video/v3/pro/text-to-video")!;
        const onChange = vi.fn();
        render(<FalGenerationSettings profile={profile} config={configFor(profile.id)} onChange={onChange} />);
        expect(screen.getByText("5")).toBeInTheDocument();
        const toggle = screen.getByRole("switch", { name: "生成声音" });
        expect(toggle).toHaveAttribute("aria-checked", "false");
        fireEvent.click(toggle);
        expect(onChange).toHaveBeenCalledWith({ generateAudio: "true" });
    });
    it("shows separate Veo first and last frame requirements and converts seconds", () => {
        const profile = getFalProfile("fal-ai/veo3.1/first-last-frame-to-video")!;
        const onChange = vi.fn();
        render(<FalGenerationSettings profile={profile} config={configFor(profile.id)} onChange={onChange} />);
        expect(screen.getByText(/首帧/)).toBeInTheDocument();
        expect(screen.getByText(/尾帧/)).toBeInTheDocument();
        fireEvent.mouseDown(screen.getByRole("combobox", { name: "时长" }));
        fireEvent.click(screen.getAllByText("6s").at(-1)!);
        expect(onChange).toHaveBeenCalledWith({ seconds: "6" });
    });
    it("has no invented Hailuo resolution control", () => {
        const profile = getFalProfile("fal-ai/minimax/hailuo-2.3/pro/image-to-video")!;
        render(<FalGenerationSettings profile={profile} config={configFor(profile.id)} onChange={vi.fn()} />);
        expect(screen.queryByRole("combobox", { name: "分辨率" })).not.toBeInTheDocument();
    });
    it("keeps invalid stored duration visible and does not mutate it on mount", () => {
        const profile = getFalProfile("fal-ai/kling-video/v3/pro/text-to-video")!;
        const onChange = vi.fn();
        render(<FalGenerationSettings profile={profile} config={configFor(profile.id, { videoSeconds: "900" })} onChange={onChange} />);
        expect(screen.getByText("900")).toBeInTheDocument();
        expect(screen.getByRole("alert")).toHaveTextContent("fal.ai 生成参数无效");
        expect(onChange).not.toHaveBeenCalled();
    });
    it("stores native advanced numbers in model indexed provider options", () => {
        const profile = getFalProfile("fal-ai/kling-video/v3/pro/text-to-video")!;
        const onChange = vi.fn();
        render(<FalGenerationSettings profile={profile} config={configFor(profile.id)} onChange={onChange} />);
        expect(screen.getByText("高级设置").closest("details")).not.toHaveAttribute("open");
        fireEvent.click(screen.getByText("高级设置"));
        fireEvent.change(screen.getByRole("spinbutton", { name: "提示词引导强度" }), { target: { value: "0.7" } });
        expect(onChange).toHaveBeenCalledWith({ providerOptions: { version: 1, models: { [`fal::${profile.id}`]: { provider: "fal", profileId: profile.id, profileVersion: 1, params: { cfg_scale: 0.7 } } } } });
    });
});

// The actual item identity and strict order also drive the thumbnail preview.

it("previews exact source items before deduplicated composer references", async () => {
    const profile = getFalProfile("fal-ai/flux-2-pro/edit")!;
    const source = { id: "source:item-a", name: "A", type: "image/png", dataUrl: "https://example.com/a.png" };
    const upstream = { id: "upstream:item-b", name: "B", type: "image/png", dataUrl: "https://example.com/b.png" };
    render(<FalGenerationMedia profile={profile} config={configFor(profile.id)} prompt="Use @[node:b] twice @[node:b]" inputs={[{ nodeId: "b", type: "image", title: "Batch", images: [upstream] }]} sourceImages={[source]} />);
    expect(await screen.findByRole("img", { name: "参考图 1 · A" })).toHaveAttribute("src", source.dataUrl);
    expect(await screen.findByRole("img", { name: "参考图 2 · B" })).toHaveAttribute("src", upstream.dataUrl);
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(screen.getByText("Use 图片2 twice 图片2")).toBeInTheDocument();
});
it("shows missing first/last and extra materials before generation", () => {
    const profile = getFalProfile("fal-ai/veo3.1/first-last-frame-to-video")!;
    const props = { profile, config: configFor(profile.id), prompt: "Animate", inputs: [] };
    const { rerender } = render(<FalGenerationMedia {...props} />);
    expect(screen.getByRole("alert")).toHaveTextContent("fal_missing_reference");
    expect(screen.getAllByText("未添加")).toHaveLength(2);
    rerender(<FalGenerationMedia {...props} sourceImages={[1, 2, 3].map(id => ({ id: String(id), name: String(id), type: "image/png", dataUrl: `https://example.com/${id}.png` }))} />);
    expect(screen.getByRole("alert")).toHaveTextContent("fal_extra_references");
    expect(screen.getByText(/额外素材 3/)).toBeInTheDocument();
});

const mentionAsset: Asset = { id: "a1", kind: "image", title: "唐剑", coverUrl: "blob:cover-a1", tags: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", data: { dataUrl: "data:image/png;base64,A1", width: 8, height: 8, bytes: 8, mimeType: "image/png" } };

it("previews asset mention references appended after connection references", async () => {
    useAssetStore.setState({ assets: [mentionAsset] });
    const profile = getFalProfile("fal-ai/veo3.1/first-last-frame-to-video")!;
    render(
        <FalGenerationMedia
            profile={profile}
            config={configFor(profile.id)}
            prompt="Shot @[asset:a1]"
            inputs={[{ nodeId: "n1", type: "image", title: "首帧来源", image: { id: "n1", name: "first.png", type: "image/png", dataUrl: "https://example.com/first.png" } }]}
        />,
    );
    expect(await screen.findByRole("img", { name: "首帧 · first.png" })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "尾帧 · 唐剑.png" })).toBeInTheDocument();
    expect(screen.getByText(/Shot 图片2/)).toBeInTheDocument();
    useAssetStore.setState({ assets: [] });
});
