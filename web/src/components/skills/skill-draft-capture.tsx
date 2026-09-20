import { useEffect, useRef, useState } from "react";

import { extractSkillMarkdown } from "@/lib/skills/skill-format";
import { useAgentStore, type AgentChatItem } from "@/stores/use-agent-store";
import { usePiHistoryStore } from "@/stores/use-pi-history-store";
import { SkillSaveDialog } from "./skill-save-dialog";

type Props = {
    onSaved?: (name: string) => void;
};

const CREATOR_COMMAND = /^\/(?:skill:)?skill-creator(?:\s|$)/;

function messageKey(message: AgentChatItem, sessionId: string | null): string {
    return `${message.threadId || sessionId || "unscoped"}\0${message.turnId || ""}\0${message.itemId || message.id}`;
}

function precedingUser(messages: AgentChatItem[], assistantIndex: number): AgentChatItem | null {
    const assistant = messages[assistantIndex];
    for (let index = assistantIndex - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== "user") continue;
        if (assistant.threadId && message.threadId !== assistant.threadId) continue;
        if (assistant.turnId && message.turnId !== assistant.turnId) continue;
        return message;
    }
    return null;
}

export function SkillDraftCapture({ onSaved }: Props) {
    const messages = useAgentStore((state) => state.messages);
    const lifecycle = useAgentStore((state) => state.piLifecycle);
    const sessionId = usePiHistoryStore((state) => state.activeSessionId);
    const [raw, setRaw] = useState<string | null>(null);
    const handled = useRef(new Set(messages.filter((message) => message.role === "assistant").map((message) => messageKey(message, sessionId))));
    const historyRestoreRevision = useRef(lifecycle.historyRestoreRevision);

    useEffect(() => {
        if (!messages.length) {
            handled.current.clear();
            setRaw(null);
            return;
        }
        if (historyRestoreRevision.current !== lifecycle.historyRestoreRevision) {
            historyRestoreRevision.current = lifecycle.historyRestoreRevision;
            messages.filter((message) => message.role === "assistant").forEach((message) => handled.current.add(messageKey(message, sessionId)));
            setRaw(null);
            return;
        }
        if (!lifecycle.completedAssistantKey || handled.current.has(lifecycle.completedAssistantKey)) return;
        handled.current.add(lifecycle.completedAssistantKey);
        const index = messages.findIndex((message) => message.role === "assistant" && messageKey(message, sessionId) === lifecycle.completedAssistantKey);
        if (index < 0) return;
        const user = precedingUser(messages, index);
        if (!user || !CREATOR_COMMAND.test(user.text.trimStart())) return;
        const draft = extractSkillMarkdown(messages[index].text);
        if (draft) setRaw(draft);
    }, [lifecycle, messages, sessionId]);

    return raw ? <SkillSaveDialog raw={raw} onSaved={onSaved} onClose={() => setRaw(null)} /> : null;
}
