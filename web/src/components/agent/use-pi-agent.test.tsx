import { useAiSourceStore } from "@/stores/use-ai-source-store";
import { act, fireEvent, render, screen, waitFor, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentBridge, AgentFileContent, PiAgentEvent, PiSessionEntrySnapshot, PiSessionEnvelope, PiSessionSummary } from "@/lib/agent/pi-agent-types";
import type { SkillRuntimeSnapshot, SkillsBridge } from "@/lib/skills/skill-types";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-op-types";
import { createModelChannel, encodeChannelModel, modelOptionsFromChannels, defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useAgentStore, type AgentAttachment, type AgentCanvasContext, type AgentChatItem } from "@/stores/use-agent-store";
import { useProjectStore, type Project } from "@/stores/canvas/use-project-store";
import { canvasTitleFromPrompt } from "@/lib/canvas/canvas-title";
import { usePiHistoryStore, type PiSession } from "@/stores/use-pi-history-store";
import { useAgentSessionStore } from "@/stores/use-agent-session-store";
import { uploadImage } from "@/services/image-storage";
import { requestImageQuestion } from "@/services/api/image";
import { modelNotReadyKey, resolvePiModelConfig, usePiAgent } from "./use-pi-agent";

import { App } from "antd";
import i18n from "@/i18n";
import { PiAgentPanel } from "./pi-agent-panel";
vi.mock("./agent-chat", () => ({ AgentChatTimeline: () => null, AgentUsageBar: () => null }));

const snapshot: SkillRuntimeSnapshot = { revision: 1, skills: [], sources: [], diagnostics: [] };

// 依赖漂移适配：vitest jsdom 环境里 fetch(dataUrl).blob() 返回 Node（undici）realm 的 Blob，
// 与全局 jsdom Blob 不同 realm，expect.any(Blob) 的 instanceof 恒为假；改按 toStringTag 断言 Blob 语义。
const anyBlob = {
    asymmetricMatch: (actual: unknown) => Object.prototype.toString.call(actual) === "[object Blob]",
    toString: () => "Any<Blob>",
};

let sessionSeq = 0;

vi.mock("@/services/image-storage", () => ({ uploadImage: vi.fn() }));
vi.mock("@/services/file-storage", () => ({ uploadMediaFile: vi.fn() }));
vi.mock("@/services/api/image", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), requestImageQuestion: vi.fn() }));
vi.mock("@/services/project-asset-storage", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    storeCanvasImage: vi.fn(),
    storeCanvasMedia: vi.fn(),
}));

const { routeOpsMock, routeAttachmentImportMock } = vi.hoisted(() => ({ routeOpsMock: vi.fn(async () => undefined), routeAttachmentImportMock: vi.fn() }));
vi.mock("@/lib/agent/agent-op-router", async (importOriginal) => {
    const original = await importOriginal<Record<string, unknown>>();
    return {
        ...original,
        agentOpRouter: { ...(original.agentOpRouter as Record<string, unknown>), routeOps: routeOpsMock, routeAttachmentImport: routeAttachmentImportMock },
        enqueueCanvasMutation: (_canvasId: string, mutation: () => Promise<unknown>) => mutation(),
    };
});

import { storeCanvasImage, storeCanvasMedia } from "@/services/project-asset-storage";

const uploadImageMock = vi.mocked(uploadImage);
const requestImageQuestionMock = vi.mocked(requestImageQuestion);
const storeCanvasImageMock = vi.mocked(storeCanvasImage);
const storeCanvasMediaMock = vi.mocked(storeCanvasMedia);

function storedGlbeRef() {
    return { backend: "project-file" as const, projectId: "project-1", assetId: "asset-stored", relativePath: "assets/imported/bottle--a1b2c3d4.glb", revision: 1 };
}

function renderPiAgent(route = "/canvas/project-1/canvas-1") {
    return renderHook(() => usePiAgent(), { wrapper: ({ children }) => <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter> });
}

function canvasSnapshot(nodes: number, viewport: { x: number; y: number }): CanvasAgentSnapshot {
    return {
        projectId: "project-1",
        canvasId: "canvas-1",
        title: "Canvas",
        nodes: Array.from({ length: nodes }, (_item, index) => ({
            id: `node-${index}`,
            type: "text",
            title: `Node ${index}`,
            position: { x: index, y: index },
            width: 100,
            height: 100,
        })),
        connections: [],
        selectedNodeIds: [],
        viewport: { ...viewport, k: 1 },
    };
}

