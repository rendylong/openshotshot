import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { createRef } from "react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { MemoryProjectSettings } from "./memory-project-settings";

const readProject = vi.fn();
const writeProject = vi.fn();
vi.stubGlobal("window", Object.assign(window, { shotshot: { agentMemory: { readUser: vi.fn(), writeUser: vi.fn(), readProject, writeProject } } }));

function renderSettings(workspacePath?: string) {
    const guardRef = createRef<{ dirty: boolean; confirmLeave: (p: () => void) => void }>();
    // guardRef.current 由组件挂载时写入；测试经 current 断言
    const view = render(
        <I18nextProvider i18n={i18n}>
            <AntApp>
                <MemoryProjectSettings workspacePath={workspacePath} guardRef={guardRef} />
            </AntApp>
        </I18nextProvider>,
    );
    return { guardRef, ...view };
}

describe("MemoryProjectSettings", () => {
    beforeEach(() => {
        // 清空调用记录，避免上一例的 readProject/writeProject 调用泄入后续断言
        vi.clearAllMocks();
    });

    it("有 workspacePath 时加载并可保存", async () => {
        readProject.mockResolvedValue({ ok: true, content: "水墨风" });
        writeProject.mockResolvedValue({ ok: true });
        const { guardRef } = renderSettings("/tmp/ws");
        fireEvent.change(await screen.findByDisplayValue("水墨风"), { target: { value: "水墨风+" } });
        expect(guardRef.current?.dirty).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
        await waitFor(() => expect(writeProject).toHaveBeenCalledWith("/tmp/ws", "水墨风+"));
    });

    it("无 workspacePath 时禁用且不加载", async () => {
        renderSettings(undefined);
        expect(await screen.findByRole("textbox")).toBeDisabled();
        expect(readProject).not.toHaveBeenCalled();
    });

    it("confirmLeave 三键：保存并关闭走 writeProject 后放行", async () => {
        readProject.mockResolvedValue({ ok: true, content: "" });
        writeProject.mockResolvedValue({ ok: true });
        const { guardRef } = renderSettings("/tmp/ws");
        fireEvent.change(await screen.findByRole("textbox"), { target: { value: "草稿" } });
        let proceeded = false;
        // confirmLeave 内部会 setState，需要在 act 内触发以刷新受控 Modal
        act(() => { guardRef.current!.confirmLeave(() => { proceeded = true; }); });
        fireEvent.click(screen.getByRole("button", { name: "保存并关闭" }));
        await waitFor(() => expect(writeProject).toHaveBeenCalledWith("/tmp/ws", "草稿"));
        expect(proceeded).toBe(true);
    });
});
