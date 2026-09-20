import { mergeCatalogSelection } from "@/lib/models/channel-model-metadata";
import { normalizeAiConfig } from "@/stores/use-config-store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, test, it, vi } from "vitest";

import { ModelSelectModal } from "@/components/layout/model-select-modal";
import i18n from "@/i18n";
import { fetchChannelModels } from "@/services/api/image";
import type { ModelChannel } from "@/stores/use-config-store";

import { fetchChannelCatalog } from "@/services/api/channel-model-catalog";
import { parseOpenRouterCatalog } from "@/services/api/openrouter-catalog";
vi.mock("@/services/api/channel-model-catalog", () => ({ fetchChannelCatalog: vi.fn() }));

vi.mock("@/services/api/fal-catalog", async importOriginal => ({ ...await importOriginal<typeof import("@/services/api/fal-catalog")>(), refreshFalSchemaCompatibility: vi.fn() }));

vi.mock("@/services/api/image", () => ({ fetchChannelModels: vi.fn() }));

function channel(values: Partial<ModelChannel> = {}): ModelChannel {
    return {
        id: "provider",
        name: "测试渠道",
        provider: "moonshot",
        baseUrl: "https://api.moonshot.cn/v1",
        apiKey: "key",
        apiFormat: "openai",
        models: [],
        ...values,
    };
}

function renderModal(value: ModelChannel, selectedNames: string[], onConfirm = vi.fn()) {
    render(
        <I18nextProvider i18n={i18n}>
            <QueryClientProvider client={new QueryClient()}><AntApp>
                <ModelSelectModal open channel={value} selectedNames={selectedNames} onConfirm={onConfirm} onClose={vi.fn()} />
            </AntApp></QueryClientProvider>
        </I18nextProvider>,
    );
    return onConfirm;
}

function clickConfirm() {
    const button = screen.getAllByRole("button").find((item) => item.textContent?.replace(/\s/g, "") === "确定");
    expect(button).toBeDefined();
    fireEvent.click(button!);
}

afterEach(() => {
    vi.clearAllMocks();
});

describe("ModelSelectModal", () => {
    test("keeps a selected private model in the existing tab after refresh", async () => {
        vi.mocked(fetchChannelModels).mockResolvedValue(["kimi-k2.5"]);
        const onConfirm = renderModal(channel(), ["kimi-old-private"]);

        fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
        expect(await screen.findByText("kimi-k2.5")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("checkbox", { name: "kimi-k2.5" }));
        fireEvent.click(screen.getByRole("tab", { name: "已有的模型 (1)" }));
        expect(screen.getByText("kimi-old-private")).toBeInTheDocument();
        clickConfirm();

        await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(["kimi-old-private", "kimi-k2.5"], []));
    });

    test("shows automatic inference when manually adding a music model", () => {
        const onConfirm = renderModal(channel({
            provider: "minimax-global",
            baseUrl: "https://api.minimax.io",
        }), []);

        fireEvent.change(screen.getByPlaceholderText("输入模型名称"), { target: { value: "music-2.6" } });
        fireEvent.click(screen.getByRole("button", { name: "增加模型" }));

        expect(screen.getByText("音乐 · 直接返回 · MiniMax 官方协议")).toBeInTheDocument();
        clickConfirm();
        expect(onConfirm).toHaveBeenCalledWith(["music-2.6"], []);
    });
});

it("returns exact selected catalog descriptors and retains selection after failed refresh", async () => {
    const entries = parseOpenRouterCatalog({ data: [{ id: "a/model:free", name: "Readable Model", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, supported_parameters: ["tools"] }] });
    vi.mocked(fetchChannelCatalog).mockResolvedValueOnce({ entries, nextCursor: null, hasMore: false, source: "network" }).mockRejectedValue(new Error("offline"));
    const confirm = renderModal(channel({ provider: "openrouter" }), []);
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    expect(await screen.findByText("Readable Model")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "a/model:free" }));
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    expect(await screen.findByText(i18n.t("config.catalog.refreshFailed"))).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "a/model:free" })).toBeChecked();
    clickConfirm();
    expect(confirm).toHaveBeenCalledWith(["a/model:free"], entries);
});

it("searches only on Enter and keeps descriptors selected in earlier searches", async () => {
    const entries = parseOpenRouterCatalog({ data: [{ id: "a/exact", name: "First", architecture: { output_modalities: ["text"] } }] });
    const later = parseOpenRouterCatalog({ data: [{ id: "b/exact", name: "Second", architecture: { output_modalities: ["text"] } }] });
    vi.mocked(fetchChannelCatalog).mockReset().mockResolvedValueOnce({ entries, nextCursor: null, hasMore: false, source: "network" }).mockResolvedValueOnce({ entries: later, nextCursor: null, hasMore: false, source: "network" });
    const confirm = renderModal(channel({ provider: "openrouter" }), []);
    const search = screen.getByPlaceholderText("搜索模型");
    fireEvent.change(search, { target: { value: "First" } });
    expect(fetchChannelCatalog).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: "Enter", code: "Enter" });
    fireEvent.keyUp(search, { key: "Enter", code: "Enter" });
    fireEvent.click(await screen.findByRole("checkbox", { name: "a/exact" }));
    fireEvent.change(search, { target: { value: "Second" } });
    expect(fetchChannelCatalog).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(search, { key: "Enter", code: "Enter" });
    fireEvent.keyUp(search, { key: "Enter", code: "Enter" });
    fireEvent.click(await screen.findByRole("checkbox", { name: "b/exact" }));
    clickConfirm();
    expect(confirm).toHaveBeenCalledWith(["a/exact", "b/exact"], [...entries, ...later]);
});

