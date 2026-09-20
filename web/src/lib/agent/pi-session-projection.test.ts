import { describe, expect, it } from "vitest";

import type { ProjectFileAssetRef } from "@/lib/project-assets/project-asset-types";
import type { PiSessionEntrySnapshot } from "./pi-agent-types";
import { AGENT_ATTACHMENTS_CUSTOM_TYPE } from "./pi-agent-types";
import { applyLiveEnvelope, projectSessionEntries } from "./pi-session-projection";
import { buildAssistantTimeline } from "@/components/agent/agent-assistant-timeline";

const SESSION_ID = "0194f6c0-a8b1-7abc-9def-0123456789ab";

function messageEntry(id: string, parentId: string | null, message: Record<string, unknown>, timestamp = "2026-09-02T00:00:00.000Z"): PiSessionEntrySnapshot {
    return { id, parentId, type: "message", role: String(message.role), timestamp, raw: { type: "message", id, parentId, timestamp, message } };
}

function compactionEntry(id: string, parentId: string, input: { summary: string; firstKeptEntryId: string; tokensBefore: number; estimatedTokensAfter?: number; reason?: string }): PiSessionEntrySnapshot {
    return {
        id,
        parentId,
        type: "compaction",
        timestamp: "2026-09-02T00:00:04.000Z",
        compaction: { summary: input.summary, firstKeptEntryId: input.firstKeptEntryId, tokensBefore: input.tokensBefore },
        raw: { type: "compaction", id, parentId, ...input },
    };
}

