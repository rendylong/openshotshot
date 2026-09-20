import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp } from "antd";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, test, vi } from "vitest";
import i18n from "@/i18n";

import { ModelPicker } from "./model-picker";
import { createModelChannel, defaultConfig, modelOptionsFromChannels, useConfigStore } from "@/stores/use-config-store";

const config = {
    ...defaultConfig,
    channels: [
        { id: "c1", name: "官方渠道", provider: "custom", baseUrl: "https://x", apiKey: "k", apiFormat: "openai", models: [{ name: "gpt-image-2", capability: "image" }, { name: "doubao-seedream", capability: "image" }] },
        { id: "c2", name: "OpenRouter", provider: "openrouter", baseUrl: "https://or", apiKey: "k", apiFormat: "openai", models: [{ name: "gemini-2.5-flash-image", capability: "image" }] },
    ],
    models: ["c1::gpt-image-2", "c1::doubao-seedream", "c2::gemini-2.5-flash-image"],
} as never;

function renderPicker() {
    useConfigStore.setState({ config: { ...defaultConfig, imageModel: "c1::gpt-image-2" } });
    return render(
        <I18nextProvider i18n={i18n}>
            <ModelPicker config={config} value="c2::gemini-2.5-flash-image" capability="image" onChange={vi.fn()} />
        </I18nextProvider>
    );
}

