import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AppConfigPanel } from "@/components/layout/app-config-modal";
import i18n from "@/i18n";
import { resetManagedCatalogForTests } from "@/lib/desktop/managed-catalog-cache";
import { emptyAiSourcePreferences } from "@/services/ai-source-preferences";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useAiSourceStore } from "@/stores/use-ai-source-store";

afterEach(() => {
    useConfigStore.setState((state) => ({ ...state, config: defaultConfig }));
    useAiSourceStore.setState({ status: "loading", error: null, applying: false, preferences: emptyAiSourcePreferences() });
    delete window.shotshot;
    resetManagedCatalogForTests();
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

const model = (id: string, capability: "image" | "text" | "video" | "audio", name = id) => ({ id, name, capability, execution: "direct" as const });
const shotshotConfig = {
    ...defaultConfig,
    credentialMode: "shotshot" as const,
    credentialModes: { agent: "shotshot", text: "shotshot", image: "shotshot", video: "shotshot", audio: "shotshot" } as const,
    managedModels: { text: "shotshot-text-pro", image: "shotshot-image-pro", video: "", audio: "" },
};

function renderPreferences() {
    return render(
        <I18nextProvider i18n={i18n}>
            <QueryClientProvider client={new QueryClient()}><AntApp>
                <AppConfigPanel initialTab="preferences" />
            </AntApp></QueryClientProvider>
        </I18nextProvider>,
    );
}

describe("AppConfigPanel managed preferences", () => {
    test("renders a managed text model picker and lists catalog names for defaults", async () => {
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(async () => [model("shotshot-text-pro", "text", "ShotShot Text Pro"), model("shotshot-image-pro", "image", "ShotShot Image Pro"), model("shotshot-image-lite", "image", "ShotShot Image Lite")]), fetch: vi.fn(), abort: vi.fn() } } as never;
        useAiSourceStore.setState({ status: "ready", error: null, applying: false });
        useConfigStore.setState({ config: shotshotConfig as never });
        renderPreferences();

        expect((await screen.findAllByText("ShotShot Text Pro")).length).toBeGreaterThanOrEqual(1);
        expect(screen.queryByText("由 shotshot 套餐提供")).not.toBeInTheDocument();
        expect(screen.queryByText("shotshot-text-pro")).not.toBeInTheDocument();
        expect(await screen.findByText("ShotShot Image Pro")).toBeInTheDocument();
    });

    test("explains a missing capability instead of showing 不可用", async () => {
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(async () => [model("managed-video", "video")]), fetch: vi.fn(), abort: vi.fn() } } as never;
        useAiSourceStore.setState({ status: "ready", error: null, applying: false });
        useConfigStore.setState({ config: shotshotConfig as never });
        renderPreferences();

        expect(await screen.findByText("套餐暂未包含 Agent 所需的文本模型")).toBeInTheDocument();
        expect(screen.getAllByText(/套餐暂未包含/).length).toBeGreaterThanOrEqual(2);
        expect(screen.queryByText("不可用")).not.toBeInTheDocument();
    });

    test("reports a fetch failure with retry when the catalog is unreachable", async () => {
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(async () => { throw new Error("network down"); }), fetch: vi.fn(), abort: vi.fn() } } as never;
        useAiSourceStore.setState({ status: "ready", error: null, applying: false });
        useConfigStore.setState({ config: shotshotConfig as never });
        renderPreferences();

        expect((await screen.findAllByText("套餐目录获取失败")).length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByRole("button", { name: "重试" }).length).toBeGreaterThanOrEqual(2);
    });

    test("commits an explicit managed model choice", async () => {
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(async () => [model("shotshot-image-pro", "image", "ShotShot Image Pro"), model("shotshot-image-lite", "image", "ShotShot Image Lite")]), fetch: vi.fn(), abort: vi.fn() } } as never;
        useAiSourceStore.setState({ status: "ready", error: null, applying: false });
        useConfigStore.setState({ config: shotshotConfig as never });
        renderPreferences();

        // antd Popover trigger="click" 只监听 onClick（pointerDown 仅适用于 Radix DropdownMenu）
        fireEvent.click(await screen.findByText("ShotShot Image Pro"), { button: 0 });
        fireEvent.click(await screen.findByText("ShotShot Image Lite"));
        await waitFor(() => expect(useConfigStore.getState().config.managedModels.image).toBe("shotshot-image-lite"));
    });

    test("commits an explicit managed agent model choice", async () => {
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(async () => [model("shotshot-text-pro", "text", "ShotShot Text Pro"), model("shotshot-text-ultra", "text", "ShotShot Text Ultra"), model("shotshot-text-max", "text", "ShotShot Text Max"), model("shotshot-image-pro", "image", "ShotShot Image Pro")]), fetch: vi.fn(), abort: vi.fn() } } as never;
        useAiSourceStore.setState({ status: "ready", error: null, applying: false });
        useConfigStore.setState({ config: { ...shotshotConfig, managedAgentModel: "shotshot-text-ultra" } as never });
        renderPreferences();

        // Agent 选择器与默认文本模型磁贴显示不同模型名，触发器文本唯一可寻址；
        // Radix Select 在 jsdom 下用键盘序列打开/选择（fireEvent 无完整 pointer 序列）。
        const agentTrigger = (await screen.findByText("ShotShot Text Ultra")).closest("button")!;
        fireEvent.keyDown(agentTrigger, { key: "Enter" });
        fireEvent.keyDown(await screen.findByRole("option", { name: "ShotShot Text Max" }), { key: "Enter" });
        await waitFor(() => expect(useConfigStore.getState().config.managedAgentModel).toBe("shotshot-text-max"));
    });
});


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
