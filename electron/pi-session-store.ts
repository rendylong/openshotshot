import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
    CURRENT_SESSION_VERSION,
    SessionManager,
    type CustomEntry,
    type SessionEntry,
    type SessionHeader,
} from "@earendil-works/pi-coding-agent";

import type { PiSessionScope, PiSessionSummary } from "@/lib/agent/pi-agent-types";

export const SESSION_SCOPE_CUSTOM_TYPE = "shotshot.session-scope";
export const SESSION_METADATA_CUSTOM_TYPE = "shotshot.session-metadata";
export const SESSION_WORKSPACE_CUSTOM_TYPE = "shotshot.session-workspace";
const DEFAULT_SESSION_TITLE = "新 Agent 会话";

export type PiSessionFileSummary = PiSessionSummary & { file: string };

export type PiSessionUnreadableFile = {
    file: string;
    error: string;
};

export type PiSessionSummaryListResult = {
    sessions: PiSessionSummary[];
    unreadable: PiSessionUnreadableFile[];
};

export type PiSessionFileValidation =
    | { ok: true; summary: PiSessionFileSummary }
    | { ok: false; error: string; bytes: Buffer };

type ParsedSessionFile = {
    header: SessionHeader;
    entries: SessionEntry[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
    return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function scopeData(value: unknown): PiSessionScope | null {
    if (!isPlainObject(value)) return null;
    const projectId = value.projectId;
    const canvasId = value.canvasId;
    if (typeof projectId !== "string" || typeof canvasId !== "string") return null;
    return { projectId, canvasId };
}

function metadataTimes(value: unknown): { createdAt?: number; updatedAt?: number } {
    if (!isPlainObject(value)) return {};
    const { createdAt, updatedAt } = value;
    return {
        ...(typeof createdAt === "number" && Number.isFinite(createdAt) ? { createdAt } : {}),
        ...(typeof updatedAt === "number" && Number.isFinite(updatedAt) ? { updatedAt } : {}),
    };
}


// The installed SDK declares CURRENT_SESSION_VERSION = 3. It can migrate older
// files only by rewriting them, so this read-only store accepts only the current
// v3 shape and reports pre-v3/future files as unreadable instead of mutating them.
const SESSION_ENTRY_TYPES: ReadonlySet<string> = new Set([
    "message",
    "thinking_level_change",
    "model_change",
    "compaction",
    "branch_summary",
    "custom",
    "custom_message",
    "label",
    "session_info",
] as const);

const AGENT_MESSAGE_ROLES: ReadonlySet<string> = new Set([
    "user",
    "assistant",
    "toolResult",
    "bashExecution",
    "custom",
    "branchSummary",
    "compactionSummary",
] as const);

const ASSISTANT_STOP_REASONS: ReadonlySet<string> = new Set([
    "pending",
    "stop",
    "length",
    "toolUse",
    "error",
    "aborted",
    "deferred",
]);

function isNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function isContentBlock(value: unknown): boolean {
    if (!isPlainObject(value) || typeof value.type !== "string") return false;
    if (value.type === "text") return typeof value.text === "string";
    if (value.type === "thinking") return typeof value.thinking === "string";
    if (value.type === "image") return typeof value.data === "string" && typeof value.mimeType === "string";
    if (value.type === "toolCall") {
        return typeof value.id === "string" && typeof value.name === "string" && isPlainObject(value.arguments);
    }
    return false;
}

function isContentBlocks(value: unknown, allowed: readonly string[]): boolean {
    return Array.isArray(value) && value.every((block) =>
        isPlainObject(block) && typeof block.type === "string" && allowed.includes(block.type) && isContentBlock(block));
}

function isUsage(value: unknown): boolean {
    if (!isPlainObject(value)) return false;
    const cost = value.cost;
    if (!isPlainObject(cost)) return false;
    return ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) => isNumber(value[key]))
        && ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => isNumber(cost[key]));
}

