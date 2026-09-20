import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, test } from "vitest";

import { HomeProjectPicker } from "@/pages/home/home-project-picker";
import i18n from "@/i18n";
import { useProjectStore } from "@/stores/canvas/use-project-store";

const renderPicker = () => render(
    <I18nextProvider i18n={i18n}>
        <HomeProjectPicker value={null} onChange={() => undefined} />
    </I18nextProvider>,
);

describe("HomeProjectPicker overlays", () => {
    beforeEach(() => {
        useProjectStore.setState({ hydrated: true, projects: [] });
    });

    test("opens the custom new-project dialog from the project menu", async () => {
        renderPicker();

        fireEvent.click(screen.getByRole("button", { name: "选择工作项目" }));
        fireEvent.click(await screen.findByRole("menuitem", { name: "新建项目" }));

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(screen.getByRole("textbox", { name: "项目名称" })).toBeInTheDocument();
    });
});
