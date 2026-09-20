import { describe, expect, it } from "vitest";

import type { AgentChatItem } from "@/stores/use-agent-store";
import { buildAssistantTimeline } from "./agent-assistant-timeline";

describe("buildAssistantTimeline", () => {
    it("keeps user, agent, tool, and next-turn messages in one chronological timeline", () => {
        const messages: AgentChatItem[] = [
            { id: "turn-1:user", threadId: "thread-1", turnId: "turn-1", role: "user", text: "先读取画布" },
            { id: "turn-1:commentary", threadId: "thread-1", turnId: "turn-1", role: "assistant", text: "我先检查当前节点。" },
            { id: "turn-1:command-1", threadId: "thread-1", turnId: "turn-1", role: "tool", text: "读取节点", detail: { kind: "command" } },
            { id: "turn-1:command-2", threadId: "thread-1", turnId: "turn-1", role: "tool", text: "读取连接", detail: { kind: "command" } },
            { id: "turn-1:final", threadId: "thread-1", turnId: "turn-1", role: "assistant", text: "画布读取完成。" },
            { id: "turn-2:user", threadId: "thread-1", turnId: "turn-2", role: "user", text: "继续生成图片" },
        ];

        const timeline = buildAssistantTimeline(messages);

        expect(timeline.map((entry) => entry.id)).toEqual([
            "turn-1:user",
            "turn-1:commentary",
            "commands:turn-1:command-1",
            "turn-1:final",
            "turn-2:user",
        ]);
        expect(timeline.map((entry) => entry.role)).toEqual(["user", "assistant", "assistant", "assistant", "user"]);
        expect(timeline[2]?.items.map((item) => item.id)).toEqual(["turn-1:command-1", "turn-1:command-2"]);
    });

    it("keeps a streaming assistant message at its original position", () => {
        const messages: AgentChatItem[] = [
            { id: "user", role: "user", text: "生成方案" },
            { id: "assistant", role: "assistant", text: "正在生成", streamId: "assistant" },
            { id: "tool", role: "tool", text: "读取画布", detail: { kind: "tool" } },
        ];

        expect(buildAssistantTimeline(messages).map((entry) => entry.id)).toEqual(["user", "assistant", "tool"]);
    });

    it("places one live duration row immediately after the user message", () => {
        const messages: AgentChatItem[] = [
            { id: "user", itemId: "user", threadId: "thread", turnId: "turn", role: "user", text: "开始", startedAt: 1_000 },
            { id: "tool", itemId: "tool:1", threadId: "thread", turnId: "turn", role: "tool", text: "读取画布", detail: { kind: "tool", status: "running" } },
            { id: "assistant", itemId: "assistant", threadId: "thread", turnId: "turn", role: "assistant", text: "完成" },
        ];

        expect(buildAssistantTimeline(messages).map((entry) => entry.id)).toEqual(["user", "duration:user", "tool", "assistant"]);
    });

    it("collapses a completed turn process while keeping the final answer visible", () => {
        const messages: AgentChatItem[] = [
            { id: "user", itemId: "user", threadId: "thread", turnId: "turn", role: "user", text: "开始", startedAt: 1_000, completedAt: 4_000, durationMs: 3_000 },
            { id: "reasoning", itemId: "reasoning:0", threadId: "thread", turnId: "turn", role: "tool", text: "分析画布结构", detail: { kind: "reasoning", status: "completed" } },
            { id: "interim", itemId: "assistant:0", threadId: "thread", turnId: "turn", role: "assistant", text: "我先读取画布。" },
            { id: "tool", itemId: "tool:1", threadId: "thread", turnId: "turn", role: "tool", text: "读取画布", detail: { kind: "tool", status: "completed" } },
            { id: "final", itemId: "assistant:1", threadId: "thread", turnId: "turn", role: "assistant", text: "画布读取完成。" },
        ];

        const timeline = buildAssistantTimeline(messages);

        expect(timeline.map((entry) => entry.id)).toEqual(["user", "process:user", "final"]);
        expect(timeline[1]).toMatchObject({
            kind: "process",
            items: [{ id: "reasoning" }, { id: "interim" }, { id: "tool" }],
        });
    });
});
