import { App } from "antd";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, test } from "vitest";

import { CanvasResourcesDrawer } from "@/components/canvas/canvas-resources-drawer";
import i18n from "@/i18n";
import { useCanvasSidePanelStore } from "@/stores/use-canvas-side-panel-store";

const renderDrawer = () =>
    render(
        <App>
            <I18nextProvider i18n={i18n}>
                <CanvasResourcesDrawer
                    nodes={[]}
                    selectedNodeIds={new Set()}
                    onFocusNode={() => {}}
                    onPreviewNode={() => {}}
                    onInsertAsset={() => {}}
                />
            </I18nextProvider>
        </App>,
    );

beforeEach(() => {
    useCanvasSidePanelStore.setState({ panelOpen: true, panelMounted: true });
    i18n.changeLanguage("zh-CN");
});

describe("CanvasResourcesDrawer", () => {
    test("shows the canvas and assets tabs when open", () => {
        renderDrawer();
        expect(screen.getByText(i18n.t("canvas.sidePanel.canvas"))).toBeInTheDocument();
        expect(screen.getByText(i18n.t("canvas.sidePanel.assets"))).toBeInTheDocument();
    });

    test("does not render the prompt library tab", () => {
        renderDrawer();
        expect(screen.queryByText("Prompt Library")).not.toBeInTheDocument();
        expect(screen.queryByText("提示词库")).not.toBeInTheDocument();
    });

    test("renders nothing when closed", () => {
        useCanvasSidePanelStore.setState({ panelOpen: false, panelMounted: false });
        renderDrawer();
        expect(screen.queryByText(i18n.t("canvas.sidePanel.canvas"))).not.toBeInTheDocument();
        expect(screen.queryByText(i18n.t("canvas.sidePanel.assets"))).not.toBeInTheDocument();
    });

    test("close button hides the drawer", () => {
        renderDrawer();
        fireEvent.click(screen.getByRole("button", { name: i18n.t("canvas.resourcesClose") }));
        expect(screen.queryByText(i18n.t("canvas.sidePanel.canvas"))).not.toBeInTheDocument();
        expect(screen.queryByText(i18n.t("canvas.sidePanel.assets"))).not.toBeInTheDocument();
    });
});
