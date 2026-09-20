import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager, type ModelRuntime as ModelRuntimeType } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { buildCanvasTools } from "@/lib/agent/pi-agent-tools";
import { resolveAgentModel } from "./agent-model-config";
import { createSessionRuntimeRegistry, createSessionToolSelection, createShotshotSessionExtension } from "./pi-session-adapter";
import type { SkillRuntime } from "./skill-runtime";

const FIXTURE_IMAGE_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

it("delivers refreshed host instructions to the provider after session restore and tool continuation", async () => {
    const root = await mkdtemp(join(tmpdir(), "shotshot-prompt-delivery-"));
    const faux = fauxProvider();
    const requests: Context[] = [];
    const capture = (context: Context) => requests.push({ ...context, messages: structuredClone(context.messages) });
    const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.refresh({ allowNetwork: false });
    const settingsManager = SettingsManager.inMemory();
    let skillSummary = "CURRENT_SKILL_REVISION_ONE";
    const registry = createSessionRuntimeRegistry({
        sessionDir: root,
        getWindow: () => null,
        resolveModel: () => faux.getModel(),
        skillRuntime: { agentSnapshot: async () => ({ ok: true, revision: 1, systemPromptBlock: skillSummary, availableSkillNames: [] }) } as unknown as SkillRuntime,
        createRuntime: async ({ cwd, agentDir, sessionManager, runtimeState }) => {
            const tools = buildCanvasTools({
                getSnapshot: () => ({ projectId: "p", canvasId: "c", title: "Canvas", nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } }),
                emitOps: () => undefined,
                readCanvasImage: async ({ nodeId }) => ({ ok: true, image: { nodeId, title: "Fixture", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", mimeType: "image/png", width: 1, height: 1, sizeBytes: 68 } }),
            }).filter((tool) => tool.name === "view_image");
            runtimeState.tools = tools;
            const extensionOptions = {
                sessionId: () => runtimeState.sessionId,
                send: () => undefined,
                getSystemPrompt: () => runtimeState.systemPrompt,
            };
            const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [createShotshotSessionExtension(extensionOptions)], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
            await resourceLoader.reload();
            const created = await createAgentSession({ cwd, agentDir, modelRuntime, settingsManager, resourceLoader, model: faux.getModel(), sessionManager, tools: ["view_image"], customTools: tools });
            return { ...created, services: { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] }, diagnostics: [] };
        },
    });
    try {
        await registry.setModelConfig({ source: "byok", model: "faux-1", baseUrl: "http://localhost:0", apiKey: "unused", apiFormat: "openai", agentApiMode: "responses", supportsImageInput: true });
        const { sessionId } = await registry.createSession({ scope: { projectId: "p", canvasId: "c" } });
        faux.setResponses([fauxAssistantMessage("blob URL 无法读取，请导出后给我。")]);
        await registry.prompt(sessionId, "读图");
        await registry.closeSession(sessionId);
        await registry.openSession(sessionId);
        faux.setResponses([
            (context) => { capture(context); return fauxAssistantMessage(fauxToolCall("view_image", { nodeId: "fixture" }), { stopReason: "toolUse" }); },
            (context) => { capture(context); return fauxAssistantMessage("pixels received"); },
            (context) => { capture(context); return fauxAssistantMessage("next turn"); },
        ]);
        await expect(registry.prompt(sessionId, "读一下画布上的图片")).resolves.toEqual({ ok: true });
        skillSummary = "CURRENT_SKILL_REVISION_TWO";
        await registry.prompt(sessionId, "继续");
        expect(requests).toHaveLength(3);
        for (const request of requests) {
            expect(request.systemPrompt).toContain("当前运行时能力高于对话历史中的旧结论");
            expect(request.tools?.map((tool) => tool.name)).toContain("view_image");
        }
        expect(requests[0].systemPrompt).toContain("CURRENT_SKILL_REVISION_ONE");
        expect(requests[1].systemPrompt).toContain("CURRENT_SKILL_REVISION_ONE");
        expect(requests[2].systemPrompt).toContain("CURRENT_SKILL_REVISION_TWO");
        expect(requests[2].systemPrompt).not.toContain("CURRENT_SKILL_REVISION_ONE");
        expect(requests[0].messages.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes("blob URL 无法读取"))).toBe(true);
        expect(requests[1].messages.some((message) => message.role === "toolResult" && message.content.some((block) => block.type === "image"))).toBe(true);
    } finally {
        await registry.dispose();
        await rm(root, { recursive: true, force: true });
    }
});

