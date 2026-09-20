import { fireEvent, render, screen } from "@testing-library/react";
import { message } from "antd";
import { useState, type ComponentProps } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

import { ImageSettingsPanel } from "./image-settings-panel";
import { resolveManagedSpecSize } from "@/services/api/image";
import { canvasThemes } from "@/lib/canvas-theme";
import { ensureManagedCatalog, resetManagedCatalogForTests } from "@/lib/desktop/managed-catalog-cache";
import type { ManagedModelDescriptor } from "@/lib/desktop/managed-model-types";
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

// —— 托管（shotshot）按模型 spec 渲染 ——
const managedImageModel = (spec?: ManagedModelDescriptor["spec"]): ManagedModelDescriptor => ({ id: "managed-image", name: "Managed Image", capability: "image", execution: "direct", spec });

function mockManagedCatalog(models: ManagedModelDescriptor[]) {
    window.shotshot = {
        agent: {} as never,
        skills: {} as never,
        platform: "darwin",
        managedModels: { listModels: vi.fn(async () => models), fetch: vi.fn(), abort: vi.fn() },
    } as never;
}

function shotshotImageConfig(overrides: Partial<AiConfig> = {}): AiConfig {
    return {
        ...baseConfig,
        ...overrides,
        credentialMode: "shotshot",
        credentialModes: { ...defaultConfig.credentialModes, image: "shotshot" },
        managedModels: { ...defaultConfig.managedModels, image: "managed-image", ...overrides.managedModels },
    };
}

afterEach(() => {
    delete window.shotshot;
    resetManagedCatalogForTests();
});

