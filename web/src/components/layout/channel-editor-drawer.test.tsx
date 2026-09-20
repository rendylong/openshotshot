import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import axios from "axios";
import { App as AntApp } from "antd";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, test, it, vi } from "vitest";

import { ChannelEditorDrawer } from "@/components/layout/channel-editor-drawer";
import i18n from "@/i18n";
import { createModelChannel, type ChannelModel, type ModelChannel } from "@/stores/use-config-store";

vi.mock("@/services/api/channel-model-catalog", () => ({ fetchChannelCatalog: vi.fn() }));

function channel(models: ChannelModel[], values: Partial<ModelChannel> = {}): ModelChannel {
    return {
        id: "provider",
        name: "测试渠道",
        provider: "custom",
        baseUrl: "https://api.example.com",
        apiKey: "key",
        apiFormat: "openai",
        models,
        ...values,
    };
}

function renderDrawer(value: ModelChannel, onSave = vi.fn()) {
    return {
        ...render(
            <I18nextProvider i18n={i18n}>
                <QueryClientProvider client={new QueryClient()}><AntApp>
                    <ChannelEditorDrawer open channel={value} onSave={onSave} onClose={vi.fn()} />
                </AntApp></QueryClientProvider>
            </I18nextProvider>,
        ),
        onSave,
    };
}

afterEach(async () => {
    vi.restoreAllMocks();
    await i18n.changeLanguage("zh-CN");
});

describe("ChannelEditorDrawer", () => {
    test("shows automatic protocol summaries and editable output/input capability controls", () => {
        const zhipuView = renderDrawer(channel([{ name: "cogvideox-3", capability: "video" }], { provider: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4" }));

        expect(screen.getByText("视频 · 异步任务 · GLM 官方协议")).toBeInTheDocument();
        expect(screen.queryByText("配置脚本")).not.toBeInTheDocument();
        expect(screen.queryByRole("switch")).not.toBeInTheDocument();
        expect(screen.getByRole("combobox", { name: /cogvideox-3 的模型能力/ })).toBeInTheDocument();

        zhipuView.unmount();
        renderDrawer(channel([{ name: "kimi-k2.5", capability: "text" }], { provider: "moonshot", baseUrl: "https://api.moonshot.cn/v1" }));
        expect(screen.getByText("文本 · 流式 · OpenAI 兼容协议")).toBeInTheDocument();
        expect(screen.getByRole("switch", { name: "kimi-k2.5 支持图片输入" })).toBeChecked();
    });

    test("saves an explicit image-input override for a text model", () => {
        const { onSave } = renderDrawer(channel([{ name: "gpt-5.5", capability: "text", supportsImageInput: true }]));

        fireEvent.click(screen.getByRole("switch", { name: "gpt-5.5 支持图片输入" }));
        fireEvent.click(screen.getByRole("button", { name: "保存" }));

        expect(onSave.mock.calls[0][0].models[0]).toMatchObject({ name: "gpt-5.5", supportsImageInput: false });
    });

    test("shows a non-editable compatibility badge and preserves legacy fields on save", () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const legacyModel: ChannelModel = {
            name: "private-video",
            capability: "video",
            executionMode: "remote_task",
            script: "  return direct  ",
            remoteTask: { timeoutMinutes: 120, submitScript: "  return submit  ", queryScript: "  return query  " },
        };
        const { onSave } = renderDrawer(channel([legacyModel]));

        expect(screen.getByText("兼容配置")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /编辑.*脚本|编辑任务协议|配置.*private-video/ })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "保存" }));

        expect(onSave).toHaveBeenCalledOnce();
        expect(onSave.mock.calls[0][0].models[0]).toEqual(legacyModel);
        expect(consoleError.mock.calls.flat().join(" ")).not.toContain("bordered={false}");
    });

    test("keeps model removal available", () => {
        const { onSave } = renderDrawer(
            channel([
                { name: "gpt-image-2", capability: "image" },
                { name: "gpt-5.5", capability: "text" },
            ]),
        );

        fireEvent.click(screen.getByRole("button", { name: "删除模型 gpt-image-2" }));
        fireEvent.click(screen.getByRole("button", { name: "保存" }));

        expect(onSave.mock.calls[0][0].models).toEqual([{ name: "gpt-5.5", capability: "text" }]);
    });

    test("renders the automatic summary in English", async () => {
        await i18n.changeLanguage("en-US");
        renderDrawer(channel([{ name: "kimi-k2.5", capability: "text" }], { provider: "moonshot", baseUrl: "https://api.moonshot.cn/v1" }));

        expect(screen.getByText("Text · Streaming · OpenAI-compatible protocol")).toBeInTheDocument();
    });
});


