import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AgentBridge } from "@/lib/agent/pi-agent-types";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-op-types";
import type { SkillRuntimeSnapshot, SkillsBridge } from "@/lib/skills/skill-types";
import i18n from "@/i18n";
import { useAgentSessionStore } from "@/stores/use-agent-session-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useAiSourceStore } from "@/stores/use-ai-source-store";
import { usePiHistoryStore } from "@/stores/use-pi-history-store";
import { PiAgentPanel } from "./pi-agent-panel";

// 时间线走 assistant-ui，jsdom 下 requestAnimationFrame 自动滚动会抛 scrollTo；
// 与 use-pi-agent.test.tsx 的面板用例一致，这里只 mock 展示层。
vi.mock("./agent-chat", () => ({ AgentChatTimeline: () => null, AgentUsageBar: () => null }));

vi.mock("@/services/project-asset-storage", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    storeCanvasImage: vi.fn(),
    storeCanvasMedia: vi.fn(),
}));

import { storeCanvasMedia } from "@/services/project-asset-storage";

const storeCanvasMediaMock = vi.mocked(storeCanvasMedia);

// 依赖漂移适配：vitest jsdom 环境里 fetch(dataUrl).blob() 返回 Node（undici）realm 的 Blob，
// 与全局 jsdom Blob 不同 realm，expect.any(Blob) 的 instanceof 恒为假；改按 toStringTag 断言 Blob 语义。
const anyBlob = {
    asymmetricMatch: (actual: unknown) => Object.prototype.toString.call(actual) === "[object Blob]",
    toString: () => "Any<Blob>",
};

const skillSnapshot: SkillRuntimeSnapshot = { revision: 1, skills: [], sources: [], diagnostics: [] };

let sessionSeq = 0;

function byokConfig() {
    return {
        ...defaultConfig,
        apiKey: "sk-test",
        channels: defaultConfig.channels.map((channel) => ({ ...channel, apiKey: "sk-test" })),
    };
}

function canvasSnapshot(): CanvasAgentSnapshot {
    return {
        projectId: "project-1",
        canvasId: "canvas-1",
        title: "Canvas",
        nodes: [],
        connections: [],
        selectedNodeIds: [],
        viewport: { x: 0, y: 0, k: 1 },
    };
}

