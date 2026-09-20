import { mkdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CURRENT_SESSION_VERSION, SessionManager, type AgentSession, type CreateAgentSessionRuntimeResult } from "@earendil-works/pi-coding-agent";
import type { BrowserWindow } from "electron";

import type { PiSessionSummary } from "@/lib/agent/pi-agent-types";
import { createSessionRuntimeRegistry, type PiSessionRuntimeFactory } from "./pi-session-adapter";
import type { SkillRuntime } from "./skill-runtime";
import { createPiSessionStore, SESSION_WORKSPACE_CUSTOM_TYPE, validateSessionFile } from "./pi-session-store";

const tempRoots: string[] = [];

async function createTempRoot(name: string) {
    const root = await mkdtemp(join(tmpdir(), `shotshot-${name}-`));
    tempRoots.push(root);
    return root;
}

function createFakeRuntimeFactory(): PiSessionRuntimeFactory {
    return async ({ sessionManager }) => {
        const session: AgentSession = {
            sessionId: sessionManager.getSessionId(),
            sessionName: sessionManager.getSessionName(),
            sessionFile: sessionManager.getSessionFile(),
            sessionManager,
            agent: { state: { systemPrompt: "" } },
            isStreaming: false,
            isIdle: true,
            isCompacting: false,
            extensionRunner: { hasHandlers: () => false },
            subscribe: vi.fn(() => () => undefined),
            prompt: vi.fn(async () => undefined),
            waitForIdle: async () => undefined,
            abort: vi.fn(async () => undefined),
            compact: vi.fn(async () => ({ summary: "summary" })),
            setModel: vi.fn(async () => undefined),
            dispose: vi.fn(),
        } as unknown as AgentSession;
        return {
            session,
            extensionsResult: { extensions: [], errors: [], runtime: {} },
            services: { cwd: "", agentDir: "", modelRuntime: {}, settingsManager: {}, resourceLoader: {}, diagnostics: [] },
            diagnostics: [],
        } as unknown as CreateAgentSessionRuntimeResult;
    };
}

