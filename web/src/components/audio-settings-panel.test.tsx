import { fireEvent, render, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { defaultConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { AudioSettingsPanel } from "./audio-settings-panel";

/** 面板是受控组件：自定义语速用例需要 onConfigChange 真正回写 config，才能驱动 QuickPillRow 呈现新值。 */
function Harness({ initialConfig, isOverridden, onConfigChange, onResetOverrides }: {
    initialConfig: AiConfig;
    isOverridden: boolean;
    onConfigChange: ComponentProps<typeof AudioSettingsPanel>["onConfigChange"];
    onResetOverrides: () => void;
}) {
    const [config, setConfig] = useState(initialConfig);
    return (
        <I18nextProvider i18n={i18n}>
            <AudioSettingsPanel
                config={config}
                isOverridden={isOverridden}
                onResetOverrides={onResetOverrides}
                onConfigChange={(key, value) => {
                    setConfig((current) => ({ ...current, [key]: value }));
                    onConfigChange(key, value);
                }}
            />
        </I18nextProvider>
    );
}

describe("AudioSettingsPanel 重构（D9/D12）", () => {
    beforeEach(() => {
        void i18n.changeLanguage("zh-CN");
        useConfigStore.setState({ config: { ...defaultConfig } });
    });
    function renderPanel(configOverrides: Partial<AiConfig> = {}, onConfigChange: ComponentProps<typeof AudioSettingsPanel>["onConfigChange"] = vi.fn()) {
        return render(
            <Harness
                initialConfig={{ ...defaultConfig, ...configOverrides } as AiConfig}
                isOverridden
                onConfigChange={onConfigChange}
                onResetOverrides={vi.fn()}
            />,
        );
    }
    it("顺序：音色 → 语速 → 格式 → 指令", () => {
        renderPanel();
        const labels = screen.getAllByText(/^(声音|语速|格式|声音指令)$/).map((el) => el.textContent);
        expect(labels.indexOf("声音")).toBeLessThan(labels.indexOf("语速"));
        expect(labels.indexOf("语速")).toBeLessThan(labels.indexOf("格式"));
        expect(labels.indexOf("格式")).toBeLessThan(labels.indexOf("声音指令"));
    });
    it("语速行有「自定义」按钮并可提交 1.3x", () => {
        renderPanel();
        fireEvent.click(screen.getByText("自定义"));
        fireEvent.change(screen.getByDisplayValue("1"), { target: { value: "1.3" } });
        fireEvent.blur(screen.getByDisplayValue("1.3"));
        expect(screen.getByText("自定义 1.3x")).toBeTruthy();
    });
    it("footer 渲染默认摘要", () => {
        renderPanel();
        expect(screen.getByText(/默认：Alloy · MP3 · 1x/)).toBeTruthy();
    });
});
