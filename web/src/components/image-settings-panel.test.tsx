import { fireEvent, render, screen } from "@testing-library/react";
import { message } from "antd";
import { useState, type ComponentProps } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

import { ImageSettingsPanel } from "./image-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { defaultConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";

vi.mock("antd", async (importOriginal) => {
    const actual = await importOriginal<typeof import("antd")>();
    return { ...actual, message: { success: vi.fn() } };
});

const theme = canvasThemes.light;
const baseConfig = { ...defaultConfig, quality: "high", size: "1536x1024", count: "7", background: "" };

/** 面板是受控组件：点击用例需要 onConfigChange 真正回写 config，才能驱动 caption/折叠重渲染。 */
function PanelHarness({ initialConfig, isOverridden, onConfigChange, onResetOverrides }: {
    initialConfig: AiConfig;
    isOverridden: boolean;
    onConfigChange: (key: "quality" | "size" | "count" | "background", value: string) => void;
    onResetOverrides: () => void;
}) {
    const [config, setConfig] = useState(initialConfig);
    return (
        <ImageSettingsPanel
            config={config}
            theme={theme}
            isOverridden={isOverridden}
            onResetOverrides={onResetOverrides}
            onConfigChange={(key, value) => {
                setConfig((current) => ({ ...current, [key]: value }));
                onConfigChange(key, value);
            }}
        />
    );
}

type PanelHarnessProps = ComponentProps<typeof PanelHarness>;

function renderPanel(overrides: { config?: Partial<AiConfig>; isOverridden?: boolean } = {}, onConfigChange: PanelHarnessProps["onConfigChange"] = vi.fn(), onReset = vi.fn()) {
    useConfigStore.setState({ config: { ...defaultConfig } });
    const utils = render(
        <I18nextProvider i18n={i18n}>
            <PanelHarness
                initialConfig={{ ...baseConfig, ...overrides.config } as AiConfig}
                isOverridden={overrides.isOverridden === undefined ? true : overrides.isOverridden}
                onConfigChange={onConfigChange}
                onResetOverrides={onReset}
            />
        </I18nextProvider>,
    );
    return { onConfigChange, onReset, ...utils };
}

afterEach(() => {
    delete window.shotshot;
});

describe("ImageSettingsPanel 重构（D8-D13）", () => {
    beforeEach(() => { void i18n.changeLanguage("zh-CN"); });

    it("无标题；顺序为 尺寸→质量→数量→透明背景", () => {
        renderPanel();
        expect(screen.queryByText("图像设置")).toBeNull();
        const labels = screen.getAllByText(/^(尺寸|质量|数量|透明背景)$/).map((el) => el.textContent);
        expect(labels.indexOf("尺寸")).toBeLessThan(labels.indexOf("质量"));
        expect(labels.indexOf("质量")).toBeLessThan(labels.indexOf("数量"));
    });
    it("质量 pill 带档位注释；比例+质量实时计算输出尺寸", () => {
        renderPanel();
        expect(screen.getByText("1K")).toBeTruthy();
        fireEvent.click(screen.getByText("16:9"));
        expect(screen.getByText(/3840 × 2160/)).toBeTruthy();
    });
    it("比例选自动：caption 提示模型决定，W×H 输入随折叠收起而不存在", () => {
        renderPanel();
        fireEvent.click(screen.getByText("AUTO").closest("button")!);
        expect(screen.getByText("尺寸由模型按提示内容决定")).toBeTruthy();
        expect(document.querySelector("input[type=number]")).toBeNull();
    });
    it("数量行：自定义按钮带值呈选中态", () => {
        renderPanel();
        expect(screen.getByText("自定义 7 张").closest("button")!.className).toContain("bg-foreground");
    });
    it("自定义 W×H 输入：键入不被 16 对齐回写，失焦才提交对齐值", () => {
        const onConfigChange = vi.fn();
        renderPanel({}, onConfigChange);
        const wInput = screen.getByDisplayValue("1536");
        fireEvent.change(wInput, { target: { value: "5" } });
        expect((wInput as HTMLInputElement).value).toBe("5");
        fireEvent.blur(wInput);
        expect(onConfigChange).toHaveBeenCalledWith("size", "16x1024");
    });
    it("footer：覆盖≠默认 → 设为默认可用且写入全局四字段", () => {
        const spy = vi.spyOn(useConfigStore.getState(), "updateConfig");
        renderPanel();
        fireEvent.click(screen.getByRole("button", { name: /设为默认/ }));
        const calls = spy.mock.calls;
        expect(calls).toContainEqual(["quality", "high"]);
        expect(calls).toContainEqual(["size", "1536x1024"]);
        expect(calls).toContainEqual(["canvasImageCount", "7"]);
        spy.mockRestore();
    });
    it("面板值=默认：设为默认禁用；isOverridden=false：重置参数禁用", () => {
        renderPanel({ config: { ...defaultConfig, quality: "auto", size: "1:1", count: "3", background: "" } as never, isOverridden: false });
        expect(screen.getByRole("button", { name: /设为默认/ }).hasAttribute("disabled")).toBe(true);
        expect(screen.getByRole("button", { name: /重置参数/ }).hasAttribute("disabled")).toBe(true);
    });
    it("重置参数回调 onResetOverrides", () => {
        const onReset = vi.fn();
        renderPanel({}, vi.fn(), onReset);
        fireEvent.click(screen.getByRole("button", { name: /重置参数/ }));
        expect(onReset).toHaveBeenCalled();
    });
});