function validateAgentMessage(value: unknown): void {
    if (!isPlainObject(value) || typeof value.role !== "string" || !AGENT_MESSAGE_ROLES.has(value.role)) {
        const role = isPlainObject(value) && typeof value.role === "string" ? value.role : "missing";
        throw new Error(`unknown agent message role "${role}"`);
    }

    switch (value.role) {
        case "user":
            if (!((typeof value.content === "string") || isContentBlocks(value.content, ["text", "image"])) || !isNumber(value.timestamp)) {
                throw new Error("malformed user message");
            }
            break;
        case "assistant": {
            if (
                !isContentBlocks(value.content, ["text", "thinking", "toolCall"])
                || typeof value.api !== "string"
                || typeof value.provider !== "string"
                || typeof value.model !== "string"
                || !isUsage(value.usage)
                || typeof value.stopReason !== "string"
                || !ASSISTANT_STOP_REASONS.has(value.stopReason)
                || !isNumber(value.timestamp)
            ) {
                throw new Error("malformed assistant message");
            }
            break;
        }
        case "toolResult":
            if (
                typeof value.toolCallId !== "string"
                || typeof value.toolName !== "string"
                || !isContentBlocks(value.content, ["text", "image"])
                || typeof value.isError !== "boolean"
                || !isNumber(value.timestamp)
            ) {
                throw new Error("malformed toolResult message");
            }
            break;
        case "bashExecution":
            if (
                typeof value.command !== "string"
                || typeof value.output !== "string"
                || (value.exitCode !== undefined && !isNumber(value.exitCode))
                || typeof value.cancelled !== "boolean"
                || typeof value.truncated !== "boolean"
                || !isNumber(value.timestamp)
            ) {
                throw new Error("malformed bashExecution message");
            }
            break;
        case "custom":
            if (
                typeof value.customType !== "string"
                || !((typeof value.content === "string") || isContentBlocks(value.content, ["text", "image"]))
                || typeof value.display !== "boolean"
                || !isNumber(value.timestamp)
            ) {
                throw new Error("malformed custom message");
            }
            break;
        case "branchSummary":
            if (typeof value.fromId !== "string" || typeof value.summary !== "string" || !isNumber(value.timestamp)) {
                throw new Error("malformed branchSummary message");
            }
            break;
        case "compactionSummary":
            if (typeof value.summary !== "string" || !isNumber(value.tokensBefore) || !isNumber(value.timestamp)) {
                throw new Error("malformed compactionSummary message");
            }
            break;
    }
}

function validateSessionEntryFields(value: Record<string, unknown>): void {
    switch (value.type) {
        case "message":
            validateAgentMessage(value.message);
            break;
        case "thinking_level_change":
            if (typeof value.thinkingLevel !== "string") throw new Error("thinking_level_change requires thinkingLevel");
            break;
        case "model_change":
            if (typeof value.provider !== "string" || typeof value.modelId !== "string") throw new Error("malformed model_change entry");
            break;
        case "compaction":
            if (typeof value.summary !== "string" || typeof value.firstKeptEntryId !== "string" || !isNumber(value.tokensBefore)) {
                throw new Error("malformed compaction entry");
            }
            break;
        case "branch_summary":
            if (typeof value.fromId !== "string" || typeof value.summary !== "string") throw new Error("malformed branch_summary entry");
            break;
        case "custom":
            if (typeof value.customType !== "string") throw new Error("custom requires customType");
            break;
        case "custom_message":
            if (
                typeof value.customType !== "string"
                || !((typeof value.content === "string") || isContentBlocks(value.content, ["text", "image"]))
                || typeof value.display !== "boolean"
            ) {
                throw new Error("malformed custom_message entry");
            }
            break;
        case "label":
            if (typeof value.targetId !== "string" || (value.label !== undefined && typeof value.label !== "string")) {
                throw new Error("malformed label entry");
            }
            break;
        case "session_info":
            if (value.name !== undefined && typeof value.name !== "string") throw new Error("malformed session_info entry");
            break;
    }
}

