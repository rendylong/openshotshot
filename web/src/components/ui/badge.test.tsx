import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./badge";

describe("Badge 变体类表", () => {
    it.each([
        ["default", "bg-foreground/10"],
        ["outline", "border-border"],
        ["success", "text-success"],
        ["warning", "text-warning"],
        ["danger", "text-danger"],
        ["info", "text-info"],
    ])("variant=%s 输出对应类", (variant, cls) => {
        const { getByText } = render(<Badge variant={variant as never}>x</Badge>);
        expect(getByText("x").className).toContain(cls);
    });
});