// 回归：面板头部工作区按钮按项目显示工作区（basename / 占位），菜单提供复制路径与更改目录；
// 审批模式入口已移入 composer，header 不再出现。
describe("PiAgentPanel workspace button", () => {
    beforeEach(() => {
        useAiSourceStore.setState({ status: "ready", preferences: { version: 1, selections: {} }, error: null, applying: false });
        useAgentStore.setState({
            messages: [],
            sending: false,
            waiting: false,
            eventLogs: [],
            tokenUsage: null,
            canvasContext: { snapshot: canvasSnapshot(), applyOps: vi.fn(), undoOps: () => null, canUndo: false },
            canvasReferences: [],
            connectError: "",
            activity: "",
            prompt: "",
            pendingAttachments: [],
            submitRequest: null,
        });
        usePiHistoryStore.setState({ activeSessionId: null, sessions: [] });
        useAgentSessionStore.setState({ sessions: [], activeSessionId: null, unreadableSessions: [], pendingUserInputs: {} });
    });

    afterEach(() => {
        delete window.shotshot;
        useProjectStore.setState({ projects: [] });
    });

    test("shows the project workspace basename and offers copy/change actions", async () => {
        useProjectStore.setState({ projects: [{ id: "project-1", title: "P", category: "", icon: "", color: "", createdAt: "", updatedAt: "", canvases: [], workspacePath: "/Users/me/ws/p1-12345678" }] });
        const agent: AgentBridge = {
            listSessions: async () => ({ sessions: [], unreadable: [] }),
            createSession: async (input) => ({ sessionId: `session-${++sessionSeq}`, title: input.title || `session-${sessionSeq}`, scope: input.scope, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }),
            openSession: async () => ({ summary: { sessionId: "session-open", title: "session-open", scope: { projectId: "project-1", canvasId: "canvas-1" }, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }, entries: [] }),
            closeSession: async () => undefined,
            readSessionEntries: async () => [],
            abort: async () => undefined,
            compact: async () => ({ ok: true }),
            setCanvasSnapshot: () => {},
            importLegacySessions: async () => ({ ok: false, error: "not enabled" }),
            prompt: async () => ({ ok: true }),
            respondToUserInput: async () => ({ ok: true }),
            setApprovalMode: async () => undefined,
            // 90b9d6d 起 createSession 前会解析项目工作区；未提供时 sendPrompt 静默失败。
            ensureProjectWorkspace: async () => ({ ok: false, error: "unsupported" }),
            respondToApproval: async () => ({ ok: true }),
            setModelConfig: async () => {},
            onEvent: () => () => undefined,
            waitForIdle: async () => {},
            registerFiles: async () => [],
            readFile: async () => ({ ok: false, error: "unsupported" }),
            listFolder: async () => ({ ok: false, error: "unsupported" }),
            fetch: async (request) => ({ id: request.id, status: 200, statusText: "OK", headers: {}, body: "" }),
            setProjects: () => {},
            setGenerationStatus: () => {},
            setModels: () => {},
            setScriptEntities: () => {},
        };
        const skills: SkillsBridge = {
            configure: async () => ({ fresh: true, snapshot: skillSnapshot }),
            scan: async () => ({ fresh: true, snapshot: skillSnapshot }),
            read: async () => null,
            readFile: async () => ({ ok: false, error: "missing" }),
            write: async () => ({ ok: true }),
            importSkill: async () => null,
            remove: async () => ({ ok: true }),
            seed: async () => ({ ok: true }),
            pickFolder: vi.fn(async () => "/tmp/x"),
        };
        window.shotshot = { agent, skills, platform: "darwin" } as never;
        render(
            <I18nextProvider i18n={i18n}>
                <AntApp>
                    <MemoryRouter initialEntries={["/canvas/project-1/canvas-1"]}>
                        <PiAgentPanel />
                    </MemoryRouter>
                </AntApp>
            </I18nextProvider>,
        );

        expect(screen.getByText("p1-12345678")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "工作区" }));
        expect(await screen.findByText("复制路径")).toBeTruthy();
        expect(screen.getByText("更改目录…")).toBeTruthy();
        // header 不再有审批模式入口（移入 composer）
        expect(screen.queryByRole("button", { name: "Agent 审批模式" })).toBeNull();
    });

    // /skills 停靠（全局空 scope、无项目）：工作区按钮只显示占位「工作区」，
    // 菜单不提供「更改目录…」，避免点击后静默无效的死项。
    test("hides the change-directory action when rendered without a project context", async () => {
        useAgentStore.setState({ canvasContext: null });
        const agent: AgentBridge = {
            listSessions: async () => ({ sessions: [], unreadable: [] }),
            createSession: async (input) => ({ sessionId: `session-${++sessionSeq}`, title: input.title || `session-${sessionSeq}`, scope: input.scope, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }),
            openSession: async () => ({ summary: { sessionId: "session-open", title: "session-open", scope: { projectId: "project-1", canvasId: "canvas-1" }, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }, entries: [] }),
            closeSession: async () => undefined,
            readSessionEntries: async () => [],
            abort: async () => undefined,
            compact: async () => ({ ok: true }),
            setCanvasSnapshot: () => {},
            importLegacySessions: async () => ({ ok: false, error: "not enabled" }),
            prompt: async () => ({ ok: true }),
            respondToUserInput: async () => ({ ok: true }),
            setApprovalMode: async () => undefined,
            ensureProjectWorkspace: async () => ({ ok: false, error: "unsupported" }),
            respondToApproval: async () => ({ ok: true }),
            setModelConfig: async () => {},
            onEvent: () => () => undefined,
            waitForIdle: async () => {},
            registerFiles: async () => [],
            readFile: async () => ({ ok: false, error: "unsupported" }),
            listFolder: async () => ({ ok: false, error: "unsupported" }),
            fetch: async (request) => ({ id: request.id, status: 200, statusText: "OK", headers: {}, body: "" }),
            setProjects: () => {},
            setGenerationStatus: () => {},
            setModels: () => {},
            setScriptEntities: () => {},
        };
        const skills: SkillsBridge = {
            configure: async () => ({ fresh: true, snapshot: skillSnapshot }),
            scan: async () => ({ fresh: true, snapshot: skillSnapshot }),
            read: async () => null,
            readFile: async () => ({ ok: false, error: "missing" }),
            write: async () => ({ ok: true }),
            importSkill: async () => null,
            remove: async () => ({ ok: true }),
            seed: async () => ({ ok: true }),
            pickFolder: async () => null,
        };
        window.shotshot = { agent, skills, platform: "darwin" } as never;
        render(
            <I18nextProvider i18n={i18n}>
                <AntApp>
                    <MemoryRouter initialEntries={["/canvas/project-1/canvas-1"]}>
                        <PiAgentPanel />
                    </MemoryRouter>
                </AntApp>
            </I18nextProvider>,
        );

        expect(screen.getByRole("button", { name: "工作区" })).toBeTruthy();
        expect(screen.getByText("工作区")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "工作区" }));
        expect(await screen.findByRole("menu")).toBeTruthy();
        expect(screen.queryByText("更改目录…")).toBeNull();
        expect(screen.queryByText("复制路径")).toBeNull();
    });
});