function projectWithCanvas(canvasId: string, canvasTitle: string): Project {
    const now = new Date(0).toISOString();
    return {
        id: "project-1",
        title: "项目",
        category: "uncategorized",
        icon: "sparkles",
        color: "#f5f5f4",
        createdAt: now,
        updatedAt: now,
        canvases: [{
            id: canvasId,
            title: canvasTitle,
            createdAt: now,
            updatedAt: now,
            nodes: [],
            connections: [],
            chatSessions: [],
            activeChatId: null,
            backgroundMode: "lines",
            showImageInfo: false,
            viewport: { x: 0, y: 0, k: 1 },
        }],
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

function summaryFor(sessionId: string, projectId: string, canvasId: string): PiSessionSummary {
    return { sessionId, title: sessionId, scope: { projectId, canvasId }, createdAt: 0, updatedAt: 3, status: "idle", hasUnfinishedOperation: false };
}

function canvasContext(snapshot: CanvasAgentSnapshot, applyOps: AgentCanvasContext["applyOps"]): AgentCanvasContext {
    return { snapshot, applyOps, undoOps: () => null, canUndo: false };
}

function attachment(): AgentFileContent {
    return {
        handle: "attachment-1",
        name: "input.png",
        kind: "image",
        mimeType: "image/png",
        size: 12,
        dataUrl: "data:image/png;base64,aW1hZ2U=",
    };
}

function pendingModel(): AgentAttachment {
    return {
        id: "m",
        name: "bottle.glb",
        kind: "glb",
        size: 1,
        url: "data:model/gltf-binary;base64,AA==",
        dataUrl: "data:model/gltf-binary;base64,AA==",
        mimeType: "model/gltf-binary",
    };
}

describe("usePiAgent turn activity", () => {
    let emit: ((event: PiAgentEvent) => void) | undefined;
    let runPrompt: () => void;
    const setModelConfigMock = vi.fn<AgentBridge["setModelConfig"]>(async () => undefined);

    beforeEach(() => {
        useAiSourceStore.setState({ status: "ready", preferences: { version: 1, selections: {} }, error: null, applying: false });
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        uploadImageMock.mockReset();
        requestImageQuestionMock.mockReset();
        storeCanvasImageMock.mockReset();
        storeCanvasMediaMock.mockReset();
        storeCanvasMediaMock.mockResolvedValue({
            url: "blob:stored-asset",
            assetRef: storedGlbeRef(),
            bytes: 1,
            mimeType: "model/gltf-binary",
        });
        setModelConfigMock.mockClear();
        runPrompt = () => {
            emit?.({ type: "agent_start" });
            vi.setSystemTime(1_500);
            emit?.({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "canvas_get_state", args: {} });
            vi.setSystemTime(2_000);
            emit?.({
                type: "tool_execution_update",
                toolCallId: "tool-1",
                toolName: "canvas_get_state",
                args: {},
                partialResult: { content: [{ type: "text", text: '{"nodes":[]}' }], details: null },
            });
            vi.setSystemTime(3_000);
            emit?.({
                type: "tool_execution_end",
                toolCallId: "tool-1",
                toolName: "canvas_get_state",
                result: { content: [{ type: "text", text: '{"nodes":[],"connections":[]}' }], details: null },
                isError: false,
            });
            vi.setSystemTime(5_500);
            emit?.({ type: "agent_end", messages: [] });
        };
        useAgentStore.setState({ messages: [], sending: false, waiting: false, eventLogs: [], tokenUsage: null, canvasContext: null });
        usePiHistoryStore.setState({ activeSessionId: null, sessions: [] });
        useAgentSessionStore.setState({ sessions: [], activeSessionId: null, unreadableSessions: [], pendingUserInputs: {} });
        useConfigStore.setState({
            config: {
                ...defaultConfig,
                channels: defaultConfig.channels.map((channel) => ({ ...channel, apiKey: "test-key" })),
            },
        });

        const agent: AgentBridge = {
            listSessions: async () => ({ sessions: [], unreadable: [] }),
            createSession: async () => ({ sessionId: `session-${++sessionSeq}`, title: `session-${sessionSeq}`, scope: { projectId: "project-1", canvasId: "canvas-1" }, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }),
            ensureProjectWorkspace: async () => ({ ok: false, error: "unsupported" }),
            openSession: async () => ({ summary: { sessionId: "session", title: "session", scope: { projectId: "p", canvasId: "c" }, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }, entries: [] }),
            closeSession: async () => undefined,
            readSessionEntries: async () => [],
            abort: async () => undefined,
            compact: async () => ({ ok: true }),
            setCanvasSnapshot: () => {},
            importLegacySessions: async () => ({ ok: false, error: "not enabled" }),
            prompt: async () => {
                runPrompt();
                return { ok: true };
            },
            respondToUserInput: async () => ({ ok: true }),
            setApprovalMode: async () => undefined,
            respondToApproval: async () => ({ ok: true }),
            setModelConfig: setModelConfigMock,
            onEvent: (callback) => { emit = callback; return () => { emit = undefined; }; },
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
            configure: async () => ({ fresh: true, snapshot }), scan: async () => ({ fresh: true, snapshot }), read: async () => null,
            readFile: async () => ({ ok: false, error: "missing" }), write: async () => ({ ok: true }), importSkill: async () => null,
            remove: async () => ({ ok: true }), seed: async () => ({ ok: true }), pickFolder: async () => null,
        };
        window.shotshot = { agent, skills, platform: "darwin" };
    });

    afterEach(() => {
        vi.useRealTimers();
        delete window.shotshot;
    });

    it("records one completed tool row and freezes the total duration on its user turn", async () => {
        const { result, unmount } = renderPiAgent();

        await act(async () => { await result.current.sendPrompt("读取画布"); });

        const messages = useAgentStore.getState().messages;
        expect(messages.map((item) => item.role)).toEqual(["user", "tool"]);
        expect(messages[0]).toMatchObject({ startedAt: 1_000, completedAt: 5_500, durationMs: 4_500 });
        expect(messages[1]).toMatchObject({
            itemId: "tool:tool-1",
            title: "读取画布",
            detail: { kind: "tool", status: "completed", input: "{}", output: '{"nodes":[],"connections":[]}', startedAt: 1_500, completedAt: 3_000, durationMs: 1_500 },
        });
        unmount();
    });

    it("names an untitled canvas with the AI-generated title", async () => {
        requestImageQuestionMock.mockResolvedValue("「科技感 iPhone 广告图」");
        useProjectStore.setState({ projects: [projectWithCanvas("canvas-1", i18n.t("canvas.canvas.untitled"))], hydrated: true, hydrationStatus: "success" });
        useAgentStore.setState({ canvasContext: canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn()) });
        const { result, unmount } = renderPiAgent();

        await act(async () => { await result.current.sendPrompt("帮我做一张 iPhone 广告图"); });
        await act(async () => {});

        expect(useProjectStore.getState().projects[0].canvases[0].title).toBe("科技感 iPhone 广告图");
        unmount();
    });

    it("replaces the home placeholder title with the AI title", async () => {
        requestImageQuestionMock.mockResolvedValue("科技感海报");
        const placeholder = canvasTitleFromPrompt("帮我做一张 iPhone 广告图");
        useProjectStore.setState({ projects: [projectWithCanvas("canvas-1", placeholder)], hydrated: true, hydrationStatus: "success" });
        useAgentStore.setState({ canvasContext: canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn()) });
        const { result, unmount } = renderPiAgent();

        await act(async () => { await result.current.sendPrompt("帮我做一张 iPhone 广告图"); });
        await act(async () => {});

        expect(useProjectStore.getState().projects[0].canvases[0].title).toBe("科技感海报");
        unmount();
    });

    it("falls back to the truncated prompt when title generation fails", async () => {
        requestImageQuestionMock.mockRejectedValue(new Error("model unavailable"));
        useProjectStore.setState({ projects: [projectWithCanvas("canvas-1", i18n.t("canvas.canvas.untitled"))], hydrated: true, hydrationStatus: "success" });
        useAgentStore.setState({ canvasContext: canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn()) });
        const { result, unmount } = renderPiAgent();

        await act(async () => { await result.current.sendPrompt("一".repeat(60)); });
        await act(async () => {});

        expect(useProjectStore.getState().projects[0].canvases[0].title).toBe(`${"一".repeat(40)}…`);
        unmount();
    });

    it("keeps an already-named canvas title on later prompts", async () => {
        useProjectStore.setState({ projects: [projectWithCanvas("canvas-1", "我的画布")], hydrated: true, hydrationStatus: "success" });
        useAgentStore.setState({ canvasContext: canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn()) });
        const { result, unmount } = renderPiAgent();

        await act(async () => { await result.current.sendPrompt("换一个名字"); });
        await act(async () => {});

        expect(useProjectStore.getState().projects[0].canvases[0].title).toBe("我的画布");
        expect(requestImageQuestionMock).not.toHaveBeenCalled();
        unmount();
    });

    it("falls back to the attachment name when the first turn has no text", async () => {
        useProjectStore.setState({ projects: [projectWithCanvas("canvas-1", i18n.t("canvas.canvas.untitled"))], hydrated: true, hydrationStatus: "success" });
        useAgentStore.setState({ canvasContext: canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn()) });
        const { result, unmount } = renderPiAgent();

        await act(async () => { await result.current.sendPrompt("", [pendingModel()]); });
        await act(async () => {});

        expect(useProjectStore.getState().projects[0].canvases[0].title).toBe("bottle.glb");
        expect(requestImageQuestionMock).not.toHaveBeenCalled();
        unmount();
    });

    it("skips the canvas auto title request for a bare skill command", async () => {
        useProjectStore.setState({ projects: [projectWithCanvas("canvas-1", i18n.t("canvas.canvas.untitled"))], hydrated: true, hydrationStatus: "success" });
        useAgentStore.setState({ canvasContext: canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn()) });
        const { result, unmount } = renderPiAgent();

        await act(async () => { await result.current.sendPrompt("/skill-creator"); });
        await act(async () => {});

        expect(requestImageQuestionMock).not.toHaveBeenCalled();
        // 跳过自动改名后画布标题保持不变（真实链路中标题已在 handoff 时取 prompt 截断）。
        expect(useProjectStore.getState().projects[0].canvases[0].title).toBe(i18n.t("canvas.canvas.untitled"));
        unmount();
    });

    it("still auto-titles canvases for skill commands with instructions", async () => {
        requestImageQuestionMock.mockResolvedValue("脚本优化");
        useProjectStore.setState({ projects: [projectWithCanvas("canvas-1", i18n.t("canvas.canvas.untitled"))], hydrated: true, hydrationStatus: "success" });
        useAgentStore.setState({ canvasContext: canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn()) });
        const { result, unmount } = renderPiAgent();

        await act(async () => { await result.current.sendPrompt("/shotshot-director 优化脚本"); });
        await act(async () => {});

        expect(requestImageQuestionMock).toHaveBeenCalledTimes(1);
        expect(useProjectStore.getState().projects[0].canvases[0].title).toBe("脚本优化");
        unmount();
    });

    it("waits for the current model config to reach the host before creating a session", async () => {
        let releaseModelConfig!: () => void;
        setModelConfigMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
            releaseModelConfig = resolve;
        }));
        let createSessionStarted = false;
        window.shotshot!.agent.createSession = async () => {
            createSessionStarted = true;
            return { sessionId: "sdk-after-config", title: "after config", scope: { projectId: "project-1", canvasId: "canvas-1" }, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false };
        };

        const { result, unmount } = renderPiAgent();
        const sending = result.current.sendPrompt("hello");
        await act(async () => { await Promise.resolve(); });
        expect(setModelConfigMock).toHaveBeenCalledTimes(1);
        expect(setModelConfigMock).toHaveBeenCalledWith(expect.objectContaining({ supportsImageInput: true }));
        expect(createSessionStarted).toBe(false);

        await act(async () => {
            releaseModelConfig();
            await sending;
        });
        expect(createSessionStarted).toBe(true);
        unmount();
    });

    it("clears stale messages when a fresh mount has no session for the current canvas", async () => {
        useAgentStore.setState({
            messages: [{ id: "stale", threadId: "old-session", turnId: "old-turn", itemId: "old-item", role: "user", text: "stale" } satisfies AgentChatItem],
            tokenUsage: { input: 1, cached: 0, output: 1 },
        });
        useAgentStore.getState().setCanvasContext(canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn()));

        const { unmount } = renderPiAgent();
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });

        expect(useAgentStore.getState().messages).toEqual([]);
        expect(useAgentStore.getState().tokenUsage).toBeNull();
        expect(useAgentSessionStore.getState().activeSessionId).toBeNull();
        unmount();
    });

    it("stores pending files in the project before creating the user message", async () => {
        const xlsxAttachment: AgentAttachment = {
            id: "sheet",
            name: "budget.xlsx",
            kind: "spreadsheet",
            size: 64,
            url: "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,AA==",
            dataUrl: "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,AA==",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        };
        const promptSpy = vi.fn<AgentBridge["prompt"]>().mockResolvedValue({ ok: true });
        const registerFiles = vi.fn<AgentBridge["registerFiles"]>().mockResolvedValue([]);
        const importAttachmentSpy = vi.fn<NonNullable<AgentCanvasContext["importAttachment"]>>().mockResolvedValue(null);
        window.shotshot!.agent.registerFiles = registerFiles;
        window.shotshot!.agent.prompt = promptSpy;
        window.shotshot!.agent.createSession = vi.fn(async () => summaryFor("target-session", "project-1", "canvas-1"));
        storeCanvasMediaMock.mockResolvedValueOnce({
            url: "blob:stored-sheet",
            assetRef: { backend: "project-file", projectId: "project-1", assetId: "asset-stored", relativePath: "assets/imported/budget--a1b2c3d4.xlsx", revision: 1 },
            bytes: 64,
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        useAgentStore.setState({
            canvasContext: { ...canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn()), importAttachment: importAttachmentSpy },
        });

        const { result, unmount } = renderPiAgent();
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        await act(async () => { await result.current.sendPrompt("修改这个表格", [xlsxAttachment]); });

        expect(storeCanvasMediaMock).toHaveBeenCalledWith(anyBlob, expect.objectContaining({
            projectId: "project-1",
            source: expect.objectContaining({ type: "agent-attachment", canvasId: "canvas-1" }),
        }));
        expect(promptSpy).toHaveBeenCalledWith("target-session", expect.objectContaining({
            files: [expect.objectContaining({ relativePath: expect.stringMatching(/^assets\/imported\//), kind: "spreadsheet", assetId: "asset-stored" })],
            images: [],
        }));
        expect(registerFiles).not.toHaveBeenCalled();
        expect(promptSpy.mock.calls[0]?.[1]).not.toHaveProperty("fileHandles");
        expect(useAgentStore.getState().messages.find((item) => item.role === "user")?.attachments?.[0]).toMatchObject({
            assetRef: { backend: "project-file", projectId: "project-1", assetId: "asset-stored", relativePath: "assets/imported/budget--a1b2c3d4.xlsx", revision: 1 },
            relativePath: "assets/imported/budget--a1b2c3d4.xlsx",
            kind: "spreadsheet",
        });
        unmount();
    });

    it("does not register session handles at pick time and imports from the stored asset", async () => {
        const registerFiles = vi.fn<AgentBridge["registerFiles"]>().mockResolvedValue([]);
        const promptSpy = vi.fn<AgentBridge["prompt"]>().mockResolvedValue({ ok: true });
        const importAttachmentSpy = vi.fn<NonNullable<AgentCanvasContext["importAttachment"]>>().mockResolvedValue(null);
        window.shotshot!.agent.registerFiles = registerFiles;
        window.shotshot!.agent.prompt = promptSpy;
        window.shotshot!.agent.createSession = vi.fn(async () => summaryFor("target-session", "project-1", "canvas-1"));
        useAgentStore.setState({
            canvasContext: { ...canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn()), importAttachment: importAttachmentSpy },
        });

        const { result, unmount } = renderPiAgent();
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        await act(async () => { await result.current.sendPrompt("product visual", [pendingModel()]); });

        expect(registerFiles).not.toHaveBeenCalled();
        expect(promptSpy).toHaveBeenCalledWith("target-session", expect.objectContaining({
            files: [expect.objectContaining({ relativePath: "assets/imported/bottle--a1b2c3d4.glb", kind: "glb" })],
            images: [],
        }));
        expect(importAttachmentSpy).toHaveBeenCalledWith(expect.objectContaining({ assetRef: storedGlbeRef(), kind: "glb", name: "bottle.glb" }));
        expect(useAgentStore.getState().messages.find((item) => item.role === "user")?.attachments?.[0]).toMatchObject({ assetRef: storedGlbeRef(), kind: "glb" });
        unmount();
    });

    it("does not prompt or import when the canvas scope changes while attachments are being stored", async () => {
        vi.useRealTimers();
        const storing = deferred<Awaited<ReturnType<typeof storeCanvasMedia>>>();
        storeCanvasMediaMock.mockImplementationOnce(() => storing.promise);
        const promptSpy = vi.fn<AgentBridge["prompt"]>().mockResolvedValue({ ok: true });
        const importAttachmentSpy = vi.fn<NonNullable<AgentCanvasContext["importAttachment"]>>().mockResolvedValue(null);
        window.shotshot!.agent.prompt = promptSpy;
        window.shotshot!.agent.createSession = vi.fn(async () => summaryFor("target-session", "project-1", "canvas-1"));
        const firstContext = { ...canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn()), importAttachment: importAttachmentSpy };
        useAgentStore.setState({ canvasContext: firstContext });

        const { result, unmount } = renderPiAgent();
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        const sending = result.current.sendPrompt("product visual", [pendingModel()]);
        await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
        expect(storeCanvasMediaMock).toHaveBeenCalled();

        await act(async () => {
            useAgentStore.getState().setCanvasContext({
                ...firstContext,
                snapshot: { ...firstContext.snapshot, projectId: "project-2", canvasId: "canvas-2" },
            });
            storing.resolve({
                url: "blob:stored",
                assetRef: storedGlbeRef(),
                bytes: 1,
                mimeType: "model/gltf-binary",
            });
            await sending;
        });

        expect(promptSpy).not.toHaveBeenCalled();
        expect(importAttachmentSpy).not.toHaveBeenCalled();
        expect(useAgentStore.getState().messages.some((item) => item.role === "user")).toBe(false);
        unmount();
    });

    it("ignores a rejected store from the previous scope without restoring its draft", async () => {
        vi.useRealTimers();
        const storing = deferred<Awaited<ReturnType<typeof storeCanvasMedia>>>();
        storeCanvasMediaMock.mockImplementationOnce(() => storing.promise);
        const promptSpy = vi.fn<AgentBridge["prompt"]>().mockResolvedValue({ ok: true });
        window.shotshot!.agent.prompt = promptSpy;
        window.shotshot!.agent.createSession = vi.fn(async () => summaryFor("target-session", "project-1", "canvas-1"));
        const firstContext = canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn());
        useAgentStore.setState({ canvasContext: firstContext });

        const { unmount } = renderPiAgent();
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        await act(async () => {
            useAgentStore.getState().submitPrompt("old draft", [pendingModel()]);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(storeCanvasMediaMock).toHaveBeenCalled();

        await act(async () => {
            useAgentStore.getState().setCanvasContext({
                ...firstContext,
                snapshot: { ...firstContext.snapshot, projectId: "project-2", canvasId: "canvas-2" },
            });
            await Promise.resolve();
            await Promise.resolve();
        });
        useAgentStore.getState().setAgentState({
            prompt: "new scope draft",
            pendingAttachments: [],
            activity: "new scope activity",
            connectError: "",
        });

        await act(async () => {
            storing.reject(new Error("old store failed"));
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(promptSpy).not.toHaveBeenCalled();
        expect(useAgentStore.getState()).toMatchObject({
            prompt: "new scope draft",
            pendingAttachments: [],
            activity: "new scope activity",
            connectError: "",
            messages: [],
        });
        unmount();
    });

    it.each(["resolve", "reject"] as const)("keeps the new same-canvas panel draft after stale attachment store %s", async (outcome) => {
        vi.useRealTimers();
        const storing = deferred<Awaited<ReturnType<typeof storeCanvasMedia>>>();
        storeCanvasMediaMock.mockImplementationOnce(() => storing.promise);
        const promptSpy = vi.fn<AgentBridge["prompt"]>().mockResolvedValue({ ok: true });
        const importSpy = vi.fn().mockResolvedValue(null);
        window.shotshot!.agent.prompt = promptSpy;
        useAgentStore.setState({ prompt: "", submitRequest: null, pendingAttachments: [], connectError: "",
            canvasContext: { ...canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn()), importAttachment: importSpy } });
        render(<MemoryRouter initialEntries={["/canvas/project-1/canvas-1"]}><App><PiAgentPanel /></App></MemoryRouter>);
        await act(async () => { useAgentStore.getState().submitPrompt("old home draft", [pendingModel()]); });
        await waitFor(() => expect(storeCanvasMediaMock).toHaveBeenCalledTimes(1));
        const oldSession = useAgentSessionStore.getState().activeSessionId;
        fireEvent.click(screen.getByRole("button", { name: i18n.t("agent.history.newThread") }));
        await waitFor(() => expect(useAgentSessionStore.getState().activeSessionId).not.toBe(oldSession));
        const input = screen.getByRole("textbox");
        input.textContent = "new conversation draft";
        fireEvent.input(input);
        const before = useAgentStore.getState();
        await act(async () => {
            if (outcome === "resolve") storing.resolve({ url: "blob:stored", assetRef: storedGlbeRef(), bytes: 1, mimeType: "model/gltf-binary" });
            else storing.reject(new Error("old store failed"));
        });
        expect(input).toHaveTextContent("new conversation draft");
        expect(screen.queryByTitle("bottle.glb")).toBeNull();
        expect(useAgentStore.getState()).toMatchObject({ prompt: "", pendingAttachments: [], connectError: "", messages: [], activity: before.activity });
        expect(promptSpy).not.toHaveBeenCalled();
        expect(importSpy).not.toHaveBeenCalled();
    });

    it.each(["storage", "missing model"])("restores the actual panel text and GLB for file-bearing retry after %s failure", async (failure) => {
        vi.useRealTimers();
        const configured = useConfigStore.getState().config;
        if (failure === "storage") storeCanvasMediaMock.mockRejectedValueOnce(new Error("workspace offline"));
        else useConfigStore.setState({ config: { ...configured, channels: [], textModel: "" } });
        const promptSpy = vi.fn<AgentBridge["prompt"]>().mockResolvedValue({ ok: true });
        window.shotshot!.agent.prompt = promptSpy;
        useAgentStore.setState({ prompt: "", submitRequest: null, pendingAttachments: [], connectError: "",
            canvasContext: canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn()) });
        render(<MemoryRouter initialEntries={["/canvas/project-1/canvas-1"]}><App><PiAgentPanel /></App></MemoryRouter>);
        await act(async () => { useAgentStore.getState().submitPrompt("product visual", [pendingModel()]); });
        await waitFor(() => expect(useAgentStore.getState().connectError).not.toBe(""));
        if (failure === "missing model") await act(async () => { useConfigStore.setState({ config: configured }); });
        await waitFor(() => expect(screen.getByRole("textbox")).toHaveTextContent("product visual"));
        expect(screen.getByTitle("bottle.glb")).toBeVisible();
        expect(useAgentStore.getState().pendingAttachments).toEqual([]);
        expect(promptSpy).not.toHaveBeenCalled();
        fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", code: "Enter" });
        await waitFor(() => expect(promptSpy).toHaveBeenCalledWith(useAgentSessionStore.getState().activeSessionId,
            expect.objectContaining({ text: "product visual", files: [expect.objectContaining({ relativePath: "assets/imported/bottle--a1b2c3d4.glb", kind: "glb" })], images: [] })));
        expect(storeCanvasMediaMock).toHaveBeenLastCalledWith(anyBlob, expect.objectContaining({ name: "bottle.glb", mimeType: pendingModel().mimeType }));
    });

    it("restores the submitted draft when pending attachment storage fails", async () => {
        const model = pendingModel();
        const promptSpy = vi.fn<AgentBridge["prompt"]>().mockResolvedValue({ ok: true });
        storeCanvasMediaMock.mockRejectedValue(new Error("workspace offline"));
        window.shotshot!.agent.prompt = promptSpy;
        window.shotshot!.agent.createSession = vi.fn(async () => summaryFor("target-session", "project-1", "canvas-1"));
        useAgentStore.setState({ canvasContext: canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn()) });
        useAgentStore.getState().submitPrompt("product visual", [model]);

        const { unmount } = renderPiAgent();
        await act(async () => {
            for (let index = 0; index < 12; index += 1) await Promise.resolve();
        });

        expect(promptSpy).not.toHaveBeenCalled();
        expect(useAgentStore.getState()).toMatchObject({
            prompt: "product visual",
            pendingAttachments: [model],
            connectError: "workspace offline",
        });
        unmount();
    });

    it("keeps thinking, text, tools, and the final answer in event order", async () => {
        const firstMessage = {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "分析画布结构" },
                { type: "text", text: "我先读取画布。" },
                { type: "toolCall", id: "tool-1", name: "canvas_get_state", arguments: {} },
            ],
            api: "openai-responses",
            provider: "openai",
            model: "test-model",
            usage: { input: 10, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "toolUse",
            timestamp: 1_100,
        };
        const finalMessage = {
            ...firstMessage,
            content: [{ type: "text", text: "画布读取完成。" }],
            stopReason: "stop",
            timestamp: 2_000,
        };
        runPrompt = () => {
            emit?.({ type: "agent_start" });
            emit?.({ type: "message_start", message: firstMessage } as PiAgentEvent);
            emit?.({ type: "message_update", message: firstMessage, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "。", partial: firstMessage } } as PiAgentEvent);
            emit?.({ type: "message_end", message: firstMessage } as PiAgentEvent);
            emit?.({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "canvas_get_state", args: {} });
            emit?.({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "canvas_get_state", result: { content: [] }, isError: false });
            emit?.({ type: "message_start", message: finalMessage } as PiAgentEvent);
            emit?.({ type: "message_update", message: finalMessage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "。", partial: finalMessage } } as PiAgentEvent);
            emit?.({ type: "message_end", message: finalMessage } as PiAgentEvent);
            emit?.({ type: "agent_end", messages: [firstMessage, finalMessage] } as PiAgentEvent);
        };
        const { result, unmount } = renderPiAgent();

        await act(async () => { await result.current.sendPrompt("读取画布"); });

        expect(useAgentStore.getState().messages.map((item) => [item.role, item.detail && typeof item.detail === "object" ? (item.detail as { kind?: string }).kind : "", item.text])).toEqual([
            ["user", "", "读取画布"],
            ["tool", "reasoning", "分析画布结构"],
            ["assistant", "", "我先读取画布。"],
            ["tool", "tool", "已读取当前画布内容"],
            ["assistant", "", "画布读取完成。"],
        ]);
        unmount();
    });

    it("does not re-arm or duplicate the TTFB mark when a later send is rejected by a gate", async () => {
        const ttfbTitle = i18n.t("agent.ttfb");
        const ttfbCount = () => useAgentStore.getState().eventLogs.filter((item) => item.title === ttfbTitle).length;
        const textDelta = (text: string) =>
            emit?.({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } } as PiAgentEvent);
        const { result, unmount } = renderHook(() => usePiAgent());

        // 首轮成功：发送被接受时起表，首个 text delta 结算一条 TTFB。
        runPrompt = () => {
            const startMessage = {
                role: "assistant",
                content: [],
                api: "openai-responses",
                provider: "openai",
                model: "test-model",
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                stopReason: "stop",
                timestamp: 1_000,
            };
            emit?.({ type: "agent_start" });
            emit?.({ type: "message_start", message: startMessage } as PiAgentEvent);
            textDelta("首个 token");
            emit?.({ type: "agent_end", messages: [] });
        };
        await act(async () => { await result.current.sendPrompt("第一问"); });
        expect(ttfbCount()).toBe(1);

        // 被门禁拒绝的发送（空输入、模型配置未就绪）不得覆盖已结算的打点，也不得让后续 delta 重复记账。
        await act(async () => { expect(await result.current.sendPrompt("   ")).toBe(false); });
        useAiSourceStore.setState({ status: "error", error: "sources offline" });
        await act(async () => { expect(await result.current.sendPrompt("第二问")).toBe(false); });
        useAiSourceStore.setState({ status: "ready", preferences: { version: 1, selections: {} }, error: null, applying: false });
        expect(ttfbCount()).toBe(1);

        // 后续来自同一 session 的 text delta 不被重新测量成第二条 TTFB。
        await act(async () => { textDelta("又一个 token"); });
        expect(ttfbCount()).toBe(1);
        unmount();
    });

    it("passes the project workspace to createSession when the project has one", async () => {
        const createSessionSpy = vi.fn(async (input: { scope: { projectId: string; canvasId: string }; title?: string; workspacePath?: string }): Promise<PiSessionSummary> => {
            sessionSeq += 1;
            return { sessionId: `created-${sessionSeq}`, title: input.title || "", scope: input.scope, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false };
        });
        const ensureProjectWorkspaceMock = vi.fn<AgentBridge["ensureProjectWorkspace"]>().mockResolvedValue({ ok: true, path: "/Users/me/ws/unused" });
        window.shotshot!.agent.createSession = createSessionSpy;
        window.shotshot!.agent.ensureProjectWorkspace = ensureProjectWorkspaceMock;
        // 项目已带 workspacePath：直接使用，不 ensure、不重建自定义路径。
        useProjectStore.setState({ projects: [{ id: "project-1", title: "P", category: "", icon: "", color: "", createdAt: "", updatedAt: "", canvases: [], workspacePath: "/Users/me/ws/project-1-12345678" }] });
        useAgentStore.setState({ canvasContext: canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn()) });

        const { result, unmount } = renderPiAgent();
        await act(async () => { await result.current.sendPrompt("读取画布"); });
        await act(async () => { await result.current.newSession(); });

        // sendPrompt 懒创建与 newSession 两条链路都直用项目工作区，且不触发 ensure。
        expect(createSessionSpy).toHaveBeenCalledTimes(2);
        expect(createSessionSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({ workspacePath: "/Users/me/ws/project-1-12345678" }));
        expect(createSessionSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ workspacePath: "/Users/me/ws/project-1-12345678" }));
        expect(ensureProjectWorkspaceMock).not.toHaveBeenCalled();
        unmount();
    });

    it("lazily ensures a project workspace before createSession and persists it", async () => {
        const createSessionSpy = vi.fn(async (input: { scope: { projectId: string; canvasId: string }; title?: string; workspacePath?: string }): Promise<PiSessionSummary> => {
            sessionSeq += 1;
            return { sessionId: `created-${sessionSeq}`, title: input.title || "", scope: input.scope, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false };
        });
        const ensureProjectWorkspaceMock = vi.fn<AgentBridge["ensureProjectWorkspace"]>().mockResolvedValue({ ok: true, path: "/Users/me/ws/ensured" });
        window.shotshot!.agent.createSession = createSessionSpy;
        window.shotshot!.agent.ensureProjectWorkspace = ensureProjectWorkspaceMock;
        // 项目尚未有工作区：创建会话前幂等 ensure，并把结果写回项目。
        useProjectStore.setState({ projects: [{ id: "project-1", title: "P", category: "", icon: "", color: "", createdAt: "", updatedAt: "", canvases: [] }] });
        useAgentStore.setState({ canvasContext: canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn()) });

        const { result, unmount } = renderPiAgent();
        await act(async () => { await result.current.sendPrompt("读取画布"); });

        expect(ensureProjectWorkspaceMock).toHaveBeenCalledWith("project-1", "P");
        expect(createSessionSpy).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: "/Users/me/ws/ensured" }));
        expect(useProjectStore.getState().projects.find((p) => p.id === "project-1")?.workspacePath).toBe("/Users/me/ws/ensured");
        unmount();
    });

    it("omits workspacePath when ensure fails", async () => {
        const createSessionSpy = vi.fn(async (input: { scope: { projectId: string; canvasId: string }; title?: string; workspacePath?: string }): Promise<PiSessionSummary> => {
            sessionSeq += 1;
            return { sessionId: `created-${sessionSeq}`, title: input.title || "", scope: input.scope, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false };
        });
        const ensureProjectWorkspaceMock = vi.fn<AgentBridge["ensureProjectWorkspace"]>().mockResolvedValue({ ok: false, error: "disk error" });
        window.shotshot!.agent.createSession = createSessionSpy;
        window.shotshot!.agent.ensureProjectWorkspace = ensureProjectWorkspaceMock;
        useProjectStore.setState({ projects: [{ id: "project-1", title: "P", category: "", icon: "", color: "", createdAt: "", updatedAt: "", canvases: [] }] });
        useAgentStore.setState({ canvasContext: canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn()) });

        const { result, unmount } = renderPiAgent();
        await act(async () => { await result.current.sendPrompt("读取画布"); });

        // ensure 失败时会话照常创建，但入参不得出现 workspacePath 键（条件展开，而非传 undefined）。
        const arg = createSessionSpy.mock.calls.at(-1)?.[0];
        expect(arg).not.toHaveProperty("workspacePath");
        unmount();
    });
});