describe("ModelPicker 改版（D18-D20）", () => {
    beforeEach(() => { void i18n.changeLanguage("zh-CN"); });

    it("展开后按渠道分组且默认徽标落在 imageModel 上", async () => {
        renderPicker();
        fireEvent.click(screen.getByRole("button"));
        expect(await screen.findByText("官方渠道")).toBeTruthy();
        expect(screen.getByText("OpenRouter")).toBeTruthy();
        expect(screen.getByText("默认")).toBeTruthy();
    });
    it("搜索过滤模型", async () => {
        renderPicker();
        fireEvent.click(screen.getByRole("button"));
        fireEvent.change(await screen.findByPlaceholderText(/搜索/), { target: { value: "gemini" } });
        expect((await screen.findAllByText(/gemini-2.5-flash-image/)).length).toBeGreaterThan(0);
        expect(screen.queryByText(/gpt-image-2/)).toBeNull();
    });
    it("hover 按钮点击后写入默认模型字段", async () => {
        const spy = vi.spyOn(useConfigStore.getState(), "updateConfig");
        renderPicker();
        fireEvent.click(screen.getByRole("button"));
        const btn = await screen.findAllByRole("button", { name: /设为默认/ });
        // jsdom 不加载 Tailwind，行按钮的可访问名也包含「设为默认」文案；只点行内 span（显式 role=button）
        const star = btn.find((el) => el.tagName === "SPAN");
        expect(star).toBeTruthy();
        fireEvent.click(star!);
        expect(spy).toHaveBeenCalledWith("imageModel", expect.any(String));
        spy.mockRestore();
    });
    it("agent 用途下 openrouter 无工具模型被过滤并渲染提示行", async () => {
        const router = createModelChannel({ id: "router", provider: "openrouter", models: [
            { name: "a/tools", capability: "text", catalog: { version: 1, source: "provider_models", providerStatus: "active", supportsTools: true } },
            { name: "a/unknown", capability: "text" },
            { name: "a/no-tools", capability: "text", catalog: { version: 1, source: "provider_models", providerStatus: "active", supportsTools: false } },
        ] });
        const other = createModelChannel({ id: "other", name: "Other", provider: "custom", models: [{ name: "existing", capability: "text" }] });
        const agentConfig = { ...defaultConfig, channels: [router, other], models: modelOptionsFromChannels([router, other]) } as never;
        render(
            <I18nextProvider i18n={i18n}>
                <ModelPicker config={agentConfig} capability="text" purpose="agent" onChange={vi.fn()} />
            </I18nextProvider>
        );
        fireEvent.click(screen.getByRole("button"));
        expect(await screen.findByRole("button", { name: /a\/tools/ })).toBeTruthy();
        expect(screen.getByRole("button", { name: /existing/ })).toBeTruthy();
        expect(screen.queryByRole("button", { name: /a\/no-tools/ })).toBeNull();
        expect(screen.queryByRole("button", { name: /a\/unknown/ })).toBeNull();
        expect(screen.getByText(/需要已确认的工具调用能力/)).toBeTruthy();
    });
    it("extraOptions 渲染在分组之前，点击回传 value 且不出「设为默认」", async () => {
        const onChange = vi.fn();
        const channel = createModelChannel({ id: "c9", name: "官方渠道", models: [{ name: "gpt-5", capability: "text" }] });
        const textConfig = { ...defaultConfig, channels: [channel], models: modelOptionsFromChannels([channel]) } as never;
        render(
            <I18nextProvider i18n={i18n}>
                <ModelPicker
                    config={textConfig}
                    value="chatgpt-option-0"
                    capability="text"
                    purpose="agent"
                    onChange={onChange}
                    extraOptions={[
                        { value: "chatgpt-option-0", label: "ChatGPT · gpt-5" },
                        { value: "chatgpt-option-1", label: "ChatGPT · o4-mini", disabled: true },
                    ]}
                />
            </I18nextProvider>
        );
        fireEvent.click(screen.getByRole("button"));
        const managed = await screen.findByRole("button", { name: /ChatGPT · gpt-5/ });
        const disabledOption = screen.getByRole("button", { name: /ChatGPT · o4-mini/ });
        expect(disabledOption).toHaveAttribute("disabled");
        // 顶部语义：extraOptions 行位于渠道分组标题之前
        const groupHeader = screen.getByText("官方渠道");
        expect(Boolean(managed.compareDocumentPosition(groupHeader) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
        // extraOptions 无 capability 默认语义，不出现「设为默认」
        expect(within(managed).queryByText(/设为默认/)).toBeNull();
        fireEvent.click(managed);
        expect(onChange).toHaveBeenCalledWith("chatgpt-option-0");
    });
    it("弹层内 pointerdown/mousedown 不冒泡到画布容器（防背景点击 setPointerCapture 劫持回归）", async () => {
        const onPointerDown = vi.fn();
        const onMouseDown = vi.fn();
        const onChange = vi.fn();
        useConfigStore.setState({ config: { ...defaultConfig, imageModel: "c1::gpt-image-2" } });
        render(
            <div onPointerDown={onPointerDown} onMouseDown={onMouseDown}>
                <I18nextProvider i18n={i18n}>
                    <ModelPicker config={config} value="c2::gemini-2.5-flash-image" capability="image" onChange={onChange} />
                </I18nextProvider>
            </div>
        );
        fireEvent.click(screen.getByRole("button"));
        const row = await screen.findByRole("button", { name: /doubao-seedream/ });
        // 画布容器（shotshot.tsx）位于组件树上游：弹层内容若不放行冒泡，pointerdown 会被判成背景点击并劫持后续 click
        fireEvent.pointerDown(row);
        fireEvent.mouseDown(row);
        expect(onPointerDown).not.toHaveBeenCalled();
        expect(onMouseDown).not.toHaveBeenCalled();
        fireEvent.click(row);
        expect(onChange).toHaveBeenCalledWith("c1::doubao-seedream");
    });
});

describe("ModelPicker extraOnly mode", () => {
    const options = [
        { value: "shotshot-image-pro", label: "ShotShot Image Pro" },
        { value: "shotshot-image-lite", label: "ShotShot Image Lite" },
    ];

    function pick(props: Partial<React.ComponentProps<typeof ModelPicker>> = {}) {
        return render(
            <I18nextProvider i18n={i18n}>
                <QueryClientProvider client={new QueryClient()}><AntApp>
                    <ModelPicker config={defaultConfig} value="shotshot-image-pro" currentLabel="ShotShot Image Pro" capability="image" extraOnly extraOptionsHeader="套餐内图片模型（2）" extraOptions={options} onChange={vi.fn()} {...props} />
                </AntApp></QueryClientProvider>
            </I18nextProvider>,
        );
    }

    test("lists only managed catalog options under the header", async () => {
        pick();
        // antd Popover trigger="click" 只监听 onClick（pointerDown 仅适用于 Radix DropdownMenu）
        fireEvent.click(screen.getByText("ShotShot Image Pro"), { button: 0 });
        expect(await screen.findByText("套餐内图片模型（2）")).toBeInTheDocument();
        expect(screen.getByText("ShotShot Image Lite")).toBeInTheDocument();
        expect(screen.queryByText("渠道与模型设置")).not.toBeInTheDocument();
    });

    test("commits the picked managed model id", async () => {
        const onChange = vi.fn();
        pick({ onChange });
        fireEvent.click(screen.getByText("ShotShot Image Pro"), { button: 0 });
        fireEvent.click(await screen.findByText("ShotShot Image Lite"));
        expect(onChange).toHaveBeenCalledWith("shotshot-image-lite");
    });
});
