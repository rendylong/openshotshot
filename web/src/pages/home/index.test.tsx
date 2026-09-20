import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, test, vi } from "vitest";

import HomePage from "@/pages/home";
import { UNCATEGORIZED_PROJECT_ID } from "@/lib/canvas/category";
import { createProjectWithCanvas } from "@/lib/canvas/project-model";
import i18n from "@/i18n";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { useHomeComposerStore } from "@/stores/use-home-composer-store";

vi.mock("antd", () => ({
    App: { useApp: () => ({ message: { error: vi.fn() } }) },
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...props}>{children}</button>,
    Modal: ({ open, children }: { open: boolean; children?: React.ReactNode }) => (open ? <div role="dialog">{children}</div> : null),
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("@/components/agent/agent-chat-composer", () => ({
    AgentChatComposer: ({ left }: { left?: React.ReactNode }) => <div>{left}</div>,
}));

const renderHome = () => render(
    <I18nextProvider i18n={i18n}>
        <MemoryRouter>
            <HomePage />
        </MemoryRouter>
    </I18nextProvider>,
);

describe("HomePage project picker", () => {
    beforeEach(() => {
        useHomeComposerStore.getState().resetDraft();
        const inbox = createProjectWithCanvas("Hidden inbox");
        inbox.id = UNCATEGORIZED_PROJECT_ID;
        const regular = createProjectWithCanvas("Brand Lab");
        const writing = createProjectWithCanvas("Writing");
        useProjectStore.setState({ hydrated: true, hydrationStatus: "success", projects: [inbox, regular, writing] });
    });

    test("selects a visible work project without exposing the internal inbox", () => {
        renderHome();

        fireEvent.click(screen.getByRole("button", { name: "选择工作项目" }));
        expect(screen.getByRole("menu")).toBeInTheDocument();
        expect(screen.getByText("新建项目")).toBeInTheDocument();
        expect(screen.getByText("Brand Lab")).toBeInTheDocument();
        expect(screen.queryByText("Hidden inbox")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("menuitemradio", { name: "Brand Lab" }));
        expect(screen.getByRole("button", { name: "当前项目：Brand Lab" })).toBeInTheDocument();
    });

    test("filters the project menu by its search query", () => {
        renderHome();

        fireEvent.click(screen.getByRole("button", { name: "选择工作项目" }));
        fireEvent.change(screen.getByPlaceholderText("搜索项目…"), { target: { value: "brand" } });

        expect(screen.getByRole("menuitemradio", { name: "Brand Lab" })).toBeInTheDocument();
        expect(screen.queryByRole("menuitemradio", { name: "Writing" })).not.toBeInTheDocument();
    });

    test("selects a project created from the picker", () => {
        renderHome();

        fireEvent.click(screen.getByRole("button", { name: "选择工作项目" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "新建项目" }));
        fireEvent.change(screen.getByRole("textbox", { name: "项目名称" }), { target: { value: "Campaign" } });
        fireEvent.click(screen.getByRole("button", { name: "创建" }));

        expect(screen.getByRole("button", { name: "当前项目：Campaign" })).toBeInTheDocument();
    });
});