describe("usePiAgent session envelope projection", () => {
    let emitSession: ((event: PiSessionEnvelope) => void) | undefined;
    const abortMock = vi.fn(async () => undefined);
    const openSessionMock = vi.fn<AgentBridge["openSession"]>(async () => ({ summary: { sessionId: "sdk-open", title: "open", scope: { projectId: "project-2", canvasId: "canvas-2" }, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }, entries: [] }));
    const listSessionsMock = vi.fn<AgentBridge["listSessions"]>(async () => ({ sessions: [], unreadable: [] }));
    const importLegacyMock = vi.fn<AgentBridge["importLegacySessions"]>(async () => ({ ok: true, imported: 0, sessions: [] }));

    beforeEach(() => {
        useAiSourceStore.setState({ status: "ready", preferences: { version: 1, selections: {} }, error: null, applying: false });
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        abortMock.mockClear();
        openSessionMock.mockClear();
        listSessionsMock.mockClear();
        importLegacyMock.mockClear();
        routeOpsMock.mockClear();
        routeAttachmentImportMock.mockClear();
        openSessionMock.mockResolvedValue({ summary: { sessionId: "sdk-open", title: "open", scope: { projectId: "project-2", canvasId: "canvas-2" }, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }, entries: [] });
        listSessionsMock.mockResolvedValue({ sessions: [], unreadable: [] });
        useAgentStore.setState({ messages: [], sending: false, waiting: false, eventLogs: [], tokenUsage: null, canvasContext: null });
        usePiHistoryStore.setState({ activeSessionId: null, sessions: [] });
        useAgentSessionStore.setState({ sessions: [], activeSessionId: null, unreadableSessions: [], pendingUserInputs: {} });
        useConfigStore.setState({
            config: {
                ...defaultConfig,
                channels: defaultConfig.channels.map((channel) => ({ ...channel, apiKey: "test-key" })),
            },
        });

        const agent: AgentBridge = {
            listSessions: listSessionsMock,
            createSession: async () => ({ sessionId: `sdk-session-${++sessionSeq}`, title: `session-${sessionSeq}`, scope: { projectId: "project-1", canvasId: "canvas-1" }, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }),
            ensureProjectWorkspace: async () => ({ ok: false, error: "unsupported" }),
            abort: abortMock,
            openSession: openSessionMock,
            importLegacySessions: importLegacyMock,
            closeSession: async () => undefined,
            readSessionEntries: async () => [],
            compact: async () => ({ ok: true }),
            setCanvasSnapshot: () => {},
            prompt: async () => ({ ok: true }),
            respondToUserInput: async () => ({ ok: true }),
            setApprovalMode: async () => undefined,
            respondToApproval: async () => ({ ok: true }),
            setModelConfig: async () => {},
            onEvent: () => { throw new Error("legacy onEvent must not be used when onSessionEvent exists"); },
            onSessionEvent: (callback) => { emitSession = callback; return () => { emitSession = undefined; }; },
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
            configure: async () => ({ fresh: true, snapshot }), scan: async () => ({ fresh: true, snapshot }), read: async () => null,
            readFile: async () => ({ ok: false, error: "missing" }), write: async () => ({ ok: true }), importSkill: async () => null,
            remove: async () => ({ ok: true }), seed: async () => ({ ok: true }), pickFolder: async () => null,
        };
        window.shotshot = { agent, skills, platform: "darwin" };
    });

    afterEach(() => {
        vi.useRealTimers();
        delete window.shotshot;
    });

    // 严格守卫（spec D2）下，agent 类 envelope 只有活动会话会被投影：
    // 先种入画布上下文（scope effect 依赖它），再让恢复流程把 sdk-session 设为活动会话。
    async function restoreActiveSession(sessionId = "sdk-session") {
        useAgentStore.setState({ canvasContext: canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn()) });
        listSessionsMock.mockResolvedValue({ sessions: [summaryFor(sessionId, "project-1", "canvas-1")], unreadable: [] });
        openSessionMock.mockResolvedValue({ summary: summaryFor(sessionId, "project-1", "canvas-1"), entries: [] });
    }

    it("does not leak background envelopes into a session-less view (null guard hole)", async () => {
        useAgentSessionStore.getState().setSessions([summaryFor("session-bg", "project-1", "canvas-1")]);
        const { unmount } = renderPiAgent();
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });

        await act(async () => {
            emitSession?.({ sessionId: "session-bg", kind: "agent", payload: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "泄漏内容" }] } } } as never);
            emitSession?.({ sessionId: "session-bg", kind: "error", payload: { type: "error", message: "后台失败" } } as never);
        });

        expect(useAgentStore.getState().messages).toHaveLength(0);
        expect(useAgentStore.getState().connectError).toBe("");
        expect(useAgentSessionStore.getState().sessions.find((item) => item.sessionId === "session-bg")?.status).toBe("error");
        unmount();
    });

    it("routes background ops through the op router instead of the active canvas", async () => {
        const applyOps = vi.fn(async () => ({ receipts: [] }) as never);
        useAgentStore.setState({ canvasContext: { snapshot: canvasSnapshot(0, { x: 0, y: 0 }), applyOps, undoOps: () => null, canUndo: false } });
        const { unmount } = renderPiAgent();
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });

        await act(async () => {
            emitSession?.({ sessionId: "session-bg", kind: "ops", payload: { type: "ops", ops: [{ type: "add_node", nodeType: "text" }], requestId: "r1" } } as never);
        });

        expect(routeOpsMock).toHaveBeenCalledWith("session-bg", [{ type: "add_node", nodeType: "text" }], "r1");
        expect(applyOps).not.toHaveBeenCalled();
        unmount();
    });

    it("projects session envelopes into one compaction card and archives live messages without duplicates", async () => {
        await restoreActiveSession();
        const { unmount } = renderPiAgent();
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(useAgentSessionStore.getState().activeSessionId).toBe("sdk-session");

        const emit = emitSession!;
        await act(async () => {
            emit({ sessionId: "sdk-session", kind: "agent", payload: { type: "compaction_start", reason: "manual" } });
            emit({ sessionId: "sdk-session", kind: "agent", payload: { type: "message_start", message: { role: "user", content: "整理画布" } } });
            emit({ sessionId: "sdk-session", kind: "agent", payload: { type: "message_start", message: { role: "assistant", content: [] } } });
            emit({ sessionId: "sdk-session", kind: "agent", payload: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "好的" }] } } });
            emit({ sessionId: "sdk-session", kind: "agent", payload: { type: "entry_appended", entry: { type: "message", id: "user-entry", parentId: null, timestamp: 1_000, message: { role: "user", content: "整理画布" } } } });
            emit({ sessionId: "sdk-session", kind: "agent", payload: { type: "entry_appended", entry: { type: "message", id: "assistant-entry", parentId: "user-entry", timestamp: 1_100, message: { role: "assistant", content: [{ type: "text", text: "好的" }] } } } });
            emit({
                sessionId: "sdk-session",
                kind: "agent",
                payload: { type: "compaction_end", reason: "manual", result: { summary: "已整理画布请求", tokensBefore: 1_000, estimatedTokensAfter: 200 }, aborted: false, willRetry: false },
            });
            emit({ sessionId: "other-session", kind: "error", payload: { message: "must not cross sessions" } });
        });

        const messages = useAgentStore.getState().messages;
        expect(messages.map((item) => [item.role, item.itemId, item.text])).toEqual([
            ["compaction", "manual", "已整理画布请求"],
            ["user", "user-entry", "整理画布"],
            ["assistant", "assistant-entry", "好的"],
        ]);
        expect(messages[0]?.detail).toMatchObject({ kind: "compaction", status: "completed", reason: "manual", tokensBefore: 1_000, tokensAfter: 200 });
        expect(useAgentStore.getState().connectError).toBe("");
        unmount();
    });

    it("stores and resolves user input requests per session", async () => {
        const { unmount } = renderPiAgent();
        useAgentSessionStore.getState().setSessions([summaryFor("sdk-session", "project-1", "canvas-1")]);

        await act(async () => {
            emitSession?.({
                sessionId: "sdk-session",
                kind: "user_input",
                payload: { type: "request", request: { requestId: "request-1", method: "select", title: "Choose", options: ["A", "B"] } },
            });
        });
        expect(useAgentSessionStore.getState().pendingUserInputs["sdk-session"]).toEqual({ requestId: "request-1", method: "select", title: "Choose", options: ["A", "B"] });
        expect(useAgentSessionStore.getState().sessions[0]).toMatchObject({ status: "waiting_input", hasUnfinishedOperation: true });

        await act(async () => {
            emitSession?.({ sessionId: "sdk-session", kind: "user_input", payload: { type: "resolved", requestId: "request-1" } });
        });
        expect(useAgentSessionStore.getState().pendingUserInputs["sdk-session"]).toBeUndefined();
        expect(useAgentSessionStore.getState().sessions[0]).toMatchObject({ status: "running", hasUnfinishedOperation: true });
        unmount();
    });

    it("logs turn starts and terminalizes a failed compaction card", async () => {
        await restoreActiveSession();
        const { unmount } = renderPiAgent();
        const emit = emitSession!;
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });

        await act(async () => {
            emit({ sessionId: "sdk-session", kind: "agent", payload: { type: "turn_start" } });
            emit({ sessionId: "sdk-session", kind: "agent", payload: { type: "compaction_start", reason: "manual" } });
            emit({ sessionId: "sdk-session", kind: "session_compact_failed", payload: { message: "summary failed" } });
        });

        expect(useAgentStore.getState().eventLogs.at(-2)).toMatchObject({ title: "开始处理", text: "开始处理" });
        const card = useAgentStore.getState().messages.find((item) => item.role === "compaction");
        expect(card?.detail).toMatchObject({ kind: "compaction", status: "failed", error: "summary failed" });
        expect(useAgentStore.getState().messages.some((item) => item.role === "error" && item.text === "summary failed")).toBe(true);
        unmount();
    });

    it("uses the shared runtime status mapping for terminal and queued envelopes", async () => {
        useAgentSessionStore.getState().setSessions([
            { sessionId: "sdk-session", title: "session", scope: { projectId: "p", canvasId: "c" }, createdAt: 0, updatedAt: 0, status: "running", hasUnfinishedOperation: true },
        ]);
        const { unmount } = renderPiAgent();
        const emit = emitSession!;

        await act(async () => {
            emit({ sessionId: "sdk-session", kind: "agent", payload: { type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: false } });
        });
        expect(useAgentSessionStore.getState().sessions[0]).toMatchObject({ status: "idle", hasUnfinishedOperation: false });

        await act(async () => {
            emit({ sessionId: "sdk-session", kind: "agent", payload: { type: "queue_update", followUp: [], steering: [] } });
        });
        expect(useAgentSessionStore.getState().sessions[0]).toMatchObject({ status: "idle", hasUnfinishedOperation: false });

        useAgentStore.setState({ waiting: true, sending: true });
        await act(async () => {
            emit({ sessionId: "sdk-session", kind: "agent", payload: { type: "agent_end", messages: [], willRetry: true } });
        });
        expect(useAgentSessionStore.getState().sessions[0]).toMatchObject({ status: "running", hasUnfinishedOperation: true });
        expect(useAgentStore.getState()).toMatchObject({ waiting: true, sending: true });

        await act(async () => {
            emit({ sessionId: "sdk-session", kind: "agent", payload: { type: "queue_update", followUp: ["next"], steering: [] } });
        });
        expect(useAgentSessionStore.getState().sessions[0]).toMatchObject({ status: "queued", hasUnfinishedOperation: true });
        unmount();
    });

    it("marks busy state when attaching a running session", async () => {
        await restoreActiveSession("sdk-running");
        listSessionsMock.mockResolvedValue({ sessions: [{ ...summaryFor("sdk-running", "project-1", "canvas-1"), status: "running", hasUnfinishedOperation: true }], unreadable: [] });
        openSessionMock.mockResolvedValue({ summary: { ...summaryFor("sdk-running", "project-1", "canvas-1"), status: "running", hasUnfinishedOperation: true }, entries: [] });
        const { unmount } = renderPiAgent();
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });

        expect(useAgentSessionStore.getState().activeSessionId).toBe("sdk-running");
        expect(useAgentStore.getState().waiting).toBe(true);
        expect(useAgentStore.getState().sending).toBe(false);
        unmount();
    });

    it("does not switch scope on canvas routes while canvasContext is transiently null", async () => {
        const { unmount } = renderPiAgent("/canvas/project-1/canvas-1");
        await act(async () => {});
        expect(listSessionsMock).not.toHaveBeenCalled();
        unmount();
    });
});

