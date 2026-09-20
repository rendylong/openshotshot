import { mkdirSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    type AgentSession,
    type AgentSessionEvent,
    type CreateAgentSessionRuntimeResult,
    type ModelRuntime,
    type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { buildModelsFromConfig } from "@/lib/agent/pi-provider-map";
import type { BrowserWindow } from "electron";

import {
    createSessionRuntimeRegistry,
    createShotshotSessionExtension,
    createSessionToolSelection,
    parseAgentPromptInput,
    parseAgentUserInputResponse,
    parseResolvedModelConfig,
    type PiSessionRuntimeFactory,
} from "./pi-session-adapter";
import type { SkillRuntime } from "./skill-runtime";
import { AGENT_ATTACHMENTS_CUSTOM_TYPE, type PiSessionEnvelope, type ResolvedTextModelConfig } from "@/lib/agent/pi-agent-types";

type FakeListener = (event: AgentSessionEvent) => void;
const tempRoots: string[] = [];

function emitFromSession(session: AgentSession, event: AgentSessionEvent) {
    (session as unknown as { emit: (event: AgentSessionEvent) => void }).emit(event);
}

function createSkillRuntime(): SkillRuntime {
    return {
        agentSnapshot: async () => ({ ok: true, revision: 1, systemPromptBlock: "", availableSkillNames: [] }),
        readForAgent: async () => "",
    } as unknown as SkillRuntime;
}

function createDeferredSkillRuntime() {
    const entered = deferred();
    const release = deferred();
    const runtime: SkillRuntime = {
        agentSnapshot: async () => {
            entered.resolve();
            await release.promise;
            return { ok: true, revision: 1, systemPromptBlock: "", availableSkillNames: [] };
        },
        readForAgent: async () => "",
    } as unknown as SkillRuntime;
    return { runtime, entered, release };
}

function createSessionManager(sessionId: string): SessionManager {
    return {
        getSessionId: () => sessionId,
        getSessionFile: () => undefined,
        getSessionDir: () => "/tmp/unused",
        isPersisted: () => false,
        getEntries: () => [],
    } as unknown as SessionManager;
}

function createFakeSession(sessionId: string): AgentSession {
    const listeners = new Set<FakeListener>();
    let activeToolNames = ["read", "canvas_get_state"];
    return {
        sessionId,
        sessionName: undefined,
        sessionFile: undefined,
        sessionManager: createSessionManager(sessionId),
        agent: { state: { systemPrompt: "" } },
        isStreaming: false,
        isIdle: true,
        isCompacting: false,
        extensionRunner: { hasHandlers: () => false },
        subscribe: vi.fn((listener: FakeListener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }),
        emit: (event: AgentSessionEvent) => listeners.forEach((listener) => listener(event)),
        prompt: vi.fn(async () => undefined),
        waitForIdle: async () => undefined,
        abort: vi.fn(async () => undefined),
        compact: vi.fn(async () => ({ summary: `summary-${sessionId}` })),
        setModel: vi.fn(async () => undefined),
        getActiveToolNames: vi.fn(() => [...activeToolNames]),
        setActiveToolsByName: vi.fn((toolNames: string[]) => {
            activeToolNames = [...toolNames];
        }),
        dispose: vi.fn(),
    } as unknown as AgentSession;
}

async function createHarness(options: {
    createRuntime?: PiSessionRuntimeFactory;
    skillRuntime?: SkillRuntime;
    onModelChanged?: Parameters<typeof createSessionRuntimeRegistry>[0]["onModelChanged"];
    resolveModel?: (config: ResolvedTextModelConfig) => ReturnType<typeof buildModelsFromConfig>["model"] | Promise<ReturnType<typeof buildModelsFromConfig>["model"]>;
} = {}) {
    // macOS 的 tmpdir 位于 /var -> /private/var 符号链接下，先取规范路径再构造
    // 路径断言期望值（与 agent-workspace.test.ts 一致），工作区绑定用的是 realpath。
    const sessionDir = await realpath(await mkdtemp(join(tmpdir(), "shotshot-pi-session-adapter-")));
    tempRoots.push(sessionDir);
    const envelopes: PiSessionEnvelope[] = [];
    const send = vi.fn((_channel: string, envelope: PiSessionEnvelope) => {
        envelopes.push(envelope);
    });
    const getWindow = () => ({ isDestroyed: () => false, webContents: { send } }) as unknown as BrowserWindow;
    const skillRuntime = options.skillRuntime ?? createSkillRuntime();
    const sessions: AgentSession[] = [];
    let nextSessionNumber = 0;

    // services.cwd 透传 runtime 选项（与 SDK createAgentSessionServices 的 resolvePath 行为一致），
    // 否则 runtime.cwd 恒为 sessionDir，测试观察不到工作区绑定。
    const createRuntime: PiSessionRuntimeFactory = options.createRuntime ?? (async ({ sessionManager, model, cwd }) => {
        const manager = sessionManager ?? createSessionManager(`session-${++nextSessionNumber}`);
        const session = createFakeSession(manager.getSessionId());
        Object.assign(session, { model, sessionManager: manager, setModel: vi.fn(async (nextModel) => { Object.assign(session, { model: nextModel }); }) });
        sessions.push(session);
        return {
            session,
            extensionsResult: { extensions: [], errors: [], runtime: {} },
            services: {
                cwd: resolve(cwd),
                agentDir: sessionDir,
                modelRuntime: {},
                settingsManager: {},
                resourceLoader: {},
                diagnostics: [],
            },
            diagnostics: [],
        } as unknown as CreateAgentSessionRuntimeResult;
    });

    const registry = createSessionRuntimeRegistry({
        sessionDir,
        createRuntime,
        getWindow,
        skillRuntime,
        resolveModel: options.resolveModel,
        onModelChanged: options.onModelChanged,
    });

    return { registry, envelopes, sessions, sessionDir };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

describe("SessionRuntimeRegistry routing", () => {
    afterEach(async () => {
        await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it("creates a managed session through the injected model resolver", async () => {
        const config: ResolvedTextModelConfig = {
            credentialMode: "shotshot",
            model: "managed-text",
            apiFormat: "openai",
            agentApiMode: "chat_completions",
        };
        const harness = await createHarness({
            resolveModel: (input) => {
                if (input.credentialMode !== "shotshot") throw new Error("unexpected model source");
                return buildModelsFromConfig(input, {
                baseUrl: "https://gateway.example",
                resolveApiKey: async () => "main-process-secret",
                inputModalities: ["text"],
                }).model;
            },
        });

        await harness.registry.setModelConfig(config);

        await expect(harness.registry.createSession({
            scope: { projectId: "project-1", canvasId: "canvas-1" },
        })).resolves.toMatchObject({ scope: { projectId: "project-1", canvasId: "canvas-1" } });
    });

    it("persists the bounded attachment manifest before prompting with project files", async () => {
        const harness = await createHarness();
        const created = await harness.registry.createSession({ scope: { projectId: "project-1", canvasId: "canvas-1" } });
        const files = [{
            assetId: "asset-1",
            relativePath: "assets/imported/budget--a1b2c3d4.xlsx",
            name: "budget.xlsx",
            kind: "spreadsheet" as const,
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            size: 64,
        }];

        await harness.registry.prompt(created.sessionId, { text: "修改这个表格", files });

        const session = harness.sessions[0];
        const manager = (session as unknown as { sessionManager: SessionManager }).sessionManager;
        const entries = manager.getEntries();
        const customEntries = entries.filter((entry) => entry.type === "custom" && (entry as unknown as { customType?: string }).customType === AGENT_ATTACHMENTS_CUSTOM_TYPE);
        expect(customEntries).toHaveLength(1);
        expect((customEntries[0] as unknown as { data?: unknown }).data).toEqual({ projectId: "project-1", files });
        expect(session.prompt).toHaveBeenCalledWith(
            "修改这个表格\n\nAttached project files:\n- assets/imported/budget--a1b2c3d4.xlsx (spreadsheet, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, 64 bytes)",
            expect.objectContaining({ streamingBehavior: "followUp" }),
        );
    });

    it("does not append an attachment manifest for plain text prompts", async () => {
        const harness = await createHarness();
        const created = await harness.registry.createSession({ scope: { projectId: "project-1", canvasId: "canvas-1" } });

        await harness.registry.prompt(created.sessionId, "读取画布");

        const session = harness.sessions[0];
        const manager = (session as unknown as { sessionManager: SessionManager }).sessionManager;
        const customEntries = manager.getEntries().filter((entry) => entry.type === "custom" && (entry as unknown as { customType?: string }).customType === AGENT_ATTACHMENTS_CUSTOM_TYPE);
        expect(customEntries).toHaveLength(0);
        expect(session.prompt).toHaveBeenCalledWith("读取画布", expect.anything());
    });

    it("aborts the attachment manifest when the prompt fails after it was persisted", async () => {
        const harness = await createHarness();
        const created = await harness.registry.createSession({ scope: { projectId: "project-1", canvasId: "canvas-1" } });
        const session = harness.sessions[0];
        const files = [{
            assetId: "asset-1",
            relativePath: "assets/imported/budget--a1b2c3d4.xlsx",
            name: "budget.xlsx",
            kind: "spreadsheet" as const,
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            size: 64,
        }];
        vi.mocked(session.prompt).mockRejectedValueOnce(new Error("provider down"));

        await expect(harness.registry.prompt(created.sessionId, { text: "修改这个表格", files }))
            .resolves.toEqual({ ok: false, error: expect.stringContaining("provider down") });

        // 清单写入后 prompt 失败：必须紧跟一条 abort 标记，恢复路径才不会把它附着到下一条用户消息。
        const manifestEntries = (session as unknown as { sessionManager: SessionManager }).sessionManager.getEntries()
            .filter((entry) => entry.type === "custom" && (entry as unknown as { customType?: string }).customType === AGENT_ATTACHMENTS_CUSTOM_TYPE);
        expect(manifestEntries).toHaveLength(2);
        const manifestId = (manifestEntries[0] as unknown as { id: string }).id;
        expect(manifestEntries[1]).toMatchObject({ data: { abortedEntryId: manifestId } });

        // 失败后的下一轮：用户消息正常落盘。恢复路径的“孤儿清单绝不附着”由投影层覆盖
        // （pi-session-projection 的 abort 用例）；这里断言 session 内没有任何可附着对象：
        // 清单之后只有 abort 标记与新的用户消息，没有中间用户消息会继承清单。
        const manager = (session as unknown as { sessionManager: SessionManager }).sessionManager;
        manager.appendMessage({ role: "user", content: "文本消息" } as never);
        const entries = manager.getEntries();
        const manifestIndex = entries.findIndex((entry) => entry.type === "custom" && (entry as unknown as { customType?: string }).customType === AGENT_ATTACHMENTS_CUSTOM_TYPE);
        const abortEntry = entries[manifestIndex + 1] as unknown as { data?: { abortedEntryId?: string } };
        expect(abortEntry?.data?.abortedEntryId).toBe((manifestEntries[0] as unknown as { id: string }).id);
        const userEntries = entries.filter((entry) => entry.type === "message" && (entry as unknown as { message?: { role?: string } }).message?.role === "user");
        expect(userEntries).toHaveLength(1);
        // 用户消息在 abort 标记之后，中间没有可消费的清单。
        expect(entries.indexOf(userEntries[0]!)).toBeGreaterThan(entries.indexOf(abortEntry as never));
    });

    it("keeps view_image registered but inactive for a text-only model", () => {
        const selection = createSessionToolSelection([
            { name: "canvas_get_state", label: "Canvas State" },
            { name: "view_image", label: "View Image" },
            { name: "ask_user_question", label: "Ask User" },
        ], false);

        expect(selection.registeredNames).toContain("view_image");
        expect(selection.activeNames).not.toContain("view_image");
        expect(selection.activeTools.map((tool) => tool.name)).not.toContain("view_image");
    });

    it("registers and activates the SDK built-in mutation tools for approval gating", () => {
        const selection = createSessionToolSelection([
            { name: "canvas_get_state", label: "Canvas State" },
        ], true);

        for (const name of ["read", "bash", "edit", "write"]) {
            expect(selection.registeredNames).toContain(name);
            expect(selection.activeNames).toContain(name);
        }
        const builtIn = selection.activeTools.filter((tool) => ["read", "bash", "edit", "write"].includes(tool.name));
        expect(builtIn.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
        expect(builtIn.every((tool) => tool.promptSnippet)).toBe(true);
    });

    it("starts sessions in the default approval mode and flips waiting_approval status", async () => {
        const harness = await createHarness();
        const summary = await harness.registry.createSession({ scope: { projectId: "p", canvasId: "a" } });
        const item = harness.registry.get(summary.sessionId);
        expect(item?.runtimeState.approvalMode).toBe("confirm_changes");

        harness.registry.setWaitingForApproval(summary.sessionId, true);
        expect(harness.registry.get(summary.sessionId)?.status).toBe("waiting_approval");

        harness.registry.setWaitingForApproval(summary.sessionId, false);
        expect(harness.registry.get(summary.sessionId)?.status).toBe("idle");
    });

    it("runs prompts in different sessions concurrently", async () => {
        const harness = await createHarness();
        const a = await harness.registry.createSession({ scope: { projectId: "p", canvasId: "a" } });
        const b = await harness.registry.createSession({ scope: { projectId: "p", canvasId: "b" } });
        expect(a.sessionId).not.toBe(b.sessionId);

        const gate = deferred();
        let started = 0;
        harness.sessions[0]!.prompt = vi.fn(async () => {
            started += 1;
            emitFromSession(harness.sessions[0]!, { type: "agent_start" });
            await gate.promise;
        });
        harness.sessions[1]!.prompt = vi.fn(async () => {
            started += 1;
            emitFromSession(harness.sessions[1]!, { type: "agent_start" });
            await gate.promise;
        });

        const first = harness.registry.prompt(a.sessionId, "first");
        const second = harness.registry.prompt(b.sessionId, "second");
        await vi.waitFor(() => expect(started).toBe(2));
        // 并发期间两个会话的 envelope 各自带正确 sessionId（renderer 按此路由，
        // 多白板并行依赖该归属不被串扰）。
        await vi.waitFor(() => {
            const sessionIds = new Set(harness.envelopes.map((envelope) => envelope.sessionId));
            expect(sessionIds.has(a.sessionId)).toBe(true);
            expect(sessionIds.has(b.sessionId)).toBe(true);
        });
        gate.resolve();
        await expect(first).resolves.toEqual({ ok: true });
        await expect(second).resolves.toEqual({ ok: true });
    });

    it("isolates abort, compact, and model changes per session", async () => {
        const harness = await createHarness();
        const a = await harness.registry.createSession({ scope: { projectId: "p", canvasId: "a" } });
        const b = await harness.registry.createSession({ scope: { projectId: "p", canvasId: "b" } });

        await harness.registry.abort(a.sessionId);
        expect(harness.sessions[0]!.abort).toHaveBeenCalledTimes(1);
        expect(harness.sessions[1]!.abort).not.toHaveBeenCalled();

        await expect(harness.registry.compact(a.sessionId)).resolves.toEqual({ ok: true });
        expect(harness.sessions[0]!.compact).toHaveBeenCalledTimes(1);
        expect(harness.sessions[1]!.compact).not.toHaveBeenCalled();

        const config: import("@/lib/agent/pi-agent-types").ByokTextModelConfig = {
            model: "model-2",
            baseUrl: "https://example.test",
            apiKey: "key",
            apiFormat: "openai",
            agentApiMode: "chat_completions",
            supportsImageInput: false,
        };
        await harness.registry.setModelConfig(config);
        expect(harness.sessions[0]!.setModel).not.toHaveBeenCalled();
        expect(harness.sessions[1]!.setModel).not.toHaveBeenCalled();
        await harness.registry.prompt(a.sessionId, "apply desired model");
        expect(harness.sessions[0]!.setModel).toHaveBeenCalledTimes(1);
        expect(harness.sessions[1]!.setModel).not.toHaveBeenCalled();
        expect(harness.sessions[0]!.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "model-2" }));
        expect(harness.sessions[0]!.dispose).not.toHaveBeenCalled();
        expect(harness.sessions[1]!.dispose).not.toHaveBeenCalled();
    });

    it("accepts the HiAPI channel provider in resolved model configs", () => {
        expect(parseResolvedModelConfig({
            model: "deepseek-v4-flash",
            baseUrl: "https://api.hiapi.ai",
            apiKey: "key",
            apiFormat: "openai",
            agentApiMode: "chat_completions",
            supportsImageInput: true,
            provider: "hiapi",
        })).toMatchObject({ provider: "hiapi", supportsImageInput: true });
    });

    it("refreshes view_image at idle prompts while preserving active-turn capabilities", async () => {
        const harness = await createHarness();
        const created = await harness.registry.createSession({ scope: { projectId: "p", canvasId: "a" } });
        const item = harness.registry.get(created.sessionId)!;
        const allTools = [
            { name: "canvas_get_state", label: "Canvas State" },
            { name: "view_image", label: "View Image" },
        ];
        item.runtimeState.tools = allTools.slice(0, 1);
        item.runtimeState.allTools = allTools;

        const imageConfig: ResolvedTextModelConfig = {
            model: "image-model",
            baseUrl: "https://example.test",
            apiKey: "key",
            apiFormat: "openai",
            agentApiMode: "responses",
            supportsImageInput: true,
        };
        await harness.registry.setModelConfig(imageConfig);
        expect(item.session.setActiveToolsByName).not.toHaveBeenCalled();
        await expect(harness.registry.prompt(created.sessionId, "inspect image")).resolves.toEqual({ ok: true });

        expect(harness.sessions[0]!.setActiveToolsByName).toHaveBeenLastCalledWith([
            "read",
            "canvas_get_state",
            "view_image",
        ]);
        expect(item.runtimeState.tools).toEqual(allTools);

        Object.assign(item.session, { isStreaming: true });
        await harness.registry.setModelConfig({ ...imageConfig, supportsImageInput: false });
        await expect(harness.registry.prompt(created.sessionId, "queued image turn")).resolves.toEqual({ ok: true });
        expect(item.session.getActiveToolNames()).toContain("view_image");
        expect(item.runtimeState.tools).toEqual(allTools);
        Object.assign(item.session, { isStreaming: false });
        await expect(harness.registry.prompt(created.sessionId, "next text turn")).resolves.toEqual({ ok: true });

        expect(harness.sessions[0]!.setActiveToolsByName).toHaveBeenLastCalledWith([
            "read",
            "canvas_get_state",
        ]);
        expect(item.runtimeState.tools).toEqual(allTools.slice(0, 1));
    });

    it("switches subscription image capability only at idle model boundaries", async () => {
        const base = buildModelsFromConfig({ model: "test", baseUrl: "https://example.test", apiKey: "key", apiFormat: "openai", agentApiMode: "responses", supportsImageInput: true }).model;
        const harness = await createHarness({ resolveModel: config => ({ ...base, provider: config.source === "chatgpt" ? "openai-codex" : "custom" }) });
        const created = await harness.registry.createSession({ scope: { projectId: "p", canvasId: "images" } });
        const item = harness.registry.get(created.sessionId)!;
        item.runtimeState.allTools = [{ name: "generate_chatgpt_image", label: "Image" }];
        await harness.registry.setModelConfig({ source: "chatgpt", model: "test" });
        await harness.registry.prompt(created.sessionId, "generate");
        expect(item.session.getActiveToolNames()).toContain("generate_chatgpt_image");
        Object.assign(item.session, { isStreaming: true });
        await harness.registry.setModelConfig({ model: "test", baseUrl: "https://example.test", apiKey: "key", apiFormat: "openai", agentApiMode: "responses", supportsImageInput: true });
        await harness.registry.prompt(created.sessionId, "queued");
        expect(item.session.getActiveToolNames()).toContain("generate_chatgpt_image");
        Object.assign(item.session, { isStreaming: false });
        await harness.registry.prompt(created.sessionId, "next");
        expect(item.session.getActiveToolNames()).not.toContain("generate_chatgpt_image");
        expect(item.runtimeState.tools).toEqual([]);
        await harness.registry.dispose();
    });

    it("rejects a resolved model config without an explicit image-input capability", () => {
        expect(parseResolvedModelConfig({
            model: "private-model",
            baseUrl: "https://example.test",
            apiKey: "key",
            apiFormat: "openai",
            agentApiMode: "responses",
        })).toBeNull();
    });

    it("marks a session as waiting for user input until the request resolves", async () => {
        const harness = await createHarness();
        const created = await harness.registry.createSession({ scope: { projectId: "p", canvasId: "a" } });

        harness.registry.setWaitingForInput(created.sessionId, true);
        expect(harness.registry.listSessions().sessions[0]).toMatchObject({ status: "waiting_input", hasUnfinishedOperation: true });

        harness.registry.setWaitingForInput(created.sessionId, false);
        expect(harness.registry.listSessions().sessions[0]).toMatchObject({ status: "idle", hasUnfinishedOperation: false });
    });

    it("returns explicit errors for unknown session ids", async () => {
        const harness = await createHarness();
        await expect(harness.registry.prompt("missing", "hello")).resolves.toEqual({
            ok: false,
            error: "Agent 会话不存在：missing",
        });
        await expect(harness.registry.abort("missing")).rejects.toThrow("Agent 会话不存在：missing");
        await expect(harness.registry.compact("missing")).resolves.toEqual({
            ok: false,
            error: "Agent 会话不存在：missing",
        });
        expect(harness.registry.get("missing")).toBeUndefined();
    });

    it("rebinds replacement sessions atomically and stops using the old reference", async () => {
        const harness = await createHarness();
        const oldSummary = await harness.registry.createSession({ scope: { projectId: "p", canvasId: "a" } });
        const oldItem = harness.registry.get(oldSummary.sessionId);
        expect(oldItem).toBeDefined();
        const oldSession = oldItem!.session;
        const oldUnsubscribe = vi.spyOn(oldItem!, "unsubscribe");

        await oldItem!.runtime.newSession();

        const replacement = oldItem!.runtime.session;
        expect(replacement).not.toBe(oldSession);
        const replacementId = replacement.sessionId;
        expect(replacementId).not.toBe(oldSummary.sessionId);
        expect(oldUnsubscribe).toHaveBeenCalledTimes(1);
        expect(harness.registry.get(oldSummary.sessionId)).toBeUndefined();
        expect(harness.registry.get(replacementId)?.session).toBe(replacement);

        await expect(harness.registry.prompt(oldSummary.sessionId, "old")).resolves.toMatchObject({ ok: false });
        await harness.registry.prompt(replacementId, "new");
        expect(oldSession.prompt).not.toHaveBeenCalledWith("old");
        expect(replacement.prompt).toHaveBeenCalledWith("new", {
            expandPromptTemplates: false,
            images: undefined,
            streamingBehavior: "followUp",
        });

        emitFromSession(oldSession, { type: "agent_start" });
        emitFromSession(replacement, { type: "agent_start" });
        expect(harness.envelopes.filter((envelope) => envelope.payload).at(-1)?.sessionId).toBe(replacementId);
    });

    it("rejects prompts whose session is replaced or closed while skills refresh", async () => {
        const replacementSkills = createDeferredSkillRuntime();
        const closeSkills = createDeferredSkillRuntime();
        const replacementHarness = await createHarness({ skillRuntime: replacementSkills.runtime });
        const closeHarness = await createHarness({ skillRuntime: closeSkills.runtime });
        const replacementSummary = await replacementHarness.registry.createSession({ scope: { projectId: "p", canvasId: "a" } });
        const closeSummary = await closeHarness.registry.createSession({ scope: { projectId: "p", canvasId: "b" } });
        const oldReplacementSession = replacementHarness.registry.get(replacementSummary.sessionId)!.session;
        const closedSession = closeHarness.registry.get(closeSummary.sessionId)!.session;

        const replacementPrompt = replacementHarness.registry.prompt(replacementSummary.sessionId, "replaced while refreshing");
        const closePrompt = closeHarness.registry.prompt(closeSummary.sessionId, "closed while refreshing");
        await Promise.all([replacementSkills.entered.promise, closeSkills.entered.promise]);

        await replacementHarness.registry.get(replacementSummary.sessionId)!.runtime.newSession();
        await closeHarness.registry.closeSession(closeSummary.sessionId);
        replacementSkills.release.resolve();
        closeSkills.release.resolve();

        await expect(replacementPrompt).resolves.toMatchObject({
            ok: false,
            error: expect.stringContaining("Agent 会话已失效"),
        });
        await expect(closePrompt).resolves.toMatchObject({
            ok: false,
            error: expect.stringContaining("Agent 会话已失效"),
        });
        expect(oldReplacementSession.prompt).not.toHaveBeenCalled();
        expect(closedSession.prompt).not.toHaveBeenCalled();
    });

    it("skips stale sessions replaced while a model change resolves", async () => {
        const entered = deferred();
        const release = deferred();
        const harness = await createHarness({
            resolveModel: async (config) => {
                entered.resolve();
                await release.promise;
                return buildModelsFromConfig(config as import("@/lib/agent/pi-agent-types").ByokTextModelConfig).model;
            },
        });
        const summary = await harness.registry.createSession({ scope: { projectId: "p", canvasId: "a" } });
        const oldItem = harness.registry.get(summary.sessionId)!;
        const config: import("@/lib/agent/pi-agent-types").ByokTextModelConfig = {
            model: "model-2",
            baseUrl: "https://example.test",
            apiKey: "key",
            apiFormat: "openai",
            agentApiMode: "chat_completions",
            supportsImageInput: false,
        };

        const changing = harness.registry.setModelConfig(config);
        await entered.promise;
        await oldItem.runtime.newSession();
        release.resolve();
        await expect(changing).resolves.toBeUndefined();

        expect(oldItem.session.setModel).not.toHaveBeenCalled();
        await harness.registry.prompt(harness.sessions[1]!.sessionId, "apply desired model");
        expect(harness.sessions[1]!.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "model-2" }));
    });

    it("clears only the closed session's file registry", async () => {
        const cleared: string[] = [];
        const harness = await createHarness();
        const a = await harness.registry.createSession({ scope: { projectId: "p", canvasId: "a" } });
        const b = await harness.registry.createSession({ scope: { projectId: "p", canvasId: "b" } });
        harness.registry.get(a.sessionId)!.files.clear = () => cleared.push(a.sessionId);
        harness.registry.get(b.sessionId)!.files.clear = () => cleared.push(b.sessionId);

        await harness.registry.closeSession(a.sessionId);

        expect(cleared).toEqual([a.sessionId]);
        expect(harness.registry.get(a.sessionId)).toBeUndefined();
        expect(harness.registry.get(b.sessionId)).toBeDefined();
    });

    it("waits for an in-flight creation during dispose and cleans up its late result", async () => {
        const factoryEntered = deferred();
        const releaseFactory = deferred();
        let createdSession: AgentSession | undefined;
        let clearCount = 0;
        let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
        const createRuntime: PiSessionRuntimeFactory = async ({ sessionManager, files }) => {
            const originalClear = files.clear.bind(files);
            files.clear = () => {
                originalClear();
                clearCount += 1;
            };
            factoryEntered.resolve();
            await releaseFactory.promise;
            createdSession = createFakeSession(sessionManager.getSessionId());
            return {
                session: createdSession,
                extensionsResult: { extensions: [], errors: [], runtime: {} },
                services: {
                    cwd: "",
                    agentDir: "",
                    modelRuntime: {},
                    settingsManager: {},
                    resourceLoader: {},
                    diagnostics: [],
                },
                diagnostics: [],
            } as unknown as CreateAgentSessionRuntimeResult;
        };

        harness = await createHarness({ createRuntime });
        const creating = harness.registry.createSession({ scope: { projectId: "p", canvasId: "a" } });
        await factoryEntered.promise;
        const disposing = harness.registry.dispose();
        releaseFactory.resolve();

        await expect(creating).rejects.toThrow("Agent runtime 已销毁，会话创建已取消");
        await expect(disposing).resolves.toBeUndefined();
        expect(harness.registry.listSessions()).toEqual({ sessions: [], unreadable: [] });
        expect(createdSession?.dispose).toHaveBeenCalled();
        expect(createdSession?.subscribe).not.toHaveBeenCalled();
        expect(clearCount).toBe(1);
    });

    it("keeps listSessions response shape stable when there are no unreadable files", async () => {
        // 老实现在没有 unreadable 时退回裸数组，会让渲染层 [...sessions] 报
        // "undefined is not iterable"。这里保证 IPC 契约永远是对象。
        const harness = await createHarness();

        const listed = harness.registry.listSessions();
        expect(Array.isArray(listed)).toBe(false);
        expect(listed).toEqual({ sessions: [], unreadable: [] });
        expect(() => [...listed.sessions]).not.toThrow();
    });

    it("forwards native compaction lifecycle events in agent envelopes", async () => {
        const harness = await createHarness();
        const summary = await harness.registry.createSession({ scope: { projectId: "p", canvasId: "a" } });
        const session = harness.registry.get(summary.sessionId)!.session;

        emitFromSession(session, { type: "compaction_start", reason: "manual" });
        emitFromSession(session, {
            type: "compaction_end",
            reason: "manual",
            result: undefined,
            aborted: false,
            willRetry: false,
        });

        expect(harness.envelopes.filter((envelope) => envelope.sessionId === summary.sessionId).slice(-2)).toEqual([
            { sessionId: summary.sessionId, kind: "agent", payload: { type: "compaction_start", reason: "manual" } },
            { sessionId: summary.sessionId, kind: "agent", payload: { type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: false } },
        ]);
    });

    it("uses the shared event status mapping for runtime state", async () => {
        const harness = await createHarness();
        const created = await harness.registry.createSession({ scope: { projectId: "p", canvasId: "a" } });
        const session = harness.registry.get(created.sessionId)!.session;
        const sessionState = session as unknown as { isStreaming: boolean; pendingMessageCount: number };

        sessionState.isStreaming = true;
        emitFromSession(session, { type: "agent_end", messages: [], willRetry: true });
        expect(harness.registry.get(created.sessionId)).toMatchObject({ status: "running" });

        sessionState.isStreaming = false;
        sessionState.pendingMessageCount = 0;
        emitFromSession(session, { type: "queue_update", followUp: [], steering: [] });
        expect(harness.registry.get(created.sessionId)).toMatchObject({ status: "idle" });

        sessionState.pendingMessageCount = 1;
        emitFromSession(session, { type: "queue_update", followUp: ["next"], steering: [] });
        expect(harness.registry.get(created.sessionId)).toMatchObject({ status: "queued" });
    });

    it("forwards compaction failure through the shotshot extension envelope", () => {
        const handlers = new Map<string, (event: unknown) => void>();
        const envelopes: PiSessionEnvelope[] = [];
        const extension = {
            on: (event: string, handler: (payload: unknown) => void) => handlers.set(event, handler),
        };

        createShotshotSessionExtension({
            sessionId: "session-1",
            send: (envelope) => envelopes.push(envelope),
        })(extension as never);

        handlers.get("session_compact_failed")!({
            type: "session_compact_failed",
            reason: "manual",
            errorMessage: "summarization failed",
            aborted: false,
            willRetry: true,
        });

        expect(envelopes).toEqual([{
            sessionId: "session-1",
            kind: "session_compact_failed",
            payload: {
                type: "session_compact_failed",
                reason: "manual",
                errorMessage: "summarization failed",
                aborted: false,
                willRetry: true,
            },
        }]);
    });

    it("binds a validated workspace at creation and reports it on the runtime state", async () => {
        const harness = await createHarness();
        const workspace = join(harness.sessionDir, "ws");
        mkdirSync(workspace, { recursive: true });
        const summary = await harness.registry.createSession({
            scope: { projectId: "p", canvasId: "a" },
            workspacePath: workspace,
        });
        const item = harness.registry.get(summary.sessionId);
        expect(item?.runtimeState.workspacePath).toBe(resolve(workspace));
        expect(resolve(item?.runtime.cwd ?? "")).toBe(resolve(workspace));
    });

    it("rejects invalid workspace paths without creating a session", async () => {
        const harness = await createHarness();
        await expect(harness.registry.createSession({
            scope: { projectId: "p", canvasId: "a" },
            workspacePath: "relative/dir",
        })).rejects.toThrow("工作区必须是绝对路径");
        expect(harness.registry.listSessions().sessions).toHaveLength(0);
    });

    it("restores the workspace from the session entry when reopening", async () => {
        const harness = await createHarness();
        const workspace = join(harness.sessionDir, "ws-reopen");
        mkdirSync(workspace, { recursive: true });
        const created = await harness.registry.createSession({
            scope: { projectId: "p", canvasId: "a" },
            workspacePath: workspace,
        });
        await harness.registry.closeSession(created.sessionId);

        const opened = await harness.registry.openSession(created.sessionId);
        expect(harness.registry.get(opened.summary.sessionId)?.runtimeState.workspacePath).toBe(resolve(workspace));
    });

    it("falls back to the default cwd when a restored workspace no longer exists", async () => {
        const harness = await createHarness();
        const workspace = join(harness.sessionDir, "ws-gone");
        mkdirSync(workspace, { recursive: true });
        const created = await harness.registry.createSession({
            scope: { projectId: "p", canvasId: "a" },
            workspacePath: workspace,
        });
        await harness.registry.closeSession(created.sessionId);
        await rm(workspace, { recursive: true, force: true });

        const opened = await harness.registry.openSession(created.sessionId);
        const item = harness.registry.get(opened.summary.sessionId);
        expect(item?.runtimeState.workspacePath).toBeUndefined();
        expect(resolve(item?.runtime.cwd ?? "")).toBe(resolve(harness.sessionDir));
    });
});

describe("resolved model config parser", () => {
    it("accepts a credential-free managed config", () => {
        expect(parseResolvedModelConfig({
            credentialMode: "shotshot",
            model: "managed-text",
            apiFormat: "openai",
            agentApiMode: "chat_completions",
        })).toEqual({ credentialMode: "shotshot", model: "managed-text", apiFormat: "openai", agentApiMode: "chat_completions" });
    });

    it("rejects renderer-supplied credentials for a managed config", () => {
        expect(parseResolvedModelConfig({
            credentialMode: "shotshot",
            model: "managed-text",
            apiFormat: "openai",
            agentApiMode: "chat_completions",
            apiKey: "must-not-cross-ipc",
        })).toBeNull();
    });

    it("rejects unsupported Responses mode for a managed config", () => {
        expect(parseResolvedModelConfig({
            credentialMode: "shotshot",
            model: "managed-text",
            apiFormat: "openai",
            agentApiMode: "responses",
        })).toBeNull();
    });
});

describe("parseAgentPromptInput project files", () => {
    const spreadsheetMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    it("accepts a bounded project file manifest", () => {
        expect(parseAgentPromptInput({
            text: "修改这个表格",
            files: [{ assetId: "asset-1", relativePath: "assets/imported/budget--a1b2c3d4.xlsx", name: "budget.xlsx", kind: "spreadsheet", mimeType: spreadsheetMime, size: 64 }],
        })).toEqual({
            text: "修改这个表格",
            files: [{ assetId: "asset-1", relativePath: "assets/imported/budget--a1b2c3d4.xlsx", name: "budget.xlsx", kind: "spreadsheet", mimeType: spreadsheetMime, size: 64 }],
        });
    });

    it("rejects malformed manifest entries and keeps legacy fileHandles working", () => {
        expect(parseAgentPromptInput({ text: "x", files: "nope" })).toBeNull();
        expect(parseAgentPromptInput({ text: "x", files: [{ relativePath: "a.xlsx", name: "a", kind: "spreadsheet", mimeType: spreadsheetMime, size: 1 }] })).toBeNull();
        expect(parseAgentPromptInput({ text: "x", files: [{ assetId: "a1", relativePath: 1, name: "a", kind: "spreadsheet", mimeType: spreadsheetMime, size: 1 }] })).toBeNull();
        expect(parseAgentPromptInput({ text: "x", files: [{ assetId: "a1", relativePath: "a", name: "a", kind: "spreadsheet", mimeType: spreadsheetMime, size: -1 }] })).toBeNull();
        expect(parseAgentPromptInput({ text: "legacy", fileHandles: ["handle-1"] })).toEqual({ text: "legacy", fileHandles: ["handle-1"] });
    });
});

describe("parseAgentUserInputResponse", () => {
    it("accepts select/input, confirmation, and cancellation responses", () => {
        expect(parseAgentUserInputResponse({ value: "" })).toEqual({ value: "" });
        expect(parseAgentUserInputResponse({ confirmed: false })).toEqual({ confirmed: false });
        expect(parseAgentUserInputResponse({ cancelled: true })).toEqual({ cancelled: true });
    });

    it("accepts form answers with optional custom text and comment", () => {
        expect(parseAgentUserInputResponse({
            answers: [
                { questionId: "style", values: ["minimal"] },
                { questionId: "tags", values: [], customText: "", comment: " Note " },
            ],
        })).toEqual({
            answers: [
                { questionId: "style", values: ["minimal"] },
                { questionId: "tags", values: [], customText: "", comment: " Note " },
            ],
        });
    });

    it("rejects malformed form answers", () => {
        for (const value of [
            { answers: "no" },
            { answers: ["no"] },
            { answers: [{ values: ["a"] }] },
            { answers: [{ questionId: "", values: [] }] },
            { answers: [{ questionId: "style", values: "a" }] },
            { answers: [{ questionId: "style", values: [1] }] },
            { answers: [{ questionId: "style", values: [], comment: 3 }] },
            { answers: [{ questionId: "style", values: [] }, "bad"] },
        ]) {
            expect(parseAgentUserInputResponse(value)).toBeNull();
        }
    });

    it("rejects malformed or ambiguous responses", () => {
        for (const value of [null, {}, { value: 1 }, { confirmed: "yes" }, { cancelled: false }, { value: "A", confirmed: true }]) {
            expect(parseAgentUserInputResponse(value)).toBeNull();
        }
    });
});


describe("managed model lifecycle", () => {
    const nativeModel = (id: string, image = false) => ({ ...buildModelsFromConfig({ model: id, apiKey: "sentinel", baseUrl: "https://example.test", apiFormat: "openai", agentApiMode: "responses", supportsImageInput: image }).model, provider: id.startsWith("chatgpt") ? "openai-codex" : "shotshot-local" });
    it("uses injected models at creation, defers changes while busy, and aborts only ChatGPT", async () => {
        const resolveModel = vi.fn(async (config: ResolvedTextModelConfig) => nativeModel(config.model));
        const harness = await createHarness({ resolveModel });
        await harness.registry.setModelConfig({ source: "chatgpt", model: "chatgpt-first" });
        const a = await harness.registry.createSession({ scope: { projectId: "p", canvasId: "a" } });
        expect(harness.registry.get(a.sessionId)?.session.model?.provider).toBe("openai-codex");
        Object.assign(harness.sessions[0]!, { isStreaming: true });
        await harness.registry.setModelConfig({ source: "chatgpt", model: "byok-second" });
        const b = await harness.registry.createSession({ scope: { projectId: "p", canvasId: "b" } });
        await harness.registry.prompt(a.sessionId, "queued on current provider");
        expect(harness.sessions[0]!.setModel).not.toHaveBeenCalled();
        expect(harness.registry.get(b.sessionId)?.session.model?.provider).toBe("shotshot-local");
        await harness.registry.abortProvider("openai-codex");
        expect(harness.sessions[0]!.abort).toHaveBeenCalledOnce();
        expect(harness.sessions[1]!.abort).not.toHaveBeenCalled();
        Object.assign(harness.sessions[0]!, { isStreaming: false });
        await harness.registry.prompt(a.sessionId, "next idle prompt");
        expect(harness.sessions[0]!.model?.id).toBe("byok-second");
    });
    it("updates image tools at an idle boundary without replacing an unwritten session", async () => {
        const onModelChanged = vi.fn();
        const harness = await createHarness({ resolveModel: config => nativeModel(config.model, config.model.includes("vision")), onModelChanged });
        await harness.registry.setModelConfig({ source: "chatgpt", model: "chatgpt-text" });
        const a = await harness.registry.createSession({ scope: { projectId: "p", canvasId: "a" } });
        const item = harness.registry.get(a.sessionId)!;
        const initialManager = item.sessionManager;
        await harness.registry.setModelConfig({ source: "chatgpt", model: "chatgpt-vision" });
        await expect(harness.registry.prompt(a.sessionId, "inspect an image")).resolves.toEqual({ ok: true });
        expect(item.sessionManager).toBe(initialManager);
        expect(onModelChanged).toHaveBeenCalledWith(item, expect.objectContaining({ input: ["text", "image"] }));
        expect(item.session.dispose).not.toHaveBeenCalled();
    });
    it("rechecks ChatGPT auth after asynchronous skill preparation", async () => {
        const skills = createDeferredSkillRuntime();
        let connected = true;
        const harness = await createHarness({ skillRuntime: skills.runtime, resolveModel: config => { if (!connected) throw new Error("chatgpt_auth_required"); return nativeModel(config.model); } });
        await harness.registry.setModelConfig({ source: "chatgpt", model: "chatgpt-first" });
        const a = await harness.registry.createSession({ scope: { projectId: "p", canvasId: "a" } });
        const request = harness.registry.prompt(a.sessionId, "pending");
        await skills.entered.promise; connected = false; skills.release.resolve();
        await expect(request).resolves.toMatchObject({ ok: false });
        expect(harness.sessions[0]!.prompt).not.toHaveBeenCalled();
    });
});
