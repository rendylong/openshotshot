import { fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp } from "antd";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { type CanvasNodeData } from "@/types/canvas";
import { defaultConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";
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
afterEach(() => {
    delete window.shotshot;
    useConfigStore.setState({ config: defaultConfig });
    effective.config = null;
});
describe("storyboard confirmation", () => {
    it.each([1, 4])("keeps node metadata and waits for confirmation (%s shots)", count => {
        const { onConfirm } = setup(count);
        expect(onConfirm).not.toHaveBeenCalled();
        fireEvent.click(screen.getByText(i18n.t("canvas.scriptCompose.confirmGenerate")));
        expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ size: "16:9", quality: "high", count: 1 }) }));
    });
    it("retains BYOK image settings", () => {
        const { onConfirm } = setup();
        fireEvent.click(screen.getByText(i18n.t("canvas.scriptCompose.confirmGenerate")));
        expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ model: defaultConfig.imageModel, size: "16:9" }) }));
    });
    it("keeps a changed model local and cancels without generating", () => {
        const { onConfirm, onCancel } = setup();
        fireEvent.click(screen.getByRole("button", { name: /取\s*消|Cancel/ }));
        expect(onCancel).toHaveBeenCalledOnce();
        expect(onConfirm).not.toHaveBeenCalled();
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
    it("defaults to storyboard title/hint without the new props", () => {
        setup();
        expect(screen.getByText(i18n.t("canvas.scriptCompose.sbSettingsTitle"))).toBeInTheDocument();
        expect(screen.getByText(i18n.t("canvas.scriptCompose.sbSettingsHint", { count: 1 }))).toBeInTheDocument();
    });
});
