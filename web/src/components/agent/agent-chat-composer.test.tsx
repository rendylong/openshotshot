import { App } from "antd";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useLocalSkillStore } from "@/stores/use-local-skill-store";
import type { AgentModel } from "@/stores/use-agent-store";
import { AgentChatComposer } from "./agent-chat-composer";

const composerBaseProps = {
    prompt: "",
    placeholder: "输入内容",
    theme: canvasThemes.light,
    onPromptChange: () => {},
    onSubmit: () => {},
};

const agentModels: AgentModel[] = [
    { id: "gpt-4o", model: "gpt-4o", displayName: "GPT-4o", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
    { id: "gemini-2.5-pro", model: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
];

function Harness({ onAddFiles = vi.fn() }: { onAddFiles?: (files: FileList | File[] | null) => void }) {
    const [prompt, setPrompt] = useState("");
    return <App><I18nextProvider i18n={i18n}><AgentChatComposer prompt={prompt} placeholder="输入内容" theme={canvasThemes.light} onPromptChange={setPrompt} onSubmit={vi.fn()} onAddFiles={onAddFiles} /></I18nextProvider></App>;
}

describe("AgentChatComposer attachment and Skill actions", () => {
    beforeEach(() => {
        i18n.changeLanguage("zh-CN");
        useLocalSkillStore.setState({ loaded: true, skills: [{ name: "photo-workflow", description: "组织产品摄影流程", shortDescription: "组织产品摄影流程", path: "/skills/photo-workflow", source: "app", manualOnly: false, readonly: false, valid: true }] });
    });

    it("shows a Skill icon and opens the same candidate menu as slash", async () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole("button", { name: "选择 Skill" }));
        expect(await screen.findByText("选择 Skill")).toBeInTheDocument();
        expect(screen.getByRole("option", { name: /photo-workflow/ })).toBeInTheDocument();
    });

    it.each([
        ["model.glb", "model/gltf-binary"],
        ["model.gltf", "model/gltf+json"],
        ["clip.mp4", "video/mp4"],
        ["brief.pdf", "application/pdf"],
        ["photo.png", "image/png"],
    ])("keeps %s in the shared picker flow", (name, type) => {
        const onAddFiles = vi.fn();
        render(<Harness onAddFiles={onAddFiles} />);
        const file = new File(["fixture"], name, { type });
        fireEvent.change(screen.getByLabelText("添加附件", { selector: "input" }), { target: { files: [file] } });
        expect(onAddFiles).toHaveBeenCalledWith(expect.arrayContaining([file]));
    });
});

describe("AgentChatComposer model picker and attach entry", () => {
    beforeEach(() => {
        i18n.changeLanguage("zh-CN");
    });

    afterEach(() => {
        useConfigStore.setState((state) => ({ ...state, config: defaultConfig }));
    });

    it("渲染当前模型，选择后 onChange 收到新 model", async () => {
        useConfigStore.setState((state) => ({ ...state, config: { ...defaultConfig, models: ["gpt-4o", "gemini-2.5-pro"] } }));
        const onModelChange = vi.fn();
        render(<App><I18nextProvider i18n={i18n}><AgentChatComposer {...composerBaseProps} models={agentModels} model="gpt-4o" onModelChange={onModelChange} /></I18nextProvider></App>);
        fireEvent.click(screen.getByRole("button", { name: /gpt-4o/ }));
        const option = await screen.findByRole("button", { name: /gemini/i });
        fireEvent.click(option);
        expect(onModelChange).toHaveBeenCalledWith(expect.stringContaining("gemini"));
    });

    it("'+' 菜单收敛后附件入口可用", async () => {
        const onAddFiles = vi.fn();
        render(<App><I18nextProvider i18n={i18n}><AgentChatComposer {...composerBaseProps} onAddFiles={onAddFiles} /></I18nextProvider></App>);
        fireEvent.click(screen.getByRole("button", { name: "添加附件" }));
        const item = await screen.findByRole("menuitem", { name: /附件/ });
        expect(item).toBeTruthy();
    });
});

describe("AgentChatComposer approval mode menu", () => {
    beforeEach(() => {
        i18n.changeLanguage("zh-CN");
    });

    it("renders the approval mode menu and reports changes", async () => {
        const onApprovalModeChange = vi.fn();
        render(<App><I18nextProvider i18n={i18n}><AgentChatComposer {...composerBaseProps} theme={canvasThemes.dark} approvalMode="confirm_changes" onApprovalModeChange={onApprovalModeChange} /></I18nextProvider></App>);
        expect(screen.getByText("变更前确认")).toBeTruthy();
        fireEvent.click(screen.getByText("变更前确认"));
        expect(await screen.findByText("完全访问")).toBeTruthy();
        fireEvent.click(screen.getByText("完全访问"));
        expect(onApprovalModeChange).toHaveBeenCalledWith("full_access");
    });

    it("不传审批 props 时不渲染审批入口", () => {
        render(<App><I18nextProvider i18n={i18n}><AgentChatComposer {...composerBaseProps} /></I18nextProvider></App>);
        expect(screen.queryByText("变更前确认")).toBeNull();
    });
});
