import { fireEvent, render, screen } from "@testing-library/react";
import { message } from "antd";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

import { GenerationDefaultsFooter } from "./generation-defaults-footer";

vi.mock("antd", async (importOriginal) => {
    const actual = await importOriginal<typeof import("antd")>();
    return { ...actual, message: { success: vi.fn() } };
});

function renderFooter(canSet: boolean, canReset: boolean, onSet = vi.fn(), onReset = vi.fn()) {
    render(
        <I18nextProvider i18n={i18n}>
            <GenerationDefaultsFooter typeName="生图" summary="高 · 3:2 · 7 张" canSet={canSet} canReset={canReset} onSetDefault={onSet} onReset={onReset} />
        </I18nextProvider>,
    );
    return {
        setBtn: screen.getByRole("button", { name: /设为默认/ }),
        resetBtn: screen.getByRole("button", { name: /重置参数/ }),
        onSet,
        onReset,
    };
}

describe("GenerationDefaultsFooter（D2/D3/D16）", () => {
    beforeEach(() => { void i18n.changeLanguage("zh-CN"); });
    it("渲染摘要与两按钮", () => {
        const { setBtn, resetBtn } = renderFooter(true, true);
        expect(screen.getByText(/默认：/)).toBeTruthy();
        expect(setBtn).toBeTruthy();
        expect(resetBtn).toBeTruthy();
    });
    it("canSet=false 禁用设为默认且不回调", () => {
        const { setBtn, onSet } = renderFooter(false, true);
        expect(setBtn.hasAttribute("disabled")).toBe(true);
        fireEvent.click(setBtn);
        expect(onSet).not.toHaveBeenCalled();
    });
    it("canReset=false 禁用重置参数", () => {
        const { resetBtn, onReset } = renderFooter(true, false);
        expect(resetBtn.hasAttribute("disabled")).toBe(true);
        fireEvent.click(resetBtn);
        expect(onReset).not.toHaveBeenCalled();
    });
    it("点击回调并弹带值 toast", () => {
        const { setBtn } = renderFooter(true, true);
        fireEvent.click(setBtn);
        expect(vi.mocked(message.success)).toHaveBeenCalledWith(expect.stringContaining("已更新生图默认"));
    });
});
