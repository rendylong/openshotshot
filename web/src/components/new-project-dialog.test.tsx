import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { useState } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { NewProjectDialog } from "@/components/new-project-dialog";
import i18n from "@/i18n";
import { useProjectStore } from "@/stores/canvas/use-project-store";

// Mirrors real consumers: the parent owns `open` and closes the dialog from its
// onCreate/onClose callbacks; the dialog itself only reports back.
function renderDialog(onCreate: (title: string, icon: string, color: string) => void) {
    function Harness() {
        const [open, setOpen] = useState(true);
        return (
            <I18nextProvider i18n={i18n}>
                <NewProjectDialog
                    open={open}
                    onClose={() => setOpen(false)}
                    onCreate={(title, icon, color) => {
                        onCreate(title, icon, color);
                        setOpen(false);
                    }}
                />
            </I18nextProvider>
        );
    }
    render(<Harness />);
}

describe("NewProjectDialog", () => {
    beforeEach(() => {
        useProjectStore.setState({ hydrated: true, projects: [] });
    });

    test("creates with the entered title, chosen icon and color, then closes", async () => {
        const onCreate = vi.fn();
        renderDialog(onCreate);

        expect(await screen.findByRole("dialog")).toBeInTheDocument();

        fireEvent.change(screen.getByRole("textbox", { name: "项目名称" }), { target: { value: "品牌实验室" } });
        fireEvent.click(screen.getByRole("button", { name: "star" }));
        fireEvent.click(screen.getByRole("button", { name: "#ef4444" }));
        // antd inserts a space between the two CJK characters of the button label.
        fireEvent.click(screen.getByRole("button", { name: /创\s*建/ }));

        expect(onCreate).toHaveBeenCalledTimes(1);
        expect(onCreate).toHaveBeenCalledWith("品牌实验室", "star", "#ef4444");
        // jsdom never fires transitionend, so closing stops at the leave motion
        // state (same assertion style as skills/index.test.tsx).
        await waitFor(() => expect(screen.getByRole("dialog")).toHaveClass("ant-zoom-leave"));
    });
});
