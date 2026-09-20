import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "antd";
import { I18nextProvider } from "react-i18next";
import { Link, MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const projectStorage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }));
const navigationControl = vi.hoisted(() => ({
    rejectNext: false,
    beforeReject: null as null | (() => void),
}));
vi.mock("@/lib/localforage-storage", () => ({ localForageStorage: projectStorage }));
vi.mock("react-router-dom", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react-router-dom")>();
    return {
        ...actual,
        useNavigate: () => {
            const navigate = actual.useNavigate();
            return async (...args: Parameters<typeof navigate>) => {
                if (navigationControl.rejectNext) {
                    navigationControl.rejectNext = false;
                    navigationControl.beforeReject?.();
                    throw new Error("navigation rejected");
                }
                return navigate(...args);
            };
        },
    };
});

import i18n from "@/i18n";
import { UNCATEGORIZED_PROJECT_ID } from "@/lib/canvas/category";
import { createProjectWithCanvas } from "@/lib/canvas/project-model";
import HomePage from "@/pages/home";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { useAgentStore, type AgentAttachment } from "@/stores/use-agent-store";
import { useAiSourceStore } from "@/stores/use-ai-source-store";
import { useChatGptStore } from "@/stores/use-chatgpt-store";
import { useHomeComposerStore } from "@/stores/use-home-composer-store";
import { useLocalSkillStore } from "@/stores/use-local-skill-store";
import * as homeAttachments from "@/pages/home/home-attachments";

const model: AgentAttachment = {
    id: "model", name: "bottle.glb", kind: "glb", mimeType: "model/gltf-binary", size: 1,
    url: "data:model/gltf-binary;base64,AA==", dataUrl: "data:model/gltf-binary;base64,AA==",
};

function Destination() {
    const { projectId, canvasId } = useParams();
    return <><output aria-label="测试画布路由">{projectId}/{canvasId}</output><Link to="/">返回首页</Link></>;
}

function renderFlow() {
    return render(<App><I18nextProvider i18n={i18n}><MemoryRouter initialEntries={["/"]}>
        <Routes><Route path="/" element={<HomePage />} /><Route path="/canvas/:projectId/:canvasId" element={<Destination />} /></Routes>
    </MemoryRouter></I18nextProvider></App>);
}

