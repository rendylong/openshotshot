import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CanvasPromptChipInput } from "./canvas-prompt-chip-input";

const assetCandidates = [{ assetId: "a1", kind: "image" as const, title: "唐剑", coverUrl: "blob:cover-a1" }];

describe("CanvasPromptChipInput asset mentions", () => {
    it("renders an asset chip for an @[asset:id] token", () => {
        const { container } = render(<CanvasPromptChipInput value="特写 @[asset:a1]" references={[]} assetCandidates={assetCandidates} onChange={vi.fn()} />);
        const chip = container.querySelector('[data-asset-id="a1"]');
        expect(chip).not.toBeNull();
        expect(chip?.querySelector("img")?.getAttribute("src")).toBe("blob:cover-a1");
        expect(chip?.textContent).toContain("唐剑");
    });

    it("renders a dashed unknown-asset chip for a dangling token", () => {
        const { container } = render(<CanvasPromptChipInput value="@[asset:gone]" references={[]} assetCandidates={assetCandidates} onChange={vi.fn()} />);
        const chip = container.querySelector('[data-asset-id="gone"]');
        expect(chip).not.toBeNull();
        expect(chip?.className).toContain("border-dashed");
    });

    it("serializes an inserted asset chip back to its token", () => {
        const onChange = vi.fn();
        const { container } = render(<CanvasPromptChipInput value="开头" references={[]} assetCandidates={assetCandidates} onChange={onChange} />);
        const editor = container.querySelector("[contenteditable='true']") as HTMLElement;
        const chip = document.createElement("span");
        chip.contentEditable = "false";
        chip.dataset.assetId = "a1";
        editor.appendChild(chip);
        fireEvent.input(editor);
        expect(onChange).toHaveBeenLastCalledWith("开头@[asset:a1]");
    });

    // linchpin：node chip 序列化必须还原为 label 文本（@ 是普通文本、chip 按 label 匹配），不得变成 @[node:id] token
    it("keeps node chip serialization as label text (never a node token)", () => {
        const onChange = vi.fn();
        const references = [{ id: "n1", nodeId: "n1", kind: "image" as const, label: "图片1", title: "分镜图", previewUrl: "blob:ref", active: true }];
        const { container } = render(<CanvasPromptChipInput value="@图片1" references={references} assetCandidates={[]} onChange={onChange} />);
        expect(container.querySelector('[data-ref-label="图片1"]')).not.toBeNull();
        fireEvent.input(container.querySelector("[contenteditable='true']") as HTMLElement);
        expect(onChange).toHaveBeenLastCalledWith("@图片1");
    });
});
