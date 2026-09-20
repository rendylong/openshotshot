import { fireEvent, render, screen } from "@testing-library/react";
import { message } from "antd";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

import { TextSettingsPanel } from "./text-settings-panel";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";

vi.mock("antd", async (importOriginal) => {
    const actual = await importOriginal<typeof import("antd")>();
    return { ...actual, message: { success: vi.fn() } };
});

const onCountChange = vi.fn();

function renderPanel(props: Record<string, unknown> = {}) {
    useConfigStore.setState({ config: { ...defaultConfig } });
    return render(
        <I18nextProvider i18n={i18n}>
            <TextSettingsPanel
                config={{ ...defaultConfig, textCount: "5" } as never}
                onConfigChange={vi.fn()}
                isOverridden
                count={5}
                onCountChange={onCountChange}
                onResetOverrides={vi.fn()}
                {...props}
            />
        </I18nextProvider>,
    );
}

describe("TextSettingsPanel 数量下沉 + footer（D12/D7）", () => {
    beforeEach(() => { void i18n.changeLanguage("zh-CN"); });
    it("数量行渲染在面板内且「自定义 5」呈选中态", () => {
        renderPanel();
        expect(screen.getByText("自定义 5").closest("button")!.className).toContain("bg-foreground");
    });
    it("点自定义按钮提交 onCountChange", () => {
        renderPanel();
        fireEvent.click(screen.getByText("自定义 5"));
        fireEvent.change(screen.getByDisplayValue("5"), { target: { value: "2" } });
        fireEvent.blur(screen.getByDisplayValue("2"));
        expect(onCountChange).toHaveBeenCalledWith(2);
    });
    it("设为默认写入 reasoningEffort/canvasTextCount", () => {
        const spy = vi.spyOn(useConfigStore.getState(), "updateConfig");
        renderPanel({ config: { ...defaultConfig, reasoningEffort: "high", textCount: "6" } as never });
        fireEvent.click(screen.getByRole("button", { name: /设为默认/ }));
        expect(spy.mock.calls).toContainEqual(["reasoningEffort", "high"]);
        expect(spy.mock.calls).toContainEqual(["canvasTextCount", "6"]);
        spy.mockRestore();
    });
});
