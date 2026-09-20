import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { canvasThemes } from "@/lib/canvas-theme";
import { MentionMenu, type MentionMenuItem } from "./mention-menu";

const reference: MentionMenuItem = { kind: "reference", reference: { id: "n1", nodeId: "n1", kind: "image", label: "图片1", title: "分镜图", previewUrl: "blob:ref", active: true } };
const asset: MentionMenuItem = { kind: "asset", candidate: { assetId: "a1", kind: "image", title: "唐剑", coverUrl: "blob:cover" } };

describe("MentionMenu", () => {
    it("renders group labels and reports the selected item", () => {
        const onSelect = vi.fn();
        render(<MentionMenu groups={[{ label: "画布引用", items: [reference] }, { label: "我的素材", items: [asset] }]} activeIndex={1} theme={Object.values(canvasThemes)[0]} onSelect={onSelect} />);
        expect(screen.getByText("画布引用")).toBeInTheDocument();
        expect(screen.getByText("我的素材")).toBeInTheDocument();
        fireEvent.click(screen.getByText("唐剑"));
        expect(onSelect).toHaveBeenCalledWith(asset);
    });
});