// Task 10（project-asset-storage）：更改目录不再直接改写 workspacePath，
// 而是先经主进程复制 + 校验（relocateWorkspace 桥），成功后才绑定新路径；失败保持原绑定。
describe("PiAgentPanel workspace relocation", () => {
    const relocateWorkspace = vi.fn<() => Promise<{ ok: true; path: string } | { ok: false; error: string }>>();
    const pickFolder = vi.fn(async () => "/tmp/picked-target");

    function buildAgent(): AgentBridge {
        return {
            listSessions: async () => ({ sessions: [], unreadable: [] }),
            createSession: async (input) => ({ sessionId: `session-${++sessionSeq}`, title: input.title || `session-${sessionSeq}`, scope: input.scope, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }),
            openSession: async () => ({ summary: { sessionId: "session-open", title: "session-open", scope: { projectId: "project-1", canvasId: "canvas-1" }, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }, entries: [] }),
            closeSession: async () => undefined,
            readSessionEntries: async () => [],
            abort: async () => undefined,
            compact: async () => ({ ok: true }),
            setCanvasSnapshot: () => {},
            importLegacySessions: async () => ({ ok: false, error: "not enabled" }),
            prompt: async () => ({ ok: true }),
            respondToUserInput: async () => ({ ok: true }),
            setApprovalMode: async () => undefined,
            ensureProjectWorkspace: async () => ({ ok: false, error: "unsupported" }),
            respondToApproval: async () => ({ ok: true }),
            setModelConfig: async () => {},
            onEvent: () => () => undefined,
            waitForIdle: async () => {},
            registerFiles: async () => [],
            readFile: async () => ({ ok: false, error: "unsupported" }),
            listFolder: async () => ({ ok: false, error: "unsupported" }),
            fetch: async (request) => ({ id: request.id, status: 200, statusText: "OK", headers: {}, body: "" }),
            setProjects: () => {},
            setGenerationStatus: () => {},
            setModels: () => {},
            setScriptEntities: () => {},
        };
    }

    function renderPanel() {
        return render(
            <I18nextProvider i18n={i18n}>
                <AntApp>
                    <MemoryRouter initialEntries={["/canvas/project-1/canvas-1"]}>
                        <PiAgentPanel />
                    </MemoryRouter>
                </AntApp>
            </I18nextProvider>,
        );
    }

    async function openChangeDirectoryMenu() {
        fireEvent.click(screen.getByRole("button", { name: "工作区" }));
        fireEvent.click(await screen.findByText("更改目录…"));
    }

    beforeEach(() => {
        relocateWorkspace.mockReset();
        pickFolder.mockClear();
        useAiSourceStore.setState({ status: "ready", preferences: { version: 1, selections: {} }, error: null, applying: false });
        useAgentStore.setState({
            messages: [],
            sending: false,
            waiting: false,
            eventLogs: [],
            tokenUsage: null,
            canvasContext: { snapshot: canvasSnapshot(), applyOps: vi.fn(), undoOps: () => null, canUndo: false },
            canvasReferences: [],
            connectError: "",
            activity: "",
            prompt: "",
            pendingAttachments: [],
            submitRequest: null,
        });
        usePiHistoryStore.setState({ activeSessionId: null, sessions: [] });
        useAgentSessionStore.setState({ sessions: [], activeSessionId: null, unreadableSessions: [], pendingUserInputs: {} });
        useProjectStore.setState({ projects: [{ id: "project-1", title: "P", category: "", icon: "", color: "", createdAt: "", updatedAt: "", canvases: [], workspacePath: "/Users/me/ws/p1-12345678" }] });
        window.shotshot = {
            agent: buildAgent(),
            skills: { configure: async () => ({ fresh: true, snapshot: skillSnapshot }), scan: async () => ({ fresh: true, snapshot: skillSnapshot }), read: async () => null, readFile: async () => ({ ok: false, error: "missing" }), write: async () => ({ ok: true }), importSkill: async () => null, remove: async () => ({ ok: true }), seed: async () => ({ ok: true }), pickFolder },
            platform: "darwin",
            projectAssets: { relocateWorkspace },
        } as never;
    });

    afterEach(() => {
        delete window.shotshot;
        useProjectStore.setState({ projects: [] });
    });

    test("relocates through the bridge and binds the verified path on success", async () => {
        relocateWorkspace.mockResolvedValue({ ok: true, path: "/tmp/verified-target" });
        renderPanel();

        await openChangeDirectoryMenu();

        await waitFor(() => expect(relocateWorkspace).toHaveBeenCalledWith({ projectId: "project-1", sourcePath: "/Users/me/ws/p1-12345678", targetPath: "/tmp/picked-target" }));
        await waitFor(() => expect(useProjectStore.getState().projects.find((p) => p.id === "project-1")?.workspacePath).toBe("/tmp/verified-target"));
    });

    test("keeps the previous workspace binding when relocation fails", async () => {
        relocateWorkspace.mockResolvedValue({ ok: false, error: "目标目录属于其他项目，拒绝覆盖" });
        renderPanel();

        await openChangeDirectoryMenu();

        await waitFor(() => expect(relocateWorkspace).toHaveBeenCalled());
        expect(useProjectStore.getState().projects.find((p) => p.id === "project-1")?.workspacePath).toBe("/Users/me/ws/p1-12345678");
    });
});