describe("usePiAgent detach-only lifecycle", () => {
    const abortMock = vi.fn(async () => undefined);
    const openSessionMock = vi.fn<AgentBridge["openSession"]>(async () => ({
        summary: { sessionId: "sdk-a", title: "A", scope: { projectId: "project-2", canvasId: "canvas-2" }, createdAt: 1, updatedAt: 2, status: "running", hasUnfinishedOperation: true },
        entries: [],
    }));
    const listSessionsMock = vi.fn<AgentBridge["listSessions"]>(async () => ({
        sessions: [
            { sessionId: "sdk-other", title: "Other scope", scope: { projectId: "other-project", canvasId: "other-canvas" }, createdAt: 0, updatedAt: 0, status: "running", hasUnfinishedOperation: true },
            { sessionId: "sdk-a", title: "A", scope: { projectId: "project-2", canvasId: "canvas-2" }, createdAt: 1, updatedAt: 2, status: "running", hasUnfinishedOperation: true },
        ],
        unreadable: [{ file: "broken.jsonl", error: "invalid JSON" }],
    }));
    const importLegacyMock = vi.fn<AgentBridge["importLegacySessions"]>(async () => ({ ok: true, imported: 1, sessions: [] }));
    let emitSession: ((event: PiSessionEnvelope) => void) | undefined;

    beforeEach(() => {
        useAiSourceStore.setState({ status: "ready", preferences: { version: 1, selections: {} }, error: null, applying: false });
        abortMock.mockClear();
        openSessionMock.mockClear();
        listSessionsMock.mockClear();
        importLegacyMock.mockClear();
        openSessionMock.mockReset().mockImplementation(async () => ({ summary: { sessionId: "sdk-a", title: "A", scope: { projectId: "project-2", canvasId: "canvas-2" }, createdAt: 1, updatedAt: 2, status: "running", hasUnfinishedOperation: true }, entries: [] }));
        listSessionsMock.mockReset().mockImplementation(async () => ({
            sessions: [
                { sessionId: "sdk-other", title: "Other scope", scope: { projectId: "other-project", canvasId: "other-canvas" }, createdAt: 0, updatedAt: 0, status: "running", hasUnfinishedOperation: true },
                { sessionId: "sdk-a", title: "A", scope: { projectId: "project-2", canvasId: "canvas-2" }, createdAt: 1, updatedAt: 2, status: "running", hasUnfinishedOperation: true },
            ],
            unreadable: [{ file: "broken.jsonl", error: "invalid JSON" }],
        }));
        importLegacyMock.mockReset().mockImplementation(async () => ({ ok: true, imported: 1, sessions: [] }));
        useAgentStore.setState({ messages: [], sending: false, waiting: false, eventLogs: [], tokenUsage: null, canvasContext: canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn(async () => ({ ...canvasSnapshot(0, { x: 0, y: 0 }), receipts: [] }))) });
        usePiHistoryStore.setState({ activeSessionId: null, sessions: [] });
        useAgentSessionStore.setState({ sessions: [], activeSessionId: null, unreadableSessions: [], pendingUserInputs: {} });
        useConfigStore.setState({ config: { ...defaultConfig, channels: defaultConfig.channels.map((channel) => ({ ...channel, apiKey: "test-key" })) } });

        const agent: AgentBridge = {
            listSessions: listSessionsMock,
            createSession: async () => ({ sessionId: "sdk-new", title: "new", scope: { projectId: "project-1", canvasId: "canvas-1" }, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }),
            ensureProjectWorkspace: async () => ({ ok: false, error: "unsupported" }),
            openSession: openSessionMock,
            closeSession: async () => undefined,
            readSessionEntries: async () => [],
            abort: abortMock,
            compact: async () => ({ ok: true }),
            setCanvasSnapshot: () => {},
            importLegacySessions: importLegacyMock,
            prompt: async () => ({ ok: true }),
            respondToUserInput: async () => ({ ok: true }),
            setApprovalMode: async () => undefined,
            respondToApproval: async () => ({ ok: true }),
            setModelConfig: async () => {},
            onEvent: () => () => undefined,
            onSessionEvent: (callback) => { emitSession = callback; return () => { emitSession = undefined; }; },
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
            configure: async () => ({ fresh: true, snapshot }), scan: async () => ({ fresh: true, snapshot }), read: async () => null,
            readFile: async () => ({ ok: false, error: "missing" }), write: async () => ({ ok: true }), importSkill: async () => null,
            remove: async () => ({ ok: true }), seed: async () => ({ ok: true }), pickFolder: async () => null,
        };
        window.shotshot = { agent, skills, platform: "darwin" };
    });

    afterEach(() => {
        delete window.shotshot;
    });

    it("switching canvas scope opens the latest session without aborting or resetting background work", async () => {
        const { result, unmount } = renderPiAgent();

        // 切到新的画布 scope：listSessions → openSession，绝不调用 abort。
        const first = useAgentStore.getState().canvasContext!;
        const secondSnapshot = { ...first.snapshot, projectId: "project-2", canvasId: "canvas-2" };
        await act(async () => {
            useAgentStore.getState().setCanvasContext({ ...first, snapshot: secondSnapshot });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(listSessionsMock).toHaveBeenCalledWith();
        expect(openSessionMock).toHaveBeenCalledWith("sdk-a");
        expect(abortMock).not.toHaveBeenCalled();
        expect(useAgentSessionStore.getState().sessions[0]).toMatchObject({ sessionId: "sdk-a", status: "running", hasUnfinishedOperation: true });
        expect(useAgentSessionStore.getState().sessions.map((item) => item.sessionId)).toEqual(["sdk-a", "sdk-other"]);
        expect(useAgentSessionStore.getState().unreadableSessions).toEqual([{ file: "broken.jsonl", error: "invalid JSON" }]);
        expect(useAgentSessionStore.getState().activeSessionId).toBe("sdk-a");

        // 停止按钮只 abort 当前 session。
        await act(async () => { result.current.stop(); });
        expect(abortMock).toHaveBeenCalledWith("sdk-a");
        unmount();
    });

    it("completes session restore even when the canvasContext reference changes mid-flight", async () => {
        // 回归：画布内节点/选中/视口变化会让 canvasContext 换新对象（同 scope）。
        // 旧实现 cleanup 无条件 bump generation，把进行中的 restore 结果整单丢弃，
        // 表现为“进入有历史会话的画布不加载最近会话”。
        const listDeferred = deferred<{ sessions: PiSessionSummary[]; unreadable: [] }>();
        listSessionsMock.mockImplementation(() => listDeferred.promise);
        openSessionMock.mockResolvedValue({
            summary: summaryFor("sdk-a", "project-1", "canvas-1"),
            entries: [],
        });

        const { unmount } = renderPiAgent();
        await act(async () => { await Promise.resolve(); });

        // 同画布、同 scope，仅 snapshot 引用变化（如节点数据加载完成）。
        const first = useAgentStore.getState().canvasContext!;
        await act(async () => {
            useAgentStore.getState().setCanvasContext({
                ...first,
                snapshot: { ...first.snapshot, nodes: first.snapshot.nodes.map((node) => ({ ...node })) },
            });
        });

        await act(async () => {
            listDeferred.resolve({ sessions: [summaryFor("sdk-a", "project-1", "canvas-1")], unreadable: [] });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(openSessionMock).toHaveBeenCalledWith("sdk-a");
        expect(useAgentSessionStore.getState().activeSessionId).toBe("sdk-a");
        expect(useAgentStore.getState().messages).toEqual([]);
        unmount();
    });

    it("keeps the panel empty when entering a canvas that has no sessions", async () => {
        // 白板（该画布从无会话）不加载任何会话、也不自动新建；首次发问才创建。
        listSessionsMock.mockResolvedValue({
            sessions: [summaryFor("sdk-other-canvas", "project-9", "canvas-9")],
            unreadable: [],
        });
        const createSessionSpy = vi.fn(async (input: { scope: { projectId: string; canvasId: string } }): Promise<PiSessionSummary> => {
            sessionSeq += 1;
            return { sessionId: `created-${sessionSeq}`, title: "", scope: input.scope, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false };
        });
        window.shotshot!.agent.createSession = createSessionSpy;

        const { unmount } = renderPiAgent();
        const first = useAgentStore.getState().canvasContext!;
        await act(async () => {
            useAgentStore.getState().setCanvasContext({ ...first, snapshot: { ...first.snapshot, projectId: "blank-project", canvasId: "blank-canvas" } });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(openSessionMock).not.toHaveBeenCalled();
        expect(createSessionSpy).not.toHaveBeenCalled();
        expect(useAgentSessionStore.getState().activeSessionId).toBeNull();
        expect(useAgentStore.getState().messages).toEqual([]);
        unmount();
    });

    it("continues the restored session when prompting after switching canvases back and forth", async () => {
        // 回归：A → B → A 后继续发问，应继续 A 上恢复出来的 session，
        // 不能因为 sessionIdRef/scope 校验失败而新建一个 session。
        const promptSpy = vi.fn(async () => ({ ok: true as const }));
        const createSessionSpy = vi.fn(async (input: { scope: { projectId: string; canvasId: string }; title?: string }): Promise<PiSessionSummary> => {
            sessionSeq += 1;
            return { sessionId: `created-${sessionSeq}`, title: input.title || "", scope: input.scope, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false };
        });
        // 画布 b 从未有过会话：listSessions 只返回画布 a 的会话。
        listSessionsMock.mockResolvedValue({
            sessions: [summaryFor("sdk-canvas-a", "project-1", "canvas-1")],
            unreadable: [],
        });
        openSessionMock.mockResolvedValue({
            summary: summaryFor("sdk-canvas-a", "project-1", "canvas-1"),
            entries: [],
        });
        const agent = window.shotshot!.agent;
        agent.prompt = promptSpy;
        agent.createSession = createSessionSpy;

        const { result, unmount } = renderPiAgent();
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(openSessionMock).toHaveBeenCalledWith("sdk-canvas-a");

        const first = useAgentStore.getState().canvasContext!;
        await act(async () => {
            useAgentStore.getState().setCanvasContext({ ...first, snapshot: { ...first.snapshot, canvasId: "canvas-1b" } });
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(useAgentSessionStore.getState().activeSessionId).toBeNull();
        await act(async () => {
            useAgentStore.getState().setCanvasContext({ ...first, snapshot: { ...first.snapshot, canvasId: "canvas-1" } });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(openSessionMock).toHaveBeenLastCalledWith("sdk-canvas-a");
        expect(useAgentSessionStore.getState().activeSessionId).toBe("sdk-canvas-a");
        // 画布 b 无会话：不加载任何会话（保持空），也不新建。
        expect(createSessionSpy).not.toHaveBeenCalled();

        let accepted = false;
        await act(async () => {
            accepted = await result.current.sendPrompt("继续");
        });

        expect(accepted).toBe(true);
        expect(promptSpy).toHaveBeenCalledWith("sdk-canvas-a", expect.objectContaining({ text: "继续" }));
        expect(createSessionSpy).not.toHaveBeenCalled();
        unmount();
    });

    it("restores the previous canvas session when switching canvases within the same project", async () => {
        // 回归：旧实现用 `projectId || canvasId` 当切换键，同项目下两个画布键相同，
        // 切换画布 early return，面板继续显示上一个画布的会话。
        listSessionsMock.mockResolvedValue({
            sessions: [
                summaryFor("sdk-canvas-b", "project-1", "canvas-1b"),
                summaryFor("sdk-canvas-a", "project-1", "canvas-1"),
            ],
            unreadable: [],
        });
        openSessionMock.mockResolvedValue({
            summary: summaryFor("sdk-canvas-b", "project-1", "canvas-1b"),
            entries: [],
        });
        const { unmount } = renderPiAgent();
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(openSessionMock).toHaveBeenCalledWith("sdk-canvas-a");

        openSessionMock.mockClear();
        openSessionMock.mockResolvedValue({
            summary: summaryFor("sdk-canvas-b", "project-1", "canvas-1b"),
            entries: [],
        });

        const first = useAgentStore.getState().canvasContext!;
        const sameProjectOtherCanvas = { ...first.snapshot, canvasId: "canvas-1b" };
        await act(async () => {
            useAgentStore.getState().setCanvasContext({ ...first, snapshot: sameProjectOtherCanvas });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(openSessionMock).toHaveBeenCalledWith("sdk-canvas-b");
        expect(useAgentSessionStore.getState().activeSessionId).toBe("sdk-canvas-b");
        unmount();
    });

    it("refuses to continue a session that belongs to another canvas scope", async () => {
        // 会话严格归属白板：跨画布“继续”是 no-op，不打开也不绑活动会话；
        // 切到会话所属画布后，同 scope 的“继续”才生效。
        const { result, unmount } = renderPiAgent();
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(useAgentSessionStore.getState().activeSessionId).toBeNull();

        await act(async () => {
            await result.current.continueSession(summaryFor("sdk-a", "project-2", "canvas-2"));
        });
        expect(openSessionMock).not.toHaveBeenCalled();
        expect(useAgentSessionStore.getState().activeSessionId).toBeNull();

        const first = useAgentStore.getState().canvasContext!;
        await act(async () => {
            useAgentStore.getState().setCanvasContext({ ...first, snapshot: { ...first.snapshot, projectId: "project-2", canvasId: "canvas-2" } });
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(openSessionMock).toHaveBeenCalledWith("sdk-a");

        openSessionMock.mockClear();
        openSessionMock.mockResolvedValue({ summary: summaryFor("sdk-a", "project-2", "canvas-2"), entries: [] });
        await act(async () => {
            await result.current.continueSession(summaryFor("sdk-a", "project-2", "canvas-2"));
        });
        expect(openSessionMock).toHaveBeenCalledWith("sdk-a");
        expect(useAgentSessionStore.getState().activeSessionId).toBe("sdk-a");
        unmount();
    });

    it("drops legacy localStorage sessions on the next mount and signals a no-op to the host", async () => {
        const legacy: PiSession = { id: "legacy-1", scope: "project-1", title: "旧对话", createdAt: 1, updatedAt: 2, messages: [{ id: "m1", role: "user", text: "hi" }] };
        usePiHistoryStore.setState({ sessions: [legacy], activeSessionId: legacy.id });

        renderPiAgent();
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });

        expect(importLegacyMock).toHaveBeenCalledTimes(1);
        expect(importLegacyMock).toHaveBeenCalledWith([]);
        expect(usePiHistoryStore.getState().sessions).toEqual([]);
        expect(usePiHistoryStore.getState().activeSessionId).toBeNull();
        expect(useAgentStore.getState().eventLogs.at(-1)?.text).toBeUndefined();
        expect(useAgentStore.getState().connectError).toBe("");
    });

    it("surfaces a host error if the no-op import itself fails, but still drops legacy data", async () => {
        const legacy: PiSession = { id: "legacy-1", scope: "project-1", title: "旧对话", createdAt: 1, updatedAt: 2, messages: [{ id: "m1", role: "user", text: "hi" }] };
        usePiHistoryStore.setState({ sessions: [legacy], activeSessionId: legacy.id });
        const migration = deferred<{ ok: false; error: string }>();
        importLegacyMock.mockReturnValueOnce(migration.promise);

        renderPiAgent();
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        await act(async () => { migration.resolve({ ok: false, error: "disk locked" }); await Promise.resolve(); await Promise.resolve(); });

        // legacy 数据在本端已经被清掉，避免旧会话仍触发重试。
        expect(usePiHistoryStore.getState().sessions).toEqual([]);
        expect(usePiHistoryStore.getState().activeSessionId).toBeNull();
        expect(importLegacyMock).toHaveBeenCalledTimes(1);
        expect(importLegacyMock).toHaveBeenCalledWith([]);
        // marker 写入失败时仍允许记录诊断，但前提已经是没有遗留数据。
        const state = useAgentStore.getState();
        expect(state.eventLogs.at(-1)?.text).toContain("disk locked");
        expect(state.connectError).toContain("disk locked");
    });

    it("does not retry the no-op import on a fresh mount after legacy data was cleared", async () => {
        // 模拟首挂载已成功清空 + 写 marker，重启后空 legacy 不再触发迁移。
        usePiHistoryStore.setState({ sessions: [], activeSessionId: null });

        renderPiAgent();
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });

        expect(importLegacyMock).not.toHaveBeenCalled();
    });

    it("does not let a late older scope open overwrite the newest active session", async () => {
        const listTwo = deferred<{ sessions: PiSessionSummary[]; unreadable: [] }>();
        const listThree = deferred<{ sessions: PiSessionSummary[]; unreadable: [] }>();
        const openTwo = deferred<{ summary: PiSessionSummary; entries: PiSessionEntrySnapshot[] }>();
        const openThree = deferred<{ summary: PiSessionSummary; entries: PiSessionEntrySnapshot[] }>();
        let listCall = 0;
        listSessionsMock.mockImplementation(() => {
            listCall += 1;
            if (listCall === 2) return listTwo.promise;
            if (listCall === 3) return listThree.promise;
            return Promise.resolve({ sessions: [], unreadable: [] });
        });
        openSessionMock.mockImplementation((sessionId: string) => (sessionId === "sdk-2" ? openTwo.promise : openThree.promise));

        const { unmount } = renderPiAgent();
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });

        const initial = useAgentStore.getState().canvasContext!;
        await act(async () => {
            useAgentStore.getState().setCanvasContext({ ...initial, snapshot: { ...initial.snapshot, projectId: "project-2", canvasId: "canvas-2" } });
            await Promise.resolve();
        });
        await act(async () => { listTwo.resolve({ sessions: [summaryFor("sdk-2", "project-2", "canvas-2")], unreadable: [] }); await Promise.resolve(); });
        expect(openSessionMock).toHaveBeenCalledWith("sdk-2");

        await act(async () => {
            useAgentStore.getState().setCanvasContext({ ...initial, snapshot: { ...initial.snapshot, projectId: "project-3", canvasId: "canvas-3" } });
            await Promise.resolve();
        });
        await act(async () => { listThree.resolve({ sessions: [summaryFor("sdk-3", "project-3", "canvas-3")], unreadable: [] }); await Promise.resolve(); });
        await act(async () => { openThree.resolve({ summary: summaryFor("sdk-3", "project-3", "canvas-3"), entries: [] }); await Promise.resolve(); });
        expect(useAgentSessionStore.getState().activeSessionId).toBe("sdk-3");

        await act(async () => { openTwo.resolve({ summary: summaryFor("sdk-2", "project-2", "canvas-2"), entries: [] }); await Promise.resolve(); });
        expect(useAgentSessionStore.getState().activeSessionId).toBe("sdk-3");
        expect(useAgentSessionStore.getState().sessions.some((item) => item.sessionId === "sdk-2")).toBe(false);
        unmount();
    });

    it("remount rebuilds the active timeline from session entries and keeps envelope status fresh", async () => {
        const initial = useAgentStore.getState().canvasContext!;
        useAgentStore.getState().setCanvasContext({ ...initial, snapshot: { ...initial.snapshot, projectId: "project-2", canvasId: "canvas-2" } });
        const { unmount } = renderPiAgent();
        unmount();

        // 重新挂载（页面返回）：scope effect 重新 openSession 并投影 entries。
        openSessionMock.mockResolvedValue({
            summary: { sessionId: "sdk-a", title: "A", scope: { projectId: "project-2", canvasId: "canvas-2" }, createdAt: 1, updatedAt: 2, status: "running", hasUnfinishedOperation: true },
            entries: [
                { id: "user-1", parentId: null, type: "message", role: "user", text: "继续画布", timestamp: "2026-09-03T00:00:00.000Z" } satisfies PiSessionEntrySnapshot,
            ],
        });
        const second = renderPiAgent();
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });

        expect(useAgentSessionStore.getState().activeSessionId).toBe("sdk-a");
        expect(useAgentStore.getState().messages.map((item) => [item.role, item.itemId])).toEqual([["user", "user-1"]]);

        emitSession?.({ sessionId: "sdk-a", kind: "agent", payload: { type: "agent_end", messages: [] } });
        await act(async () => { await Promise.resolve(); });
        expect(useAgentSessionStore.getState().sessions[0]).toMatchObject({ sessionId: "sdk-a", status: "idle" });
        second.unmount();
    });
});

describe("usePiAgent per-session send admission", () => {
    beforeEach(() => {
        useAiSourceStore.setState({ status: "ready", preferences: { version: 1, selections: {} }, error: null, applying: false });
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        useAgentStore.setState({ messages: [], sending: false, waiting: false, eventLogs: [], tokenUsage: null, canvasContext: canvasContext(canvasSnapshot(0, { x: 0, y: 0 }), vi.fn()) });
        usePiHistoryStore.setState({ activeSessionId: null, sessions: [] });
        useAgentSessionStore.setState({ sessions: [], activeSessionId: null, unreadableSessions: [], pendingUserInputs: {}, pendingApprovals: {} });
        useConfigStore.setState({ config: { ...defaultConfig, channels: defaultConfig.channels.map((channel) => ({ ...channel, apiKey: "test-key" })) } });
    });
    afterEach(() => {
        vi.useRealTimers();
        delete window.shotshot;
    });

    function installBridge(promptImpl: AgentBridge["prompt"]) {
        const agent: AgentBridge = {
            listSessions: async () => ({ sessions: [], unreadable: [] }),
            createSession: async () => ({ sessionId: `session-${++sessionSeq}`, title: `session-${sessionSeq}`, scope: { projectId: "project-1", canvasId: "canvas-1" }, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false }),
            ensureProjectWorkspace: async () => ({ ok: false, error: "unsupported" }),
            openSession: async () => ({ summary: summaryFor("session", "project-1", "canvas-1"), entries: [] }),
            closeSession: async () => undefined,
            readSessionEntries: async () => [],
            abort: async () => undefined,
            compact: async () => ({ ok: true }),
            setCanvasSnapshot: () => {},
            importLegacySessions: async () => ({ ok: false, error: "x" }),
            prompt: promptImpl,
            respondToUserInput: async () => ({ ok: true }),
            setApprovalMode: async () => undefined,
            respondToApproval: async () => ({ ok: true }),
            setModelConfig: async () => {},
            onEvent: () => () => undefined,
            onSessionEvent: () => () => undefined,
            waitForIdle: async () => {},
            registerFiles: async () => [],
            readFile: async () => ({ ok: false, error: "x" }),
            listFolder: async () => ({ ok: false, error: "x" }),
            fetch: async (request) => ({ id: request.id, status: 200, statusText: "OK", headers: {}, body: "" }),
            setProjects: () => {},
            setGenerationStatus: () => {},
            setModels: () => {},
            setScriptEntities: () => {},
        };
        const skills: SkillsBridge = {
            configure: async () => ({ fresh: true, snapshot }), scan: async () => ({ fresh: true, snapshot }), read: async () => null,
            readFile: async () => ({ ok: false, error: "x" }), write: async () => ({ ok: true }), importSkill: async () => null,
            remove: async () => ({ ok: true }), seed: async () => ({ ok: true }), pickFolder: async () => null,
        };
        window.shotshot = { agent, skills, platform: "darwin" } as never;
    }

    it("rejects a second send to the same session while the first is in flight", async () => {
        const gate = deferred<void>();
        installBridge(async () => {
            await gate.promise;
            return { ok: true };
        });
        const { result, unmount } = renderPiAgent();
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        const first = result.current.sendPrompt("第一个任务");
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });

        const secondResult = await result.current.sendPrompt("第二个任务");

        expect(secondResult).toBe(false);
        expect(useAgentStore.getState().connectError).toContain("已有任务在运行");
        await act(async () => {
            gate.resolve();
            await expect(first).resolves.toBe(true);
        });
        unmount();
    });

    it("accepts a new send after the previous prompt on the same session settles", async () => {
        installBridge(async () => ({ ok: true }));
        const { result, unmount } = renderPiAgent();
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });

        await act(async () => { await expect(result.current.sendPrompt("第一条")).resolves.toBe(true); });
        await act(async () => { await expect(result.current.sendPrompt("第二条")).resolves.toBe(true); });
        unmount();
    });

    it("touches the canvas updatedAt when a prompt is admitted", async () => {
        installBridge(async () => ({ ok: true }));
        useProjectStore.setState({ projects: [projectWithCanvas("canvas-1", "画布")], hydrated: true, hydrationStatus: "success" });
        const { result, unmount } = renderPiAgent();
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });

        vi.setSystemTime(1_000);
        await act(async () => { await expect(result.current.sendPrompt("置顶一下")).resolves.toBe(true); });
        // 受理即触碰（spec 2026-09-18 画布活跃置顶）：createdAt 基线 1970-01-01T00:00:00Z → 触碰后为当前 fake 时间
        expect(useProjectStore.getState().findCanvas("canvas-1")?.canvas.updatedAt).toBe("1970-01-01T00:00:01.000Z");
        unmount();
    });

    it("does not touch the canvas when the send is rejected by admission", async () => {
        const gate = deferred<void>();
        installBridge(async () => {
            await gate.promise;
            return { ok: true };
        });
        useProjectStore.setState({ projects: [projectWithCanvas("canvas-1", "画布")], hydrated: true, hydrationStatus: "success" });
        const { result, unmount } = renderPiAgent();
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        vi.setSystemTime(1_000);
        const first = result.current.sendPrompt("第一个任务");
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });

        vi.setSystemTime(5_000);
        const secondResult = await result.current.sendPrompt("第二个任务");
        expect(secondResult).toBe(false);
        // 只有受理的发送触碰：拒绝路径不得覆盖第一次受理时的 updatedAt
        expect(useProjectStore.getState().findCanvas("canvas-1")?.canvas.updatedAt).toBe("1970-01-01T00:00:01.000Z");
        await act(async () => {
            gate.resolve();
            await expect(first).resolves.toBe(true);
        });
        unmount();
    });

    it("does not let a late settling send reset the current view state", async () => {
        const gate = deferred<void>();
        installBridge(async () => {
            await gate.promise;
            return { ok: true };
        });
        const { result, unmount } = renderPiAgent();
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        const first = result.current.sendPrompt("画布A任务");
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });

        // 模拟切画布：scope effect 把活动会话清空，随后新画布有自己的在途状态
        useAgentStore.setState({ canvasContext: canvasContext({ ...canvasSnapshot(0, { x: 0, y: 0 }), canvasId: "canvas-2" }, vi.fn()) });
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        useAgentStore.getState().setAgentState({ sending: true, waiting: true });

        await act(async () => {
            gate.resolve();
            await expect(first).resolves.toBe(true);
        });
        // 晚到 settle 不得重置「当前视图」的在途状态
        expect(useAgentStore.getState().sending).toBe(true);
        unmount();
    });
});

