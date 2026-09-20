import { fireEvent, render } from "@testing-library/react";
import { Download } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { IconButton } from "./icon-button";

describe("IconButton", () => {
    it("渲染 aria-label 与图标", () => {
        const { getByRole } = render(<IconButton icon={Download} label="下载" onClick={() => {}} />);
        expect(getByRole("button", { name: "下载" })).toBeTruthy();
    });
    it("loading 时禁点并渲染 spinner", () => {
        const onClick = vi.fn();
        const { getByRole } = render(<IconButton icon={Download} label="下载" loading onClick={onClick} />);
        expect(getByRole("button", { name: "下载" }).className).toContain("opacity-50");
        fireEvent.click(getByRole("button", { name: "下载" }));
        expect(onClick).not.toHaveBeenCalled();
    });
    it("danger 变体挂 text-danger", () => {
        const { getByRole } = render(<IconButton icon={Download} label="删" variant="danger" onClick={() => {}} />);
        expect(getByRole("button", { name: "删" }).className).toContain("text-danger");
    });
});