// 回归：面板 header 提供收起按钮，/skills 停靠时也能从面板自身关闭（画布顶栏 Bot 开关之外的第二入口）。
describe("PiAgentPanel header close button", () => {
    beforeEach(() => {
        useAiSourceStore.setState({ status: "ready", preferences: { version: 1, selections: {} }, error: null, applying: false });
        useAgentStore.setState({
            messages: [],
            sending: false,
            waiting: false,
            eventLogs: [],
            tokenUsage: null,
            canvasContext: { snapshot: canvasSnapshot(), applyOps: vi.fn(), undoOps: () => null, canUndo: false },
            canvasReferences: [],
            connectError: "",
            activity: "",
            prompt: "",
            pendingAttachments: [],
            submitRequest: null,
        });
        usePiHistoryStore.setState({ activeSessionId: null, sessions: [] });
        useAgentSessionStore.setState({ sessions: [], activeSessionId: null, unreadableSessions: [], pendingUserInputs: {} });
    });

    afterEach(() => {
        delete window.shotshot;
        useAgentStore.setState({ panelOpen: false, panelMounted: false, panelClosing: false });
    });

    test("header close button collapses the panel", () => {
        const agent: AgentBridge = {
            listSessions: async () => ({ sessions: [], unreadable: [] }),
            createSession: async (input) => ({ sessionId: `session-${++sessionSeq}`, title: input.title || `session-${sessionSeq}`, scope: input.scope, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }),
            openSession: async () => ({ summary: { sessionId: "session-open", title: "session-open", scope: { projectId: "project-1", canvasId: "canvas-1" }, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }, entries: [] }),
            closeSession: async () => undefined,
            readSessionEntries: async () => [],
            abort: async () => undefined,
            compact: async () => ({ ok: true }),
            setCanvasSnapshot: () => {},
            importLegacySessions: async () => ({ ok: false, error: "not enabled" }),
            prompt: async () => ({ ok: true }),
            respondToUserInput: async () => ({ ok: true }),
            setApprovalMode: async () => undefined,
            ensureProjectWorkspace: async () => ({ ok: false, error: "unsupported" }),
            respondToApproval: async () => ({ ok: true }),
            setModelConfig: async () => {},
            onEvent: () => () => undefined,
            waitForIdle: async () => {},
            registerFiles: async () => [],
            readFile: async () => ({ ok: false, error: "unsupported" }),
            listFolder: async () => ({ ok: false, error: "unsupported" }),
            fetch: async (request) => ({ id: request.id, status: 200, statusText: "OK", headers: {}, body: "" }),
            setProjects: () => {},
            setGenerationStatus: () => {},
            setModels: () => {},
            setScriptEntities: () => {},
        };
        const skills: SkillsBridge = {
            configure: async () => ({ fresh: true, snapshot: skillSnapshot }),
            scan: async () => ({ fresh: true, snapshot: skillSnapshot }),
            read: async () => null,
            readFile: async () => ({ ok: false, error: "missing" }),
            write: async () => ({ ok: true }),
            importSkill: async () => null,
            remove: async () => ({ ok: true }),
            seed: async () => ({ ok: true }),
            pickFolder: async () => null,
        };
        window.shotshot = { agent, skills, platform: "darwin" } as never;
        render(
            <I18nextProvider i18n={i18n}>
                <AntApp>
                    <MemoryRouter initialEntries={["/canvas/project-1/canvas-1"]}>
                        <PiAgentPanel />
                    </MemoryRouter>
                </AntApp>
            </I18nextProvider>,
        );
        useAgentStore.setState({ panelOpen: true, panelMounted: true, panelClosing: false });

        fireEvent.click(screen.getByRole("button", { name: "收起 Agent" }));

        expect(useAgentStore.getState().panelOpen).toBe(false);
    });
});

