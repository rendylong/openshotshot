import { fireEvent, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";

import { CanvasListView } from "@/components/canvas/canvas-list-view";
import { CanvasTopBar } from "@/components/canvas/canvas-top-bar";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import i18n from "@/i18n";

const project = {
    id: "project-1",
    title: "Project One",
    category: "uncategorized",
    icon: "folder",
    color: "#6366f1",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    canvases: [],
};

const projectWithCanvas = {
    ...project,
    canvases: [
        {
            id: "canvas-1",
            title: "Canvas One",
            createdAt: "2026-08-31T00:00:00.000Z",
            updatedAt: "2026-08-31T00:00:00.000Z",
            nodes: [],
            connections: [],
            chatSessions: [],
            activeChatId: null,
            backgroundMode: "lines" as const,
            showImageInfo: false,
            viewport: { x: 0, y: 0, k: 1 },
        },
    ],
};

function CurrentPath() {
    return <span>{useLocation().pathname}</span>;
}

describe("page back navigation", () => {
    test("project detail removes the redundant subtitle and exposes project actions", () => {
        render(
            <I18nextProvider i18n={i18n}>
                <MemoryRouter>
                    <CanvasListView project={project} />
                </MemoryRouter>
            </I18nextProvider>,
        );

        expect(screen.queryByText(i18n.t("projects.detail.subtitle"))).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: i18n.t("projects.more") })).toBeInTheDocument();
    });

    test("project detail shows its badge and reveals canvas actions on hover", () => {
        render(
            <I18nextProvider i18n={i18n}>
                <MemoryRouter>
                    <CanvasListView project={projectWithCanvas} />
                </MemoryRouter>
            </I18nextProvider>,
        );

        const heading = screen.getByRole("heading", { name: "Project One" });
        expect(heading.parentElement?.querySelector("svg")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: i18n.t("common.edit") }).parentElement).toHaveClass("opacity-0", "group-hover:opacity-100");
    });

    test("project detail returns to the project list", () => {
        render(
            <I18nextProvider i18n={i18n}>
                <MemoryRouter initialEntries={["/projects/project-1"]}>
                    <Routes>
                        <Route path="/projects/project-1" element={<CanvasListView project={project} />} />
                        <Route path="/projects" element={<CurrentPath />} />
                    </Routes>
                </MemoryRouter>
            </I18nextProvider>,
        );

        fireEvent.click(screen.getByRole("button", { name: i18n.t("common.back") }));
        expect(screen.getByText("/projects")).toBeInTheDocument();
    });

    test("canvas top bar leaves the left side empty", () => {
        render(
            <I18nextProvider i18n={i18n}>
                <MemoryRouter initialEntries={["/canvas/project-1/canvas-1"]}>
                    <CanvasTopBar
                        agentOpen={false}
                        onToggleAgent={vi.fn()}
                        viewportControls={(
                            <CanvasZoomControls
                                scale={1}
                                onReset={vi.fn()}
                                isMiniMapOpen={false}
                                onToggleMiniMap={vi.fn()}
                                backgroundMode="lines"
                                showImageInfo={false}
                                onBackgroundModeChange={vi.fn()}
                                onShowImageInfoChange={vi.fn()}
                            />
                        )}
                    />
                </MemoryRouter>
            </I18nextProvider>,
        );

        expect(screen.queryByRole("button", { name: i18n.t("common.back") })).not.toBeInTheDocument();
        expect(screen.getByRole("toolbar", { name: i18n.t("canvas.topControls") })).toBeInTheDocument();
    });

    test("canvas keeps viewport controls in the top bar and renders top actions as icons", () => {
        render(
            <I18nextProvider i18n={i18n}>
                <MemoryRouter initialEntries={["/canvas/project-1/canvas-1"]}>
                    <CanvasTopBar
                        agentOpen={false}
                        onToggleAgent={vi.fn()}
                        viewportControls={(
                            <CanvasZoomControls
                                scale={1}
                                onReset={vi.fn()}
                                isMiniMapOpen={false}
                                onToggleMiniMap={vi.fn()}
                                backgroundMode="lines"
                                showImageInfo={false}
                                onBackgroundModeChange={vi.fn()}
                                onShowImageInfoChange={vi.fn()}
                            />
                        )}
                    />
                </MemoryRouter>
            </I18nextProvider>,
        );

        const controls = screen.getByRole("toolbar", { name: i18n.t("canvas.topControls") });
        expect(screen.queryByText("Canvas One")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: i18n.t("common.back") })).not.toBeInTheDocument();
        expect(within(controls).getByText("100%")).toBeInTheDocument();
        for (const name of [i18n.t("canvas.resources"), i18n.t("canvas.openAgent")]) {
            expect(screen.getByRole("button", { name })).toHaveTextContent(/^$/);
        }
    });
});