describe("projectSessionEntries", () => {
    it("makes entry ids authoritative, replaces a covered range with one compaction card, and keeps tool pairing", () => {
        const entries = [
            { id: "scope", parentId: null, type: "custom", customType: "shotshot.session-scope" },
            messageEntry("user-1", "scope", { role: "user", content: "Draw a house" }),
            messageEntry("assistant-1", "user-1", {
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "Check the canvas" },
                    { type: "text", text: "I will check it." },
                    { type: "toolCall", id: "tool-1", name: "canvas_get_state", arguments: { includeNodes: true } },
                ],
                stopReason: "toolUse",
            }),
            messageEntry("tool-result-1", "assistant-1", {
                role: "toolResult",
                toolCallId: "tool-1",
                toolName: "canvas_get_state",
                content: [{ type: "text", text: "canvas ready" }],
                isError: false,
            }),
            compactionEntry("compaction-1", "tool-result-1", {
                summary: "The user asked for a house.",
                firstKeptEntryId: "user-2",
                tokensBefore: 1_000,
                estimatedTokensAfter: 200,
                reason: "manual",
            }),
            messageEntry("user-2", "compaction-1", { role: "user", content: "Now paint it" }, "2026-09-02T00:00:05.000Z"),
            messageEntry("assistant-2", "user-2", { role: "assistant", content: [{ type: "text", text: "Done" }] }, "2026-09-02T00:00:06.000Z"),
        ] as PiSessionEntrySnapshot[];

        const timeline = projectSessionEntries(SESSION_ID, entries, {
            "user-1": "adapter-turn-1",
            "assistant-1": "adapter-turn-1",
            "tool-result-1": "adapter-turn-1",
            "user-2": "adapter-turn-2",
            "assistant-2": "adapter-turn-2",
        });

        expect(timeline.map((item) => [item.role, item.id, item.itemId, item.turnId])).toEqual([
            ["compaction", `${SESSION_ID}:compaction-1`, "compaction-1", "adapter-turn-1"],
            ["user", `${SESSION_ID}:user-2`, "user-2", "adapter-turn-2"],
            ["assistant", `${SESSION_ID}:assistant-2`, "assistant-2", "adapter-turn-2"],
        ]);
        expect(timeline[0]?.detail).toMatchObject({
            kind: "compaction",
            status: "completed",
            reason: "manual",
            summary: "The user asked for a house.",
            tokensBefore: 1_000,
            tokensAfter: 200,
            range: { fromEntryId: "user-1", toEntryId: "tool-result-1" },
        });
        expect(timeline[0]?.text).toContain("The user asked for a house.");
    });

    it("preserves archived assistant thinking/text split, tool result attribution, and error terminal state", () => {
        const timeline = projectSessionEntries(SESSION_ID, [
            messageEntry("user", null, { role: "user", content: "Read canvas" }),
            messageEntry("assistant", "user", {
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "Inspect nodes" },
                    { type: "text", text: "Reading" },
                ],
                stopReason: "toolUse",
            }),
            messageEntry("tool", "assistant", { role: "toolResult", toolCallId: "call-1", toolName: "canvas_get_state", content: [{ type: "text", text: "nodes" }], isError: false }),
            messageEntry("failed", "tool", { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Stopped by user" }),
        ], { user: "turn-1", assistant: "turn-1", tool: "turn-1", failed: "turn-1" });

        expect(timeline.map((item) => [item.role, item.itemId, item.title, item.text])).toEqual([
            ["user", "user", undefined, "Read canvas"],
            ["tool", "assistant", "Reasoning", "Inspect nodes"],
            ["assistant", "assistant", "Assistant", "Reading"],
            ["tool", "tool", "canvas_get_state", "nodes"],
            ["error", "failed", undefined, "Stopped by user"],
        ]);
        expect(timeline[3]?.detail).toMatchObject({ kind: "tool", status: "completed", toolCallId: "call-1", output: "nodes" });
        expect(timeline[4]?.detail).toMatchObject({ kind: "error", status: "aborted", entryId: "failed" });
    });

    it("pairs an archived assistant tool call with its result into one terminal result item", () => {
        const timeline = projectSessionEntries(SESSION_ID, [
            messageEntry("user", null, { role: "user", content: "Read canvas" }),
            messageEntry("assistant", "user", {
                role: "assistant",
                content: [{ type: "toolCall", id: "call-1", name: "canvas_get_state", arguments: { includeNodes: true } }],
                stopReason: "toolUse",
            }),
            messageEntry("tool-result", "assistant", {
                role: "toolResult",
                toolCallId: "call-1",
                toolName: "canvas_get_state",
                content: [{ type: "text", text: "canvas ready" }],
                isError: false,
            }),
        ], { user: "turn-1", assistant: "turn-1", "tool-result": "turn-1" });

        const toolItems = timeline.filter((item) => item.role === "tool");
        expect(toolItems).toHaveLength(1);
        expect(toolItems[0]).toMatchObject({
            id: `${SESSION_ID}:tool-result`,
            itemId: "tool-result",
            turnId: "turn-1",
            title: "canvas_get_state",
            text: "canvas ready",
        });
        expect(toolItems[0]?.detail).toMatchObject({
            kind: "tool",
            status: "completed",
            toolCallId: "call-1",
            input: "{\"includeNodes\":true}",
            output: "canvas ready",
        });
    });

    it("keeps same-id tool calls paired within their own turns", () => {
        const timeline = projectSessionEntries(SESSION_ID, [
            messageEntry("user-1", null, { role: "user", content: "First turn" }),
            messageEntry("assistant-call-1", "user-1", {
                role: "assistant",
                content: [{ type: "toolCall", id: "call-1", name: "canvas_get_state", arguments: { turn: 1 } }],
            }),
            messageEntry("user-2", "assistant-call-1", { role: "user", content: "Second turn" }),
            messageEntry("assistant-call-2", "user-2", {
                role: "assistant",
                content: [{ type: "toolCall", id: "call-1", name: "canvas_get_state", arguments: { turn: 2 } }],
            }),
            messageEntry("tool-result-2", "assistant-call-2", {
                role: "toolResult",
                toolCallId: "call-1",
                toolName: "canvas_get_state",
                content: [{ type: "text", text: "second result" }],
            }),
            messageEntry("tool-result-1", "assistant-call-1", {
                role: "toolResult",
                toolCallId: "call-1",
                toolName: "canvas_get_state",
                content: [{ type: "text", text: "first result" }],
            }),
        ], {
            "user-1": "turn-1",
            "assistant-call-1": "turn-1",
            "tool-result-1": "turn-1",
            "user-2": "turn-2",
            "assistant-call-2": "turn-2",
            "tool-result-2": "turn-2",
        });

        const toolItems = timeline.filter((item) => item.role === "tool");
        expect(toolItems).toHaveLength(2);
        expect(toolItems.map((item) => [item.id, item.turnId, item.text])).toEqual([
            [`${SESSION_ID}:tool-result-2`, "turn-2", "second result"],
            [`${SESSION_ID}:tool-result-1`, "turn-1", "first result"],
        ]);
        expect(toolItems[0]?.detail).toMatchObject({ toolCallId: "call-1", callEntryId: "assistant-call-2", input: "{\"turn\":2}" });
        expect(toolItems[1]?.detail).toMatchObject({ toolCallId: "call-1", callEntryId: "assistant-call-1", input: "{\"turn\":1}" });
    });

    it("restores attachments and asset refs from session history", () => {
        const projectRef: ProjectFileAssetRef = {
            backend: "project-file",
            projectId: "project-1",
            assetId: "asset-1",
            relativePath: "assets/imported/budget--a1b2c3d4.xlsx",
            revision: 1,
        };
        const manifestEntry = (id: string, withRevision: boolean): PiSessionEntrySnapshot => ({
            id,
            parentId: null,
            type: "custom",
            raw: {
                type: "custom",
                id,
                customType: AGENT_ATTACHMENTS_CUSTOM_TYPE,
                data: {
                    projectId: "project-1",
                    files: [{ assetId: "asset-1", relativePath: projectRef.relativePath, name: "budget.xlsx", kind: "spreadsheet", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 64, ...(withRevision ? { revision: 2 } : {}) }],
                },
            },
        });
        const entriesWithAttachment = [
            // 运行时写入的清单带 revision。
            manifestEntry("manifest-1", true),
            messageEntry("user-1", "manifest-1", { role: "user", content: "修改这个表格" }),
            messageEntry("assistant-1", "user-1", { role: "assistant", content: [{ type: "text", text: "完成" }] }),
            // 兼容路径：清单省略 revision 时也要恢复出可被主进程读取的 ref。
            manifestEntry("manifest-2", false),
            messageEntry("user-2", "manifest-2", { role: "user", content: "再看一眼" }),
        ];

        const timeline = projectSessionEntries(SESSION_ID, entriesWithAttachment);
        const users = timeline.filter((item) => item.role === "user");
        expect(users).toHaveLength(2);
        // manifest 带 revision：原样恢复。
        expect(users[0]).toMatchObject({ role: "user", attachments: [{ assetRef: { ...projectRef, revision: 2 }, kind: "spreadsheet", name: "budget.xlsx", size: 64, relativePath: projectRef.relativePath }] });
        // manifest 省略 revision：回退为数字 1，保证 ref 能通过主进程 parseRef 的预览读取。
        const restoredRef = users[1]?.attachments?.[0]?.assetRef;
        expect(restoredRef).toMatchObject({ backend: "project-file", assetId: "asset-1", projectId: "project-1", relativePath: projectRef.relativePath });
        if (restoredRef?.backend === "project-file") {
            expect(restoredRef.revision).toEqual(expect.any(Number));
            expect(restoredRef.revision).toBeGreaterThanOrEqual(1);
            expect(restoredRef.revision).toBe(1);
        }
    });

    it("does not leak a pending manifest to later turns and ignores foreign custom entries", () => {
        const manifestEntry: PiSessionEntrySnapshot = {
            id: "manifest-1",
            parentId: null,
            type: "custom",
            raw: {
                type: "custom",
                id: "manifest-1",
                customType: AGENT_ATTACHMENTS_CUSTOM_TYPE,
                data: {
                    projectId: "project-1",
                    files: [{ assetId: "asset-1", relativePath: "assets/imported/budget--a1b2c3d4.xlsx", name: "budget.xlsx", kind: "spreadsheet", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 64 }],
                },
            },
        };
        const timeline = projectSessionEntries(SESSION_ID, [
            manifestEntry,
            messageEntry("user-1", "manifest-1", { role: "user", content: "修改这个表格" }),
            messageEntry("assistant-1", "user-1", { role: "assistant", content: [{ type: "text", text: "完成" }] }),
            messageEntry("user-2", "assistant-1", { role: "user", content: "再看看" }),
            {
                id: "scope-1",
                parentId: "user-2",
                type: "custom",
                raw: { type: "custom", id: "scope-1", customType: "shotshot.session-scope", data: { projectId: "project-1" } },
            },
            messageEntry("user-3", "scope-1", { role: "user", content: "继续" }),
        ]);

        const users = timeline.filter((item) => item.role === "user");
        expect(users).toHaveLength(3);
        expect(users[0]?.attachments).toHaveLength(1);
        expect(users[1]?.attachments).toBeUndefined();
        expect(users[2]?.attachments).toBeUndefined();
    });

    it("does not inherit a compacted-away turn's manifest on the kept user message", () => {
        const manifestEntry: PiSessionEntrySnapshot = {
            id: "manifest-1",
            parentId: null,
            type: "custom",
            raw: {
                type: "custom",
                id: "manifest-1",
                customType: AGENT_ATTACHMENTS_CUSTOM_TYPE,
                data: {
                    projectId: "project-1",
                    // 运行时写入的清单没有 revision：assetRef 也不得伪造 0。
                    files: [{ assetId: "asset-1", relativePath: "assets/imported/budget--a1b2c3d4.xlsx", name: "budget.xlsx", kind: "spreadsheet", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 64 }],
                },
            },
        };
        const timeline = projectSessionEntries(SESSION_ID, [
            manifestEntry,
            messageEntry("user-a", "manifest-1", { role: "user", content: "修改这个表格" }),
            messageEntry("assistant-a", "user-a", { role: "assistant", content: [{ type: "text", text: "完成" }] }),
            compactionEntry("compaction-1", "assistant-a", { summary: "已压缩首轮", firstKeptEntryId: "user-b", tokensBefore: 500 }),
            messageEntry("user-b", "compaction-1", { role: "user", content: "再看看" }),
        ]);

        // user-a 落在压缩覆盖范围内被丢弃；压缩边界必须把未消费的清单一并清掉。
        const users = timeline.filter((item) => item.role === "user");
        expect(users.map((item) => item.text)).toEqual(["再看看"]);
        expect(users[0]?.attachments).toBeUndefined();
        expect(timeline.some((item) => item.role === "compaction")).toBe(true);
    });

    it("never attaches a manifest that the main process aborted after a failed prompt", () => {
        const manifestEntry: PiSessionEntrySnapshot = {
            id: "manifest-1",
            parentId: null,
            type: "custom",
            raw: {
                type: "custom",
                id: "manifest-1",
                customType: AGENT_ATTACHMENTS_CUSTOM_TYPE,
                data: {
                    projectId: "project-1",
                    files: [{ assetId: "asset-1", relativePath: "assets/imported/budget--a1b2c3d4.xlsx", name: "budget.xlsx", kind: "spreadsheet", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 64 }],
                },
            },
        };
        const abortEntry: PiSessionEntrySnapshot = {
            id: "abort-1",
            parentId: "manifest-1",
            type: "custom",
            raw: { type: "custom", id: "abort-1", customType: AGENT_ATTACHMENTS_CUSTOM_TYPE, data: { abortedEntryId: "manifest-1" } },
        };
        const timeline = projectSessionEntries(SESSION_ID, [
            manifestEntry,
            abortEntry,
            messageEntry("user-1", "abort-1", { role: "user", content: "文本消息" }),
        ]);

        const users = timeline.filter((item) => item.role === "user");
        expect(users).toHaveLength(1);
        expect(users[0]?.attachments).toBeUndefined();
    });

    it("keeps the assistant reply visible when an entry snapshot has no raw message parts", () => {
        // toEntrySnapshot 兜底路径：raw 缺失时投影只能拿到 entry.text 字符串，
        // assistant 项不能因此消失（否则恢复会话只剩 user 文本和空 turn 折叠条）。
        const entries = [
            messageEntry("user-1", null, { role: "user", content: "hi" }),
            { id: "assistant-1", parentId: "user-1", type: "message", role: "assistant", text: "你好！", timestamp: "2026-09-02T00:00:02.000Z" } as PiSessionEntrySnapshot,
        ];

        const items = projectSessionEntries(SESSION_ID, entries, {});

        expect(items.map((item) => item.role)).toEqual(["user", "assistant"]);
        expect(items[1]?.text).toBe("你好！");
    });

    it("renders raw text tool_call segments as tool cards instead of dumping markup", () => {
        const raw = "好问题!让我看看 skills 的内容。<tool_call>\nRead\n/tmp/skills.md<tool_call>\nList\n/tmp/examples";
        const entries = [
            messageEntry("user-1", null, { role: "user", content: "你有哪些 skills" }),
            messageEntry("assistant-1", "user-1", { role: "assistant", content: [{ type: "text", text: raw }] }),
        ];

        const items = projectSessionEntries(SESSION_ID, entries, {});

        expect(items.map((item) => item.role)).toEqual(["user", "tool", "tool", "assistant"]);
        expect(items[1]).toMatchObject({
            role: "tool",
            title: "Read",
            detail: { kind: "tool", status: "completed", input: "/tmp/skills.md" },
        });
        expect(items[2]).toMatchObject({
            role: "tool",
            title: "List",
            detail: { kind: "tool", status: "completed", input: "/tmp/examples" },
        });
        expect(items[3]?.text).toBe("好问题!让我看看 skills 的内容。");
        expect(items[3]?.text).not.toContain("tool_call");
    });
});