// 回归：面板 header 提供收起按钮，/skills 停靠时也能从面板自身关闭（画布顶栏 Bot 开关之外的第二入口）。
describe("PiAgentPanel header close button", () => {
    beforeEach(() => {
        useAiSourceStore.setState({ status: "ready", preferences: { version: 1, selections: {} }, error: null, applying: false });
        useAgentStore.setState({
            messages: [],
            sending: false,
            waiting: false,
            eventLogs: [],
            tokenUsage: null,
            canvasContext: { snapshot: canvasSnapshot(), applyOps: vi.fn(), undoOps: () => null, canUndo: false },
            canvasReferences: [],
            connectError: "",
            activity: "",
            prompt: "",
            pendingAttachments: [],
            submitRequest: null,
        });
        usePiHistoryStore.setState({ activeSessionId: null, sessions: [] });
        useAgentSessionStore.setState({ sessions: [], activeSessionId: null, unreadableSessions: [], pendingUserInputs: {} });
    });

    afterEach(() => {
        delete window.shotshot;
        useAgentStore.setState({ panelOpen: false, panelMounted: false, panelClosing: false });
    });

    test("header close button collapses the panel", () => {
        const agent: AgentBridge = {
            listSessions: async () => ({ sessions: [], unreadable: [] }),
            createSession: async (input) => ({ sessionId: `session-${++sessionSeq}`, title: input.title || `session-${sessionSeq}`, scope: input.scope, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }),
            openSession: async () => ({ summary: { sessionId: "session-open", title: "session-open", scope: { projectId: "project-1", canvasId: "canvas-1" }, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }, entries: [] }),
            closeSession: async () => undefined,
            readSessionEntries: async () => [],
            abort: async () => undefined,
            compact: async () => ({ ok: true }),
            setCanvasSnapshot: () => {},
            importLegacySessions: async () => ({ ok: false, error: "not enabled" }),
            prompt: async () => ({ ok: true }),
            respondToUserInput: async () => ({ ok: true }),
            setApprovalMode: async () => undefined,
            // 90b9d6d 起 createSession 前会解析项目工作区；未提供时 sendPrompt 静默失败。
            ensureProjectWorkspace: async () => ({ ok: false, error: "unsupported" }),
            respondToApproval: async () => ({ ok: true }),
            setModelConfig: async () => {},
            onEvent: () => () => undefined,
            waitForIdle: async () => {},
            registerFiles: async () => [],
            readFile: async () => ({ ok: false, error: "unsupported" }),
            listFolder: async () => ({ ok: false, error: "unsupported" }),
            fetch: async (request) => ({ id: request.id, status: 200, statusText: "OK", headers: {}, body: "" }),
            setProjects: () => {},
            setGenerationStatus: () => {},
            setModels: () => {},
            setScriptEntities: () => {},
        };
        const skills: SkillsBridge = {
            configure: async () => ({ fresh: true, snapshot: skillSnapshot }),
            scan: async () => ({ fresh: true, snapshot: skillSnapshot }),
            read: async () => null,
            readFile: async () => ({ ok: false, error: "missing" }),
            write: async () => ({ ok: true }),
            importSkill: async () => null,
            remove: async () => ({ ok: true }),
            seed: async () => ({ ok: true }),
            pickFolder: async () => null,
        };
        window.shotshot = { agent, skills, platform: "darwin" } as never;
        render(
            <I18nextProvider i18n={i18n}>
                <AntApp>
                    <MemoryRouter initialEntries={["/canvas/project-1/canvas-1"]}>
                        <PiAgentPanel />
                    </MemoryRouter>
                </AntApp>
            </I18nextProvider>,
        );
        useAgentStore.setState({ panelOpen: true, panelMounted: true, panelClosing: false });

        fireEvent.click(screen.getByRole("button", { name: "收起 Agent" }));

        expect(useAgentStore.getState().panelOpen).toBe(false);
    });
});

