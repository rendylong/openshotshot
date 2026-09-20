import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";

import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-op-types";

import { createCanvasSnapshotCache, createShotshotSessionExtension } from "./pi-canvas-context";

function snapshot(title: string): CanvasAgentSnapshot {
    return {
        projectId: "project-1",
        canvasId: "canvas-1",
        title,
        nodes: [],
        connections: [],
        selectedNodeIds: [],
        viewport: { x: 0, y: 0, k: 1 },
    };
}

function createExtensionHarness() {
    const cache = createCanvasSnapshotCache();
    const handlers = new Map<string, (event: unknown) => unknown>();
    const envelopes: unknown[] = [];
    const extension: Pick<ExtensionAPI, "on"> = {
        on: (event, handler) => handlers.set(event, handler as (event: unknown) => unknown),
    };
    const factory = createShotshotSessionExtension({
        sessionId: "session-1",
        send: (envelope) => envelopes.push(envelope),
    });
    factory(extension as ExtensionAPI);
    return { cache, envelopes, handlers };
}

describe("canvas snapshot access", () => {
    it("keeps only the latest snapshot for each canvas", () => {
        const cache = createCanvasSnapshotCache();
        const scope = { projectId: "project-1", canvasId: "canvas-1" };

        cache.set(scope, snapshot("old"));
        expect(cache.get("canvas-1")).toMatchObject({ title: "old" });

        cache.set({ ...scope, projectId: "project-2" }, snapshot("new"));
        expect(cache.get("canvas-1")).toMatchObject({ title: "new" });
        expect(cache.get("missing")).toBeUndefined();
    });

    it("does not register a canvas context handler", () => {
        const { handlers } = createExtensionHarness();

        expect(handlers.has("context")).toBe(false);
    });

    it("keeps provider context free of canvas snapshots during compaction", async () => {
        const root = await mkdtemp(join(tmpdir(), "shotshot-pi-canvas-context-"));
        const cwd = join(root, "project");
        const agentDir = join(root, "agent");
        const sessionDir = join(root, "sessions");
        await Promise.all([cwd, agentDir, sessionDir].map((path) => mkdir(path, { recursive: true })));

        const faux = fauxProvider({ models: [{ id: "faux-1" }] });
        const contexts: unknown[][] = [];
        const reply = (text: string): FauxResponseStep => (context) => {
            contexts.push(context.messages);
            faux.appendResponses([reply("fallback")]);
            return fauxAssistantMessage(text);
        };
        faux.setResponses([reply("first answer")]);

        const modelRuntime = await ModelRuntime.create({
            authPath: join(agentDir, "auth.json"),
            modelsPath: join(agentDir, "models.json"),
            refreshOnCreate: false,
        });
        modelRuntime.registerNativeProvider(faux.provider);
        await modelRuntime.refresh({ allowNetwork: false });
        const settingsManager = SettingsManager.inMemory();
        const sessionManager = SessionManager.create(cwd, sessionDir);
        const cache = createCanvasSnapshotCache();
        const envelopes: unknown[] = [];
        cache.set({ projectId: "project-1", canvasId: "canvas-1" }, snapshot("snapshot-title"));
        const resourceLoader = new DefaultResourceLoader({
            cwd,
            agentDir,
            settingsManager,
            extensionFactories: [createShotshotSessionExtension({
                sessionId: sessionManager.getSessionId(),
                send: (envelope) => envelopes.push(envelope),
            })],
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
        });
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

        await session.prompt("first question");
        cache.set({ projectId: "project-1", canvasId: "canvas-1" }, snapshot("fresh-title"));
        await session.prompt(`second question\n${"overflow ".repeat(15_000)}`);
        await session.compact();
        session.dispose();

        expect(JSON.stringify(contexts[0])).not.toContain("snapshot-title");
        expect(JSON.stringify(contexts[1])).not.toContain("fresh-title");
        expect(JSON.stringify(contexts[1])).not.toContain("snapshot-title");
        expect(JSON.stringify(contexts[2])).not.toContain("fresh-title");
        expect(envelopes).toEqual([expect.objectContaining({
            sessionId: sessionManager.getSessionId(),
            kind: "agent",
            payload: expect.objectContaining({ type: "session_before_compact" }),
        })]);

        const compaction = sessionManager.getEntries().find((entry) => entry.type === "compaction");
        expect(compaction && "summary" in compaction ? compaction.summary : "").not.toContain("fresh-title");

        const rawSession = await readFile(sessionManager.getSessionFile()!, "utf8");
        expect(rawSession).not.toContain("snapshot-title");
        expect(rawSession).not.toContain("fresh-title");
    });
});
