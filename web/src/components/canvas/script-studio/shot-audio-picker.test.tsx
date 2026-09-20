import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import i18n from "@/i18n";
import { ShotAudioPicker, type AudioNodeLite } from "./shot-audio-picker";

// Task 4 才会把 audio* 文案落进 locales；这里仅在测试环境注册，
// 让组件断言可对准正式中文文案（deep merge，不覆盖既有键）。
void i18n.addResourceBundle(
    "zh-CN",
    "translation",
    {
        canvas: {
            scriptStudio: {
                audioAdd: "添加音频",
                audioPickerEmpty: "画布上还没有音频节点",
                audioPickerEmptyHint: "也可以直接上传本地音频",
                audioUploading: "正在添加…",
                audioUpload: "上传本地音频",
            },
        },
    },
    true,
    true,
);

const nodes: AudioNodeLite[] = [
    { id: "audio-1", title: "环境声.mp3", storageKey: "audio:k1" },
    { id: "audio-2", title: "配音.wav", storageKey: "audio:k2" },
];

const renderPicker = (over: Partial<Parameters<typeof ShotAudioPicker>[0]> = {}) => {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    const handlers = { onPick: vi.fn(), onUpload: vi.fn(), onClose: vi.fn() };
    render(
        <ShotAudioPicker
            anchor={anchor}
            audioNodes={over.audioNodes ?? nodes}
            uploading={over.uploading ?? false}
            pickedId={over.pickedId}
            onPick={handlers.onPick}
            onUpload={handlers.onUpload}
            onClose={handlers.onClose}
        />,
    );
    return { ...handlers, anchor };
};

afterEach(cleanup);

describe("ShotAudioPicker", () => {
    it("列出画布音频节点（名称 + aria-selected 高亮当前引用）", () => {
        renderPicker({ pickedId: "audio-2" });
        expect(screen.getByText("环境声.mp3")).toBeTruthy();
        const picked = screen.getByRole("option", { name: "配音.wav" });
        expect(picked.getAttribute("aria-selected")).toBe("true");
    });

    it("空列表显示空态文案，上传按钮仍可见", () => {
        renderPicker({ audioNodes: [] });
        expect(screen.getByText("画布上还没有音频节点")).toBeTruthy();
        expect(screen.getByText("也可以直接上传本地音频")).toBeTruthy();
        expect(screen.getByRole("button", { name: "上传本地音频" })).toBeTruthy();
    });

    it("mousedown 选项即 onPick（防 blur 竞态）", () => {
        const { onPick } = renderPicker();
        fireEvent.mouseDown(screen.getByRole("option", { name: "环境声.mp3" }));
        expect(onPick).toHaveBeenCalledWith(nodes[0]);
    });

    it("上传中禁用按钮并显示进行中文案；选择文件触发 onUpload", () => {
        const { onUpload } = renderPicker({ uploading: true });
        expect((screen.getByRole("button", { name: "正在添加…" }) as HTMLButtonElement).disabled).toBe(true);
        const input = document.querySelector('input[type="file"]') as HTMLInputElement;
        fireEvent.change(input, { target: { files: [new File(["x"], "v.mp3", { type: "audio/mpeg" })] } });
        expect(onUpload).toHaveBeenCalled();
    });

    it("Esc → onClose（外点单独成例，见下一例）", () => {
        const { onClose } = renderPicker();
        fireEvent.keyDown(window, { key: "Escape" });
        expect(onClose).toHaveBeenCalled();
    });

    it("外点（body mousedown）→ 关闭；浮层内 mousedown 不关闭，上传按钮点击仍到达文件输入", () => {
        const { onClose, onUpload } = renderPicker();
        fireEvent.mouseDown(document.body);
        expect(onClose).toHaveBeenCalledTimes(1);
        onClose.mockClear();
        const uploadBtn = screen.getByRole("button", { name: "上传本地音频" });
        fireEvent.mouseDown(uploadBtn);
        expect(onClose).not.toHaveBeenCalled();
        const input = document.querySelector('input[type="file"]') as HTMLInputElement;
        const openFile = vi.spyOn(input, "click").mockImplementation(() => {});
        fireEvent.click(uploadBtn);
        expect(openFile).toHaveBeenCalledTimes(1);
        fireEvent.change(input, { target: { files: [new File(["x"], "v.mp3", { type: "audio/mpeg" })] } });
        expect(onUpload).toHaveBeenCalledWith(expect.any(File));
    });

    it("Tab 聚焦上传按钮时 Enter 交还按钮，不再写入选中选项", () => {
        const { onPick } = renderPicker();
        const uploadBtn = screen.getByRole("button", { name: "上传本地音频" });
        uploadBtn.focus();
        fireEvent.keyDown(uploadBtn, { key: "Enter" });
        expect(onPick).not.toHaveBeenCalled();
    });

    it("键盘 ↑↓ 循环高亮（滚动跟随可见）、Enter 写入", () => {
        const scrollSpy = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
        const { onPick } = renderPicker();
        fireEvent.keyDown(window, { key: "Enter" });
        expect(onPick).toHaveBeenCalledWith(nodes[0]);
        fireEvent.keyDown(window, { key: "ArrowDown" });
        expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest" });
        fireEvent.keyDown(window, { key: "Enter" });
        expect(onPick).toHaveBeenLastCalledWith(nodes[1]);
    });

    it("列表自身滚动不关闭浮层；页面级滚动（window）仍关闭", () => {
        const { onClose } = renderPicker();
        fireEvent.scroll(screen.getByRole("listbox"));
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.scroll(window);
        expect(onClose).toHaveBeenCalled();
    });
});