// Task 5（project-asset-storage）：面板附件走发送时持久化 —— 挑选阶段只做本地预览
// 且不注册会话句柄；发送时写入项目资产失败要恢复草稿与附件，等待用户重试。
describe("PiAgentPanel attachment materialization", () => {
    const registerFiles = vi.fn<AgentBridge["registerFiles"]>().mockResolvedValue([]);
    const promptSpy = vi.fn<AgentBridge["prompt"]>().mockResolvedValue({ ok: true });

    function buildAgent(): AgentBridge {
        return {
            listSessions: async () => ({ sessions: [], unreadable: [] }),
            createSession: async (input) => ({ sessionId: `session-${++sessionSeq}`, title: input.title || `session-${sessionSeq}`, scope: input.scope, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }),
            openSession: async () => ({ summary: { sessionId: "session-open", title: "session-open", scope: { projectId: "project-1", canvasId: "canvas-1" }, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }, entries: [] }),
            closeSession: async () => undefined,
            readSessionEntries: async () => [],
            abort: async () => undefined,
            compact: async () => ({ ok: true }),
            setCanvasSnapshot: () => {},
            importLegacySessions: async () => ({ ok: false, error: "not enabled" }),
            prompt: promptSpy,
            respondToUserInput: async () => ({ ok: true }),
            setApprovalMode: async () => undefined,
            ensureProjectWorkspace: async () => ({ ok: false, error: "unsupported" }),
            respondToApproval: async () => ({ ok: true }),
            setModelConfig: async () => {},
            onEvent: () => () => undefined,
            waitForIdle: async () => {},
            registerFiles,
            readFile: async () => ({ ok: false, error: "unsupported" }),
            listFolder: async () => ({ ok: false, error: "unsupported" }),
            fetch: async (request) => ({ id: request.id, status: 200, statusText: "OK", headers: {}, body: "" }),
            setProjects: () => {},
            setGenerationStatus: () => {},
            setModels: () => {},
            setScriptEntities: () => {},
        };
    }

    const skills: SkillsBridge = {
        configure: async () => ({ fresh: true, snapshot: skillSnapshot }),
        scan: async () => ({ fresh: true, snapshot: skillSnapshot }),
        read: async () => null,
        readFile: async () => ({ ok: false, error: "missing" }),
        write: async () => ({ ok: true }),
        importSkill: async () => null,
        remove: async () => ({ ok: true }),
        seed: async () => ({ ok: true }),
        pickFolder: async () => null,
    };

    function renderPanel() {
        return render(
            <I18nextProvider i18n={i18n}>
                <AntApp>
                    <MemoryRouter initialEntries={["/canvas/project-1/canvas-1"]}>
                        <PiAgentPanel />
                    </MemoryRouter>
                </AntApp>
            </I18nextProvider>,
        );
    }

    function composerFileInput(): HTMLInputElement {
        const candidates = screen.getAllByLabelText(i18n.t("agent.composer.addAttachment"));
        const input = candidates.find((element) => element.tagName === "INPUT") as HTMLInputElement;
        expect(input).toBeTruthy();
        return input;
    }

    async function pickAttachment(name: string, type: string) {
        const input = composerFileInput();
        await act(async () => {
            fireEvent.change(input, { target: { files: [new File(["fixture"], name, { type })] } });
        });
        await waitFor(() => expect(screen.getByTitle(name)).toBeInTheDocument());
    }

    beforeEach(async () => {
        registerFiles.mockClear();
        promptSpy.mockClear();
        storeCanvasMediaMock.mockReset();
        useAiSourceStore.setState({ status: "ready", preferences: { version: 1, selections: {} }, error: null, applying: false });
        useConfigStore.setState({ config: byokConfig() });
        useAgentStore.setState({
            messages: [],
            sending: false,
            waiting: false,
            eventLogs: [],
            tokenUsage: null,
            canvasContext: { snapshot: canvasSnapshot(), applyOps: vi.fn(), undoOps: () => null, canUndo: false },
            canvasReferences: [],
            connectError: "",
            activity: "",
            prompt: "",
            pendingAttachments: [],
            submitRequest: null,
        });
        usePiHistoryStore.setState({ activeSessionId: null, sessions: [] });
        useAgentSessionStore.setState({ sessions: [], activeSessionId: null, unreadableSessions: [], pendingUserInputs: {} });
        window.shotshot = { agent: buildAgent(), skills, platform: "darwin" } as never;
    });

    afterEach(async () => {
        delete window.shotshot;
        useConfigStore.setState({ config: defaultConfig });
        useAgentStore.setState({ connectError: "", activity: "" });
    });

    test("keeps attachment picks as local previews without registering a session handle", async () => {
        renderPanel();

        await pickAttachment("note.txt", "text/plain");

        // 挑选阶段绝不注册最终会话句柄；持久化只发生在发送时。
        expect(registerFiles).not.toHaveBeenCalled();
        expect(promptSpy).not.toHaveBeenCalled();
    });

    test("sends the bounded file manifest and never registers handles at send time", async () => {
        storeCanvasMediaMock.mockResolvedValue({
            url: "blob:stored",
            assetRef: { backend: "project-file", projectId: "project-1", assetId: "asset-1", relativePath: "assets/imported/note--a1b2c3d4.txt", revision: 1 },
            bytes: 7,
            mimeType: "text/plain",
        });
        renderPanel();
        await pickAttachment("note.txt", "text/plain");

        const textbox = screen.getByRole("textbox");
        await act(async () => {
            textbox.textContent = "总结这个文件";
            fireEvent.input(textbox);
            fireEvent.keyDown(textbox, { key: "Enter", code: "Enter" });
        });

        await waitFor(() => expect(promptSpy).toHaveBeenCalledTimes(1));
        expect(registerFiles).not.toHaveBeenCalled();
        expect(promptSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            files: [expect.objectContaining({ relativePath: "assets/imported/note--a1b2c3d4.txt", kind: "text", name: "note.txt" })],
            images: [],
        }));
        expect(storeCanvasMediaMock).toHaveBeenCalledWith(anyBlob, expect.objectContaining({
            projectId: "project-1",
            source: expect.objectContaining({ type: "agent-attachment", canvasId: "canvas-1" }),
        }));
        expect(useAgentStore.getState().messages.find((item) => item.role === "user")?.attachments?.[0]).toMatchObject({
            assetRef: { backend: "project-file", assetId: "asset-1" },
            relativePath: "assets/imported/note--a1b2c3d4.txt",
        });
    });

    test("restores the composer draft and attachment chips when project storage fails at send time", async () => {
        storeCanvasMediaMock.mockRejectedValue(new Error("workspace offline"));
        renderPanel();
        await pickAttachment("note.txt", "text/plain");

        const textbox = screen.getByRole("textbox");
        await act(async () => {
            textbox.textContent = "总结这个文件";
            fireEvent.input(textbox);
            fireEvent.keyDown(textbox, { key: "Enter", code: "Enter" });
        });

        await waitFor(() => expect(useAgentStore.getState().connectError).toContain("workspace offline"));
        // 草稿与附件都在输入区恢复，用户可以直接重试。
        await waitFor(() => expect(screen.getByRole("textbox")).toHaveTextContent("总结这个文件"));
        expect(screen.getByTitle("note.txt")).toBeInTheDocument();
        expect(promptSpy).not.toHaveBeenCalled();
        expect(useAgentStore.getState().messages.some((item) => item.role === "user")).toBe(false);
    });
});

