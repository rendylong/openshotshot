import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime, createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSessionEvent, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { buildCanvasTools } from "@/lib/agent/pi-agent-tools";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-op-types";
import { createSessionToolSelection } from "./pi-session-adapter";
import { createShotshotSessionExtension } from "./pi-canvas-context";
import { createShotshotWaitExtension, SMART_POLL_INTERVAL_MS, SMART_NOT_FOUND_GRACE_MS, WAIT_TOOL_SUMMARY, type WaitToolResult } from "./pi-agent-wait";
import type { GenerationStatusEntry } from "@/lib/agent/generation-status";
import type { WaitStatusProvider } from "./pi-agent-wait";

function makeEntry(nodeId: string, status: string, extra: Record<string, unknown> = {}): GenerationStatusEntry {
    if (status === "not_found") return { nodeId, status: "not_found" };
    return { nodeId, source: "remote_media", status, terminal: ["succeeded", "failed", "timed_out", "interrupted"].includes(status), updatedAt: new Date().toISOString(), ...extra } as GenerationStatusEntry;
}

function smartHarness(options: { queue: GenerationStatusEntry[][]; error?: string }) {
    const tools: ToolDefinition<any>[] = [];
    const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
    const ui = { setStatus: vi.fn(), setWidget: vi.fn() };
    const ctx = { hasUI: true, ui, sessionManager: { getSessionId: () => "test-session" } } as unknown as ExtensionContext;
    let cursor = 0;
    const waitStatus = vi.fn<WaitStatusProvider>(async (nodeIds) => {
        void nodeIds;
        if (options.error) return { ok: false, error: options.error };
        const entries = options.queue[Math.min(cursor, options.queue.length - 1)] ?? [];
        cursor += 1;
        return { ok: true, entries };
    });
    createShotshotWaitExtension({ waitStatus })({
        events: createEventBus(), sendMessage: vi.fn(),
        registerTool: (tool: ToolDefinition<any>) => tools.push(tool),
        on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    } as unknown as ExtensionAPI);
    const emit = async (name: string, event: Record<string, unknown> = {}) => {
        for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
    };
    return { tools, ctx, emit, waitStatus };
}

// Execute the installed package, mocking only the host event/context surface.
function extensionHarness() {
    const tools: ToolDefinition<any>[] = [];
    const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
    const sendMessage = vi.fn();
    const ui = { setStatus: vi.fn(), setWidget: vi.fn() };
    const ctx = { hasUI: true, ui, sessionManager: { getSessionId: () => "test-session" } } as unknown as ExtensionContext;
    createShotshotWaitExtension()({
        events: createEventBus(), sendMessage,
        registerTool: (tool: ToolDefinition<any>) => tools.push(tool),
        on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    } as unknown as ExtensionAPI);
    const emit = async (name: string, event: Record<string, unknown> = {}) => {
        for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
    };
    const run = (seconds = 30, signal?: AbortSignal) => tools[0]!.execute("wait-call", { seconds, reason: "generation" }, signal, undefined, ctx);
    return { tools, ctx, ui, sendMessage, emit, run };
}

afterEach(() => vi.useRealTimers());