function parseSessionBytes(bytes: Buffer): ParsedSessionFile {
    const text = bytes.toString("utf8");
    const lines = text.split("\n");
    let header: SessionHeader | null = null;
    const entries: SessionEntry[] = [];
    const entryIds = new Set<string>();

    for (const [index, rawLine] of lines.entries()) {
        if (!rawLine.trim()) continue;
        let raw: unknown;
        try {
            raw = JSON.parse(rawLine);
        } catch {
            throw new Error(`line ${index + 1} is not valid JSON`);
        }

        if (!header) {
            if (!isPlainObject(raw) || raw.type !== "session" || !isNonEmptyString(raw.id) || typeof raw.cwd !== "string" || !isTimestamp(raw.timestamp)) {
                throw new Error("the first non-empty line is not a valid session header");
            }
            if (raw.parentSession !== undefined && typeof raw.parentSession !== "string") throw new Error("the session header has an invalid parentSession");
            if (raw.version !== CURRENT_SESSION_VERSION) {
                throw new Error(`unsupported session version ${raw.version === undefined ? "(missing)" : String(raw.version)}; supported version is ${CURRENT_SESSION_VERSION}`);
            }
            header = raw as unknown as SessionHeader;
            continue;
        }

        if (
            !isPlainObject(raw)
            || !isNonEmptyString(raw.type)
            || !SESSION_ENTRY_TYPES.has(raw.type)
            || !isNonEmptyString(raw.id)
            || !isTimestamp(raw.timestamp)
            || (raw.parentId !== null && !isNonEmptyString(raw.parentId))
            || entryIds.has(raw.id)
            || (raw.parentId !== null && !entryIds.has(raw.parentId))
        ) {
            if (isPlainObject(raw) && typeof raw.type === "string" && !SESSION_ENTRY_TYPES.has(raw.type)) {
                throw new Error(`unknown entry type "${raw.type}"`);
            }
            throw new Error(`line ${index + 1} is not a valid session entry`);
        }
        try {
            validateSessionEntryFields(raw);
        } catch (error) {
            throw new Error(error instanceof Error ? error.message : String(error));
        }
        entryIds.add(raw.id);
        entries.push(raw as unknown as SessionEntry);
    }

    if (!header) throw new Error("the file has no session header");
    return { header, entries };
}

function summaryFromParsed(path: string, parsed: ParsedSessionFile): PiSessionFileSummary {
    const headerTime = Date.parse(parsed.header.timestamp);
    let scope: PiSessionScope = { projectId: "", canvasId: "" };
    let title = DEFAULT_SESSION_TITLE;
    let latestUpdatedAt = headerTime;
    let metadata: { createdAt?: number; updatedAt?: number } | undefined;

    for (const entry of parsed.entries) {
        const timestamp = Date.parse(entry.timestamp);
        if (!Number.isNaN(timestamp)) latestUpdatedAt = Math.max(latestUpdatedAt, timestamp);
        if (entry.type === "custom" && entry.customType === SESSION_SCOPE_CUSTOM_TYPE) {
            const nextScope = scopeData(entry.data);
            if (nextScope) scope = nextScope;
        }
        if (entry.type === "custom" && entry.customType === SESSION_METADATA_CUSTOM_TYPE) {
            metadata = metadataTimes(entry.data);
        }
        if (entry.type === "session_info" && typeof entry.name === "string") title = entry.name || title;
    }

    // Imported histories carry authoritative legacy wall-clock times; SDK append
    // timestamps record when migration itself happened and must not replace them.
    return {
        sessionId: parsed.header.id,
        title,
        scope,
        createdAt: metadata?.createdAt ?? headerTime,
        updatedAt: metadata?.updatedAt ?? latestUpdatedAt,
        status: "idle",
        hasUnfinishedOperation: false,
        file: path,
    };
}

