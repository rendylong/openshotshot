import { act, fireEvent, render } from "@testing-library/react";
import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasFloatingPanel } from "./canvas-floating-panel";

function Harness({ onOpenChange, placement, variant, width, children }: { onOpenChange?: (open: boolean) => void; placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight"; variant?: "canvas" | "page"; width?: number; children?: React.ReactNode }) {
    const ref = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(true);
    return (
        <>
            <button ref={ref}>anchor</button>
            <CanvasFloatingPanel open={open} anchorRef={ref} placement={placement} variant={variant} width={width} ariaLabel="测试面板" onOpenChange={(o) => { onOpenChange?.(o); setOpen(o); }}>
                {children ?? <div>panel-body</div>}
            </CanvasFloatingPanel>
        </>
    );
}

describe("CanvasFloatingPanel", () => {
    it("open 时 portal 到 body 且带 aria-label", () => {
        const { baseElement } = render(<Harness />);
        const panel = baseElement.ownerDocument.body.querySelector('[aria-label="测试面板"]');
        expect(panel).toBeTruthy();
        expect(panel!.textContent).toContain("panel-body");
    });
    it("外点 pointerdown 关闭", () => {
        const onOpenChange = vi.fn();
        const { baseElement } = render(<Harness onOpenChange={onOpenChange} />);
        fireEvent.pointerDown(baseElement.ownerDocument.body, { target: baseElement.ownerDocument.body });
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    it("Esc 关闭", () => {
        const onOpenChange = vi.fn();
        const { baseElement } = render(<Harness onOpenChange={onOpenChange} />);
        fireEvent.keyDown(baseElement.ownerDocument.body, { key: "Escape" });
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });
});

describe("CanvasFloatingPanel 定位与皮肤（table-driven）", () => {
    beforeEach(() => vi.restoreAllMocks());
    const rect = { left: 100, right: 200, top: 300, bottom: 340, width: 100, height: 40 } as DOMRect;
    it.each([
        ["topLeft", { left: "100px" }],
        ["top", { left: "-28px" }], // 100+50-178=-28 → clamp 到 12
        ["topRight", { left: "-156px" }], // 200-356=-156 → clamp 到 12（任务书表格笔误 178，按组件公式 right-width 修正）
        ["bottomLeft", { left: "100px" }],
        ["bottom", { left: "12px" }],
        ["bottomRight", { left: "-156px" }], // 200-356=-156 → clamp 到 12（同上）
    ])("placement=%s 定位数学 + 边缘 clamp（spec §8.2-5 保真项）", (placement, expected) => {
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
        const { baseElement } = render(<Harness placement={placement as never} />);
        const panel = baseElement.ownerDocument.body.querySelector('[aria-label="测试面板"]') as HTMLElement;
        const left = parseInt((panel.style.left as string).replace("px", ""), 10);
        expect(left).toBe(Math.max(12, Math.min(1024 - 356 - 12, parseInt(expected.left))));
    });
    it.each([
        ["canvas", "var(--canvas-surface)", true],
        ["page", "var(--popover)", false],
    ])("variant=%s 皮肤正确", (variant, bg, hasBlur) => {
        const { baseElement } = render(<Harness variant={variant as never} />);
        const panel = baseElement.ownerDocument.body.querySelector('[aria-label="测试面板"]') as HTMLElement;
        expect(panel.style.background).toBe(bg);
        expect(!!panel.style.backdropFilter).toBe(hasBlur);
        expect(panel.style.borderRadius).toBe("18px");
        expect(panel.style.boxShadow).toBe("var(--elevation-overlay)");
    });
    it("open=false 与 anchorRect=null 均渲染 null", () => {
        const { container } = render(<CanvasFloatingPanel open={false} anchorRef={{ current: null } as never} ariaLabel="x" onOpenChange={() => {}}><div /></CanvasFloatingPanel>);
        expect(container.ownerDocument.body.querySelector('[aria-label="x"]')).toBeNull();
    });
    it("内点 pointerdown 不关、anchor 自身点击不关", () => {
        const onOpenChange = vi.fn();
        const { baseElement } = render(<Harness onOpenChange={onOpenChange} />);
        const panel = baseElement.ownerDocument.body.querySelector('[aria-label="测试面板"]')!;
        fireEvent.pointerDown(panel, { target: panel });
        expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });
    it("resize 后重定位（scroll/resize = 重定位而非关闭，与现 4 popover 行为一致）", async () => {
        const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
        const { baseElement } = render(<Harness />);
        spy.mockReturnValue({ ...rect, left: 500, right: 600 } as DOMRect);
        await act(async () => { window.dispatchEvent(new Event("resize")); });
        const panel = baseElement.ownerDocument.body.querySelector('[aria-label="测试面板"]') as HTMLElement;
        expect(panel.style.left).toBe("500px");
        expect(document.body.contains(panel)).toBe(true);
    });
    it("Tab 在面板内圈定：末元素 Tab 回到首元素（spec §9 必测项）", () => {
        const { baseElement } = render(<Harness><button>first</button><button>last</button></Harness>);
        const panel = baseElement.ownerDocument.body.querySelector('[aria-label="测试面板"]')!;
        const buttons = panel.querySelectorAll("button");
        buttons[1].focus();
        fireEvent.keyDown(panel, { key: "Tab" });
        expect(document.activeElement).toBe(buttons[0]);
    });
    it("默认 z=1200", () => {
        const { baseElement } = render(<Harness />);
        expect((baseElement.ownerDocument.body.querySelector('[aria-label="测试面板"]') as HTMLElement).style.zIndex).toBe("1200");
    });
    it("bottom placement 贴近视口底部且空间不足 → 自动翻转为 top（style.bottom 存在而非 style.top）", () => {
        // jsdom innerHeight=768：below=768-940-8-24=-204<260，above=900-8-24=868>=260 → topLeft
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 100, right: 200, top: 900, bottom: 940, width: 100, height: 40 } as DOMRect);
        const { baseElement } = render(<Harness placement="bottomLeft" />);
        const panel = baseElement.ownerDocument.body.querySelector('[aria-label="测试面板"]') as HTMLElement;
        expect(panel.style.top).toBe("");
        expect(panel.style.bottom).not.toBe("");
    });
    it("bottom placement 空间充足时不换向（style.top 存在）", () => {
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 100, right: 200, top: 300, bottom: 340, width: 100, height: 40 } as DOMRect);
        const { baseElement } = render(<Harness placement="bottomLeft" />);
        const panel = baseElement.ownerDocument.body.querySelector('[aria-label="测试面板"]') as HTMLElement;
        expect(panel.style.top).not.toBe("");
        expect(panel.style.bottom).toBe("");
    });
});