describe("packaged blocking wait adapter", () => {
    it("exposes only wait, preserves bounds, defaults to block and rejects yield", async () => {
        vi.useFakeTimers();
        const h = extensionHarness();
        expect(h.tools.map((t) => t.name)).toEqual(["wait"]);
        expect(h.tools[0]!.parameters.properties.seconds).toMatchObject({ minimum: 1, maximum: 1800 });
        expect(h.tools[0]!.parameters.properties.mode).toMatchObject({ const: "block", default: "block" });
        await expect(h.tools[0]!.execute("bad", { seconds: 1, reason: "test", mode: "yield" }, undefined, undefined, h.ctx)).rejects.toThrow('only mode="block"');
        const pending = h.run(1);
        await vi.advanceTimersByTimeAsync(1000);
        await expect(pending).resolves.toMatchObject({ details: { mode: "block", outcome: "completed" } });
        expect(h.ui.setWidget).not.toHaveBeenCalled();
        expect(h.ui.setStatus).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(["abort", "input", "session_shutdown"])("cancels on %s with no detached wake or cross-session cancellation", async (kind) => {
        vi.useFakeTimers();
        const a = extensionHarness();
        const b = extensionHarness();
        const controller = new AbortController();
        const first = a.run(30, controller.signal);
        const second = b.run(30);
        if (kind === "abort") controller.abort();
        else await a.emit(kind, { source: "rpc" });
        await expect(first).resolves.toMatchObject({ details: { outcome: "cancelled" } });
        let secondDone = false;
        void second.then(() => { secondDone = true; });
        await vi.advanceTimersByTimeAsync(1000);
        expect(secondDone).toBe(false);
        await vi.advanceTimersByTimeAsync(60_000);
        await expect(second).resolves.toMatchObject({ details: { outcome: "completed" } });
        expect(a.sendMessage).not.toHaveBeenCalled();
        expect(b.sendMessage).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("shares the upstream budget across sibling calls and resets on a new run", async () => {
        vi.useFakeTimers();
        const h = extensionHarness();
        await h.emit("agent_start");
        const pending = [h.run(300), h.run(300), h.run(300)];
        await expect(h.run(1)).rejects.toThrow("budget");
        await vi.advanceTimersByTimeAsync(300_000);
        await Promise.all(pending);
        await expect(h.run(1)).rejects.toThrow("budget");
        await h.emit("agent_start");
        const next = h.run(1);
        await vi.advanceTimersByTimeAsync(1000);
        await expect(next).resolves.toMatchObject({ details: { outcome: "completed" } });
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("real pinned Pi SDK wait integration", () => {
    it("runs generation → wait → batch status with no inference while waiting and supports SDK abort", async () => {
        const root = await mkdtemp(join(tmpdir(), "shotshot-generation-wait-"));
        const faux = fauxProvider();
        const requests: Context[] = [];
        const ops: CanvasAgentOp[] = [];
        const events: AgentSessionEvent[] = [];
        const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), refreshOnCreate: false });
        modelRuntime.registerNativeProvider(faux.provider);
        await modelRuntime.refresh({ allowNetwork: false });
        const settingsManager = SettingsManager.inMemory();
        const getGenerationStatus = vi.fn(async () => ({ ok: true as const, tasks: [{ nodeId: generatedId(), source: "remote_media" as const, status: "succeeded" as const, updatedAt: new Date().toISOString() }] }));
        const generatedId = () => (ops.find((op) => op.type === "run_generation") as Extract<CanvasAgentOp, { type: "run_generation" }>).nodeId;
        const canvasTools = buildCanvasTools({
            getSnapshot: () => ({ projectId: "p", canvasId: "c", title: "Test", nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } }),
            emitOps: (batch) => { ops.push(...batch); }, getGenerationStatus,
        }).filter((tool) => ["canvas_generate_node", "generation_get_status"].includes(tool.name));
        const selection = createSessionToolSelection([...canvasTools, WAIT_TOOL_SUMMARY], false);
        const resourceLoader = new DefaultResourceLoader({
            cwd: root, agentDir: root, settingsManager,
            extensionFactories: [createShotshotSessionExtension({ sessionId: "fixture", send: () => {}, getSystemPrompt: () => selection.activeTools.map((t) => `${t.name}: ${t.promptSnippet}`).join("\n") }), createShotshotWaitExtension()],
            noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        });
        await resourceLoader.reload();
        const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root), tools: selection.registeredNames, customTools: canvasTools });
        await session.bindExtensions({ mode: "rpc", onError: (error) => { throw error; } });
        session.setActiveToolsByName(selection.activeNames);
        session.subscribe((event) => events.push(event));
        const step = (name?: string, args?: () => Record<string, unknown>) => (ctx: Context) => {
            requests.push({ ...ctx, messages: structuredClone(ctx.messages) });
            return name ? fauxAssistantMessage(fauxToolCall(name, args!()), { stopReason: "toolUse" }) : fauxAssistantMessage("done");
        };
        try {
            expect(session.getActiveToolNames()).toContain("wait");
            expect(session.getActiveToolNames()).not.toContain("wait_for_background_task");
            faux.setResponses([
                step("canvas_generate_node", () => ({ prompt: "test image" })),
                step("wait", () => ({ seconds: 1, reason: "generation" })),
                step("generation_get_status", () => ({ nodeIds: [generatedId(), "other-node"] })), step(),
            ]);
            const pending = session.prompt("Generate and check the result");
            await vi.waitFor(() => expect(events.some((e) => e.type === "tool_execution_update" && e.toolName === "wait"), JSON.stringify(events.filter((e) => e.type === "tool_execution_end" || e.type === "agent_end"))).toBe(true));
            expect(requests).toHaveLength(2);
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(requests).toHaveLength(2);
            expect(getGenerationStatus).not.toHaveBeenCalled();
            await pending;
            expect(requests).toHaveLength(4);
            expect(getGenerationStatus).toHaveBeenCalledWith({ nodeIds: [generatedId(), "other-node"], limit: 20 });
            expect(events.some((e) => e.type === "tool_execution_end" && e.toolName === "wait" && !e.isError)).toBe(true);
            for (const request of requests) {
                expect(request.tools?.some((tool) => tool.name === "wait")).toBe(true);
                expect(request.systemPrompt).toContain("generation_get_status");
                expect(request.systemPrompt).toContain("30");
            }

            events.length = 0;
            faux.setResponses([step("wait", () => ({ seconds: 30, reason: "abort check", mode: "block" })), step()]);
            const abortPending = session.prompt("wait");
            await vi.waitFor(() => expect(events.some((e) => e.type === "tool_execution_update")).toBe(true));
            const beforeAbort = requests.length;
            await session.abort();
            await abortPending;
            expect(requests).toHaveLength(beforeAbort);
            expect(session.isStreaming).toBe(false);

            for (const args of [{ seconds: 0, reason: "invalid" }, { seconds: 301, reason: "invalid" }, { seconds: 1, reason: "invalid", mode: "yield" }]) {
                events.length = 0;
                faux.setResponses([step("wait", () => args), step()]);
                await session.prompt("invalid wait");
                expect(events.some((e) => e.type === "tool_execution_end" && e.isError)).toBe(true);
            }

            events.length = 0;
            faux.setResponses([step("wait", () => ({ seconds: 30, reason: "user input" })), step(), step()]);
            const interrupted = session.prompt("wait for generation");
            await vi.waitFor(() => expect(events.some((e) => e.type === "tool_execution_update")).toBe(true));
            await session.prompt("continue now", { streamingBehavior: "followUp" });
            await interrupted;
            const cancelled = events.find((e) => e.type === "tool_execution_end" && e.toolName === "wait");
            expect(cancelled).toMatchObject({ result: { details: { outcome: "cancelled" } } });

            events.length = 0;
            faux.setResponses([step("wait", () => ({ seconds: 30, reason: "session teardown" })), step()]);
            const closing = session.prompt("wait until session closes");
            await vi.waitFor(() => expect(events.some((e) => e.type === "tool_execution_update")).toBe(true));
            const beforeClose = requests.length;
            const runtime = new AgentSessionRuntime(session, { cwd: root, agentDir: root, modelRuntime, settingsManager, resourceLoader, diagnostics: [] }, async () => { throw new Error("No replacement in this test"); });
            await runtime.dispose();
            await closing;
            expect(requests).toHaveLength(beforeClose);
        } finally {
            await session.abort();
            session.dispose();
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe("smart wait schema and validation", () => {
    it("exposes nodeIds schema, seconds cap 1800 and overridden description", () => {
        const h = smartHarness({ queue: [[makeEntry("n1", "succeeded")]] });
        const params = h.tools[0]!.parameters.properties;
        expect(params.seconds).toMatchObject({ minimum: 1, maximum: 1800 });
        expect(String(params.seconds.description)).toContain("1800");
        expect(params.nodeIds).toMatchObject({ minItems: 1, maxItems: 20 });
        expect(String(h.tools[0]!.description)).toContain("nodeIds");
    });

    it.each([
        [{ seconds: 301, reason: "too long blind" }, /1-300/],
        [{ seconds: 0, reason: "too short" }, /1-300/],
    ])("rejects blind wait %s", async (args, pattern) => {
        const h = smartHarness({ queue: [[makeEntry("n1", "succeeded")]] });
        await expect(h.tools[0]!.execute("x", args, undefined, undefined, h.ctx)).rejects.toThrow(pattern);
    });

    it("rejects smart wait when no status provider is wired", async () => {
        const h = extensionHarness();
        await expect(h.tools[0]!.execute("x", { seconds: 30, reason: "g", nodeIds: ["n1"] }, undefined, undefined, h.ctx)).rejects.toThrow(/不支持/);
    });
});

describe("smart wait state machine", () => {
    it("returns completed immediately when all nodes are already terminal at t=0", async () => {
        vi.useFakeTimers();
        const h = smartHarness({ queue: [[makeEntry("a", "succeeded"), makeEntry("b", "timed_out")]] });
        const pending = h.tools[0]!.execute("x", { seconds: 60, reason: "g", nodeIds: ["a", "b"] }, undefined, undefined, h.ctx);
        await expect(pending).resolves.toMatchObject({ details: { outcome: "completed" } });
        expect(h.waitStatus).toHaveBeenCalledTimes(1);
    });

    it("keeps polling until staggered completions, emitting onUpdate per tick", async () => {
        vi.useFakeTimers();
        const h = smartHarness({ queue: [
            [makeEntry("a", "pending"), makeEntry("b", "pending")],
            [makeEntry("a", "succeeded"), makeEntry("b", "pending")],
            [makeEntry("a", "succeeded"), makeEntry("b", "succeeded")],
        ] });
        const onUpdate = vi.fn();
        const pending = h.tools[0]!.execute("x", { seconds: 60, reason: "g", nodeIds: ["a", "b"] }, undefined, onUpdate, h.ctx);
        await vi.advanceTimersByTimeAsync(SMART_POLL_INTERVAL_MS);
        await vi.advanceTimersByTimeAsync(SMART_POLL_INTERVAL_MS);
        await expect(pending).resolves.toMatchObject({ details: { outcome: "completed" } });
        expect(onUpdate.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(JSON.stringify(onUpdate.mock.calls[0]![0])).toContain("smart");
    });

    it("returns failed early when any node fails, attaching remaining entries", async () => {
        vi.useFakeTimers();
        const h = smartHarness({ queue: [
            [makeEntry("a", "pending"), makeEntry("b", "pending")],
            [makeEntry("a", "succeeded"), makeEntry("b", "failed", { error: "upstream_failed" })],
        ] });
        const pending = h.tools[0]!.execute("x", { seconds: 120, reason: "g", nodeIds: ["a", "b"] }, undefined, undefined, h.ctx);
        await vi.advanceTimersByTimeAsync(SMART_POLL_INTERVAL_MS);
        const result = await pending;
        expect(result.details).toMatchObject({ outcome: "failed", trigger: { nodeId: "b", error: "upstream_failed" } });
        const text = String((result as WaitToolResult).content[0]!.text);
        expect(text).toContain("剩余节点");
        expect(text).toContain('"tasks"');
    });

    it("exits not_found after 30s when unresolved ids stay not_found (mixed case included)", async () => {
        vi.useFakeTimers();
        const h = smartHarness({ queue: [[makeEntry("a", "succeeded"), makeEntry("ghost", "not_found")]] });
        const pending = h.tools[0]!.execute("x", { seconds: 300, reason: "g", nodeIds: ["a", "ghost"] }, undefined, undefined, h.ctx);
        const assertion = expect(pending).resolves.toMatchObject({ details: { outcome: "not_found" } });
        await vi.advanceTimersByTimeAsync(SMART_NOT_FOUND_GRACE_MS + SMART_POLL_INTERVAL_MS);
        await assertion;
    });

    it("treats timed_out as terminal but keeps waiting for the rest until the cap", async () => {
        vi.useFakeTimers();
        const h = smartHarness({ queue: [[makeEntry("a", "timed_out"), makeEntry("b", "pending")]] });
        const pending = h.tools[0]!.execute("x", { seconds: 11, reason: "g", nodeIds: ["a", "b"] }, undefined, undefined, h.ctx);
        const assertion = expect(pending).resolves.toMatchObject({ details: { outcome: "timeout" } });
        await vi.advanceTimersByTimeAsync(11_000);
        await assertion;
        expect(h.waitStatus.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("cancels without throwing on abort while sleeping", async () => {
        vi.useFakeTimers();
        const h = smartHarness({ queue: [[makeEntry("a", "pending")]] });
        const controller = new AbortController();
        const pending = h.tools[0]!.execute("x", { seconds: 60, reason: "g", nodeIds: ["a"] }, controller.signal, undefined, h.ctx);
        await vi.advanceTimersByTimeAsync(1);
        controller.abort();
        await expect(pending).resolves.toMatchObject({ details: { outcome: "cancelled" } });
    });

    it("enforces the 3600s run budget and resets it on agent_start", async () => {
        vi.useFakeTimers();
        const h = smartHarness({ queue: [[makeEntry("a", "pending")]] });
        const first = h.tools[0]!.execute("x", { seconds: 1800, reason: "g", nodeIds: ["a"] }, undefined, undefined, h.ctx);
        await vi.advanceTimersByTimeAsync(1_800_000);
        await expect(first).resolves.toMatchObject({ details: { outcome: "timeout" } });
        const second = h.tools[0]!.execute("y", { seconds: 1800, reason: "g", nodeIds: ["a"] }, undefined, undefined, h.ctx);
        await vi.advanceTimersByTimeAsync(1_800_000);
        await expect(second).resolves.toMatchObject({ details: { outcome: "timeout" } });
        await expect(h.tools[0]!.execute("z", { seconds: 1, reason: "g", nodeIds: ["a"] }, undefined, undefined, h.ctx)).rejects.toThrow(/预算/);
        await h.emit("agent_start");
        const fourth = h.tools[0]!.execute("w", { seconds: 1, reason: "g", nodeIds: ["a"] }, undefined, undefined, h.ctx);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(fourth).resolves.toMatchObject({ details: { outcome: "timeout" } });
    });

    it("surfaces provider errors explicitly", async () => {
        vi.useFakeTimers();
        const h = smartHarness({ queue: [], error: "状态源不可用" });
        await expect(h.tools[0]!.execute("x", { seconds: 30, reason: "g", nodeIds: ["a"] }, undefined, undefined, h.ctx)).rejects.toThrow(/状态源不可用/);
    });

    it("treats an alias-covered source id as returned instead of synthesizing not_found", async () => {
        vi.useFakeTimers();
        const h = smartHarness({ queue: [[{ nodeId: "derived", sourceNodeId: "source-a", source: "remote_media", status: "succeeded", terminal: true, updatedAt: new Date().toISOString() }]] });
        const pending = h.tools[0]!.execute("x", { seconds: 60, reason: "g", nodeIds: ["source-a"] }, undefined, undefined, h.ctx);
        await expect(pending).resolves.toMatchObject({ details: { outcome: "completed" } });
        expect(h.waitStatus).toHaveBeenCalledTimes(1);
    });

    it("synthesizes not_found only for ids absent from entries and alias coverage", async () => {
        vi.useFakeTimers();
        const h = smartHarness({ queue: [[makeEntry("a", "succeeded")]] });
        const pending = h.tools[0]!.execute("x", { seconds: 300, reason: "g", nodeIds: ["a", "ghost"] }, undefined, undefined, h.ctx);
        const assertion = expect(pending).resolves.toMatchObject({ details: { outcome: "not_found" } });
        await vi.advanceTimersByTimeAsync(SMART_NOT_FOUND_GRACE_MS + SMART_POLL_INTERVAL_MS);
        await assertion;
    });
});
