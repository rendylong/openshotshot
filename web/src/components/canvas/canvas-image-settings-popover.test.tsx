import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";

const config = { quality: "auto", size: "auto", count: "1" } as never;

function renderPopover(onOpenChange = vi.fn()) {
    const utils = render(<CanvasImageSettingsPopover config={config} onConfigChange={() => {}} onOpenChange={onOpenChange} />);
    return { onOpenChange, trigger: utils.getByRole("button"), ...utils };
}

describe("CanvasImageSettingsPopover（收敛后的 shell 回归）", () => {
    it("点触发按钮 → panel 出现且 onOpenChange(true)（updateOpen 双写正向）", () => {
        const { trigger, onOpenChange, baseElement } = renderPopover();
        fireEvent.click(trigger);
        expect(onOpenChange).toHaveBeenCalledWith(true);
        expect(baseElement.ownerDocument.body.querySelector('[role="dialog"]')).toBeTruthy();
    });
    it("再点触发按钮 → 关闭且 onOpenChange(false)（双写负向：漏一半即父级状态漂移）", () => {
        const { trigger, onOpenChange } = renderPopover();
        fireEvent.click(trigger);
        fireEvent.click(trigger);
        expect(onOpenChange).toHaveBeenLastCalledWith(false);
    });
    it("panel 内 pointerdown 不关、外点关闭且 onOpenChange(false)", () => {
        const { onOpenChange, baseElement, trigger } = renderPopover();
        fireEvent.click(trigger);
        const panel = baseElement.ownerDocument.body.querySelector('[role="dialog"]')!;
        fireEvent.pointerDown(panel, { target: panel });
        expect(onOpenChange).not.toHaveBeenLastCalledWith(false);
        fireEvent.pointerDown(baseElement.ownerDocument.body, { target: baseElement.ownerDocument.body });
        expect(onOpenChange).toHaveBeenLastCalledWith(false);
    });
});