// 回归：头部去 tab 改版 —— 对话历史收进右上角 Popover；日志 tab 移除，
// 改为 2 秒窗口内连点标题 5 次开/关的调试模式（整区替换对话内容）。
describe("PiAgentPanel header history popover and debug log mode", () => {
    function buildAgent(): AgentBridge {
        return {
            listSessions: async () => ({ sessions: [], unreadable: [] }),
            createSession: async (input) => ({ sessionId: `session-${++sessionSeq}`, title: input.title || `session-${sessionSeq}`, scope: input.scope, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }),
            openSession: async () => ({ summary: { sessionId: "session-open", title: "session-open", scope: { projectId: "project-1", canvasId: "canvas-1" }, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }, entries: [] }),
            closeSession: async () => undefined,
            readSessionEntries: async () => [],
            abort: async () => undefined,
            compact: async () => ({ ok: true }),
            setCanvasSnapshot: () => {},
            importLegacySessions: async () => ({ ok: false, error: "not enabled" }),
            prompt: async () => ({ ok: true }),
            respondToUserInput: async () => ({ ok: true }),
            setApprovalMode: async () => undefined,
            ensureProjectWorkspace: async () => ({ ok: false, error: "unsupported" }),
            respondToApproval: async () => ({ ok: true }),
            setModelConfig: async () => {},
            onEvent: () => () => undefined,
            waitForIdle: async () => {},
            registerFiles: async () => [],
            readFile: async () => ({ ok: false, error: "unsupported" }),
            listFolder: async () => ({ ok: false, error: "unsupported" }),
            fetch: async (request) => ({ id: request.id, status: 200, statusText: "OK", headers: {}, body: "" }),
            setProjects: () => {},
            setGenerationStatus: () => {},
            setModels: () => {},
            setScriptEntities: () => {},
        };
    }

    const skills: SkillsBridge = {
        configure: async () => ({ fresh: true, snapshot: skillSnapshot }),
        scan: async () => ({ fresh: true, snapshot: skillSnapshot }),
        read: async () => null,
        readFile: async () => ({ ok: false, error: "missing" }),
        write: async () => ({ ok: true }),
        importSkill: async () => null,
        remove: async () => ({ ok: true }),
        seed: async () => ({ ok: true }),
        pickFolder: async () => null,
    };

    function renderPanel() {
        return render(
            <I18nextProvider i18n={i18n}>
                <AntApp>
                    <MemoryRouter initialEntries={["/canvas/project-1/canvas-1"]}>
                        <PiAgentPanel />
                    </MemoryRouter>
                </AntApp>
            </I18nextProvider>,
        );
    }

    beforeEach(async () => {
        useAiSourceStore.setState({ status: "ready", preferences: { version: 1, selections: {} }, error: null, applying: false });
        useConfigStore.setState({ config: byokConfig() });
        useAgentStore.setState({
            messages: [],
            sending: false,
            waiting: false,
            eventLogs: [],
            tokenUsage: null,
            canvasContext: { snapshot: canvasSnapshot(), applyOps: vi.fn(), undoOps: () => null, canUndo: false },
            canvasReferences: [],
            connectError: "",
            activity: "",
            prompt: "",
            pendingAttachments: [],
            submitRequest: null,
        });
        usePiHistoryStore.setState({ activeSessionId: null, sessions: [] });
        useAgentSessionStore.setState({ sessions: [], activeSessionId: null, unreadableSessions: [], pendingUserInputs: {} });
        window.shotshot = { agent: buildAgent(), skills, platform: "darwin" } as never;
        // composer 只在 modelConfig 就绪时挂载；先注水目录快照。
    });

    afterEach(() => {
        delete window.shotshot;
        useConfigStore.setState({ config: defaultConfig });
    });

    test("opens the chat history popover from the header history button", async () => {
        renderPanel();

        fireEvent.click(screen.getByRole("button", { name: i18n.t("agent.panel.history") }));

        // 浮层标题 + 历史视图（空状态）都在；对话内容不被替换。
        expect(await screen.findByText(i18n.t("agent.panel.history"))).toBeTruthy();
        expect(screen.getByText(i18n.t("agent.pi.historyEmpty"))).toBeTruthy();
        expect(screen.getByRole("textbox", { name: i18n.t("agent.pi.placeholder") })).toBeTruthy();
    });

    test("toggles the debug log view by clicking the header blank zone five times", () => {
        renderPanel();
        const debugZone = screen.getByTestId("agent-panel-debug-zone");

        for (let i = 0; i < 5; i += 1) fireEvent.click(debugZone);

        // 整区替换：composer 消失，日志视图 + 调试徽标出现。
        expect(screen.queryByRole("textbox", { name: i18n.t("agent.pi.placeholder") })).toBeNull();
        expect(screen.getByText(i18n.t("agent.panel.debugMode"))).toBeTruthy();
        expect(screen.getByText(i18n.t("agent.logs.title"))).toBeTruthy();

        for (let i = 0; i < 5; i += 1) fireEvent.click(debugZone);

        expect(screen.getByRole("textbox", { name: i18n.t("agent.pi.placeholder") })).toBeTruthy();
        expect(screen.queryByText(i18n.t("agent.panel.debugMode"))).toBeNull();
    });

    test("resets the click window so spaced clicks do not toggle debug mode", () => {
        vi.useFakeTimers();
        try {
            renderPanel();
            const debugZone = screen.getByTestId("agent-panel-debug-zone");

            for (let i = 0; i < 4; i += 1) fireEvent.click(debugZone);
            vi.advanceTimersByTime(2100);
            for (let i = 0; i < 4; i += 1) fireEvent.click(debugZone);

            // 两个窗口内各只有 4 次：调试模式未开启。
            expect(screen.queryByText(i18n.t("agent.panel.debugMode"))).toBeNull();
            expect(screen.getByRole("textbox", { name: i18n.t("agent.pi.placeholder") })).toBeTruthy();

            fireEvent.click(debugZone);
            expect(screen.getByText(i18n.t("agent.panel.debugMode"))).toBeTruthy();
        } finally {
            vi.useRealTimers();
        }
    });

    test("shows background tasks chip with stop and open actions", async () => {
        const abortMock = vi.fn(async () => undefined);
        window.shotshot!.agent.abort = abortMock;
        // listSessions 返回跨画布的运行中会话：恢复流程把它保留在列表里但不设为活动会话
        window.shotshot!.agent.listSessions = async () => ({
            sessions: [
                { sessionId: "bg-1", title: "bg", scope: { projectId: "project-1", canvasId: "canvas-2" }, createdAt: 0, updatedAt: 5, status: "running", hasUnfinishedOperation: true },
                { sessionId: "session-open", title: "open", scope: { projectId: "project-1", canvasId: "canvas-1" }, createdAt: 0, updatedAt: 9, status: "idle", hasUnfinishedOperation: false },
            ],
            unreadable: [],
        });

        renderPanel();
        await waitFor(() => expect(useAgentSessionStore.getState().activeSessionId).toBe("session-open"));

        // 只有跨画布的未完成会话出现在 chip/浮层；活动会话 session-open 不出现。
        fireEvent.click(screen.getByRole("button", { name: i18n.t("agent.background.title") }));
        expect(await screen.findByText(i18n.t("agent.background.title"))).toBeTruthy();
        expect(screen.getAllByRole("button", { name: i18n.t("agent.background.stop") })).toHaveLength(1);

        fireEvent.click(screen.getByRole("button", { name: i18n.t("agent.background.stop") }));
        await act(async () => {});
        expect(abortMock).toHaveBeenCalledWith("bg-1");
    });
});