export function validateSessionFile(path: string): PiSessionFileValidation {
    let bytes: Buffer;
    try {
        bytes = readFileSync(path);
    } catch (error) {
        return {
            ok: false,
            error: `Unable to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
            bytes: Buffer.alloc(0),
        };
    }

    try {
        const parsed = parseSessionBytes(bytes);
        return { ok: true, summary: summaryFromParsed(path, parsed) };
    } catch (error) {
        return {
            ok: false,
            error: `${path} is not a valid shotshot session file: ${error instanceof Error ? error.message : String(error)}`,
            bytes,
        };
    }
}

function listSessionFiles(sessionDir: string): string[] {
    try {
        return readdirSync(sessionDir)
            .filter((file) => file.endsWith(".jsonl"))
            .map((file) => join(sessionDir, file));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
}

export type PiSessionStore = {
    createSessionManager(input: { scope: PiSessionScope; title?: string; sessionId?: string; workspacePath?: string }): SessionManager;
    readSessionWorkspace(manager: SessionManager): string | null;
    openSessionManager(sessionId: string): SessionManager;
    ensureScopeEntry(sessionManager: SessionManager, scope: PiSessionScope): boolean;
    listSessionSummaries(scope?: PiSessionScope): PiSessionSummaryListResult;
};

export function createPiSessionStore(input: { sessionDir: string }): PiSessionStore {
    const sessionDir = input.sessionDir;

    const ensureScopeEntry = (sessionManager: SessionManager, scope: PiSessionScope): boolean => {
        // getBranch() is the active tree path. A scope marker left only on an
        // abandoned branch is not sufficient for the file's current branch.
        const hasScope = sessionManager.getBranch().some((entry): entry is CustomEntry =>
            entry.type === "custom" && entry.customType === SESSION_SCOPE_CUSTOM_TYPE && scopeData(entry.data) !== null);
        if (hasScope) return false;
        sessionManager.appendCustomEntry(SESSION_SCOPE_CUSTOM_TYPE, { projectId: scope.projectId, canvasId: scope.canvasId });
        return true;
    };

    const createSessionManager = ({ scope, title, sessionId, workspacePath }: { scope: PiSessionScope; title?: string; sessionId?: string; workspacePath?: string }) => {
        // The SDK delays its first file write until an assistant message exists.
        // Seed only the SDK JSONL header so scope/title are durable immediately
        // without fabricating a transcript message.
        const seed = SessionManager.inMemory(sessionDir, sessionId ? { id: sessionId } : undefined);
        const id = seed.getSessionId();
        const timestamp = new Date().toISOString();
        const fileTimestamp = timestamp.replace(/[:.]/g, "-");
        const sessionFile = join(sessionDir, `${fileTimestamp}_${id}.jsonl`);
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(sessionFile, `${JSON.stringify({
            type: "session",
            version: CURRENT_SESSION_VERSION,
            id,
            timestamp,
            cwd: resolve(sessionDir),
        })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        const sessionManager = SessionManager.open(sessionFile, sessionDir);
        ensureScopeEntry(sessionManager, scope);
        if (workspacePath) sessionManager.appendCustomEntry(SESSION_WORKSPACE_CUSTOM_TYPE, { path: workspacePath });
        sessionManager.appendSessionInfo(title?.trim() || DEFAULT_SESSION_TITLE);
        return sessionManager;
    };

    const readSessionWorkspace = (sessionManager: SessionManager): string | null => {
        for (const entry of sessionManager.getBranch()) {
            if (entry.type !== "custom" || entry.customType !== SESSION_WORKSPACE_CUSTOM_TYPE) continue;
            const data = entry.data as { path?: unknown };
            return typeof data?.path === "string" && data.path ? data.path : null;
        }
        return null;
    };

    return {
        createSessionManager,
        readSessionWorkspace,
        ensureScopeEntry,
        openSessionManager(sessionId) {
            const validations = listSessionFiles(sessionDir).map((file) => validateSessionFile(file));
            const matches = validations.filter((validation): validation is { ok: true; summary: PiSessionFileSummary } =>
                validation.ok && validation.summary.sessionId === sessionId);
            if (!matches.length) {
                const unreadable = validations.find((validation) => !validation.ok);
                if (unreadable && !unreadable.ok) throw new Error(unreadable.error);
                throw new Error(`Agent 会话不存在：${sessionId}`);
            }
            // Prefer the newest copy if a future SDK operation writes the same id twice.
            const latest = matches.reduce((left, right) =>
                right.summary.updatedAt > left.summary.updatedAt ? right : left);
            return SessionManager.open(latest.summary.file, sessionDir);
        },
        listSessionSummaries(scope) {
            const sessions: PiSessionSummary[] = [];
            const unreadable: PiSessionUnreadableFile[] = [];
            for (const file of listSessionFiles(sessionDir)) {
                const validation = validateSessionFile(file);
                if (validation.ok) {
                    if (!scope || (validation.summary.scope.projectId === scope.projectId && validation.summary.scope.canvasId === scope.canvasId)) {
                        const { file: _file, ...summary } = validation.summary;
                        sessions.push(summary);
                    }
                } else {
                    unreadable.push({ file, error: validation.error });
                }
            }
            sessions.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.sessionId.localeCompare(b.sessionId));
            return { sessions, unreadable };
        },
    };
}
