import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, test, vi } from "vitest";

import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import i18n from "@/i18n";

function renderToolbar() {
    const props = {
        canvasTool: "select" as const,
        onAddImage: vi.fn(),
        onAddVideo: vi.fn(),
        onAddModel3d: vi.fn(),
        onAddAudio: vi.fn(),
        onAddScript: vi.fn(),
        onAddText: vi.fn(),
        onAddExtensionNode: vi.fn(),
        onUpload: vi.fn(),
        onCanvasToolChange: vi.fn(),
    };

    render(
        <I18nextProvider i18n={i18n}>
            <CanvasToolbar {...props} />
        </I18nextProvider>,
    );

    return props;
}

describe("canvas toolbar", () => {
    test("creates builtin nodes from one add menu and hides removed actions", () => {
        const props = renderToolbar();

        expect(screen.queryByRole("button", { name: i18n.t("canvas.undo") })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: i18n.t("canvas.redo") })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: i18n.t("canvas.toolbar.group") })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: i18n.t("canvas.toolbar.config") })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: i18n.t("canvas.deleteSelected") })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: i18n.t("canvas.toolbar.clear") })).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: i18n.t("canvas.toolbar.add") }));
        fireEvent.click(screen.getByRole("button", { name: i18n.t("canvas.toolbar.image") }));

        expect(props.onAddImage).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("button", { name: i18n.t("canvas.toolbar.video") })).not.toBeInTheDocument();
    });
});

describe("canvas appearance controls", () => {
    test("opens from the top-right viewport controls and changes the background", () => {
        const onBackgroundModeChange = vi.fn();
        render(
            <I18nextProvider i18n={i18n}>
                <CanvasZoomControls
                    scale={1}
                    onReset={vi.fn()}
                    isMiniMapOpen={false}
                    onToggleMiniMap={vi.fn()}
                    backgroundMode="dots"
                    showImageInfo={false}
                    onBackgroundModeChange={onBackgroundModeChange}
                    onShowImageInfoChange={vi.fn()}
                />
            </I18nextProvider>,
        );

        fireEvent.click(screen.getByRole("button", { name: i18n.t("canvas.toolbar.appearance") }));
        fireEvent.click(screen.getByRole("radio", { name: i18n.t("canvas.toolbar.lines") }));

        expect(onBackgroundModeChange).toHaveBeenCalledWith("lines");
    });
});
