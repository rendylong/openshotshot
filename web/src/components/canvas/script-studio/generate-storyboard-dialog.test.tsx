import { fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp } from "antd";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { resetManagedCatalogForTests } from "@/lib/desktop/managed-catalog-cache";
import { type CanvasNodeData } from "@/types/canvas";
import { defaultConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-helpers";
import { buildImageGenerationMetadata } from "@/lib/canvas/canvas-node-factory";
import { buildNodeConfig } from "@/lib/canvas/node-config";
import { CapabilityModelPicker } from "@/components/managed-model-picker";
import { resolveManagedModelForCapability } from "@/services/api/model-transport";
import { GenerateStoryboardDialog } from "./generate-storyboard-dialog";

const effective = vi.hoisted(() => ({ config: null as AiConfig | null }));
vi.mock("@/stores/use-config-store", async importOriginal => {
    const actual = await importOriginal<typeof import("@/stores/use-config-store")>();
    return { ...actual, useEffectiveConfig: () => effective.config || actual.defaultConfig };
});
const node: CanvasNodeData = { id: "script", type: "script", title: "Script", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { size: "16:9", quality: "high", count: 1 } };
function setup(count = 1) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const view = render(<I18nextProvider i18n={i18n}><AntApp><GenerateStoryboardDialog node={node} count={count} onConfirm={onConfirm} onCancel={onCancel} /></AntApp></I18nextProvider>);
    return { onConfirm, onCancel, ...view };
}
function managed(models = [
    { id: "other", name: "Other image", capability: "image", execution: "direct" },
    { id: "gpt-image-2/image-to-image", name: "Image 2 Edit", capability: "image", execution: "remote_task" },
]) {
    effective.config = { ...defaultConfig, credentialModes: { ...defaultConfig.credentialModes, image: "shotshot" }, managedModels: { ...defaultConfig.managedModels, image: "other" } };
    useConfigStore.setState({ config: effective.config });
    window.shotshot = { managedModels: { listModels: vi.fn(async () => models) } } as never;
}
afterEach(() => {
    delete window.shotshot;
    resetManagedCatalogForTests();
    useConfigStore.setState({ config: defaultConfig });
    effective.config = null;
});
describe("storyboard confirmation", () => {
    it.each([1, 4])("defaults to catalog Image 2 edit and waits for confirmation (%s shots)", async count => {
        managed();
        const { onConfirm } = setup(count);
        expect(await screen.findByText("Image 2 Edit")).toBeInTheDocument();
        expect(onConfirm).not.toHaveBeenCalled();
        fireEvent.click(screen.getByText(i18n.t("canvas.scriptCompose.confirmGenerate")));
        expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ managedImageModel: "gpt-image-2/image-to-image", metadata: expect.objectContaining({ size: "16:9", quality: "high", count: 1 }) }));
    });
    it("carries confirmation through request resolution, node metadata and the canvas picker", async () => {
        managed();
        const capturedConfig = effective.config!;
        const { onConfirm, unmount } = setup(4);
        await screen.findByText("Image 2 Edit");
        fireEvent.click(screen.getByText(i18n.t("canvas.scriptCompose.confirmGenerate")));
        const settings = onConfirm.mock.calls[0][0];
        expect(useConfigStore.getState().config.managedModels.image).toBe("gpt-image-2/image-to-image");
        const requestConfig = buildGenerationConfig(capturedConfig, { ...node, metadata: settings.metadata }, "image", settings.managedImageModel);
        const generated = { ...node, type: "image", metadata: buildImageGenerationMetadata("edit", requestConfig, 1, []) };
        expect(generated.metadata.model).toBe("gpt-image-2/image-to-image");
        expect((await resolveManagedModelForCapability(requestConfig, "image")).id).toBe("gpt-image-2/image-to-image");
        unmount();
        const panelConfig = buildNodeConfig(useConfigStore.getState().config, generated, "image");
        render(<I18nextProvider i18n={i18n}><AntApp><CapabilityModelPicker config={panelConfig} capability="image" value={panelConfig.model} nodeModel={generated.metadata.model} onChange={vi.fn()} /></AntApp></I18nextProvider>);
        expect(await screen.findByText("Image 2 Edit")).toBeInTheDocument();
        // Later preference changes must not change the already-confirmed batch request,
        // nor what the node displays (node-scoped model wins over the plan preference).
        useConfigStore.getState().updateConfig("managedModels", { ...useConfigStore.getState().config.managedModels, image: "other" });
        expect((await resolveManagedModelForCapability(requestConfig, "image")).id).toBe("gpt-image-2/image-to-image");
        expect(screen.getByText("Image 2 Edit")).toBeInTheDocument();
    });
    it("keeps a changed model local and cancels without generating", async () => {
        managed();
        const { onConfirm, onCancel } = setup();
        fireEvent.click(await screen.findByText("Image 2 Edit"));
        fireEvent.click(await screen.findByText("Other image"));
        expect(useConfigStore.getState().config.managedModels.image).toBe("other");
        fireEvent.click(screen.getByRole("button", { name: /取\s*消|Cancel/ }));
        expect(onCancel).toHaveBeenCalledOnce();
        expect(onConfirm).not.toHaveBeenCalled();
    });
    it("uses the user's selected alternative on confirmation", async () => {
        managed();
        const { onConfirm } = setup();
        fireEvent.click(await screen.findByText("Image 2 Edit"));
        fireEvent.click(await screen.findByText("Other image"));
        fireEvent.click(screen.getByText(i18n.t("canvas.scriptCompose.confirmGenerate")));
        expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ managedImageModel: "other" }));
    });
    it("recognizes public aliases by the catalog display name", async () => {
        managed([
            { id: "other", name: "Other image", capability: "image", execution: "direct" },
            { id: "plan-image-edit", name: "Image 2 图生图", capability: "image", execution: "remote_task" },
        ]);
        const { onConfirm } = setup();
        expect(await screen.findByText("Image 2 图生图")).toBeInTheDocument();
        fireEvent.click(screen.getByText(i18n.t("canvas.scriptCompose.confirmGenerate")));
        expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ managedImageModel: "plan-image-edit" }));
    });
    it("does not invent an unavailable Image 2 model", async () => {
        managed([{ id: "other", name: "Other image", capability: "image", execution: "direct" }]);
        setup();
        expect(await screen.findByText("Other image")).toBeInTheDocument();
        expect(screen.queryByText("Image 2 Edit")).not.toBeInTheDocument();
    });
    it("retains BYOK image settings", () => {
        const { onConfirm } = setup();
        fireEvent.click(screen.getByText(i18n.t("canvas.scriptCompose.confirmGenerate")));
        expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ managedImageModel: undefined, metadata: expect.objectContaining({ model: defaultConfig.imageModel, size: "16:9" }) }));
    });
});
const assetSeedNode: CanvasNodeData = { id: "asset-ref-seed", type: "image", title: "", position: { x: 0, y: 0 }, width: 340, height: 240, metadata: {} };
describe("asset reference scenario", () => {
    function setupAsset() {
        const onConfirm = vi.fn();
        const onCancel = vi.fn();
        render(<I18nextProvider i18n={i18n}><AntApp><GenerateStoryboardDialog node={assetSeedNode} count={1}
            title={i18n.t("canvas.scriptAssets.genDialogTitle")}
            hint={i18n.t("canvas.scriptAssets.genDialogHint", { name: "林小雨" })}
            promptPreview="日系动画女主角"
            maxCount={1} countLocked
            onConfirm={onConfirm} onCancel={onCancel} /></AntApp></I18nextProvider>);
        return { onConfirm, onCancel };
    }
    it("renders asset title/hint/prompt preview and confirms with count locked to 1 (BYOK)", () => {
        const { onConfirm } = setupAsset();
        expect(screen.getByText(i18n.t("canvas.scriptAssets.genDialogTitle"))).toBeInTheDocument();
        expect(screen.getByText(/林小雨/)).toBeInTheDocument();
        expect(screen.getByText("日系动画女主角")).toBeInTheDocument();
        expect(screen.queryByText(i18n.t("settingsPanels.image.images", { count: 2 }))).not.toBeInTheDocument();
        fireEvent.click(screen.getByText(i18n.t("canvas.scriptCompose.confirmGenerate")));
        expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ count: 1 }) }));
    });
    it("keeps managed model resolution and preference write-back in the asset scenario", async () => {
        managed();
        const { onConfirm } = setupAsset();
        expect(await screen.findByText("Image 2 Edit")).toBeInTheDocument();
        fireEvent.click(screen.getByText(i18n.t("canvas.scriptCompose.confirmGenerate")));
        expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ managedImageModel: "gpt-image-2/image-to-image", metadata: expect.objectContaining({ count: 1 }) }));
    });
    it("defaults to storyboard title/hint without the new props", () => {
        setup();
        expect(screen.getByText(i18n.t("canvas.scriptCompose.sbSettingsTitle"))).toBeInTheDocument();
        expect(screen.getByText(i18n.t("canvas.scriptCompose.sbSettingsHint", { count: 1 }))).toBeInTheDocument();
    });
});
