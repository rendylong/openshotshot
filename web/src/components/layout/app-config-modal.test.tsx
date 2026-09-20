import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AppConfigPanel } from "@/components/layout/app-config-modal";
import i18n from "@/i18n";
import { emptyAiSourcePreferences } from "@/services/ai-source-preferences";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useAiSourceStore } from "@/stores/use-ai-source-store";

afterEach(() => {
    useConfigStore.setState((state) => ({ ...state, config: defaultConfig }));
    useAiSourceStore.setState({ status: "loading", error: null, applying: false, preferences: emptyAiSourcePreferences() });
    delete window.shotshot;
});

describe("AppConfigPanel Agent preferences", () => {
    test("shows an independent Agent model and defaults its API to Responses", () => {
        render(
            <I18nextProvider i18n={i18n}>
                <QueryClientProvider client={new QueryClient()}><AntApp>
                    <AppConfigPanel initialTab="preferences" />
                </AntApp></QueryClientProvider>
            </I18nextProvider>,
        );

        expect(screen.getByText("Agent 模型")).toBeInTheDocument();
        expect(screen.getByText("Agent API")).toBeInTheDocument();
        expect(screen.getByText("Responses API")).toBeInTheDocument();
        expect(screen.getByText("默认文本模型")).toBeInTheDocument();
    });
});

describe("AppConfigPanel official providers", () => {
    test("offers all official presets before creating a provider", async () => {
        render(
            <I18nextProvider i18n={i18n}>
                <QueryClientProvider client={new QueryClient()}><AntApp>
                    <AppConfigPanel initialTab="channels" />
                </AntApp></QueryClientProvider>
            </I18nextProvider>,
        );

        // Radix DropdownMenu 在 pointerDown 时打开菜单
        fireEvent.pointerDown(screen.getByRole("button", { name: "新增渠道" }), { button: 0 });

        expect(await screen.findByText("MiniMax 中国")).toBeInTheDocument();
        expect(screen.getByText("MiniMax 国际")).toBeInTheDocument();
        expect(screen.getByText("OpenRouter")).toBeInTheDocument();
        expect(screen.getByText("DeepSeek")).toBeInTheDocument();
        expect(screen.getByText("Moonshot / Kimi")).toBeInTheDocument();
        expect(screen.getByText("智谱 GLM / Z.AI")).toBeInTheDocument();
        expect(screen.getByText("自定义渠道")).toBeInTheDocument();
    });
});

function renderPreferences() {
    return render(
        <I18nextProvider i18n={i18n}>
            <QueryClientProvider client={new QueryClient()}><AntApp>
                <AppConfigPanel initialTab="preferences" />
            </AntApp></QueryClientProvider>
        </I18nextProvider>,
    );
}

test("reference compression switch controls the persisted global preference", () => {
    renderPreferences();
    const toggle = screen.getByRole("switch", { name: "压缩参考图" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(useConfigStore.getState().config.compressReferenceImages).toBe(false);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(useConfigStore.getState().config.compressReferenceImages).toBe(true);
});