describe("OpenRouter Agent capabilities", () => {
    beforeEach(() => useAiSourceStore.setState({ status: "ready", preferences: { version: 1, selections: {} }, error: null, applying: false }));
    it.each([undefined, false, true])("requires confirmed tools support (%s)", (supportsTools) => {
        const channel = createModelChannel({ provider: "openrouter", apiKey: "fixture-key", models: [{ name: "vendor/vision/model:free", capability: "text", catalog: { version: 1, source: "provider_models", providerStatus: "active", supportsTools } }] });
        const value = encodeChannelModel(channel.id, channel.models[0].name);
        const config = { ...defaultConfig, channels: [channel], models: modelOptionsFromChannels([channel]), agentModel: value };
        expect(channel.models[0].supportsImageInput).toBe(true); // Legacy name inference must not authorize OpenRouter images.
        const resolved = resolvePiModelConfig(config);
        if (supportsTools !== true) {
            expect(resolved).toBeNull();
            const original = useConfigStore.getState().config;
            useConfigStore.setState({ config });
            expect(modelNotReadyKey()).toBe("config.catalog.agentRequiresTools");
            useConfigStore.setState({ config: original });
        }
        else expect(resolved).toMatchObject({ model: "vendor/vision/model:free", provider: "openrouter", supportsImageInput: false });
    });
    it.each([["text"], ["text", "image"]].map(inputModalities => ({ inputModalities })))("uses only confirmed input modalities %j", ({ inputModalities }) => {
        const channel = createModelChannel({ provider: "openrouter", apiKey: "fixture-key", models: [{ name: "a/model:free", capability: "text", catalog: { version: 1, source: "provider_models", providerStatus: "active", supportsTools: true, inputModalities } }] });
        const config = { ...defaultConfig, channels: [channel], agentModel: encodeChannelModel(channel.id, channel.models[0].name) };
        expect(resolvePiModelConfig(config)).toMatchObject({ supportsImageInput: inputModalities.includes("image") });
    });
});
