// Offline runtime smoke test for the pinned @earendil-works/pi-coding-agent dependency.
//
// All model traffic goes through pi-ai's faux provider, which implements the
// `{ stream, streamSimple }` API-module contract and is the pattern pi uses in its
// own tests. Every directory is created with fs.mkdtemp under os.tmpdir, so this
// suite never reads the user's real ~/.pi or ~/.shotshot state.
import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
    AgentSessionRuntime,
    createAgentSession,
    createAgentSessionRuntime,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    type AgentSession,
    type AgentSessionEvent,
    type AgentSessionServices,
    type CompactionEntry,
    type CreateAgentSessionRuntimeFactory,
    type ExtensionFactory,
    type ModelChangeEntry,
    type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle, type FauxResponseStep } from "@earendil-works/pi-ai";

const COMPACTION_SUMMARY = "Offline compaction checkpoint.";

const scopeExtension: ExtensionFactory = (extension) => {
    extension.on("turn_end", () => {
        extension.appendEntry("shotshot.session-scope", { canvasId: "canvas-1", projectId: "project-1" });
    });
};

interface OfflineHarness {
    root: string;
    cwd: string;
    agentDir: string;
    sessionDir: string;
    faux: FauxProviderHandle;
    replies: string[];
    createSession(sessionManager: SessionManager, extensions?: ExtensionFactory[]): Promise<AgentSession>;
    createRuntimeFactory(): CreateAgentSessionRuntimeFactory;
}

async function createOfflineHarness(options: { tokensPerSecond?: number } = {}): Promise<OfflineHarness> {
    const root = await mkdtemp(join(tmpdir(), "shotshot-pi-sdk-smoke-"));
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const sessionDir = join(root, "sessions");
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }], tokensPerSecond: options.tokensPerSecond });
    const replies: string[] = [];
    // The faux queue is consumed per LLM call. Re-enqueue the single scripted step so
    // normal turns and compaction summarization both stay offline and deterministic.
    const respond: FauxResponseStep = (context) => {
        faux.appendResponses([respond]);
        if (context.systemPrompt?.includes("context summarization assistant")) {
            return fauxAssistantMessage(COMPACTION_SUMMARY);
        }
        return fauxAssistantMessage(replies.shift() ?? "offline fallback reply");
    };
    faux.setResponses([respond]);

    // Point every configurable path at the temp agentDir so the real ~/.pi is never read.
    const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
        refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.refresh({ allowNetwork: false });
    const settingsManager = SettingsManager.inMemory();

    const buildResourceLoader = (loaderCwd: string, loaderAgentDir: string, extensions: ExtensionFactory[]) =>
        new DefaultResourceLoader({
            cwd: loaderCwd,
            agentDir: loaderAgentDir,
            settingsManager,
            extensionFactories: extensions,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
        });

    const createSession = async (sessionManager: SessionManager, extensions: ExtensionFactory[] = []) => {
        const resourceLoader = buildResourceLoader(cwd, agentDir, extensions);
        await resourceLoader.reload();
        const { session } = await createAgentSession({
            cwd,
            agentDir,
            modelRuntime,
            settingsManager,
            resourceLoader,
            model: faux.getModel(),
            noTools: "all",
            customTools: [],
            sessionManager,
        });
        return session;
    };

    const createRuntimeFactory = (): CreateAgentSessionRuntimeFactory => async ({ cwd: sessionCwd, agentDir: sessionAgentDir, sessionManager }) => {
        const resourceLoader = buildResourceLoader(sessionCwd, sessionAgentDir, []);
        await resourceLoader.reload();
        const created = await createAgentSession({
            cwd: sessionCwd,
            agentDir: sessionAgentDir,
            modelRuntime,
            settingsManager,
            resourceLoader,
            model: faux.getModel(),
            noTools: "all",
            customTools: [],
            sessionManager,
        });
        const services: AgentSessionServices = { cwd: sessionCwd, agentDir: sessionAgentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
        return { ...created, services, diagnostics: [] };
    };

    return { root, cwd, agentDir, sessionDir, faux, replies, createSession, createRuntimeFactory };
}