describe("AutoDL channel editor", () => {
    test("shows ComfyUI protocol and Token guidance, preserving custom URL and credentials", () => {
        const { onSave } = renderDrawer(createModelChannel({ provider: "autodl", models: [], baseUrl: "https://proxy.example.test", apiKey: "fake-token" }));
        expect(screen.queryByRole("combobox", { name: i18n.t("config.channelEditor.protocol") })).not.toBeInTheDocument();
        expect(screen.getByText(i18n.t("autodl.protocol"))).toBeInTheDocument();
        expect(screen.getByText(i18n.t("autodl.tokenHint"))).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "edited-placeholder" } });
        fireEvent.click(screen.getByRole("button", { name: "保存" }));
        expect(onSave.mock.calls[0][0]).toMatchObject({ provider: "autodl", baseUrl: "https://proxy.example.test", apiKey: "edited-placeholder" });
    });

    test("offers all eleven readable workflows without requesting a model API or requiring a Token", () => {
        const get = vi.spyOn(axios, "get").mockRejectedValue(new Error("unexpected network"));
        const { onSave } = renderDrawer(createModelChannel({ provider: "autodl", models: [] }));
        fireEvent.click(screen.getByRole("button", { name: i18n.t("config.channelEditor.selectModels") }));
        const modal = within(screen.getAllByRole("dialog").at(-1)!);
        expect(modal.getAllByRole("checkbox")).toHaveLength(11);
        expect(modal.getByText(i18n.t("autodl.workflows.motionRetargeting"))).toBeInTheDocument();
        expect(modal.queryByRole("button", { name: i18n.t("config.modelSelect.fetch") })).not.toBeInTheDocument();
        fireEvent.click(modal.getByRole("checkbox", { name: "wan2.2animate-v4-motion_retargeting" }));
        fireEvent.click(modal.getByRole("button", { name: (name) => name.replace(/\s/g, "") === i18n.t("config.modelSelect.confirm") }));
        fireEvent.click(screen.getByRole("button", { name: "保存" }));
        expect(onSave.mock.calls[0][0].models).toEqual([{ name: "wan2.2animate-v4-motion_retargeting", capability: "video" }]);
        expect(get).not.toHaveBeenCalled();
    });

    test("detects official hosts with a custom provider and keeps normal protocol selection for lookalikes", () => {
        const view = renderDrawer(channel([], { baseUrl: "https://www.autodl.art" }));
        expect(screen.getByText(i18n.t("autodl.protocol"))).toBeInTheDocument();
        view.unmount();
        renderDrawer(channel([], { baseUrl: "https://autodl.art.attacker.test" }));
        expect(screen.queryByText(i18n.t("autodl.protocol"))).not.toBeInTheDocument();
        expect(screen.getByRole("combobox")).toBeInTheDocument();
    });
});

it("fetches, selects, saves and reopens OpenRouter capabilities without losing private fields", async () => {
    const { fetchChannelCatalog } = await import("@/services/api/channel-model-catalog");
    vi.mocked(fetchChannelCatalog).mockResolvedValue({ entries: [{ id: "a/model:free", displayName: "Readable Model", provider: "openrouter", category: "text", metadata: { version: 1, source: "provider_models", inputModalities: ["text", "image"], outputModalities: ["text"], supportsTools: true, providerStatus: "active" }, availability: "ready" }], nextCursor: null, hasMore: false, source: "network" });
    const original = createModelChannel({ provider: "openrouter", models: [{ name: "private", capability: "text", script: "preserve me" }] });
    const view = renderDrawer(original);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("config.channelEditor.selectModels") }));
    const modal = within(screen.getAllByRole("dialog").at(-1)!);
    fireEvent.click(modal.getByRole("button", { name: i18n.t("config.modelSelect.fetch") }));
    fireEvent.click(await modal.findByRole("checkbox", { name: "a/model:free" }));
    fireEvent.click(modal.getByRole("button", { name: name => name.replace(/\s/g, "") === i18n.t("config.modelSelect.confirm") }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    const saved = view.onSave.mock.calls[0][0];
    expect(saved.models).toHaveLength(2);
    expect(saved.models[0]).toEqual(original.models[0]);
    expect(saved.models[1]).toMatchObject({ name: "a/model:free", supportsImageInput: true, catalog: { supportsTools: true } });
    view.unmount();
    renderDrawer(saved);
    expect(screen.getByRole("switch", { name: "a/model:free 支持图片输入" })).toBeChecked();
    expect(screen.getByText(i18n.t("config.catalog.tools"))).toBeInTheDocument();
});

it("invalidates only the current channel catalog when its API key changes", async () => {
    const { waitFor } = await import("@testing-library/react");
    const client = new QueryClient();
    const value = createModelChannel({ provider: "openrouter" });
    client.setQueryData(["channel-catalog", value.id, "openrouter"], { pages: [] });
    client.setQueryData(["channel-catalog", "other", "openrouter"], { pages: [] });
    render(<QueryClientProvider client={client}><I18nextProvider i18n={i18n}><AntApp><ChannelEditorDrawer open channel={value} onSave={vi.fn()} onClose={vi.fn()} /></AntApp></I18nextProvider></QueryClientProvider>);
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "replacement-placeholder" } });
    await waitFor(() => expect(client.getQueryState(["channel-catalog", value.id, "openrouter"])?.isInvalidated).toBe(true));
    expect(client.getQueryState(["channel-catalog", "other", "openrouter"])?.isInvalidated).toBe(false);
});
