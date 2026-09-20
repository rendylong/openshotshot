import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { createRef } from "react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { MemorySettingsSection, type MemoryGuard } from "./memory-settings-section";

const readUser = vi.fn();
const writeUser = vi.fn();
vi.stubGlobal("window", Object.assign(window, { shotshot: { agentMemory: { readUser, writeUser, readProject: vi.fn(), writeProject: vi.fn() } } }));

function renderSection() {
    const guardRef = createRef<MemoryGuard>();
    // guardRef.current 由组件挂载时写入；测试经 current 断言
    const view = render(
        <I18nextProvider i18n={i18n}>
            <AntApp>
                <MemorySettingsSection guardRef={guardRef} hidden={false} />
            </AntApp>
        </I18nextProvider>,
    );
    return { guardRef, ...view };
}

describe("MemorySettingsSection", () => {
    beforeEach(() => {
        // 清空调用记录，避免上一例的 writeUser 调用泄入后续断言
        vi.clearAllMocks();
    });

    it("挂载即加载用户记忆并展示计数", async () => {
        readUser.mockResolvedValue({ ok: true, content: "品牌色 #0EA5E9" });
        const { guardRef } = renderSection();
        await waitFor(() => expect(screen.getByDisplayValue("品牌色 #0EA5E9")).toBeInTheDocument());
        expect(screen.getByText("11 / 2000")).toBeInTheDocument();
        expect(guardRef.current?.dirty).toBe(false);
    });

    it("编辑后 dirty=true，保存走 writeUser 并复位", async () => {
        readUser.mockResolvedValue({ ok: true, content: "" });
        writeUser.mockResolvedValue({ ok: true });
        const { guardRef } = renderSection();
        fireEvent.change(await screen.findByRole("textbox"), { target: { value: "新条目" } });
        expect(guardRef.current?.dirty).toBe(true);
        // antd 会对两字中文按钮文案插入空格（保 存），按可访问名 + 宽容空白匹配
        fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
        await waitFor(() => expect(writeUser).toHaveBeenCalledWith("新条目"));
        await waitFor(() => expect(guardRef.current?.dirty).toBe(false));
    });

    it("confirmLeave 在脏状态下弹三键确认：放弃修改恢复基线", async () => {
        readUser.mockResolvedValue({ ok: true, content: "基线" });
        const { guardRef } = renderSection();
        await screen.findByDisplayValue("基线");
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "改掉" } });
        let proceeded = false;
        // confirmLeave 内部会 setState，需要在 act 内触发以刷新受控 Modal
        act(() => { guardRef.current!.confirmLeave(() => { proceeded = true; }); });
        fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
        await waitFor(() => expect(screen.getByDisplayValue("基线")).toBeInTheDocument());
        expect(proceeded).toBe(true);
    });

    it("confirmLeave 取消不放行", async () => {
        readUser.mockResolvedValue({ ok: true, content: "" });
        const { guardRef } = renderSection();
        fireEvent.change(await screen.findByRole("textbox"), { target: { value: "脏" } });
        let proceeded = false;
        act(() => { guardRef.current!.confirmLeave(() => { proceeded = true; }); });
        fireEvent.click(screen.getByRole("button", { name: /取\s*消/ }));
        expect(proceeded).toBe(false);
        expect(writeUser).not.toHaveBeenCalled();
    });

    it("保存并关闭写盘失败：留在确认弹窗、编辑保留、不 proceed", async () => {
        readUser.mockResolvedValue({ ok: true, content: "" });
        writeUser.mockResolvedValue({ ok: false, error: "x" });
        const { guardRef } = renderSection();
        fireEvent.change(await screen.findByRole("textbox"), { target: { value: "脏" } });
        let proceeded = false;
        act(() => { guardRef.current!.confirmLeave(() => { proceeded = true; }); });
        fireEvent.click(screen.getByRole("button", { name: "保存并关闭" }));
        await waitFor(() => expect(writeUser).toHaveBeenCalledWith("脏"));
        expect(screen.getByText("未保存的修改")).toBeInTheDocument();
        expect(guardRef.current?.dirty).toBe(true);
        expect(proceeded).toBe(false);
    });
});
