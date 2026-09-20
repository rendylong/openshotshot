import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";

import i18n from "@/i18n";
import { RichDescriptionCell } from "./rich-description-cell";
import type { ScriptShot } from "@/types/script-node";

const entities = [
    { id: "e1", name: "狸花猫大厨", group: "character" as const, ready: true },
    { id: "e2", name: "太空餐厅", group: "scene" as const, ready: false },
];

const shot = (over: Partial<ScriptShot> = {}): ScriptShot => ({
    shotId: "s1", no: 1, origin: "manual", shotSize: "中景", angle: "平视", movement: "固定",
    duration: 4, mood: "温暖", sfx: "", dialogue: "", descriptionRich: [], description: "", entityRefs: [], composed: false, ...over,
});

function renderCell(shotProp = shot(), onChange = vi.fn()) {
    render(
        <I18nextProvider i18n={i18n}>
            <RichDescriptionCell shot={shotProp} entities={entities} onChange={onChange} />
        </I18nextProvider>,
    );
    return onChange;
}

describe("RichDescriptionCell", () => {
    it("初始渲染已有 rich 内容为内联胶囊", () => {
        renderCell(shot({ descriptionRich: [{ t: "text", v: "灶台前，" }, { t: "ref", entityId: "e1" }] }));
        const cell = document.querySelector(".rich-desc") as HTMLElement;
        const chip = cell.querySelector(".inline-entity") as HTMLElement;
        expect(chip?.textContent).toBe("狸花猫大厨");
        expect(chip?.dataset.entityId).toBe("e1");
    });

    it("输入 @ 前缀弹出实体浮层；Enter 选中后在光标处插入胶囊并派生 entityRefs", async () => {
        const onChange = renderCell();
        const cell = document.querySelector(".rich-desc") as HTMLElement;
        cell.focus();
        fireEvent.input(cell, { target: { innerHTML: "辣椒森林，@" } });
        // contentEditable 的 selectionStart 不可直接用；用 Selection API 置于末尾
        const range = document.createRange();
        range.selectNodeContents(cell);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        fireEvent.input(cell, {});
        await waitFor(() => {
            expect(document.querySelector(".entity-picker")).not.toBeNull();
        });
        fireEvent.keyDown(cell, { key: "Enter" });
        await waitFor(() => {
            expect(onChange).toHaveBeenCalled();
        });
        const patch = onChange.mock.calls.at(-1)?.[0];
        expect(patch.entityRefs).toContain("e1");
        expect(patch.descriptionRich.some((seg: { t: string }) => seg.t === "ref")).toBe(true);
        expect(cell.querySelector(".inline-entity")?.textContent).toBe("狸花猫大厨");
    });

    it("无匹配实体时浮层显示引导文案", async () => {
        renderCell();
        const cell = document.querySelector(".rich-desc") as HTMLElement;
        cell.focus();
        cell.appendChild(document.createTextNode("@zzz"));
        const range = document.createRange();
        range.selectNodeContents(cell);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        fireEvent.input(cell, {});
        await waitFor(() => {
            expect(screen.getByText(/没有匹配资产/)).not.toBeNull();
        });
    });

    // —— @ 直接创建新资产（spec §8 用例 4-13）——
    const typeAtEnd = (cell: HTMLElement, html: string) => {
        cell.focus();
        cell.innerHTML = html;
        const range = document.createRange();
        range.selectNodeContents(cell);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        fireEvent.input(cell, {});
    };

    const renderCellWithCreate = (onCreateAsset = vi.fn()) => {
        const onChange = vi.fn();
        render(
            <I18nextProvider i18n={i18n}>
                <RichDescriptionCell shot={shot()} entities={entities} onChange={onChange} onCreateAsset={onCreateAsset} />
            </I18nextProvider>,
        );
        return { onChange, onCreateAsset };
    };

    it("query 非空且零匹配 → 新建行出现，既有空态文案被替换", async () => {
        renderCellWithCreate();
        const cell = document.querySelector(".rich-desc") as HTMLElement;
        typeAtEnd(cell, "@zzz");
        await waitFor(() => expect(document.querySelector(".ep-create")).not.toBeNull());
        expect(screen.queryByText(/没有匹配资产/)).toBeNull();
    });

    it("query 是既有资产名的子串但非全等 → 匹配项与新建行同时显示", async () => {
        renderCellWithCreate();
        const cell = document.querySelector(".rich-desc") as HTMLElement;
        typeAtEnd(cell, "@狸");
        await waitFor(() => expect(document.querySelector(".entity-picker")).not.toBeNull());
        expect(document.querySelectorAll(".entity-picker [data-entity-id]").length).toBe(1);
        expect(document.querySelector(".ep-create")).not.toBeNull();
    });

    it("query 与挂载实体同名 → 隐藏新建行", async () => {
        renderCellWithCreate();
        const cell = document.querySelector(".rich-desc") as HTMLElement;
        typeAtEnd(cell, "@狸花猫大厨");
        await waitFor(() => expect(document.querySelector(".entity-picker")).not.toBeNull());
        expect(document.querySelector(".ep-create")).toBeNull();
    });

    it("未传 onCreateAsset + 零匹配 → 仍显示既有空态且无新建行（回归保护）", async () => {
        renderCell();
        const cell = document.querySelector(".rich-desc") as HTMLElement;
        typeAtEnd(cell, "@zzz");
        await waitFor(() => expect(screen.getByText(/没有匹配资产/)).not.toBeNull());
        expect(document.querySelector(".ep-create")).toBeNull();
    });

    it("零匹配新建行激活时 Enter → 默认角色创建、插胶囊、description 含资产名", async () => {
        const { onCreateAsset, onChange } = renderCellWithCreate();
        onCreateAsset.mockReturnValue({ id: "ent_new", name: "zzz", group: "character", ready: false });
        const cell = document.querySelector(".rich-desc") as HTMLElement;
        typeAtEnd(cell, "@zzz");
        await waitFor(() => expect(document.querySelector(".ep-create")).not.toBeNull());
        fireEvent.keyDown(cell, { key: "Enter" });
        await waitFor(() => expect(onCreateAsset).toHaveBeenCalledWith("zzz", "character"));
        const patch = onChange.mock.calls.at(-1)?.[0];
        expect(patch.entityRefs).toContain("ent_new");
        expect(patch.description).toContain("zzz"); // nameOf 覆写：创建瞬间不缺名
        expect(cell.querySelector(".inline-entity")?.textContent).toBe("zzz");
        expect(document.querySelector(".entity-picker")).toBeNull();
    });

    it("点击分组 chip 仅切档不创建；再 Enter 以所选档位创建", async () => {
        const { onCreateAsset } = renderCellWithCreate();
        onCreateAsset.mockReturnValue({ id: "ent_new", name: "zzz", group: "scene", ready: false });
        const cell = document.querySelector(".rich-desc") as HTMLElement;
        typeAtEnd(cell, "@zzz");
        await waitFor(() => expect(document.querySelector(".ep-create")).not.toBeNull());
        fireEvent.mouseDown(document.querySelector('[data-group="scene"]') as HTMLElement);
        expect(onCreateAsset).not.toHaveBeenCalled();
        fireEvent.keyDown(cell, { key: "Enter" });
        await waitFor(() => expect(onCreateAsset).toHaveBeenCalledWith("zzz", "scene"));
    });

    it("group 跨键入保持；Esc 关闭再打开重置为角色", async () => {
        const { onCreateAsset } = renderCellWithCreate();
        onCreateAsset.mockReturnValue({ id: "ent_new", name: "zzx", group: "scene", ready: false });
        const cell = document.querySelector(".rich-desc") as HTMLElement;
        typeAtEnd(cell, "@zz");
        await waitFor(() => expect(document.querySelector(".ep-create")).not.toBeNull());
        fireEvent.mouseDown(document.querySelector('[data-group="scene"]') as HTMLElement);
        typeAtEnd(cell, "@zzx"); // 继续键入重建浮层
        await waitFor(() => expect(document.querySelector(".ep-create")).not.toBeNull());
        fireEvent.keyDown(cell, { key: "Enter" });
        await waitFor(() => expect(onCreateAsset).toHaveBeenCalledWith("zzx", "scene"));
        // Esc 后重开：回到默认角色
        onCreateAsset.mockReturnValue({ id: "ent_new2", name: "za", group: "character", ready: false });
        typeAtEnd(cell, "@za");
        await waitFor(() => expect(document.querySelector(".ep-create")).not.toBeNull());
        fireEvent.mouseDown(document.querySelector('[data-group="scene"]') as HTMLElement);
        fireEvent.keyDown(cell, { key: "Escape" });
        expect(document.querySelector(".entity-picker")).toBeNull();
        typeAtEnd(cell, "@za");
        await waitFor(() => expect(document.querySelector(".ep-create")).not.toBeNull());
        fireEvent.keyDown(cell, { key: "Enter" });
        await waitFor(() => expect(onCreateAsset).toHaveBeenCalledWith("za", "character"));
    });

    it("键盘导航：↓ 可达新建行，激活时 ←→ 切档且焦点不离开单元格", async () => {
        const { onCreateAsset } = renderCellWithCreate();
        onCreateAsset.mockReturnValue({ id: "ent_new", name: "狸", group: "item", ready: false });
        const cell = document.querySelector(".rich-desc") as HTMLElement;
        typeAtEnd(cell, "@狸");
        await waitFor(() => expect(document.querySelectorAll(".entity-picker [data-entity-id]").length).toBe(1));
        fireEvent.keyDown(cell, { key: "ArrowDown" }); // 1 项 → 新建行（index 1）
        await waitFor(() => expect(document.querySelector(".ep-create")?.classList.contains("active")).toBe(true));
        fireEvent.keyDown(cell, { key: "ArrowRight" });
        await waitFor(() => expect(document.querySelector('[data-group="scene"]')?.classList.contains("active")).toBe(true));
        fireEvent.keyDown(cell, { key: "ArrowLeft" });
        fireEvent.keyDown(cell, { key: "ArrowLeft" });
        await waitFor(() => expect(document.querySelector('[data-group="item"]')?.classList.contains("active")).toBe(true));
        const sel = window.getSelection();
        expect(sel?.rangeCount).toBe(1);
        expect(cell.contains(sel!.getRangeAt(0).startContainer)).toBe(true);
        fireEvent.keyDown(cell, { key: "Enter" });
        await waitFor(() => expect(onCreateAsset).toHaveBeenCalledWith("狸", "item"));
    });

    it("IME 组合期 Enter 不创建、浮层不关闭", async () => {
        const { onCreateAsset } = renderCellWithCreate();
        const cell = document.querySelector(".rich-desc") as HTMLElement;
        typeAtEnd(cell, "@zz");
        await waitFor(() => expect(document.querySelector(".ep-create")).not.toBeNull());
        fireEvent.keyDown(cell, { key: "Enter", isComposing: true });
        expect(onCreateAsset).not.toHaveBeenCalled();
        expect(document.querySelector(".ep-create")).not.toBeNull();
    });

    it("新建行插值转义：query 含 & 时按文本渲染", async () => {
        renderCellWithCreate();
        const cell = document.querySelector(".rich-desc") as HTMLElement;
        typeAtEnd(cell, "@a&b");
        await waitFor(() => expect(document.querySelector(".ep-create")).not.toBeNull());
        expect((document.querySelector(".entity-picker") as HTMLElement).innerHTML).toContain("a&amp;b");
    });

    it("浮层实体名插值转义：名称含 HTML 标签时按文本渲染", async () => {
        const evil = [{ id: "e9", name: "<b>猫</b>", group: "character" as const, ready: false }];
        render(
            <I18nextProvider i18n={i18n}>
                <RichDescriptionCell shot={shot()} entities={evil} onChange={vi.fn()} onCreateAsset={vi.fn()} />
            </I18nextProvider>,
        );
        const cell = document.querySelector(".rich-desc") as HTMLElement;
        typeAtEnd(cell, "@");
        await waitFor(() => expect(document.querySelectorAll("[data-entity-id]").length).toBe(1));
        const host = document.querySelector(".entity-picker") as HTMLElement;
        expect(host.querySelector("b")).toBeNull();
        expect(host.innerHTML).toContain("&lt;b&gt;猫");
    });

    it("create 路径字面复用 pickEntity 的重复引用防御：返回已引用 id 时不重复插胶囊", async () => {
        const seeded = shot({ descriptionRich: [{ t: "text", v: "开头 " }, { t: "ref", entityId: "e1" }], entityRefs: ["e1"] });
        const onDuplicateRef = vi.fn();
        const onCreateAsset = vi.fn().mockReturnValue({ id: "e1", name: "狸花猫大厨", group: "character", ready: true });
        render(
            <I18nextProvider i18n={i18n}>
                <RichDescriptionCell shot={seeded} entities={entities} onChange={vi.fn()} onDuplicateRef={onDuplicateRef} onCreateAsset={onCreateAsset} />
            </I18nextProvider>,
        );
        const cell = document.querySelector(".rich-desc") as HTMLElement;
        expect(cell.querySelectorAll(".inline-entity").length).toBe(1);
        // 在既有胶囊后追加 @query（不能用 innerHTML 整体重写，会丢胶囊）
        cell.appendChild(document.createTextNode("@zz"));
        const range = document.createRange();
        range.selectNodeContents(cell);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        fireEvent.input(cell, {});
        await waitFor(() => expect(document.querySelector(".ep-create")).not.toBeNull());
        fireEvent.keyDown(cell, { key: "Enter" });
        await waitFor(() => expect(onDuplicateRef).toHaveBeenCalledWith("狸花猫大厨"));
        expect(cell.querySelectorAll(".inline-entity").length).toBe(1);
        expect(document.querySelector(".entity-picker")).toBeNull();
    });
});