describe("home creation flow", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        navigationControl.rejectNext = false;
        navigationControl.beforeReject = null;
        projectStorage.setItem.mockResolvedValue(undefined);
        useHomeComposerStore.getState().resetDraft();
        useProjectStore.setState({ hydrated: true, hydrationStatus: "success", projects: [], pendingPrompt: null, pendingProjectId: null, pendingCanvasId: null });
        useAgentStore.getState().setAgentState({ pendingAttachments: [], submitRequest: null });
        useLocalSkillStore.setState({ loaded: true, skills: [] });
        useAiSourceStore.setState({ status: "ready", applying: false, error: null, preferences: { version: 1, selections: {} } });
        useChatGptStore.setState({ status: { state: "signed-out" }, models: [] });
        useConfigStore.setState({ config: defaultConfig });
        await i18n.changeLanguage("zh-CN");
    });

    it("opens a blank canvas and preserves the home draft on return", async () => {
        useHomeComposerStore.getState().setPrompt("保留的需求");
        renderFlow();
        expect(screen.getByRole("button", { name: i18n.t("composer.inspiration.prompts.model.0") })).toBeVisible();
        expect(screen.queryByRole("button", { name: "更多灵感" })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "从画布开始" }));
        expect(await screen.findByLabelText("测试画布路由")).toHaveTextContent(UNCATEGORIZED_PROJECT_ID);
        expect(useAgentStore.getState().submitRequest).toBeNull();
        expect(useProjectStore.getState().pendingPrompt).toBeNull();
        expect(useProjectStore.getState().projects[0].canvases[0].nodes).toEqual([]);
        fireEvent.click(screen.getByRole("link", { name: "返回首页" }));
        expect(screen.getByRole("textbox", { name: i18n.t("composer.placeholder") })).toHaveTextContent("保留的需求");
    });

    it("replaces the draft without an extra dialog and keeps its target and model", async () => {
        const project = createProjectWithCanvas("Campaign");
        useProjectStore.setState({ projects: [project] });
        const state = useHomeComposerStore.getState();
        state.setPrompt("旧的内容");
        state.setProjectTarget({ projectId: project.id });
        state.appendAttachments(state.draftId, [model]);
        renderFlow();
        fireEvent.click(screen.getByRole("button", { name: "设计海报" }));
        const text = i18n.t("composer.inspiration.prompts.poster.0");
        fireEvent.click(screen.getByRole("button", { name: text }));
        expect(screen.getByRole("textbox", { name: i18n.t("composer.placeholder") })).toHaveTextContent(text);
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(screen.getByRole("textbox", { name: i18n.t("composer.placeholder") })).toHaveFocus();
        expect(screen.getByRole("button", { name: text })).toBeVisible();
        expect(screen.queryByText("试试这样描述 · 设计海报")).not.toBeInTheDocument();
        expect(useHomeComposerStore.getState()).toMatchObject({ projectTarget: { projectId: project.id }, attachments: [model] });
    });

    it("hands off rich attachments and removes deleted files", async () => {
        const image = { ...model, id: "image", name: "hero.png", kind: "image" as const, mimeType: "image/png", handle: "stale-handle" };
        const state = useHomeComposerStore.getState();
        state.setPrompt("创建场景");
        state.appendAttachments(state.draftId, [model, image]);
        renderFlow();
        fireEvent.click(screen.getAllByRole("button", { name: "移除附件" })[1]);
        fireEvent.click(screen.getByRole("button", { name: "发送" }));
        await screen.findByLabelText("测试画布路由");
        expect(useAgentStore.getState().pendingAttachments).toEqual([model]);
        expect(useAgentStore.getState().pendingAttachments[0]).toMatchObject({ kind: "glb", dataUrl: model.dataUrl });
        expect(useAgentStore.getState().pendingAttachments[0].handle).toBeUndefined();
        expect(useHomeComposerStore.getState()).toMatchObject({ prompt: "", attachments: [], projectTarget: null });
    });

    it("submits an attachment-only draft with the default request", async () => {
        const state = useHomeComposerStore.getState();
        state.appendAttachments(state.draftId, [model]);
        renderFlow();
        fireEvent.click(screen.getByRole("button", { name: "发送" }));
        await screen.findByLabelText("测试画布路由");
        expect(useProjectStore.getState().pendingPrompt).toBe(i18n.t("agent.eventMore.attachmentPrompt"));
    });

    it("keeps send unavailable for an empty draft", () => {
        renderFlow();
        expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    });

    it("blocks rapid blank-board actions synchronously", async () => {
        renderFlow();
        const button = screen.getByRole("button", { name: "从画布开始" });
        act(() => { fireEvent.click(button); fireEvent.click(button); });
        await screen.findByLabelText("测试画布路由");
        expect(useProjectStore.getState().projects[0].canvases).toHaveLength(1);
    });

    it("allows a blank board while model configuration is unavailable", async () => {
        renderFlow();
        expect(screen.getByText(i18n.t("composer.configBlocked"))).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "从画布开始" }));
        expect(await screen.findByLabelText("测试画布路由")).toBeVisible();
    });

    it("shows project recovery state inline and disables blank creation", () => {
        useProjectStore.setState({ hydrationStatus: "error" });
        renderFlow();
        expect(screen.getByText(i18n.t("composer.errors.notReady"))).toBeVisible();
        expect(screen.getByRole("button", { name: "从画布开始" })).toBeDisabled();
    });

    it("drops a file read that completes after successful handoff", async () => {
        let finish!: (attachments: AgentAttachment[]) => void;
        vi.spyOn(homeAttachments, "readHomeAttachments").mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
        useHomeComposerStore.getState().setPrompt("先发送文字");
        renderFlow();
        const input = screen.getByLabelText("添加附件", { selector: "input" });
        fireEvent.change(input, { target: { files: [new File(["x"], "late.glb", { type: "model/gltf-binary" })] } });
        fireEvent.click(screen.getByRole("button", { name: "发送" }));
        await screen.findByLabelText("测试画布路由");
        await act(async () => { finish([model]); await Promise.resolve(); });
        expect(useHomeComposerStore.getState().attachments).toEqual([]);
    });

    it("rolls back an unconsumed handoff after navigation rejects and releases the action lock", async () => {
        const previousAttachment = { ...model, id: "previous", name: "previous.glb" };
        useHomeComposerStore.getState().setPrompt("保留失败输入");
        useProjectStore.setState({ pendingPrompt: "旧任务", pendingProjectId: "old-project", pendingCanvasId: "old-canvas" });
        useAgentStore.getState().setAgentState({ pendingAttachments: [previousAttachment] });
        navigationControl.rejectNext = true;
        renderFlow();
        fireEvent.click(screen.getByRole("button", { name: "发送" }));
        await waitFor(() => expect(useAgentStore.getState().pendingAttachments).toEqual([previousAttachment]));
        expect(useHomeComposerStore.getState().prompt).toBe("保留失败输入");
        expect(useProjectStore.getState()).toMatchObject({ pendingPrompt: "旧任务", pendingProjectId: "old-project", pendingCanvasId: "old-canvas" });
        expect(useProjectStore.getState().projects[0].canvases).toHaveLength(1);

        fireEvent.click(screen.getByRole("button", { name: "发送" }));
        expect(await screen.findByLabelText("测试画布路由")).toBeVisible();
    });

    it("does not overwrite handoff ownership replaced before navigation rejects", async () => {
        const replacementAttachment = { ...model, id: "replacement", name: "replacement.glb" };
        useHomeComposerStore.getState().setPrompt("保留失败输入");
        useProjectStore.setState({ pendingPrompt: "旧任务", pendingProjectId: "old-project", pendingCanvasId: "old-canvas" });
        navigationControl.rejectNext = true;
        navigationControl.beforeReject = () => {
            const installed = useProjectStore.getState();
            useProjectStore.setState({ pendingPrompt: "替代任务", pendingProjectId: installed.pendingProjectId, pendingCanvasId: installed.pendingCanvasId });
            useAgentStore.getState().setAgentState({ pendingAttachments: [replacementAttachment] });
        };
        renderFlow();
        fireEvent.click(screen.getByRole("button", { name: "发送" }));
        await waitFor(() => expect(useProjectStore.getState().pendingPrompt).toBe("替代任务"));
        expect(useProjectStore.getState()).toMatchObject({ pendingPrompt: "替代任务" });
        expect(useAgentStore.getState().pendingAttachments).toEqual([replacementAttachment]);
        expect(useHomeComposerStore.getState().prompt).toBe("保留失败输入");
        expect(useProjectStore.getState().projects[0].canvases).toHaveLength(1);
    });

    it("updates the warning from the real ChatGPT source state", async () => {
        useAiSourceStore.setState({ preferences: { version: 1, selections: { agent: { source: "chatgpt", modelId: "codex" } } } });
        renderFlow();
        expect(screen.getByText(i18n.t("composer.configBlocked"))).toBeVisible();
        act(() => useChatGptStore.setState({ status: { state: "signed-in" }, models: [{ id: "codex", name: "Codex", supportsImageInput: true }] }));
        await waitFor(() => expect(screen.queryByText(i18n.t("composer.configBlocked"))).toBeNull());
    });

    it("contains none of the forbidden helper or demo copy", () => {
        renderFlow();
        for (const text of ["已填入", "替换原内容", "确认替换", "演示", "一键生成"]) expect(screen.queryByText(text, { exact: false })).toBeNull();
    });
});
