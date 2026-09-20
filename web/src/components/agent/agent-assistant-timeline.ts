import type { ThreadMessageLike } from "@assistant-ui/react";

import type { AgentChatItem } from "@/stores/use-agent-store";
import { isPlanMessage } from "./agent-event-formatters";

export type AgentAssistantTimelineEntry = {
    id: string;
    role: "user" | "assistant";
    items: AgentChatItem[];
    kind?: "duration" | "process";
    turn?: AgentChatItem;
};

export function buildAssistantTimeline(messages: AgentChatItem[]) {
    const timeline: AgentAssistantTimelineEntry[] = [];
    let commands: AgentChatItem[] = [];
    let commandScope = "";
    const flushCommands = () => {
        if (!commands.length) return;
        timeline.push({ id: `commands:${commands[0].id}`, role: "assistant", items: commands });
        commands = [];
        commandScope = "";
    };
    const visibleMessages = messages.filter((item) => !isPlanMessage(item));
    for (let index = 0; index < visibleMessages.length; index += 1) {
        const item = visibleMessages[index];
        if (isCompletedTurnUser(item)) {
            flushCommands();
            timeline.push({ id: item.id, role: "user", items: [item] });
            const turnItems: AgentChatItem[] = [];
            while (index + 1 < visibleMessages.length && sameTurn(visibleMessages[index + 1], item) && visibleMessages[index + 1].role !== "user") {
                turnItems.push(visibleMessages[index + 1]);
                index += 1;
            }
            const finalItem = turnItems.at(-1);
            const hasFinal = finalItem?.role === "assistant" || finalItem?.role === "error";
            const processItems = hasFinal ? turnItems.slice(0, -1) : turnItems;
            timeline.push({ id: `process:${item.id}`, role: "assistant", items: processItems, kind: "process", turn: item });
            if (hasFinal && finalItem) timeline.push({ id: finalItem.id, role: "assistant", items: [finalItem] });
            continue;
        }
        if (isCommandMessage(item)) {
            const scope = item.threadId && item.turnId ? `${item.threadId}\0${item.turnId}` : item.id;
            if (commands.length && scope !== commandScope) flushCommands();
            commands.push(item);
            commandScope = scope;
            continue;
        }
        flushCommands();
        timeline.push({ id: item.id, role: item.role === "user" ? "user" : "assistant", items: [item] });
        if (item.role === "user" && typeof item.startedAt === "number") {
            timeline.push({ id: `duration:${item.id}`, role: "assistant", items: [item], kind: "duration" });
        }
    }
    flushCommands();
    return timeline;
}

export function assistantTimelineMessage(entry: AgentAssistantTimelineEntry): ThreadMessageLike {
    return {
        id: entry.id,
        role: entry.role,
        content: [{ type: "text", text: entry.kind === "duration" ? "" : entry.items.map((item) => item.text).join("\n\n") }],
    };
}

function isCommandMessage(item: AgentChatItem) {
    return item.role === "tool" && item.detail && typeof item.detail === "object" && (item.detail as { kind?: unknown }).kind === "command";
}

function isCompletedTurnUser(item: AgentChatItem) {
    return item.role === "user" && Boolean(item.threadId && item.turnId) && typeof item.completedAt === "number";
}

function sameTurn(item: AgentChatItem, turn: AgentChatItem) {
    return item.threadId === turn.threadId && item.turnId === turn.turnId;
}
