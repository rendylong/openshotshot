import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { PiSessionSummary } from "@/lib/agent/pi-agent-types";
import { isValidSessionId } from "@/lib/agent/pi-session-contract";

import { createPiSessionStore, SESSION_METADATA_CUSTOM_TYPE, type PiSessionStore } from "./pi-session-store";

type LegacyAgentMessage = {
    role: "user" | "assistant";
    text: string;
};

type LegacyPiSession = {
    id: string;
    scope: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: LegacyAgentMessage[];
};

export type LegacySessionImportResult =
    | { ok: true; imported: number; sessions: PiSessionSummary[] }
    | { ok: false; error: string };

export type LegacySessionImportOptions = {
    sessionDir: string;
    migrationMarker: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLegacySessions(raw: unknown): LegacyPiSession[] | string {
    if (!Array.isArray(raw)) return "旧 Agent 历史必须是数组";
    const sessions: LegacyPiSession[] = [];
    const ids = new Set<string>();

    for (const [sessionIndex, sessionRaw] of raw.entries()) {
        if (!isPlainObject(sessionRaw)) return `旧 Agent 历史[${sessionIndex}]必须是对象`;
        const { id, scope, title, createdAt, updatedAt, messages } = sessionRaw;
        if (!isValidSessionId(id)) return `旧 Agent 历史[${sessionIndex}].id 非法`;
        if (typeof scope !== "string") return `旧 Agent 历史[${sessionIndex}].scope 非法`;
        if (typeof title !== "string") return `旧 Agent 历史[${sessionIndex}].title 非法`;
        if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0) return `旧 Agent 历史[${sessionIndex}].createdAt 非法`;
        if (typeof updatedAt !== "number" || !Number.isSafeInteger(updatedAt) || updatedAt < createdAt) return `旧 Agent 历史[${sessionIndex}].updatedAt 非法`;
        if (!Array.isArray(messages)) return `旧 Agent 历史[${sessionIndex}].messages 非法`;
        if (ids.has(id)) return `旧 Agent 历史[${sessionIndex}].id 重复`;
        ids.add(id);

        const parsedMessages: LegacyAgentMessage[] = [];
        for (const [messageIndex, messageRaw] of messages.entries()) {
            if (!isPlainObject(messageRaw)) return `旧 Agent 历史[${sessionIndex}].messages[${messageIndex}]必须是对象`;
            // Tool/error/system records cannot be faithfully represented as SDK
            // transcript messages. They are intentionally dropped, not fabricated.
            if (messageRaw.role !== "user" && messageRaw.role !== "assistant") continue;
            if (typeof messageRaw.text !== "string") return `旧 Agent 历史[${sessionIndex}].messages[${messageIndex}].text 非法`;
            parsedMessages.push({ role: messageRaw.role, text: messageRaw.text });
        }
        sessions.push({ id, scope, title, createdAt, updatedAt, messages: parsedMessages });
    }
    return sessions;
}

function legacyUserMessage(text: string, timestamp: number): Message {
    return { role: "user", content: text, timestamp };
}

function legacyAssistantMessage(text: string, timestamp: number): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "shotshot-legacy",
        provider: "shotshot-legacy",
        model: "legacy",
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp,
    };
}

// The legacy localStorage model stored one scope string: projectId || canvasId
// || "default". It did not know the later {projectId, canvasId} pair. Preserve
// the known owner as projectId and let the renderer refine to a canvas scope
// when the user next opens that history item.
function mapLegacyScope(scope: string): { projectId: string; canvasId: string } {
    if (!scope || scope === "default") return { projectId: "", canvasId: "" };
    return { projectId: scope, canvasId: "" };
}

async function markerExists(path: string): Promise<boolean | string> {
    try {
        await readFile(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        return `无法读取旧历史迁移标记：${error instanceof Error ? error.message : String(error)}`;
    }
}

async function writeMarker(path: string, imported: number): Promise<void> {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, imported })}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
}

export async function importLegacySessions(
    input: unknown,
    options: LegacySessionImportOptions,
): Promise<LegacySessionImportResult> {
    const parsed = parseLegacySessions(input);
    if (typeof parsed === "string") return { ok: false, error: parsed };

    const marker = await markerExists(options.migrationMarker);
    if (typeof marker === "string") return { ok: false, error: marker };
    if (marker) return { ok: true, imported: 0, sessions: [] };

    try {
        await mkdir(options.sessionDir, { recursive: true });
    } catch (error) {
        return { ok: false, error: `无法创建 Agent 会话目录：${error instanceof Error ? error.message : String(error)}` };
    }

    const store: PiSessionStore = createPiSessionStore({ sessionDir: options.sessionDir });
    const summaries: PiSessionSummary[] = [];
    for (const session of parsed) {
        const scope = mapLegacyScope(session.scope);
        const manager = store.createSessionManager({
            scope,
            title: session.title,
            sessionId: session.id,
        });
        manager.appendCustomEntry(SESSION_METADATA_CUSTOM_TYPE, {
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
        });
        for (const message of session.messages) {
            manager.appendMessage(message.role === "user"
                ? legacyUserMessage(message.text, session.createdAt)
                : legacyAssistantMessage(message.text, session.createdAt));
        }
        summaries.push({
            sessionId: manager.getSessionId(),
            title: session.title.trim() || "旧 Agent 会话",
            scope,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            status: "idle",
            hasUnfinishedOperation: false,
        });
    }

    try {
        await writeMarker(options.migrationMarker, summaries.length);
    } catch (error) {
        return { ok: false, error: `无法写入旧历史迁移标记：${error instanceof Error ? error.message : String(error)}` };
    }
    return { ok: true, imported: summaries.length, sessions: summaries };
}