it.each(["cache", "unavailable"])("surfaces %s catalog status with unknown tool capability", async status => {
    const entries = parseOpenRouterCatalog({ data: [{ id: "private/id", architecture: { output_modalities: ["text"] } }] });
    vi.mocked(fetchChannelCatalog).mockReset().mockResolvedValue({ entries, nextCursor: null, hasMore: false, source: status === "cache" ? "cache" : "network", cacheUnavailable: status === "unavailable" });
    renderModal(channel({ provider: "openrouter" }), []);
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    expect(await screen.findByText(i18n.t(status === "cache" ? "config.catalog.cached" : "config.catalog.cacheUnavailable"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("config.catalog.toolsUnknown"))).toBeInTheDocument();
});

it("shows fal media availability and only fetches schema after a model is selected", async () => {
    const { builtinFalCatalog, refreshFalSchemaCompatibility } = await import("@/services/api/fal-catalog");
    const entries = builtinFalCatalog({ q: "flux-2-pro" }).entries;
    vi.mocked(fetchChannelCatalog).mockReset().mockResolvedValue({ entries, source: "builtin", nextCursor: null, hasMore: false });
    vi.mocked(refreshFalSchemaCompatibility).mockResolvedValue({ availability: "ready", diagnostics: [], metadata: entries[0].metadata, cacheUnavailable: false });
    renderModal(channel({ provider: "fal", apiKey: "", baseUrl: "https://queue.fal.run" }), []);
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    expect(await screen.findByText(i18n.t("fal.catalog.builtin"))).toBeInTheDocument();
    expect(refreshFalSchemaCompatibility).not.toHaveBeenCalled();
    expect(screen.queryByText(i18n.t("config.catalog.toolsUnknown"))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "fal-ai/flux-2-pro" }));
    await waitFor(() => expect(refreshFalSchemaCompatibility).toHaveBeenCalledWith("fal-ai/flux-2-pro"));
    expect(screen.getByText(i18n.t("fal.fields.image_size"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("fal.catalog.refreshSchema") }));
    await waitFor(() => expect(refreshFalSchemaCompatibility).toHaveBeenCalledTimes(2));
});

it("keeps deprecated history selectable for removal and disables unsupported new fal models", async () => {
    const { builtinFalCatalog } = await import("@/services/api/fal-catalog");
    const entry = builtinFalCatalog({ q: "flux-2-pro" }).entries[0];
    vi.mocked(fetchChannelCatalog).mockReset().mockResolvedValue({ entries: [{ ...entry, id: "fal-ai/unknown", availability: "unsupported" }, { ...entry, metadata: { ...entry.metadata, providerStatus: "deprecated" }, availability: "deprecated" }], source: "network", nextCursor: null, hasMore: false });
    renderModal(channel({ provider: "fal" }), [entry.id]);
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    expect(await screen.findByRole("checkbox", { name: "fal-ai/unknown" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: entry.id })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: entry.id })).not.toBeDisabled();
});

it("shows a manually entered unknown fal endpoint as unsupported without selecting it", () => {
    const confirm = renderModal(channel({ provider: "fal" }), []);
    fireEvent.change(screen.getByPlaceholderText("输入模型名称"), { target: { value: "fal-ai/not-reviewed" } });
    fireEvent.click(screen.getByRole("button", { name: "增加模型" }));
    expect(screen.getByRole("checkbox", { name: "fal-ai/not-reviewed" })).toBeDisabled();
    expect(screen.getByText(`未识别 · ${i18n.t("fal.catalog.unsupported")}`)).toBeInTheDocument();
    clickConfirm();
    expect(confirm).toHaveBeenCalledWith([], []);
});

it.each(["pending", "rejected"])("manual exact fal model saves local image capability with %s schema lookup", async state => {
    const { refreshFalSchemaCompatibility } = await import("@/services/api/fal-catalog");
    vi.mocked(refreshFalSchemaCompatibility).mockImplementation(() => state === "pending" ? new Promise(() => {}) : Promise.reject(new Error("offline")));
    const value = channel({ provider: "fal" });
    const confirm = renderModal(value, []);
    fireEvent.change(screen.getByPlaceholderText("输入模型名称"), { target: { value: "fal-ai/nano-banana-2" } });
    fireEvent.click(screen.getByRole("button", { name: "增加模型" }));
    if (state === "rejected") await screen.findByText(i18n.t("fal.catalog.schemaFailed"));
    clickConfirm();
    const [ids, descriptors] = confirm.mock.calls[0];
    expect(descriptors).toEqual([expect.objectContaining({ id: "fal-ai/nano-banana-2", category: "text-to-image" })]);
    const models = mergeCatalogSelection(value, ids, descriptors);
    expect(normalizeAiConfig({ channels: [{ ...value, models }] }).channels[0].models[0]).toMatchObject({ name: "fal-ai/nano-banana-2", capability: "image" });
    expect(mergeCatalogSelection(value, ids, [])[0].capability).toBe("image");
});
