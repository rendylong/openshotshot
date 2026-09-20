import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

import { createPiSessionStore } from "./pi-session-store";
import { importLegacySessions } from "./pi-session-migration";

const tempRoots: string[] = [];

async function createTempRoot() {
    const root = await mkdtemp(join(tmpdir(), "shotshot-pi-session-migration-"));
    tempRoots.push(root);
    return root;
}

const legacyInput = () => [
    {
        id: "11111111-1111-7111-8111-111111111111",
        scope: "default",
        title: "Default chat",
        createdAt: 1000,
        updatedAt: 2000,
        messages: [
            { id: "m1", role: "user", text: "hello" },
            { id: "m2", role: "assistant", text: "hi" },
            { id: "m3", role: "tool", text: "tool output must be dropped" },
            { id: "m4", role: "error", text: "error output must be dropped" },
        ],
    },
    {
        id: "22222222-2222-7222-8222-222222222222",
        scope: "canvas-2",
        title: "Canvas chat",
        createdAt: 3000,
        updatedAt: 4000,
        messages: [
            { id: "m5", role: "user", text: "draw this" },
            { id: "m6", role: "assistant", text: "done" },
        ],
    },
];

describe("legacy Pi session migration", () => {
    afterEach(async () => {
        await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it("imports only user and assistant text and maps the legacy single-string scope", async () => {
        const root = await createTempRoot();
        const sessionDir = join(root, "sessions");
        const marker = join(root, "legacy-local-storage-v1.json");
        const input = legacyInput();
        Object.freeze(input);
        Object.freeze(input[0]);
        Object.freeze(input[0]!.messages);

        const result = await importLegacySessions(input, { sessionDir, migrationMarker: marker });
        expect(result).toMatchObject({ ok: true, imported: 2 });
        if (!result.ok) throw new Error("expected migration to succeed");
        expect(result.sessions).toEqual([
            expect.objectContaining({
                sessionId: "11111111-1111-7111-8111-111111111111",
                title: "Default chat",
                scope: { projectId: "", canvasId: "" },
                createdAt: 1000,
                updatedAt: 2000,
            }),
            expect.objectContaining({
                sessionId: "22222222-2222-7222-8222-222222222222",
                title: "Canvas chat",
                scope: { projectId: "canvas-2", canvasId: "" },
                createdAt: 3000,
                updatedAt: 4000,
            }),
        ]);
        expect(input).toEqual(legacyInput());

        const store = createPiSessionStore({ sessionDir });
        const first = store.openSessionManager("11111111-1111-7111-8111-111111111111");
        const second = store.openSessionManager("22222222-2222-7222-8222-222222222222");
        const scopeEntries = first.getEntries().filter((entry): entry is Extract<SessionEntry, { type: "custom" }> =>
            entry.type === "custom" && entry.customType === "shotshot.session-scope");
        expect(scopeEntries).toHaveLength(1);
        expect(scopeEntries[0]?.data).toEqual({ projectId: "", canvasId: "" });
        expect(first.getSessionName()).toBe("Default chat");
        const messageText = (content: unknown) => Array.isArray(content)
            ? content.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("")
            : String(content);
        expect(first.getEntries().filter((entry): entry is SessionMessageEntry => entry.type === "message").map((entry) => {
            if (entry.type !== "message") throw new Error("unreachable");
            return [entry.message.role, messageText((entry.message as { content?: unknown }).content)];
        })).toEqual([
            ["user", "hello"],
            ["assistant", "hi"],
        ]);
        expect(second.getEntries().filter((entry): entry is SessionMessageEntry => entry.type === "message").map((entry) => {
            if (entry.type !== "message") throw new Error("unreachable");
            return entry.message.role;
        })).toEqual(["user", "assistant"]);
        expect([...first.getEntries(), ...second.getEntries()].some((entry) =>
            entry.type === "message" && !["user", "assistant"].includes(entry.message.role))).toBe(false);
        expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({ version: 1, imported: 2 });
    });

    it("is a no-op when the migration marker already exists", async () => {
        const root = await createTempRoot();
        const sessionDir = join(root, "sessions");
        const marker = join(root, "legacy-local-storage-v1.json");
        await mkdir(sessionDir, { recursive: true });
        await writeFile(marker, "{\"version\":1,\"imported\":99}\n");
        const before = await readFile(marker);

        const result = await importLegacySessions(legacyInput(), { sessionDir, migrationMarker: marker });
        expect(result).toEqual({
            ok: true,
            imported: 0,
            sessions: [],
        });
        expect(await readFile(marker)).toEqual(before);
        expect(await readdir(sessionDir)).toEqual([]);
    });

    it("rejects invalid input before creating a session or marker", async () => {
        const root = await createTempRoot();
        const sessionDir = join(root, "sessions");
        const marker = join(root, "legacy-local-storage-v1.json");

        const result = await importLegacySessions([{ id: "bad id", scope: "default", title: "x", messages: [] }], {
            sessionDir,
            migrationMarker: marker,
        });
        expect(result).toEqual({ ok: false, error: "旧 Agent 历史[0].id 非法" });
        expect(await readdir(root)).toEqual([]);
    });
});
