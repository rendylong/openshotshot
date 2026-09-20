import { App } from "antd";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it } from "vitest";

import i18n from "@/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import { useAgentStore } from "@/stores/use-agent-store";
import { useLocalSkillStore } from "@/stores/use-local-skill-store";
import { AgentChatPromptInput, type AgentChatPromptInputHandle } from "./agent-chat-prompt-input";

function Harness() {
    const [value, setValue] = useState("");
    return <AgentChatPromptInput value={value} placeholder="输入内容" theme={canvasThemes.light} onChange={setValue} onSubmit={() => {}} />;
}

function placeCaretAfter(node: Node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

describe("AgentChatPromptInput Skill commands", () => {
    beforeEach(() => {
        i18n.changeLanguage("zh-CN");
        useAgentStore.getState().setAgentState({ canvasReferences: [] });
        useLocalSkillStore.setState({
            loaded: true,
            skills: [{ name: "photo-workflow", description: "组织产品摄影流程", path: "/skills/photo-workflow", source: "app", manualOnly: false, readonly: false, valid: true }],
        });
    });

    it("opens on slash, inserts a name-only pill, and removes it with Backspace", async () => {
        render(<App><I18nextProvider i18n={i18n}><Harness /></I18nextProvider></App>);
        const editor = screen.getByRole("textbox", { name: "输入内容" });
        editor.textContent = "/";
        placeCaretAfter(editor);
        fireEvent.input(editor);

        expect(await screen.findByText("选择 Skill")).toBeInTheDocument();
        fireEvent.pointerDown(screen.getByRole("option", { name: /photo-workflow/ }));

        const pill = editor.querySelector<HTMLElement>("[data-agent-token-kind='skill']");
        expect(pill).toHaveTextContent("photo-workflow");
        expect(pill).toHaveAttribute("data-agent-token", "/photo-workflow");
        expect(editor).not.toHaveTextContent("skill:photo-workflow");

        placeCaretAfter(editor);
        fireEvent.keyDown(editor, { key: "Backspace" });
        await waitFor(() => expect(editor.querySelector("[data-agent-token-kind='skill']")).not.toBeInTheDocument());
    });

    it("starts with no highlighted row; Enter inserts only after ArrowDown builds a cursor", async () => {
        render(<App><I18nextProvider i18n={i18n}><Harness /></I18nextProvider></App>);
        const editor = screen.getByRole("textbox", { name: "输入内容" });
        editor.textContent = "/";
        placeCaretAfter(editor);
        fireEvent.input(editor);

        const option = await screen.findByRole("option", { name: /photo-workflow/ });
        expect(option).toHaveAttribute("aria-selected", "false");

        fireEvent.keyDown(editor, { key: "Enter" });
        expect(editor.querySelector("[data-agent-token-kind='skill']")).not.toBeInTheDocument();

        fireEvent.keyDown(editor, { key: "ArrowDown" });
        expect(screen.getByRole("option", { name: /photo-workflow/ })).toHaveAttribute("aria-selected", "true");
        fireEvent.keyDown(editor, { key: "Enter" });
        expect(editor.querySelector("[data-agent-token-kind='skill']")).toHaveTextContent("photo-workflow");
    });

    it("focuses the controlled replacement at its end", async () => {
        const inputRef = createRef<AgentChatPromptInputHandle>();
        const props = { placeholder: "输入内容", theme: canvasThemes.light, onChange: () => {}, onSubmit: () => {} };
        const view = render(<App><I18nextProvider i18n={i18n}><AgentChatPromptInput {...props} value="/photo-workflow old" inputRef={inputRef} /></I18nextProvider></App>);
        view.rerender(<App><I18nextProvider i18n={i18n}><AgentChatPromptInput {...props} value="新的海报灵感" inputRef={inputRef} /></I18nextProvider></App>);
        act(() => inputRef.current!.focus());
        const editor = screen.getByRole("textbox", { name: "输入内容" });
        expect(editor).toHaveFocus();
        expect(editor.textContent).toBe("新的海报灵感");
        expect(editor.querySelector("[data-agent-token-kind='skill']")).toBeNull();
        const range = window.getSelection()!.getRangeAt(0);
        expect(range.collapsed).toBe(true);
        const tail = range.cloneRange();
        tail.selectNodeContents(editor);
        tail.setStart(range.endContainer, range.endOffset);
        expect(tail.toString()).toBe("");
    });

    it("hides the placeholder while IME composition text is in the editor", () => {
        render(<App><I18nextProvider i18n={i18n}><Harness /></I18nextProvider></App>);
        const editor = screen.getByRole("textbox", { name: "输入内容" });
        expect(screen.getByText("输入内容")).toBeInTheDocument();

        fireEvent.compositionStart(editor);
        editor.textContent = "nihao";
        fireEvent.input(editor);
        expect(screen.queryByText("输入内容")).not.toBeInTheDocument();

        fireEvent.compositionEnd(editor);
        expect(editor.textContent).toBe("nihao");
        expect(screen.queryByText("输入内容")).not.toBeInTheDocument();
    });
});