describe("applyLiveEnvelope", () => {
    const now = () => 1_700_000_000_000;
    const context = { activeTurnId: "live-turn-1", now };

    it("keeps archived live user messages open until the whole agent run finishes", () => {
        let timeline: ReturnType<typeof projectSessionEntries> = [{ id: "user", role: "user", text: "Read canvas", threadId: SESSION_ID, turnId: "live-turn-1", startedAt: now() - 1000 }];
        timeline = applyLiveEnvelope(timeline, { sessionId: SESSION_ID, kind: "agent", payload: { type: "entry_appended", entry: messageEntry("user-entry", null, { role: "user", content: "Read canvas" }).raw } }, context);
        expect(timeline[0]?.completedAt).toBeUndefined();
        expect(timeline[0]?.startedAt).toBe(now() - 1000);
    });

    it("keeps intermediate replies and tools visible across Pi turns and retries, then collapses once", () => {
        let timeline: ReturnType<typeof projectSessionEntries> = [
            { id: "user", role: "user", text: "Read canvas", threadId: SESSION_ID, turnId: "live-turn-1", startedAt: now() - 1000 },
            { id: "interim", role: "assistant", text: "Reading", threadId: SESSION_ID, turnId: "live-turn-1" },
            { id: "tool", role: "tool", text: "nodes", threadId: SESSION_ID, turnId: "live-turn-1", detail: { kind: "tool", status: "completed" } },
        ];
        for (const payload of [{ type: "turn_end" }, { type: "agent_end", willRetry: true }]) {
            timeline = applyLiveEnvelope(timeline, { sessionId: SESSION_ID, kind: "agent", payload }, context);
            expect(timeline[0]?.completedAt).toBeUndefined();
            expect(buildAssistantTimeline(timeline).map((entry) => entry.id)).toEqual(["user", "duration:user", "interim", "tool"]);
        }
        timeline.push({ id: "final", role: "assistant", text: "Done", threadId: SESSION_ID, turnId: "live-turn-1", streamId: "final" });
        timeline = applyLiveEnvelope(timeline, { sessionId: SESSION_ID, kind: "agent", payload: { type: "agent_end" } }, context);
        expect(buildAssistantTimeline(timeline).map((entry) => entry.id)).toEqual(["user", "process:user", "final"]);
        expect(timeline.at(-1)?.streamId).toBeUndefined();
    });

    it("archives a streamed assistant and a completed tool without duplicating live items", () => {
        let timeline = applyLiveEnvelope([
            { id: `${SESSION_ID}:live-turn-1:user`, itemId: "user", threadId: SESSION_ID, turnId: "live-turn-1", role: "user", text: "Read canvas" },
        ], { sessionId: SESSION_ID, kind: "agent", payload: { type: "message_start", message: { role: "user", content: "Read canvas" } } }, context);

        timeline = applyLiveEnvelope(timeline, { sessionId: SESSION_ID, kind: "agent", payload: { type: "message_start", message: { role: "assistant", content: [] } } }, context);
        timeline = applyLiveEnvelope(timeline, { sessionId: SESSION_ID, kind: "agent", payload: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Reading" }] }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Reading" } } }, context);
        timeline = applyLiveEnvelope(timeline, { sessionId: SESSION_ID, kind: "agent", payload: { type: "entry_appended", entry: { type: "message", id: "user-entry", parentId: null, timestamp: "2026-09-02T00:00:00.000Z", message: { role: "user", content: "Read canvas" } } } }, context);
        timeline = applyLiveEnvelope(timeline, { sessionId: SESSION_ID, kind: "agent", payload: { type: "entry_appended", entry: { type: "message", id: "assistant-entry", parentId: "user-entry", timestamp: "2026-09-02T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "Reading" }] } } } }, context);
        timeline = applyLiveEnvelope(timeline, { sessionId: SESSION_ID, kind: "agent", payload: { type: "tool_execution_start", toolCallId: "call-1", toolName: "canvas_get_state", args: { includeNodes: true } } }, context);
        timeline = applyLiveEnvelope(timeline, { sessionId: SESSION_ID, kind: "agent", payload: { type: "tool_execution_update", toolCallId: "call-1", toolName: "canvas_get_state", args: { includeNodes: true }, partialResult: { content: [{ type: "text", text: "partial" }] } } }, context);
        timeline = applyLiveEnvelope(timeline, { sessionId: SESSION_ID, kind: "agent", payload: { type: "tool_execution_end", toolCallId: "call-1", toolName: "canvas_get_state", result: { content: [{ type: "text", text: "nodes" }] }, isError: false } }, context);
        timeline = applyLiveEnvelope(timeline, { sessionId: SESSION_ID, kind: "agent", payload: { type: "entry_appended", entry: { type: "message", id: "tool-entry", parentId: "assistant-entry", timestamp: "2026-09-02T00:00:02.000Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "canvas_get_state", content: [{ type: "text", text: "nodes" }], isError: false } } } }, context);

        expect(timeline.map((item) => [item.role, item.id, item.itemId, item.text])).toEqual([
            ["user", `${SESSION_ID}:user-entry`, "user-entry", "Read canvas"],
            ["assistant", `${SESSION_ID}:assistant-entry`, "assistant-entry", "Reading"],
            ["tool", `${SESSION_ID}:tool-entry`, "tool-entry", "nodes"],
        ]);
        expect(timeline[2]?.detail).toMatchObject({ kind: "tool", status: "completed", toolCallId: "call-1", input: "{\"includeNodes\":true}", output: "nodes" });
    });

    it("projects compaction lifecycle and failure into one terminal card", () => {
        let timeline: ReturnType<typeof projectSessionEntries> = [];
        timeline = applyLiveEnvelope(timeline, { sessionId: SESSION_ID, kind: "agent", payload: { type: "compaction_start", reason: "threshold" } }, context);
        timeline = applyLiveEnvelope(timeline, { sessionId: SESSION_ID, kind: "agent", payload: { type: "compaction_end", reason: "threshold", result: { summary: "Earlier work", firstKeptEntryId: "kept", tokensBefore: 900, estimatedTokensAfter: 180 }, aborted: false, willRetry: false } }, context);
        timeline = applyLiveEnvelope(timeline, { sessionId: SESSION_ID, kind: "session_compact_failed", payload: { message: "summary failed" } }, context);

        expect(timeline).toHaveLength(1);
        expect(timeline[0]).toMatchObject({
            role: "compaction",
            threadId: SESSION_ID,
            turnId: "live-turn-1",
            detail: { kind: "compaction", status: "failed", reason: "threshold", summary: "Earlier work", tokensBefore: 900, tokensAfter: 180, error: "summary failed" },
        });
    });

    it("carries the live covered entry range through compaction end and archive", () => {
        const initial: ReturnType<typeof projectSessionEntries> = [
            { id: `${SESSION_ID}:covered-user`, itemId: "covered-user", threadId: SESSION_ID, turnId: "old-turn", role: "user", text: "covered" },
            { id: `${SESSION_ID}:kept-user`, itemId: "kept-user", threadId: SESSION_ID, turnId: "live-turn-1", role: "user", text: "kept" },
        ];

        let timeline = applyLiveEnvelope(initial, { sessionId: SESSION_ID, kind: "agent", payload: { type: "compaction_start", reason: "manual" } }, context);
        timeline = applyLiveEnvelope(timeline, {
            sessionId: SESSION_ID,
            kind: "agent",
            payload: {
                type: "compaction_end",
                reason: "manual",
                result: { summary: "covered history", firstKeptEntryId: "kept-user", tokensBefore: 900, estimatedTokensAfter: 180 },
                aborted: false,
                willRetry: false,
            },
        }, context);
        timeline = applyLiveEnvelope(timeline, {
            sessionId: SESSION_ID,
            kind: "agent",
            payload: {
                type: "entry_appended",
                entry: {
                    type: "compaction",
                    id: "compaction-entry",
                    parentId: "covered-user",
                    timestamp: "2026-09-02T00:00:03.000Z",
                    summary: "covered history",
                    firstKeptEntryId: "kept-user",
                    tokensBefore: 900,
                },
            },
        }, context);

        const card = timeline.find((item) => item.role === "compaction");
        expect(card?.id).toBe(`${SESSION_ID}:compaction-entry`);
        expect(card?.itemId).toBe("compaction-entry");
        expect(card?.detail).toMatchObject({
            status: "completed",
            range: { fromEntryId: "covered-user", toEntryId: "covered-user" },
            entryId: "compaction-entry",
        });
    });
});

it("keeps reasoning-only Codex continuations ordered so the final reply stays outside the collapsed process", () => {
    const context = { turnId: "images-turn", streamId: "stream", now: () => 1000 };
    let timeline: ReturnType<typeof applyLiveEnvelope> = [];
    const emit = (payload: Record<string, unknown>) => {
        timeline = applyLiveEnvelope(timeline, { sessionId: SESSION_ID, kind: "agent", payload }, context);
    };
    emit({ type: "message_start", message: { role: "user", content: "Generate an image" } });
    for (let i = 0; i < 3; i++) {
        emit({ type: "message_start", message: { role: "assistant", content: [] } });
        emit({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: `Step ${i}` }] } });
        emit({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: `Step ${i}` }, { type: "toolCall", id: `tool-${i}`, name: "canvas_get_state", arguments: {} }] } });
        emit({ type: "tool_execution_end", toolCallId: `tool-${i}`, toolName: "canvas_get_state", result: { content: [{ type: "text", text: "done" }] }, isError: false });
    }
    emit({ type: "message_start", message: { role: "assistant", content: [] } });
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Image generated." }] } });
    emit({ type: "agent_end" });
    expect(timeline.at(-1)?.text).toBe("Image generated.");
    expect(timeline.filter(item => item.detail && (item.detail as { kind?: string }).kind === "reasoning")).toHaveLength(3);
    expect(new Set(timeline.map(item => item.id)).size).toBe(timeline.length);
    const rendered = buildAssistantTimeline(timeline);
    expect(rendered.at(-1)).toMatchObject({ items: [{ role: "assistant", text: "Image generated." }] });
    expect(rendered.at(-1)?.kind).not.toBe("process");
});