function collectEvents(session: AgentSession): AgentSessionEvent[] {
    const events: AgentSessionEvent[] = [];
    session.subscribe((event) => {
        events.push(event);
    });
    return events;
}

function collapsedEventSequence(events: AgentSessionEvent[]): string[] {
    const types = events.map((event) => event.type);
    return types.filter((type, index) => index === 0 || type !== types[index - 1]);
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

describe("@earendil-works/pi-coding-agent runtime smoke", () => {
    it("exports the documented session SDK surface", async () => {
        const sdk = await import("@earendil-works/pi-coding-agent");

        expect(sdk.createAgentSession).toBeTypeOf("function");
        expect(sdk.AgentSession).toBeTypeOf("function");
        expect(sdk.AgentSessionRuntime).toBeTypeOf("function");
        expect(sdk.SessionManager).toBeTypeOf("function");
        expect(sdk.SessionManager.inMemory).toBeTypeOf("function");
        for (const method of ["newSession", "switchSession", "fork", "importFromJsonl"] as const) {
            expect(sdk.AgentSessionRuntime.prototype[method]).toBeTypeOf("function");
        }
    });

    it("runs an offline prompt turn with lifecycle events, custom entries, and model changes", async () => {
        const harness = await createOfflineHarness();
        const sessionManager = SessionManager.inMemory(harness.cwd);
        const session = await harness.createSession(sessionManager, [scopeExtension]);
        const events = collectEvents(session);

        expect(session.getActiveToolNames()).toEqual([]);
        harness.replies.push("Offline assistant reply");
        await session.prompt("What should I paint next?");

        expect(session.isIdle).toBe(true);
        expect(collapsedEventSequence(events)).toEqual([
            "agent_start",
            "turn_start",
            "message_start",
            "message_end",
            "message_start",
            "message_update",
            "message_end",
            "entry_appended",
            "turn_end",
            "agent_end",
            "agent_settled",
        ]);

        const messageStartRoles = events.filter((event) => event.type === "message_start").map((event) => event.message.role);
        expect(messageStartRoles).toEqual(["user", "assistant"]);
        expect(events.some((event) => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")).toBe(true);

        const agentEnd = events.find((event) => event.type === "agent_end");
        expect(agentEnd?.willRetry).toBe(false);
        const finalAssistant = agentEnd?.messages.at(-1);
        expect(finalAssistant?.role).toBe("assistant");
        if (!finalAssistant || finalAssistant.role !== "assistant") throw new Error("expected the run to end with an assistant message");
        expect(finalAssistant.stopReason).toBe("stop");
        const assistantContent = finalAssistant.content;
        expect(Array.isArray(assistantContent) && assistantContent.some((block) => block.type === "text" && block.text === "Offline assistant reply")).toBe(true);

        const appendedEntry = events.find((event) => event.type === "entry_appended")?.entry;
        expect(appendedEntry).toMatchObject({ type: "custom", customType: "shotshot.session-scope", data: { canvasId: "canvas-1", projectId: "project-1" } });

        const customEntryId = sessionManager.appendCustomEntry("shotshot.session-scope", { canvasId: "canvas-direct", projectId: "project-direct" });
        expect(sessionManager.getEntry(customEntryId)).toMatchObject({ id: customEntryId, type: "custom", customType: "shotshot.session-scope", data: { canvasId: "canvas-direct", projectId: "project-direct" } });
        expect(sessionManager.getEntries().some((entry) => entry.id === customEntryId)).toBe(true);

        const nextModel = harness.faux.getModel("faux-2");
        expect(nextModel).toBeDefined();
        await session.setModel(nextModel!);
        expect(session.model?.id).toBe("faux-2");
        const modelChangeIds = sessionManager.getEntries().filter((entry): entry is ModelChangeEntry => entry.type === "model_change").map((entry) => entry.modelId);
        expect(modelChangeIds).toEqual(["faux-1", "faux-2"]);

        session.dispose();
    });

    it("compacts and reloads a file-backed session without losing original entries", async () => {
        const harness = await createOfflineHarness();
        const sessionManager = SessionManager.create(harness.cwd, harness.sessionDir);
        const session = await harness.createSession(sessionManager);
        const events = collectEvents(session);

        harness.replies.push("First offline answer", "Second offline answer");
        await session.prompt("Summarize our first exchange");
        const messageEntriesAfterFirstTurn = sessionManager.getEntries().filter((entry): entry is SessionMessageEntry => entry.type === "message");
        expect(messageEntriesAfterFirstTurn.map((entry) => entry.message.role)).toEqual(["user", "assistant"]);
        const firstUserEntry = messageEntriesAfterFirstTurn[0];
        const firstAssistantEntry = messageEntriesAfterFirstTurn[1];

        // The oversized second turn exceeds the default keepRecentTokens window so a
        // manual compact has real history to summarize.
        await session.prompt("overflow ".repeat(15_000));
        const entriesBeforeCompaction = sessionManager.getEntries();
        const secondUserEntry = sessionManager.getEntries().filter((entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "user")[1];

        const result = await session.compact();

        expect(result.summary).toContain(COMPACTION_SUMMARY);
        expect(session.isCompacting).toBe(false);
        expect(events.filter((event) => event.type === "compaction_start" || event.type === "compaction_end").map((event) => event.type)).toEqual(["compaction_start", "compaction_end"]);
        const compactionEnd = events.find((event) => event.type === "compaction_end");
        expect(compactionEnd).toMatchObject({ reason: "manual", aborted: false, willRetry: false });
        expect(compactionEnd?.result?.summary).toContain(COMPACTION_SUMMARY);
        expect(compactionEnd?.result?.firstKeptEntryId).toBe(secondUserEntry?.id);

        const entriesAfterCompaction = sessionManager.getEntries();
        expect(entriesAfterCompaction).toHaveLength(entriesBeforeCompaction.length + 1);
        for (const entry of entriesBeforeCompaction) {
            expect(entriesAfterCompaction.some((candidate) => candidate.id === entry.id)).toBe(true);
        }
        const compactionEntry = entriesAfterCompaction.find((entry): entry is CompactionEntry => entry.type === "compaction");
        expect(compactionEntry?.summary).toContain(COMPACTION_SUMMARY);
        expect(compactionEntry?.firstKeptEntryId).toBe(secondUserEntry?.id);

        // Compaction-aware context hides the summarized prefix while the entry tree keeps it.
        const contextEntryIds = sessionManager.buildContextEntries().map((entry) => entry.id);
        expect(contextEntryIds).not.toContain(firstUserEntry?.id);
        expect(contextEntryIds).not.toContain(firstAssistantEntry?.id);
        expect(contextEntryIds).toContain(compactionEntry?.id);
        expect(contextEntryIds).toContain(secondUserEntry?.id);
        expect(sessionManager.buildSessionContext().messages[0]?.role).toBe("compactionSummary");

        // The append-only session stays a well-formed linear tree for this flow.
        expect(sessionManager.getTree()).toHaveLength(1);
        for (const [index, entry] of entriesAfterCompaction.entries()) {
            expect(entry.parentId).toBe(index === 0 ? null : entriesAfterCompaction[index - 1]?.id);
        }

        const sessionFile = sessionManager.getSessionFile();
        expect(sessionFile?.startsWith(harness.root)).toBe(true);
        const reopened = SessionManager.open(sessionFile!);
        expect(reopened.getSessionId()).toBe(sessionManager.getSessionId());
        expect(reopened.getEntries().map((entry) => entry.id)).toEqual(entriesAfterCompaction.map((entry) => entry.id));
        expect(reopened.buildSessionContext().messages.map((message) => message.role)).toEqual(sessionManager.buildSessionContext().messages.map((message) => message.role));

        const rawSession = await readFile(sessionFile!, "utf8");
        const [headerLine] = rawSession.split("\n");
        expect(JSON.parse(headerLine!)).toMatchObject({ type: "session", cwd: harness.cwd });
        expect(rawSession).toContain('"compaction"');

        session.dispose();
    });

    it("replaces sessions through the runtime without reusing the old reference", async () => {
        const harness = await createOfflineHarness();
        const runtime = await createAgentSessionRuntime(harness.createRuntimeFactory(), {
            cwd: harness.cwd,
            agentDir: harness.agentDir,
            sessionManager: SessionManager.create(harness.cwd, harness.sessionDir),
        });
        const original = runtime.session;
        const originalId = original.sessionId;
        const originalFile = original.sessionFile;
        expect(originalFile).toBeDefined();

        harness.replies.push("initial answer");
        await original.prompt("initial question");
        const originalEntryIds = original.sessionManager.getEntries().map((entry) => entry.id);
        const originalMessages = original.sessionManager.getEntries().filter((entry): entry is SessionMessageEntry => entry.type === "message");
        expect(originalMessages.map((entry) => entry.message.role)).toEqual(["user", "assistant"]);
        const firstUserEntry = originalMessages[0];

        const fork = await runtime.fork(firstUserEntry!.id);
        expect(fork.cancelled).toBe(false);
        expect(runtime.session).not.toBe(original);
        expect(runtime.session.sessionId).not.toBe(originalId);
        const forkEntryIds = runtime.session.sessionManager.getEntries().map((entry) => entry.id);
        expect(forkEntryIds.slice(0, 2)).toEqual(originalEntryIds.slice(0, 2));
        expect(forkEntryIds).not.toContain(firstUserEntry!.id);

        harness.replies.push("post-fork answer");
        await runtime.session.prompt("continue on the fork");
        const forkIdsAfterPrompt = runtime.session.sessionManager.getEntries().map((entry) => entry.id);
        expect(original.sessionManager.getEntries().map((entry) => entry.id)).toEqual(originalEntryIds);

        const forkSession = runtime.session;
        await runtime.newSession();
        expect(runtime.session).not.toBe(forkSession);
        expect(runtime.session.sessionId).not.toBe(forkSession.sessionId);
        harness.replies.push("post-new answer");
        await runtime.session.prompt("start fresh");
        expect(forkSession.sessionManager.getEntries().map((entry) => entry.id)).toEqual(forkIdsAfterPrompt);

        const switched = await runtime.switchSession(originalFile!);
        expect(switched.cancelled).toBe(false);
        expect(runtime.session.sessionId).toBe(originalId);
        expect(runtime.session.sessionManager.getEntries().map((entry) => entry.id)).toEqual(originalEntryIds);

        const importSource = join(harness.root, "import-source.jsonl");
        await copyFile(originalFile!, importSource);
        const imported = await runtime.importFromJsonl(importSource);
        expect(imported.cancelled).toBe(false);
        expect(runtime.session.sessionId).toBe(originalId);
        expect(runtime.session.sessionManager.getEntries().map((entry) => entry.id)).toEqual(originalEntryIds);

        await runtime.dispose();
    });

    it("exposes queue updates and aborts an in-flight offline turn", async () => {
        const harness = await createOfflineHarness({ tokensPerSecond: 20_000 });
        const session = await harness.createSession(SessionManager.inMemory(harness.cwd));
        const events = collectEvents(session);

        harness.replies.push("L".repeat(60_000), "follow-up answer");
        const promptPromise = session.prompt("start a slow turn");
        await waitFor(() => events.some((event) => event.type === "message_update"));
        expect(session.isStreaming).toBe(true);

        await session.prompt("queued while streaming", { streamingBehavior: "followUp" });
        const queueEvent = events.find((event) => event.type === "queue_update" && event.followUp.includes("queued while streaming"));
        expect(queueEvent).toMatchObject({ steering: [], followUp: ["queued while streaming"] });

        await session.abort();
        await promptPromise;
        expect(session.isIdle).toBe(true);
        expect(events.some((event) => event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "aborted")).toBe(true);

        session.dispose();
    });
});
