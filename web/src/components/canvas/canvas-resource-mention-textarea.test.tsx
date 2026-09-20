import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

import { CanvasPromptChipInput } from "./canvas-prompt-chip-input";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";

const reference = { id: "r1", nodeId: "n1", kind: "image", label: "海报.png", title: "海报.png", active: true } as CanvasResourceReference;

describe("mention 下拉（收敛到 CanvasFloatingPanel 后）", () => {
    it("输入 @ 出现候选 → 点击候选 → 插入回调触发且面板关闭", async () => {
        const onChange = vi.fn();
        const { baseElement } = render(<CanvasResourceMentionTextarea value="" onChange={onChange} references={[reference]} />);
        const input = screen.getByRole("textbox");
        fireEvent.change(input, { target: { value: "@" } });
        await waitFor(() => expect(baseElement.ownerDocument.body.querySelector('[role="dialog"]')).toBeTruthy());
        fireEvent.click(baseElement.ownerDocument.body.querySelector('[role="dialog"] button')!);
        await waitFor(() => expect(baseElement.ownerDocument.body.querySelector('[role="dialog"]')).toBeNull());
        expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining("海报.png"));
    });
});

describe("CanvasPromptChipInput 渲染冒烟", () => {
    it("渲染 contentEditable 输入框", () => {
        render(<CanvasPromptChipInput value="" references={[reference]} onChange={() => {}} />);
        expect(screen.getByRole("textbox")).toBeTruthy();
    });
});