it("delivers view_image and the typed image block for a multimodal BYOK model without leaking image bytes into diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "shotshot-byok-delivery-"));
    // faux 只充当传输层；能力身份（input 数组）来自真实 BYOK 解析链路。
    const requests: Context[] = [];
    const capture = (context: Context) => requests.push({ ...context, messages: structuredClone(context.messages) });
    const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), refreshOnCreate: false });
    const settingsManager = SettingsManager.inMemory();
    const stubRuntime = { getModel: () => undefined, registerNativeProvider: () => undefined } as unknown as ModelRuntimeType;
    const byokConfig = { source: "byok" as const, model: "minimax-m3", baseUrl: "https://gateway.example", apiKey: "main-process-secret", apiFormat: "openai" as const, agentApiMode: "chat_completions" as const, supportsImageInput: true };
    const byokModel = await resolveAgentModel(byokConfig, stubRuntime);
    const faux = fauxProvider({ provider: byokModel.provider });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.refresh({ allowNetwork: false });
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registry = createSessionRuntimeRegistry({
        sessionDir: root,
        getWindow: () => null,
        resolveModel: async (config) => {
            const resolved = await resolveAgentModel(config, stubRuntime);
            return { ...resolved, api: faux.getModel()!.api };
        },
        skillRuntime: { agentSnapshot: async () => ({ ok: true, revision: 1, systemPromptBlock: "", availableSkillNames: [] }) } as unknown as SkillRuntime,
        createRuntime: async ({ cwd, agentDir, sessionManager, model, runtimeState }) => {
            if (!model) throw new Error("模型未配置：请先调用 setModelConfig");
            const tools = buildCanvasTools({
                getSnapshot: () => ({ projectId: "p", canvasId: "c", title: "Canvas", nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } }),
                emitOps: () => undefined,
                readCanvasImage: async ({ nodeId }) => ({ ok: true, image: { nodeId, title: "Fixture", dataUrl: FIXTURE_IMAGE_DATA_URL, mimeType: "image/png", width: 1, height: 1, sizeBytes: 68 } }),
            }).filter((tool) => tool.name === "view_image");
            const allTools = tools.map((tool) => ({ name: tool.name, label: tool.label }));
            const toolSelection = createSessionToolSelection(allTools, model.input.includes("image"), model.provider);
            runtimeState.tools = toolSelection.activeTools;
            const extensionOptions = {
                sessionId: () => runtimeState.sessionId,
                send: () => undefined,
                getSystemPrompt: () => runtimeState.systemPrompt,
            };
            const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [createShotshotSessionExtension(extensionOptions)], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
            await resourceLoader.reload();
            const created = await createAgentSession({ cwd, agentDir, modelRuntime, settingsManager, resourceLoader, model, sessionManager, tools: toolSelection.registeredNames, customTools: tools });
            created.session.setActiveToolsByName(toolSelection.activeNames);
            return { ...created, services: { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] }, diagnostics: [] };
        },
    });
    try {
        await registry.setModelConfig({ source: "byok", model: "minimax-m3", baseUrl: "https://gateway.example", apiKey: "main-process-secret", apiFormat: "openai", agentApiMode: "chat_completions", supportsImageInput: true });
        const { sessionId } = await registry.createSession({ scope: { projectId: "p", canvasId: "c" } });
        faux.setResponses([
            (context) => { capture(context); return fauxAssistantMessage(fauxToolCall("view_image", { nodeId: "fixture" }), { stopReason: "toolUse" }); },
            (context) => { capture(context); return fauxAssistantMessage("pixels received"); },
        ]);
        await expect(registry.prompt(sessionId, "读一下画布上的图片")).resolves.toEqual({ ok: true });

        expect(requests[0].tools?.map((tool) => tool.name)).toContain("view_image");
        expect(requests[1].messages.some((message) => message.role === "toolResult" && message.content.some((block) => block.type === "image"))).toBe(true);

        // 诊断日志与会话 details 不携带 data URL / base64：图片字节只出现在给模型的类型化 image block。
        for (const call of logSpy.mock.calls) {
            expect(String(call[0])).not.toMatch(/data:image|base64/);
        }
        const sessionFiles = (await readdir(root)).filter((name) => name.endsWith(".jsonl"));
        expect(sessionFiles.length).toBeGreaterThan(0);
        for (const name of sessionFiles) {
            const raw = await readFile(join(root, name), "utf8");
            expect(raw).not.toMatch(/data:image/);
            for (const line of raw.split("\n").filter(Boolean)) {
                const entry = JSON.parse(line) as { message?: { details?: unknown } };
                if (entry.message?.details !== undefined) {
                    expect(JSON.stringify(entry.message.details)).not.toMatch(/base64|data:image/);
                }
            }
        }
    } finally {
        logSpy.mockRestore();
        await registry.dispose();
        await rm(root, { recursive: true, force: true });
    }
});