describe("Pi JSONL session store", () => {
    afterEach(async () => {
        await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it("writes one idempotent scope entry and restores all entries after reload", async () => {
        const root = await createTempRoot("session-store-scope");
        const store = createPiSessionStore({ sessionDir: root });
        const scope = { projectId: "project-1", canvasId: "canvas-1" };

        const created = store.createSessionManager({ scope, title: "Concept art" });
        const sessionId = created.getSessionId();
        expect(created.getSessionFile()).toMatch(new RegExp(`_${sessionId}\\.jsonl$`));
        expect(store.ensureScopeEntry(created, scope)).toBe(false);
        expect(created.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "shotshot.session-scope")).toHaveLength(1);
        expect(created.getSessionName()).toBe("Concept art");

        created.appendMessage({ role: "user", content: "draw a lamp", timestamp: Date.now() });
        created.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "lamp sketch added" }],
            api: "shotshot-test",
            provider: "shotshot-test",
            model: "test",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: Date.now(),
        });
        const entryIds = created.getEntries().map((entry) => entry.id);

        const reopened = store.openSessionManager(sessionId);
        expect(reopened.getSessionId()).toBe(sessionId);
        expect(reopened.getEntries().map((entry) => entry.id)).toEqual(entryIds);
        expect(store.ensureScopeEntry(reopened, scope)).toBe(false);
        expect(reopened.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "shotshot.session-scope")).toHaveLength(1);
    });

    it("lists persisted summaries by scope and keeps live update times authoritative in the adapter result contract", async () => {
        const root = await createTempRoot("session-store-list");
        const store = createPiSessionStore({ sessionDir: root });
        const first = store.createSessionManager({ scope: { projectId: "p", canvasId: "a" }, title: "Canvas A" });
        const second = store.createSessionManager({ scope: { projectId: "p", canvasId: "b" }, title: "Canvas B" });

        const all = store.listSessionSummaries();
        expect(all.sessions.map((summary) => summary.sessionId).sort()).toEqual([first.getSessionId(), second.getSessionId()].sort());
        expect(all.unreadable).toEqual([]);
        expect(all.sessions.map((summary) => [summary.scope.projectId, summary.scope.canvasId, summary.title]).sort()).toEqual([
            ["p", "a", "Canvas A"],
            ["p", "b", "Canvas B"],
        ]);
        expect(all.sessions.every((summary) => summary.status === "idle")).toBe(true);

        const scoped = store.listSessionSummaries({ projectId: "p", canvasId: "b" });
        expect(scoped.sessions.map((summary) => summary.sessionId)).toEqual([second.getSessionId()]);
    });

    it("reports a corrupt JSONL file without reading through SessionManager or changing its bytes", async () => {
        const root = await createTempRoot("session-store-corrupt");
        const store = createPiSessionStore({ sessionDir: root });
        const valid = store.createSessionManager({ scope: { projectId: "p", canvasId: "a" }, title: "Valid" });
        const corruptPath = join(root, "20260101T000000-00000000-0000-7000-8000-000000000000_corrupt.jsonl");
        const corruptBytes = Buffer.from('{type:"session"}\nnot-json\n', "utf8");
        await writeFile(corruptPath, corruptBytes);

        const before = await readFile(corruptPath);
        const validation = validateSessionFile(corruptPath);
        expect(validation).toMatchObject({ ok: false });
        if (validation.ok) throw new Error("expected corrupt file validation to fail");
        expect(validation.error).toContain(corruptPath);
        expect(await readFile(corruptPath)).toEqual(before);
        expect([...validation.bytes]).toEqual([...corruptBytes]);

        const listed = store.listSessionSummaries();
        expect(listed.sessions.map((summary) => summary.sessionId)).toEqual([valid.getSessionId()]);
        expect(listed.unreadable).toHaveLength(1);
        expect(listed.unreadable[0]).toMatchObject({ file: corruptPath });
        expect(listed.unreadable[0]?.error).toContain("not valid JSON");
        expect(await readFile(corruptPath)).toEqual(before);
        await expect(() => store.openSessionManager("00000000-0000-7000-8000-000000000000")).toThrow(/not a valid shotshot session file/i);
        expect(await readFile(corruptPath)).toEqual(before);
    });

    it("restores a registry session from JSONL after a registry restart", async () => {
        const root = await createTempRoot("session-store-registry-restart");
        const scope = { projectId: "project-1", canvasId: "canvas-1" };
        const skillRuntime = { agentSnapshot: async () => ({ ok: true, revision: 1, systemPromptBlock: "", availableSkillNames: [] }), readForAgent: async () => "" } as unknown as SkillRuntime;
        const createRegistry = () => createSessionRuntimeRegistry({
            sessionDir: root,
            createRuntime: createFakeRuntimeFactory(),
            getWindow: () => null as unknown as BrowserWindow,
            skillRuntime,
        });

        const first = createRegistry();
        const created = await first.createSession({ scope, title: "Restarted chat" });
        const item = first.get(created.sessionId)!;
        item.sessionManager.appendMessage({ role: "user", content: "persist me", timestamp: Date.now() });
        const entryIds = item.sessionManager.getEntries().map((entry) => entry.id);
        await first.dispose();

        const second = createRegistry();
        const opened = await second.openSession(created.sessionId);
        expect(opened.summary).toMatchObject({ sessionId: created.sessionId, title: "Restarted chat", scope });
        expect(opened.entries.map((entry) => entry.id)).toEqual(entryIds);
        expect(opened.entries.at(-1)).toMatchObject({ role: "user", text: "persist me" });
        expect(second.listSessions()).toEqual({ sessions: [opened.summary], unreadable: [] });
        await second.dispose();
    });

    it("rejects a structurally valid future session version without opening it", async () => {
        const root = await createTempRoot("session-store-future-version");
        const store = createPiSessionStore({ sessionDir: root });
        const valid = store.createSessionManager({ scope: { projectId: "p", canvasId: "a" }, title: "Valid" });
        const sessionId = "future0000000";
        const path = join(root, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
        const bytes = Buffer.from(`${JSON.stringify({
            type: "session",
            version: CURRENT_SESSION_VERSION + 1,
            id: sessionId,
            timestamp: "2026-01-01T00:00:00.000Z",
            cwd: root,
        })}\n`, "utf8");
        await writeFile(path, bytes);
        const openSpy = vi.spyOn(SessionManager, "open");

        const validation = validateSessionFile(path);
        expect(validation).toMatchObject({ ok: false });
        if (validation.ok) throw new Error("expected future version to be unreadable");
        expect(validation.error).toContain("unsupported session version");
        expect([...validation.bytes]).toEqual([...bytes]);

        const listed = store.listSessionSummaries();
        expect(listed.sessions.map((summary) => summary.sessionId)).toEqual([valid.getSessionId()]);
        expect(listed.unreadable).toHaveLength(1);
        expect(listed.unreadable[0]?.error).toContain("unsupported session version");
        expect(() => store.openSessionManager(sessionId)).toThrow("unsupported session version");
        expect(openSpy).not.toHaveBeenCalled();
        expect(await readFile(path)).toEqual(bytes);
        openSpy.mockRestore();
    });

    it("rejects a known header with an unknown entry type without opening it", async () => {
        const root = await createTempRoot("session-store-unknown-entry");
        const store = createPiSessionStore({ sessionDir: root });
        const sessionId = "unknown0000000";
        const path = join(root, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
        const bytes = Buffer.from([
            JSON.stringify({
                type: "session",
                version: CURRENT_SESSION_VERSION,
                id: sessionId,
                timestamp: "2026-01-01T00:00:00.000Z",
                cwd: root,
            }),
            JSON.stringify({
                type: "future_entry",
                id: "entry0000",
                parentId: null,
                timestamp: "2026-01-01T00:00:01.000Z",
            }),
        ].map((line) => `${line}\n`).join(""), "utf8");
        await writeFile(path, bytes);
        const openSpy = vi.spyOn(SessionManager, "open");

        const validation = validateSessionFile(path);
        expect(validation).toMatchObject({ ok: false });
        if (validation.ok) throw new Error("expected unknown entry type to be unreadable");
        expect(validation.error).toContain("unknown entry type \"future_entry\"");
        expect([...validation.bytes]).toEqual([...bytes]);

        const listed = store.listSessionSummaries();
        expect(listed.sessions).toEqual([]);
        expect(listed.unreadable).toHaveLength(1);
        expect(listed.unreadable[0]?.error).toContain("unknown entry type \"future_entry\"");
        expect(() => store.openSessionManager(sessionId)).toThrow("unknown entry type");
        expect(openSpy).not.toHaveBeenCalled();
        expect(await readFile(path)).toEqual(bytes);
        openSpy.mockRestore();
    });

    it("uses the SDK file layout and exposes only summary metadata to list callers", async () => {
        const root = await createTempRoot("session-store-layout");
        const store = createPiSessionStore({ sessionDir: root });
        const manager = store.createSessionManager({ scope: { projectId: "p", canvasId: "a" }, title: "Layout" });

        const files = await readdir(root);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(new RegExp(`_${manager.getSessionId()}\\.jsonl$`));

        const summary: PiSessionSummary | undefined = store.listSessionSummaries().sessions[0];
        expect(summary).toMatchObject({
            sessionId: manager.getSessionId(),
            title: "Layout",
            scope: { projectId: "p", canvasId: "a" },
        });
    });

    it("appends a workspace entry at creation and reads it back", async () => {
        const root = await createTempRoot("session-store-workspace");
        const store = createPiSessionStore({ sessionDir: root });
        const workspace = join(root, "ws");
        mkdirSync(workspace, { recursive: true });
        const manager = store.createSessionManager({
            scope: { projectId: "p", canvasId: "c" },
            workspacePath: workspace,
        });
        expect(store.readSessionWorkspace(manager)).toBe(workspace);
    });

    it("treats sessions without a workspace entry as workspace-less", async () => {
        const root = await createTempRoot("session-store-workspace-less");
        const store = createPiSessionStore({ sessionDir: root });
        const manager = store.createSessionManager({ scope: { projectId: "p", canvasId: "c" } });
        expect(store.readSessionWorkspace(manager)).toBeNull();
    });

    it("returns null for a malformed workspace entry instead of throwing", async () => {
        const root = await createTempRoot("session-store-workspace-malformed");
        const store = createPiSessionStore({ sessionDir: root });
        const manager = store.createSessionManager({ scope: { projectId: "p", canvasId: "c" } });
        manager.appendCustomEntry(SESSION_WORKSPACE_CUSTOM_TYPE, { path: 42 });
        expect(store.readSessionWorkspace(manager)).toBeNull();
    });
});
