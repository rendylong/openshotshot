import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";

import i18n from "@/i18n";
import type { ScriptShot } from "@/types/script-node";
import { ShotListRow } from "./shot-list-row";

const baseShot: ScriptShot = {
    shotId: "s1", no: 3, origin: "generated", shotSize: "近景", angle: "平视",
    movement: "缓慢推近至猫咪面部，跟随爪部动作轻微上摇", duration: 4, mood: "清爽", sfx: "水声",
    dialogue: "嗯？今天吃什么", descriptionRich: [
        { t: "text", v: "水流冲洗" },
        { t: "ref", entityId: "e1" },
        { t: "text", v: "，水珠飞溅" },
    ],
    description: "水流冲洗新鲜食材，水珠飞溅", entityRefs: ["e1"], composed: true,
};

const renderRow = (over: Partial<Parameters<typeof ShotListRow>[0]> = {}) => {
    const props = {
        shot: baseShot,
        selected: false,
        entities: [{ id: "e1", name: "新鲜食材", group: "item" as const, ready: true }],
        storyboardState: "ready" as const,
        thumb: "data:image/png;base64,x",
        refCount: 1,
        onSelect: vi.fn(),
        ...over,
    };
    render(
        <I18nextProvider i18n={i18n}>
            <ShotListRow {...props} />
        </I18nextProvider>,
    );
    return props;
};

describe("ShotListRow", () => {
    it("描述富段按语序渲染内联引用芯片（非独立行）", () => {
        renderRow();
        const desc = screen.getByTestId("shot-desc");
        expect(desc.textContent).toContain("水流冲洗");
        expect(desc.querySelector(".iref")?.textContent).toBe("@新鲜食材");
        expect(desc.textContent?.indexOf("水流冲洗")).toBeLessThan(desc.textContent?.indexOf("@新鲜食材") ?? 0);
    });

    it("元信息逐值渲染且长运镜值被省略截断（title 保留全文）", () => {
        renderRow();
        const mv = screen.getByTitle("缓慢推近至猫咪面部，跟随爪部动作轻微上摇");
        expect(mv.className).toContain("truncate");
        expect(screen.getByText("4s")).toBeInTheDocument();
    });

    it("状态 chips：台词 + 资产引用 + 分镜图就绪不显 chip", () => {
        renderRow();
        expect(screen.getByText("有台词")).toBeInTheDocument();
        expect(screen.getByText("已引用 1 个资产")).toBeInTheDocument();
        expect(screen.queryByText(/分镜图/)).not.toBeInTheDocument();
    });

    it("分镜图失败显 danger chip；无图显「镜号+景别」虚线格", () => {
        renderRow({ storyboardState: "error", thumb: undefined });
        expect(screen.getByText("分镜图失败")).toBeInTheDocument();
        // 镜号/景别同时出现在行首列与虚线格（虚线格复述镜号+景别），用 getAllByText 断言存在
        expect(screen.getAllByText("03").length).toBeGreaterThan(0);
        expect(screen.getAllByText("近景").length).toBeGreaterThan(0);
    });

    it("点击行触发 onSelect；role=option + aria-selected", () => {
        const props = renderRow({ selected: true });
        fireEvent.click(screen.getByRole("option", { selected: true }));
        expect(props.onSelect).toHaveBeenCalledTimes(1);
    });

    it("行 hover「+」在其后插入（stopPropagation 不改选中）", () => {
        const props = renderRow({ onInsertAfter: vi.fn() });
        fireEvent.click(screen.getByRole("button", { name: "在第 3 镜后插入镜头" }));
        expect(props.onInsertAfter).toHaveBeenCalledTimes(1);
        expect(props.onSelect).not.toHaveBeenCalled();
    });
});
