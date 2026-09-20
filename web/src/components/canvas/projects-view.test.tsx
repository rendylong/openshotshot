import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { ProjectsView } from "@/components/canvas/projects-view";
import { UNCATEGORIZED_PROJECT_ID } from "@/lib/canvas/category";
import { createProjectWithCanvas } from "@/lib/canvas/project-model";
import i18n from "@/i18n";
import { useProjectStore } from "@/stores/canvas/use-project-store";

vi.mock("antd", () => ({
    App: { useApp: () => ({ message: { success: vi.fn(), error: vi.fn() } }) },
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...props}>{children}</button>,
}));

vi.mock("@/components/canvas/canvas-project-card", () => ({
    CanvasProjectCard: ({ project }: { project: { title: string } }) => <article>{project.title}</article>,
}));
vi.mock("@/components/new-project-dialog", () => ({ NewProjectDialog: () => null }));
vi.mock("@/components/canvas/canvas-delete-projects-dialog", () => ({ CanvasDeleteProjectsDialog: () => null }));

const renderProjects = () => render(
    <I18nextProvider i18n={i18n}>
        <MemoryRouter>
            <ProjectsView />
        </MemoryRouter>
    </I18nextProvider>,
);

describe("ProjectsView", () => {
    beforeEach(() => {
        const inbox = createProjectWithCanvas("First home prompt");
        inbox.id = UNCATEGORIZED_PROJECT_ID;
        const regular = createProjectWithCanvas("Brand Lab");
        useProjectStore.setState({ hydrated: true, projects: [inbox, regular] });
    });

    test("hides the internal uncategorized canvas container from the project list", () => {
        renderProjects();

        expect(screen.queryByText("First home prompt")).not.toBeInTheDocument();
        expect(screen.getByText("Brand Lab")).toBeInTheDocument();
    });

    test("offers project creation without bulk deletion or canvas import actions", () => {
        renderProjects();

        expect(screen.getByRole("button", { name: /新建项目|New project/i })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /删除全部|Delete all/i })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /导入画布|Import canvas/i })).not.toBeInTheDocument();
    });
});
