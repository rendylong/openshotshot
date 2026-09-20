import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, test, vi } from "vitest";

import { SettingsPopover } from "@/components/layout/settings-popover";
import i18n from "@/i18n";

// antd's Popover portals and relies on browser layout APIs that jsdom does not
// model. Replace it with a controlled passthrough so this test exercises our
// own menu semantics (aria attributes, open/close, focus return) rather than
// antd internals.
vi.mock("antd", () => ({
    Popover: ({ children, content, open, onOpenChange, afterOpenChange }: { children: React.ReactNode; content: React.ReactNode; open: boolean; onOpenChange?: (open: boolean) => void; afterOpenChange?: (visible: boolean) => void }) => (
        <>
            <span onClick={() => { onOpenChange?.(!open); afterOpenChange?.(!open); }}>{children}</span>
            {open ? <div role="menu">{content}</div> : null}
        </>
    ),
}));

const renderPopover = (onOpenChange?: (open: boolean) => void) =>
    render(
        <I18nextProvider i18n={i18n}>
            <SettingsPopover onOpenChange={onOpenChange} />
        </I18nextProvider>,
    );

describe("SettingsPopover", () => {
    test("trigger exposes menu semantics and a collapsed state", () => {
        renderPopover();
        const trigger = screen.getByRole("button", { name: "设置" });
        expect(trigger).toHaveAttribute("aria-haspopup", "menu");
        expect(trigger).toHaveAttribute("aria-expanded", "false");
    });

    test("clicking the trigger opens the menu and expands", () => {
        renderPopover();
        fireEvent.click(screen.getByRole("button", { name: "设置" }));
        expect(screen.getByRole("button", { name: "设置" })).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByRole("menu")).toBeInTheDocument();
        expect(screen.getByText("模型与 API 配置")).toBeInTheDocument();
        expect(screen.getByText("帮助与文档")).toBeInTheDocument();
    });

    test("closing the menu collapses the trigger", () => {
        renderPopover();
        const trigger = screen.getByRole("button", { name: "设置" });
        fireEvent.click(trigger);
        fireEvent.click(screen.getByRole("button", { name: "设置" }));
        expect(screen.getByRole("button", { name: "设置" })).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    test("reports active state so the sidebar can stay expanded", () => {
        const onOpenChange = vi.fn();
        renderPopover(onOpenChange);
        fireEvent.click(screen.getByRole("button", { name: "设置" }));
        expect(onOpenChange).toHaveBeenCalledWith(true);
    });

    test("collapsed mode keeps only the gear trigger", () => {
        render(
            <I18nextProvider i18n={i18n}>
                <SettingsPopover collapsed />
            </I18nextProvider>,
        );
        const trigger = screen.getByRole("button", { name: "设置" });
        expect(trigger).toHaveClass("w-10", "justify-center");
        // 侧栏折叠态：只留齿轮图标，无文字
        expect(trigger).not.toHaveTextContent("设置");
    });
});