describe("ImageSettingsPanel 托管模型按 spec 渲染", () => {
    beforeEach(() => { void i18n.changeLanguage("zh-CN"); });

    it("仅分辨率轴：只渲染声明的比例与 1K/2K/4K，不渲染质量控件", async () => {
        mockManagedCatalog([managedImageModel({ aspectRatios: ["1:1", "16:9"], resolutions: ["1K", "2K", "4K"], qualities: [] })]);
        await ensureManagedCatalog();
        const onConfigChange = vi.fn();
        renderPanel({ config: { ...shotshotImageConfig(), size: "1:1", quality: "2K" } }, onConfigChange);

        expect(screen.getByRole("button", { name: "1K" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "2K" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "4K" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "标准" })).toBeNull();
        expect(screen.queryByRole("button", { name: "极致" })).toBeNull();
        // 比例只列 spec.aspectRatios：全局表中的 3:2 与 AUTO 不出现
        expect(screen.getByRole("button", { name: "16:9" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "3:2" })).toBeNull();
        expect(screen.queryByText("AUTO")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "16:9" }));
        expect(onConfigChange).toHaveBeenCalledWith("size", "16:9");
        fireEvent.click(screen.getByRole("button", { name: "2K" }));
        expect(onConfigChange).toHaveBeenCalledWith("quality", "2K");
    });

    it("仅质量轴：渲染标准/精细/极致，不渲染分辨率控件", async () => {
        mockManagedCatalog([managedImageModel({ aspectRatios: ["1:1"], resolutions: [], qualities: ["standard", "fine", "ultra"] })]);
        await ensureManagedCatalog();
        const onConfigChange = vi.fn();
        renderPanel({ config: { ...shotshotImageConfig(), quality: "fine" } }, onConfigChange);

        expect(screen.getByRole("button", { name: "标准" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "精细" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "极致" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "1K" })).toBeNull();
        expect(screen.queryByRole("button", { name: "4K" })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "极致" }));
        expect(onConfigChange).toHaveBeenCalledWith("quality", "ultra");
    });

    it("仅有比例轴：只渲染比例，无第二轴控件", async () => {
        mockManagedCatalog([managedImageModel({ aspectRatios: ["1:1", "4:3"], resolutions: [], qualities: [] })]);
        await ensureManagedCatalog();
        renderPanel({ config: { ...shotshotImageConfig(), size: "4:3" } });

        expect(screen.getByRole("button", { name: "4:3" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "1:1" })).toBeTruthy();
        expect(screen.queryByText("质量")).toBeNull();
        expect(screen.queryByRole("button", { name: "1K" })).toBeNull();
        expect(screen.queryByRole("button", { name: "标准" })).toBeNull();
    });

    it("双轴模型：整体不可用并给出原因，不静默单轴渲染", async () => {
        mockManagedCatalog([managedImageModel({ aspectRatios: ["1:1"], resolutions: ["1K", "2K"], qualities: ["standard", "fine"] })]);
        await ensureManagedCatalog();
        renderPanel({ config: shotshotImageConfig() });

        expect(screen.getByText(/同时提供分辨率与质量/)).toBeTruthy();
        expect(screen.queryByRole("button", { name: "1K" })).toBeNull();
        expect(screen.queryByRole("button", { name: "标准" })).toBeNull();
        expect(screen.queryByRole("button", { name: "1:1" })).toBeNull();
    });

    it("未声明的档位 disabled + aria-disabled + 原因文案", async () => {
        mockManagedCatalog([managedImageModel({ aspectRatios: ["1:1"], resolutions: ["1K", "2K"], qualities: [] })]);
        await ensureManagedCatalog();
        renderPanel({ config: { ...shotshotImageConfig(), quality: "2K" } });

        const fourK = screen.getByRole("button", { name: "4K" });
        expect(fourK.hasAttribute("disabled")).toBe(true);
        expect(fourK.getAttribute("aria-disabled")).toBe("true");
        expect(fourK.getAttribute("title")).toContain("4K");
        expect(screen.getByText("该模型不支持 4K")).toBeTruthy();
        expect(screen.getByRole("button", { name: "1K" }).hasAttribute("disabled")).toBe(false);
    });

    it("目录未水合（null）时回退固定比例子集且不崩溃", () => {
        renderPanel({ config: shotshotImageConfig() });
        // 托管线路无法表达 AUTO 与自定义 W×H，回退路径也不再提供（Finding B）。
        expect(screen.queryByText("AUTO")).toBeNull();
        expect(screen.queryByText("3:2")).toBeNull();
        expect(screen.getByRole("button", { name: "1:1" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "16:9" })).toBeTruthy();
        expect(screen.queryByText("自定义尺寸")).toBeNull();
        expect(screen.getByRole("button", { name: /^中/ })).toBeTruthy();
    });

    it("目录读取失败（error）时回退固定比例子集且不崩溃", async () => {
        window.shotshot = {
            agent: {} as never,
            skills: {} as never,
            platform: "darwin",
            managedModels: { listModels: vi.fn(async () => { throw new Error("managed_catalog_unavailable"); }), fetch: vi.fn(), abort: vi.fn() },
        } as never;
        await ensureManagedCatalog().catch(() => undefined);
        renderPanel({ config: shotshotImageConfig() });
        expect(screen.queryByText("AUTO")).toBeNull();
        expect(screen.getByRole("button", { name: "4:3" })).toBeTruthy();
        expect(screen.getByRole("button", { name: /^高/ })).toBeTruthy();
    });

    it("spec 存在但所有轴为空时回退固定比例子集且不崩溃", async () => {
        mockManagedCatalog([managedImageModel({ aspectRatios: [], resolutions: [], qualities: [] })]);
        await ensureManagedCatalog();
        renderPanel({ config: shotshotImageConfig() });
        expect(screen.queryByText("AUTO")).toBeNull();
        expect(screen.queryByText("3:2")).toBeNull();
        expect(screen.getByRole("button", { name: "9:16" })).toBeTruthy();
        expect(screen.getByRole("button", { name: /^高/ })).toBeTruthy();
    });

    it("声明但词表之外的 token 也渲染（不静默消失），已知未声明档位仍灰置", async () => {
        mockManagedCatalog([managedImageModel({ aspectRatios: ["1:1"], resolutions: ["512", "1K"], qualities: [] })]);
        await ensureManagedCatalog();
        renderPanel({ config: { ...shotshotImageConfig(), quality: "512" } });

        const declaredUnknown = screen.getByRole("button", { name: "512" });
        expect(declaredUnknown.hasAttribute("disabled")).toBe(false);
        expect(declaredUnknown.getAttribute("aria-pressed")).toBe("true");
        expect(screen.getByRole("button", { name: "1K" }).hasAttribute("disabled")).toBe(false);
        expect(screen.getByRole("button", { name: "2K" }).hasAttribute("disabled")).toBe(true);
        expect(screen.getByRole("button", { name: "4K" }).hasAttribute("disabled")).toBe(true);
        expect(screen.getByText("该模型不支持 2K、4K")).toBeTruthy();
    });

    it("en-US 下多档位禁用原因使用本地化分隔符", async () => {
        void i18n.changeLanguage("en-US");
        mockManagedCatalog([managedImageModel({ aspectRatios: ["1:1"], resolutions: ["1K"], qualities: [] })]);
        await ensureManagedCatalog();
        renderPanel({ config: { ...shotshotImageConfig(), quality: "1K" } });
        expect(screen.getByText("This model does not support 2K, 4K")).toBeTruthy();
        void i18n.changeLanguage("zh-CN");
    });

    it("目录已水合但无图片模型时回退固定比例子集且不崩溃", async () => {
        mockManagedCatalog([{ id: "managed-video", name: "Managed Video", capability: "video", execution: "direct" }]);
        await ensureManagedCatalog();
        renderPanel({ config: shotshotImageConfig() });
        expect(screen.queryByText("AUTO")).toBeNull();
        expect(screen.queryByText("3:2")).toBeNull();
        expect(screen.getByRole("button", { name: "1:1" })).toBeTruthy();
        expect(screen.getByRole("button", { name: /^高/ })).toBeTruthy();
    });

    it("remote_task 图片模型按 spec 渲染，面板写入声明档位使 canonical 键可组装", async () => {
        // 分派器按 model.execution 选适配器，remote_task 图片模型同样可执行，因此必须渲染其声明轴。
        const spec = { aspectRatios: ["1:1"], resolutions: ["1K"], qualities: [] };
        mockManagedCatalog([{ id: "managed-image", name: "Managed Image", capability: "image", execution: "remote_task", spec }]);
        await ensureManagedCatalog();
        const onConfigChange = vi.fn();
        renderPanel({ config: { ...shotshotImageConfig(), size: "1:1", quality: "high" } }, onConfigChange);

        // 声明的分辨率轴渲染成可用控件（旧行为会因 execution=direct 过滤而回退全局表格）。
        expect(screen.getByText("分辨率")).toBeTruthy();
        expect(screen.getByRole("button", { name: "1K" }).hasAttribute("disabled")).toBe(false);
        expect(screen.queryByText("质量")).toBeNull();

        // 面板与请求边界都把未声明的 high 归一为首个声明值；不打开面板的入口也能生成合法键。
        expect(onConfigChange).toHaveBeenCalledWith("quality", "1K");
        expect(resolveManagedSpecSize({ ...shotshotImageConfig(), size: "1:1", quality: "high" }, spec)).toBe("1:1|1K");
        expect(resolveManagedSpecSize({ ...shotshotImageConfig(), size: "1:1", quality: "1K" }, spec)).toBe("1:1|1K");
    });

    it("默认 quality=auto + 声明第二轴的模型：面板写入第一个声明值且键携带它（Finding A）", async () => {
        const spec = { aspectRatios: ["1:1"], resolutions: ["1K", "2K", "4K"], qualities: [] };
        mockManagedCatalog([managedImageModel(spec)]);
        await ensureManagedCatalog();
        const onConfigChange = vi.fn();
        renderPanel({ config: { ...shotshotImageConfig(), size: "1:1", quality: "auto" } }, onConfigChange);

        expect(onConfigChange).toHaveBeenCalledWith("quality", "1K");
        // 面板写回后，请求路径用声明值组装 canonical key，而不是裸比例。
        expect(resolveManagedSpecSize({ ...shotshotImageConfig(), size: "1:1", quality: "1K" }, spec)).toBe("1:1|1K");
    });

    it("非声明 quality 不由面板或请求边界改写成裸比例", async () => {
        const spec = { aspectRatios: ["1:1"], resolutions: ["1K", "2K"], qualities: [] };
        mockManagedCatalog([managedImageModel(spec)]);
        await ensureManagedCatalog();
        const onConfigChange = vi.fn();
        renderPanel({ config: { ...shotshotImageConfig(), size: "1:1", quality: "4K" } }, onConfigChange);
        // 4K 未声明 → 面板改写成第一个声明值 1K（不是静默留空让请求发裸比例）。
        expect(onConfigChange).toHaveBeenCalledWith("quality", "1K");
        expect(resolveManagedSpecSize({ ...shotshotImageConfig(), size: "1:1", quality: "4K" }, spec)).toBe("1:1|1K");
    });

    it("BYOK 回归：仍用全局表格（AUTO/3:2/低中高）", () => {
        renderPanel();
        expect(screen.getByText("AUTO")).toBeTruthy();
        expect(screen.getByText("3:2")).toBeTruthy();
        expect(screen.getByText("1K")).toBeTruthy();
        expect(screen.getByRole("button", { name: /低/ })).toBeTruthy();
    });
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
