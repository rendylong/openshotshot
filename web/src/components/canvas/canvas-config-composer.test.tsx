import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { CanvasConfigComposer } from "./canvas-config-composer";
import type { NodeGenerationInput } from "./canvas-node-generation";

const image = (id: string, title: string): NodeGenerationInput => ({ nodeId: id, type: "image", title, image: { id, name: `${id}.png`, type: "image/png", dataUrl: `data:image/png;base64,${id}` } });
const inputs: NodeGenerationInput[] = [{ nodeId: "group", type: "group", title: "Frames", children: [image("first", "Opening shot"), image("last", "Closing shot")] } as NodeGenerationInput];
function composer(value: string, workflowId = "minimax_h3_b99_002", references = inputs, composerMode = true) {
    return <CanvasConfigComposer nodeId="config" nodes={[]} value={value} inputs={references} workflowId={workflowId} composerMode={composerMode} onChange={vi.fn()} onClose={vi.fn()} />;
}

describe("AutoDL input preview", () => {
    beforeEach(() => { void i18n.changeLanguage("en-US"); });
    it("expands groups in order and shows readable first/last roles with the compiled prompt", () => {
        render(composer("Pan between @[node:group]"));
        expect(screen.getByText("Preview final prompt and reference order")).toBeInTheDocument();
        expect(screen.getByText("First frame ← Opening shot")).toBeInTheDocument();
        expect(screen.getByText("Last frame ← Closing shot")).toBeInTheDocument();
        expect(screen.getByText(/Pan between.*Image 1.*Image 2/)).toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    it("shows errors for missing token targets and missing required media", () => {
        const { rerender } = render(composer("@[node:deleted]"));
        expect(screen.getByRole("alert")).toHaveTextContent(/deleted/);
        rerender(composer("Animate", "minimax_h3_b99_002", []));
        expect(screen.getByRole("alert")).toHaveTextContent("first_frame");
    });
    it("shows no prompt for lip sync and binds connected image/audio with empty prompt", () => {
        const references: NodeGenerationInput[] = [image("portrait", "Portrait"), { nodeId: "speech", type: "audio", title: "Speech", audio: { id: "speech", name: "speech.mp3", type: "audio/mpeg", url: "https://example.test/speech.mp3" } }];
        render(composer("", "minimax_h3_image_audio_to_video", references, false));
        expect(screen.getByText(/Prompt text is not submitted/)).toBeInTheDocument();
        expect(screen.getByText("Image 1 ← Portrait")).toBeInTheDocument();
        expect(screen.getByText("Audio 1 ← Speech")).toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    it("leaves generic composer use unchanged", () => {
        render(<CanvasConfigComposer nodeId="config" nodes={[]} value="Prompt" inputs={[]} onChange={vi.fn()} onClose={vi.fn()} />);
        expect(screen.queryByText("Preview final prompt and reference order")).not.toBeInTheDocument();
    });
});

const assetFixture: Asset = { id: "a1", kind: "image", title: "唐剑", coverUrl: "blob:cover-a1", tags: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", data: { dataUrl: "data:image/png;base64,A1", width: 8, height: 8, bytes: 8, mimeType: "image/png" } };

describe("Config composer asset mentions", () => {
    beforeEach(() => {
        void i18n.changeLanguage("en-US");
        useAssetStore.setState({ assets: [assetFixture] });
    });
    it("mixes asset tokens with node tokens in prompt word order in the compiled preview", () => {
        render(composer("@[asset:a1] then @[node:first]", "minimax_h3_b99_002", inputs, true));
        expect(screen.getByText(/Image 1 then Image 2/)).toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    it("renders an asset chip for a stored asset token", () => {
        const { container } = render(composer("start @[asset:a1]"));
        expect(container.querySelector('[data-asset-id="a1"]')).not.toBeNull();
    });
    it("reports a missing asset token as an error", () => {
        render(composer("@[asset:gone]"));
        expect(screen.getByRole("alert")).toHaveTextContent(/gone/);
    });
    it("opens the asset group in the mention menu when no canvas inputs are connected", () => {
        const { container } = render(composer("@", "minimax_h3_b99_002", [], true));
        const editor = container.querySelector('[contenteditable="true"]') as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        fireEvent.input(editor);
        expect(screen.getByText("My assets")).toBeInTheDocument();
    });
});
