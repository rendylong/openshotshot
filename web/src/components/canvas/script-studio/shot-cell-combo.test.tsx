import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { ShotCellCombo } from "./shot-cell-combo";

const OPTIONS = ["固定", "推镜", "拉镜", "摇镜", "移镜", "跟镜"];

const renderCombo = (value = "") => {
    const onChange = vi.fn();
    render(<ShotCellCombo value={value} options={OPTIONS} placeholder="—" ariaLabel="运镜" onChange={onChange} />);
    return onChange;
};

const input = () => screen.getByRole("combobox", { name: "运镜" }) as HTMLInputElement;
const popup = () => document.querySelector(".script-cell-combo-popup");

const clickChevron = () => fireEvent.click(document.querySelector("button")!);

describe("ShotCellCombo", () => {
    it("默认收起；键入有匹配时展开并过滤", () => {
        const onChange = renderCombo();
        expect(popup()).toBeNull();
        fireEvent.change(input(), { target: { value: "推" } });
        expect(onChange).toHaveBeenCalledWith("推");
        expect(popup()).not.toBeNull();
        expect(popup()!.textContent).toContain("推镜");
        expect(popup()!.textContent).not.toContain("固定");
        expect(input().getAttribute("aria-expanded")).toBe("true");
    });

    it("越界现值 focus 不弹层；点 chevron 强制展开全量列表", () => {
        renderCombo("环绕");
        expect(popup()).toBeNull();
        clickChevron();
        expect(popup()).not.toBeNull();
        expect(popup()!.textContent).toContain("固定");
        expect(popup()!.textContent).toContain("拉镜");
        // 再点收起（toggle）
        clickChevron();
        expect(popup()).toBeNull();
    });

    it("收起态 ↓ 展开全量并高亮首项，Enter 提交高亮项", () => {
        const onChange = renderCombo();
        fireEvent.keyDown(input(), { key: "ArrowDown" });
        expect(popup()).not.toBeNull();
        expect(input().getAttribute("aria-activedescendant")).toContain("opt-0");
        fireEvent.keyDown(input(), { key: "Enter" });
        expect(onChange).toHaveBeenLastCalledWith("固定");
        expect(popup()).toBeNull();
    });

    it("展开中键入至零匹配立即收起；↑ 高亮末项", () => {
        const onChange = renderCombo();
        fireEvent.keyDown(input(), { key: "ArrowDown" });
        fireEvent.change(input(), { target: { value: "不存在的运镜" } });
        expect(onChange).toHaveBeenCalledWith("不存在的运镜");
        expect(popup()).toBeNull();
        // 再按 ↑：值无匹配 → 全量展开且高亮末项（跟镜）
        fireEvent.keyDown(input(), { key: "ArrowUp" });
        expect(popup()!.textContent).toContain("跟镜");
        fireEvent.keyDown(input(), { key: "Enter" });
        expect(onChange).toHaveBeenLastCalledWith("跟镜");
    });

    it("点击选项写入并收起（mousedown 提交）", () => {
        const onChange = renderCombo();
        clickChevron();
        const items = document.querySelectorAll(".script-cell-combo-popup .ep-item");
        expect(items.length).toBe(OPTIONS.length);
        fireEvent.mouseDown(items[1]!);
        expect(onChange).toHaveBeenLastCalledWith("推镜");
        expect(popup()).toBeNull();
    });

    it("Esc 收起且不回滚已提交的值；失焦收起", () => {
        const onChange = renderCombo();
        fireEvent.change(input(), { target: { value: "推镜" } });
        fireEvent.keyDown(input(), { key: "Escape" });
        expect(popup()).toBeNull();
        expect(onChange).toHaveBeenLastCalledWith("推镜");
        // 重新展开后失焦同样收起
        fireEvent.keyDown(input(), { key: "ArrowDown" });
        expect(popup()).not.toBeNull();
        fireEvent.blur(input());
        expect(popup()).toBeNull();
    });

    it("展开中窗口滚动/resize 收起（防浮层脱锚）", () => {
        renderCombo();
        fireEvent.keyDown(input(), { key: "ArrowDown" });
        expect(popup()).not.toBeNull();
        // 原生 window 事件不经过 React 合成系统，需 act 包裹让状态更新同步 flush
        act(() => window.dispatchEvent(new Event("scroll")));
        expect(popup()).toBeNull();
        fireEvent.keyDown(input(), { key: "ArrowDown" });
        act(() => window.dispatchEvent(new Event("resize")));
        expect(popup()).toBeNull();
    });
});
