// web/src/components/ui/settings-controls.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

import { OptionPill, QuickPillRow, SettingGroup, SettingRow } from "./settings-controls";

describe("settings-controls", () => {
    it("OptionPill 选中态反色、未选中态 hover 可点", () => {
        const onClick = vi.fn();
        const { getByRole } = render(<OptionPill selected onClick={onClick}>1:1</OptionPill>);
        const pill = getByRole("button", { name: "1:1" });
        expect(pill.className).toContain("bg-foreground");
        fireEvent.click(pill);
        expect(onClick).toHaveBeenCalledOnce();
    });
    it("disabled 不可点", () => {
        const onClick = vi.fn();
        const { getByRole } = render(<OptionPill selected={false} disabled onClick={onClick}>x</OptionPill>);
        fireEvent.click(getByRole("button", { name: "x" }));
        expect(onClick).not.toHaveBeenCalled();
    });
    it("SettingRow 渲染 label + hint + 控件", () => {
        const { getByText } = render(<SettingRow label="尺寸" hint="说明">ctrl</SettingRow>);
        expect(getByText("尺寸")).toBeTruthy();
        expect(getByText("说明")).toBeTruthy();
        expect(getByText("ctrl")).toBeTruthy();
    });
    it("SettingGroup 渲染分组标题", () => {
        const { getByText } = render(<SettingGroup title="画幅">rows</SettingGroup>);
        expect(getByText("画幅")).toBeTruthy();
    });
});

function Harness({ onChange }: { onChange: (v: number) => void }) {
    const [value, setValue] = useState(3);
    return (
        <I18nextProvider i18n={i18n}>
            <QuickPillRow
                values={[1, 2, 3, 4]}
                value={value}
                format={(v) => `${v} 张`}
                min={1}
                max={15}
                parse={(s) => { const n = Math.floor(Number(s)); return Number.isFinite(n) ? Math.max(1, Math.min(15, n)) : null; }}
                onChange={(v) => { setValue(v as number); onChange(v as number); }}
            />
        </I18nextProvider>
    );
}

describe("QuickPillRow（D12 快选+自定义按钮）", () => {
    beforeEach(() => { void i18n.changeLanguage("zh-CN"); });
    it("快选值命中时渲染 4 个快选 pill + 未选中的「自定义」", () => {
        render(<Harness onChange={vi.fn()} />);
        expect(screen.getByText("3 张")).toBeTruthy();
        const custom = screen.getByText("自定义");
        expect(custom.className).not.toContain("bg-foreground");
    });
    it("当前值不在快选档：自定义 pill 选中并带值", () => {
        render(<Harness onChange={vi.fn()} />);
        fireEvent.click(screen.getByText("自定义"));
        fireEvent.change(screen.getByDisplayValue("3"), { target: { value: "7" } });
        fireEvent.blur(screen.getByDisplayValue("7"));
        expect(screen.getByText("自定义 7 张")).toBeTruthy();
    });
    it("点击自定义 → 原位输入框 → 提交回调", () => {
        const onChange = vi.fn();
        render(<Harness onChange={onChange} />);
        fireEvent.click(screen.getByText("自定义"));
        fireEvent.change(screen.getByDisplayValue("3"), { target: { value: "9" } });
        fireEvent.blur(screen.getByDisplayValue("9"));
        expect(onChange).toHaveBeenCalledWith(9);
    });
    it("非法输入不提交", () => {
        const onChange = vi.fn();
        render(<Harness onChange={onChange} />);
        fireEvent.click(screen.getByText("自定义"));
        fireEvent.change(screen.getByDisplayValue("3"), { target: { value: "" } });
        fireEvent.blur(screen.getByDisplayValue(""));
        expect(onChange).not.toHaveBeenCalled();
    });
});
