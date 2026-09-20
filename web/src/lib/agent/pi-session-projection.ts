import type { AgentChatItem, AgentCompactionDetail, AgentMessageAttachment } from "@/stores/use-agent-store";
import type { AgentAttachmentKind } from "@/lib/agent/agent-attachments";
import type { ProjectFileAssetRef } from "@/lib/project-assets/project-asset-types";
import { AGENT_ATTACHMENTS_CUSTOM_TYPE, type PiSessionEnvelope, type PiSessionEntryRange, type PiSessionEntrySnapshot } from "./pi-agent-types";

export type PiSessionTurnBindings = Readonly<Record<string, string>>;

export type PiSessionProjectionContext = {
    activeTurnId?: string;
    turnBindings?: PiSessionTurnBindings;
    now?: () => number;
    streamId?: string;
    labels?: {
        assistantTitle?: string;
        reasoningTitle?: string;
    };
    format?: {
        toolTitle?: (name: string) => string;
        toolText?: (name: string) => string;
        toolDetail?: (name: string, input: unknown, status: string) => Record<string, unknown>;
        toolSummary?: (name: string, result: unknown, isError: boolean) => string;
    };
};

type ContentPart = {
    type?: unknown;
    text?: unknown;
    thinking?: unknown;
    id?: unknown;
    name?: unknown;
    arguments?: unknown;
};

const DEFAULT_LABELS = { assistantTitle: "Assistant", reasoningTitle: "Reasoning" };

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function number(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parts(content: unknown): ContentPart[] {
    return Array.isArray(content) ? content.filter((part): part is ContentPart => Boolean(part) && typeof part === "object") : [];
}

function extractText(content: unknown): string {
    if (typeof content === "string") return content;
    return parts(content).filter((part) => part.type === "text").map((part) => string(part.text)).join("");
}

function payloadText(value: unknown): string {
    if (value == null) return "";
    if (typeof value === "string") return value.trim();
    const content = Array.isArray(value) ? value : object(value).content;
    if (Array.isArray(content)) {
        const text = content.flatMap((part) => {
            const text = string(object(part).text);
            return text ? [text] : [];
        }).join("\n");
        if (text) return text;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function messageOf(entry: PiSessionEntrySnapshot): Record<string, unknown> {
    const rawMessage = object(object(entry.raw).message);
    if (Object.keys(rawMessage).length) return rawMessage;
    return {
        role: entry.role,
        content: entry.text,
    };
}

/**
 * 从附件清单 custom entry 恢复用户消息的附件元数据：相对路径 + assetRef 是持久身份，
 * 只恢复文本视为数据丢失。清单只在相邻的下一条用户消息上生效；
 * prompt 失败时主进程会补写 abortedEntryId 标记，使孤儿清单永不附着。
 */
type RestoredManifest = { abortedEntryId?: string; attachments?: AgentMessageAttachment[] };

function restoredManifest(entry: PiSessionEntrySnapshot): RestoredManifest | undefined {
    const raw = object(entry.raw);
    if (string(raw.customType) !== AGENT_ATTACHMENTS_CUSTOM_TYPE) return undefined;
    const data = object(raw.data);
    const abortedEntryId = string(data.abortedEntryId);
    if (abortedEntryId) return { abortedEntryId };
    const projectId = string(data.projectId);
    const attachments = (Array.isArray(data.files) ? data.files : []).flatMap((file) => {
        const item = object(file);
        const name = string(item.name);
        const assetId = string(item.assetId);
        const relativePath = string(item.relativePath);
        if (!projectId || !name || !assetId || !relativePath) return [];
        const revision = number(item.revision);
        // 展示侧 ref 必须始终携带整数 revision，否则主进程 parseRef 拒读、预览退化为文件卡片。
        // manifest 运行时不写 revision 时回退 1：store 按 assetId/projectId/relativePath 解析身份，
        // changed 事件按 projectId:assetId 前缀失效缓存，回退值最多造成一次展示缓存键不命中，不会读错内容。
        const assetRef: ProjectFileAssetRef = {
            backend: "project-file",
            assetId,
            projectId,
            relativePath,
            revision: revision ?? 1,
        };
        return [{
            id: `${entry.id}:${assetId}`,
            name,
            kind: (string(item.kind) || "file") as AgentAttachmentKind,
            mimeType: string(item.mimeType),
            size: number(item.size) ?? 0,
            url: "",
            relativePath,
            assetRef,
        } satisfies AgentMessageAttachment];
    });
    return attachments.length ? { attachments } : undefined;
}

function timestampOf(entry: PiSessionEntrySnapshot): number | undefined {
    const parsed = Date.parse(entry.timestamp || "");
    return Number.isFinite(parsed) ? parsed : undefined;
}

function isTranscriptEntry(entry: PiSessionEntrySnapshot): boolean {
    return entry.type === "message" && ["user", "assistant", "toolResult", "bashExecution", "custom", "branchSummary", "compactionSummary"].includes(entry.role || string(messageOf(entry).role));
}

function compactionReason(entry: PiSessionEntrySnapshot): AgentCompactionDetail["reason"] {
    const reason = string(object(entry.raw).reason) || string(object(entry.raw).details).valueOf();
    return reason === "threshold" || reason === "overflow" ? reason : "manual";
}

function compactionTokensAfter(entry: PiSessionEntrySnapshot, fallbackSummary: string): number | undefined {
    const raw = object(entry.raw);
    return number(raw.estimatedTokensAfter) ?? (fallbackSummary ? Math.ceil(fallbackSummary.length / 4) : undefined);
}

function toolDetail(context: PiSessionProjectionContext, name: string, input: unknown, status: string): Record<string, unknown> {
    return { ...(context.format?.toolDetail?.(name, input, status) ?? { kind: "tool", status }), toolName: name };
}

function toolSummary(context: PiSessionProjectionContext, name: string, result: unknown, isError: boolean): string {
    if (isError) return payloadText(result) || "Tool failed";
    return context.format?.toolSummary?.(name, result, isError) || extractText(result) || payloadText(result) || "Tool completed";
}

function baseItem(sessionId: string, entry: PiSessionEntrySnapshot, turnId: string): Pick<AgentChatItem, "itemId" | "threadId" | "turnId"> {
    return { itemId: entry.id, threadId: sessionId, turnId };
}

type RawToolCallText = { index: number; name: string; input: string };

/**
 * 从纯文本输出里拆出原生 `<tool_call>` 段。
 *
 * MiniMax 的 Anthropic 兼容端点偶尔会把工具调用按模型原生文本吐出来，例如
 * `<tool_call>\nRead\n/Users/.../skills.md`（可能带转义变形的分隔符）。SDK
 * 解析不到结构化 toolCall part 时，界面上只剩一坨 raw 标记；这里按宽松规则
 * 把每个工具段抽成一张工具卡片，剩余文本作为 assistant 回复展示。
 */
function splitRawToolCallText(text: string): { text: string; calls: RawToolCallText[] } {
    if (!text || !text.includes("<")) return { text, calls: [] };
    const pattern = /<\s*tool_call\s*>\s*([A-Za-z_][\w:.-]*)\s*([\s\S]*?)(?=<\s*\/\s*tool_call\s*>|<\s*tool_call\s*>|$)/gi;
    const calls: RawToolCallText[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
        const name = match[1] || "";
        if (!name) continue;
        // 有的输出里工具段之间夹着被转义变形的分隔符（`]minimax[>` 之类），从参数里截掉。
        const input = (match[2] || "").split(/\]\s*minimax\s*\[/i)[0].trim();
        calls.push({ index: calls.length, name, input });
    }
    if (!calls.length) return { text, calls: [] };
    return { text: text.replace(pattern, "").trim(), calls };
}

function projectAssistantEntry(sessionId: string, entry: PiSessionEntrySnapshot, turnId: string, context: PiSessionProjectionContext): AgentChatItem[] {
    const message = messageOf(entry);
    const content = parts(message.content);
    const time = timestampOf(entry);
    const output: AgentChatItem[] = [];
    let thinkingIndex = 0;
    content.forEach((part) => {
        if (part.type === "thinking" && string(part.thinking)) {
            output.push({
                ...baseItem(sessionId, entry, turnId),
                id: `${sessionId}:${entry.id}:thinking:${thinkingIndex++}`,
                role: "tool",
                title: context.labels?.reasoningTitle || DEFAULT_LABELS.reasoningTitle,
                text: string(part.thinking),
                detail: { kind: "reasoning", status: "completed", entryId: entry.id },
                ...(time ? { completedAt: time } : {}),
            });
        } else if (part.type === "toolCall" && string(part.id)) {
            const name = string(part.name);
            output.push({
                ...baseItem(sessionId, entry, turnId),
                id: `${sessionId}:${entry.id}:call:${string(part.id)}`,
                role: "tool",
                title: context.format?.toolTitle?.(name) || name,
                text: context.format?.toolText?.(name) || name,
                detail: { ...toolDetail(context, name, part.arguments, "running"), toolCallId: string(part.id), input: payloadText(part.arguments), entryId: entry.id },
            });
        }
    });
    // extractText 对数组取 text parts；对字符串 content（raw 缺失时的兜底投影）直接返回原文。
    const assistantText = extractText(message.content);
    // MiniMax 等模型可能把原生 <tool_call> 标记当纯文本输出，协议层解析不到结构化
    // toolCall part。这里把文本里的工具调用段拆成工具卡片，避免整段 raw 标记直接刷给用户。
    const { text: visibleText, calls } = splitRawToolCallText(assistantText);
    for (const call of calls) {
        output.push({
            ...baseItem(sessionId, entry, turnId),
            id: `${sessionId}:${entry.id}:raw-call:${call.index}`,
            role: "tool",
            title: call.name,
            text: call.name,
            detail: { kind: "tool", status: "completed", input: call.input, entryId: entry.id },
            ...(time ? { completedAt: time } : {}),
        });
    }
    if (visibleText) {
        output.push({
            ...baseItem(sessionId, entry, turnId),
            id: `${sessionId}:${entry.id}`,
            role: "assistant",
            title: context.labels?.assistantTitle || DEFAULT_LABELS.assistantTitle,
            text: visibleText,
            detail: { kind: "assistant", status: "completed", entryId: entry.id },
            ...(time ? { completedAt: time } : {}),
        });
    }
    const error = string(message.errorMessage);
    if (error) {
        output.push({
            ...baseItem(sessionId, entry, turnId),
            id: `${sessionId}:${entry.id}:error`,
            role: "error",
            text: error,
            detail: { kind: "error", status: string(message.stopReason) === "aborted" ? "aborted" : "error", entryId: entry.id },
            ...(time ? { completedAt: time } : {}),
        });
    }
    return output;
}

function projectMessageEntry(sessionId: string, entry: PiSessionEntrySnapshot, turnId: string, context: PiSessionProjectionContext, restored?: AgentMessageAttachment[]): AgentChatItem[] {
    const message = messageOf(entry);
    const role = entry.role || string(message.role);
    const time = timestampOf(entry);
    if (role === "assistant") return projectAssistantEntry(sessionId, entry, turnId, context);
    if (role === "user") {
        return [{
            ...baseItem(sessionId, entry, turnId),
            id: `${sessionId}:${entry.id}`,
            role: "user",
            text: extractText(message.content),
            ...(restored?.length ? { attachments: restored } : {}),
            ...(time ? { startedAt: time, completedAt: time, durationMs: 0 } : {}),
        }];
    }
    if (role === "toolResult") {
        const toolCallId = string(message.toolCallId);
        const name = string(message.toolName) || toolCallId;
        const isError = message.isError === true;
        return [{
            ...baseItem(sessionId, entry, turnId),
            id: `${sessionId}:${entry.id}`,
            role: "tool",
            title: context.format?.toolTitle?.(name) || name,
            text: toolSummary(context, name, message.content, isError),
            detail: {
                ...toolDetail(context, name, undefined, isError ? "failed" : "completed"),
                toolCallId,
                output: payloadText(message.content),
                entryId: entry.id,
            },
            ...(time ? { completedAt: time } : {}),
        }];
    }
    if (role === "bashExecution" || role === "custom") {
        return [{
            ...baseItem(sessionId, entry, turnId),
            id: `${sessionId}:${entry.id}`,
            role: "tool",
            title: role,
            text: extractText(message.content),
            detail: { kind: "tool", status: "completed", entryId: entry.id },
        }];
    }
    return [];
}

function pairToolCallsWithResults(items: AgentChatItem[]): AgentChatItem[] {
    const output = [...items];
    for (let resultIndex = 0; resultIndex < output.length; resultIndex += 1) {
        const result = output[resultIndex];
        const resultDetail = detailOf(result);
        const toolCallId = resultDetail.toolCallId;
        if (result.role !== "tool" || typeof toolCallId !== "string" || resultDetail.status === "running") continue;
        const callIndex = output.findIndex((item) => {
            const detail = detailOf(item);
            return item.threadId === result.threadId
                && item.turnId === result.turnId
                && item.role === "tool"
                && detail.toolCallId === toolCallId
                && detail.status === "running"
                && detail.entryId !== resultDetail.entryId;
        });
        if (callIndex < 0) continue;
        const call = output[callIndex]!;
        const callDetail = detailOf(call);
        output.splice(callIndex, 1);
        if (callIndex < resultIndex) resultIndex -= 1;
        output[resultIndex] = {
            ...result,
            title: result.title || call.title,
            text: result.text || call.text,
            detail: {
                ...callDetail,
                ...resultDetail,
                input: callDetail.input ?? resultDetail.input,
                callEntryId: callDetail.entryId,
            },
        };
    }
    return output;
}

function fallbackTurns(entries: PiSessionEntrySnapshot[]): Map<string, string> {
    const result = new Map<string, string>();
    let turn = "history-turn-1";
    let turnCount = 1;
    for (const entry of entries) {
        if (entry.type === "message" && (entry.role || string(messageOf(entry).role)) === "user") {
            turnCount += 1;
            turn = `history-turn-${turnCount}`;
        }
        result.set(entry.id, turn);
    }
    return result;
}

export function projectSessionEntries(
    sessionId: string,
    entries: PiSessionEntrySnapshot[],
    turnBindings: PiSessionTurnBindings = {},
    context: PiSessionProjectionContext = {},
): AgentChatItem[] {
    const transcript = entries.filter(isTranscriptEntry);
    const fallback = fallbackTurns(entries);
    const firstKept = new Map(entries.map((entry) => [entry.id, entry.compaction?.firstKeptEntryId]).filter((entry): entry is [string, string] => Boolean(entry[1])));
    const covered = new Set<string>();
    for (const [compactionId, keptId] of firstKept) {
        const compactionIndex = entries.findIndex((entry) => entry.id === compactionId);
        const keptIndex = entries.findIndex((entry) => entry.id === keptId);
        if (compactionIndex < 0 || keptIndex < 0) continue;
        for (const entry of entries.slice(0, keptIndex)) {
            if (isTranscriptEntry(entry) && entry.type !== "compaction" && !covered.has(entry.id)) covered.add(entry.id);
        }
    }

    const output: AgentChatItem[] = [];
    // 附件清单 entry 出现在其用户消息之前；compaction 边界或 abort 标记都会让它失效，
    // 避免压缩前轮次的附件被错误归属到压缩后保留的用户消息上。
    let pendingManifest: { id: string; attachments: AgentMessageAttachment[] } | undefined;
    for (const entry of entries) {
        if (covered.has(entry.id)) continue;
        if (entry.type === "compaction" && entry.compaction) {
            const keptId = entry.compaction.firstKeptEntryId;
            const keptIndex = entries.findIndex((candidate) => candidate.id === keptId);
            const coveredEntries = keptIndex > 0 ? entries.slice(0, keptIndex).filter((candidate) => covered.has(candidate.id)) : [];
            const from = coveredEntries.at(0)?.id;
            const to = coveredEntries.at(-1)?.id;
            const summary = entry.compaction.summary || entry.text || "";
            const turnId = turnBindings[entry.id] || (from ? turnBindings[from] || fallback.get(from) : "") || `history-compaction-${entry.id}`;
            output.push({
                id: `${sessionId}:${entry.id}`,
                itemId: entry.id,
                threadId: sessionId,
                turnId,
                role: "compaction",
                text: summary,
                detail: {
                    kind: "compaction",
                    status: "completed",
                    reason: compactionReason(entry),
                    summary,
                    tokensBefore: entry.compaction.tokensBefore,
                    ...(compactionTokensAfter(entry, summary) !== undefined ? { tokensAfter: compactionTokensAfter(entry, summary) } : {}),
                    ...(from && to ? { range: { fromEntryId: from, toEntryId: to } } : {}),
                },
                ...(timestampOf(entry) ? { completedAt: timestampOf(entry) } : {}),
            });
            pendingManifest = undefined;
            continue;
        }
        if (entry.type === "custom") {
            const manifest = restoredManifest(entry);
            if (manifest) {
                if (manifest.abortedEntryId) {
                    if (pendingManifest?.id === manifest.abortedEntryId) pendingManifest = undefined;
                } else if (manifest.attachments) {
                    pendingManifest = { id: entry.id, attachments: manifest.attachments };
                }
                continue;
            }
        }
        if (entry.type !== "message" || !isTranscriptEntry(entry)) continue;
        const role = entry.role || string(messageOf(entry).role);
        if (role !== "user") pendingManifest = undefined;
        output.push(...projectMessageEntry(sessionId, entry, turnBindings[entry.id] || fallback.get(entry.id) || entry.id, context, pendingManifest?.attachments));
        pendingManifest = undefined;
    }
    return pairToolCallsWithResults(output);
}

function snapshotFromEntry(raw: unknown): PiSessionEntrySnapshot | null {
    const entry = object(raw);
    const id = string(entry.id);
    const type = string(entry.type);
    if (!id || !type) return null;
    const message = object(entry.message);
    const firstKeptEntryId = string(entry.firstKeptEntryId) || string(object(entry.compaction).firstKeptEntryId);
    return {
        id,
        parentId: string(entry.parentId) || null,
        type,
        ...(Object.keys(message).length ? { role: string(message.role), text: extractText(message.content) } : {}),
        ...(type === "compaction" && firstKeptEntryId ? {
            compaction: {
                summary: string(entry.summary) || string(object(entry.compaction).summary),
                firstKeptEntryId,
                tokensBefore: number(entry.tokensBefore) || number(object(entry.compaction).tokensBefore) || 0,
            },
        } : {}),
        ...(string(entry.timestamp) ? { timestamp: string(entry.timestamp) } : {}),
        raw: entry,
    };
}

function detailOf(item: AgentChatItem): Record<string, unknown> {
    return object(item.detail);
}

function turnOf(item: AgentChatItem): string {
    return string(item.turnId);
}

function nowOf(context: PiSessionProjectionContext): number {
    return context.now?.() || Date.now();
}

function assistantGroups(timeline: AgentChatItem[], threadId: string, turnId: string): number[] {
    const groups = new Set<number>();
    for (const item of timeline) {
        if (item.threadId !== threadId || turnOf(item) !== turnId) continue;
        const detail = detailOf(item);
        const index = detail.liveMessageIndex;
        // Reasoning-only Codex messages are rendered as tool rows but still belong
        // to an assistant message. Dropping their index reuses an earlier slot.
        if (typeof index === "number") groups.add(index);
    }
    return [...groups].sort((left, right) => left - right);
}

function replaceItems(timeline: AgentChatItem[], replaced: AgentChatItem[], next: AgentChatItem[]): AgentChatItem[] {
    if (!replaced.length) return [...timeline, ...next];
    const ids = new Set(replaced.map((item) => item.id));
    const first = timeline.findIndex((item) => ids.has(item.id));
    if (first < 0) return [...timeline, ...next];
    return [...timeline.slice(0, first), ...next, ...timeline.slice(first).filter((item) => !ids.has(item.id))];
}

function liveAssistantItems(message: Record<string, unknown>, threadId: string, turnId: string, index: number, streaming: boolean, context: PiSessionProjectionContext): AgentChatItem[] {
    const entryTime = number(message.timestamp);
    const streamId = streaming ? context.streamId : undefined;
    const output: AgentChatItem[] = [];
    let thinkingIndex = 0;
    for (const part of parts(message.content)) {
        if (part.type === "thinking" && string(part.thinking)) {
            output.push({
                id: `${threadId}:${turnId}:live-assistant:${index}:thinking:${thinkingIndex++}`,
                itemId: `live-assistant:${index}:thinking:${thinkingIndex}`,
                threadId,
                turnId,
                role: "tool",
                title: context.labels?.reasoningTitle || DEFAULT_LABELS.reasoningTitle,
                text: string(part.thinking),
                detail: { kind: "reasoning", status: streaming ? "running" : "completed", liveMessageIndex: index },
                ...(streamId ? { streamId } : {}),
            });
        }
    }
    const assistantText = parts(message.content).filter((part) => part.type === "text").map((part) => string(part.text)).join("");
    if (assistantText) {
        output.push({
            id: `${threadId}:${turnId}:live-assistant:${index}:text`,
            itemId: `live-assistant:${index}:text`,
            threadId,
            turnId,
            role: "assistant",
            title: context.labels?.assistantTitle || DEFAULT_LABELS.assistantTitle,
            text: assistantText,
            detail: { kind: "assistant", status: streaming ? "running" : "completed", liveMessageIndex: index },
            ...(streamId ? { streamId } : {}),
            ...(entryTime ? { completedAt: entryTime } : {}),
        });
    }
    if (!output.length) {
        output.push({
            id: `${threadId}:${turnId}:live-assistant:${index}:pending`,
            itemId: `live-assistant:${index}:pending`,
            threadId,
            turnId,
            role: "assistant",
            title: context.labels?.assistantTitle || DEFAULT_LABELS.assistantTitle,
            text: "",
            detail: { kind: "assistant", status: streaming ? "running" : "completed", liveMessageIndex: index },
            ...(streamId ? { streamId } : {}),
        });
    }
    return output;
}

function upsertLiveTool(timeline: AgentChatItem[], item: AgentChatItem): AgentChatItem[] {
    const existing = timeline.find((candidate) => candidate.id === item.id);
    if (!existing) return [...timeline, item];
    return timeline.map((candidate) => candidate.id === item.id
        ? { ...candidate, ...item, detail: { ...detailOf(candidate), ...detailOf(item) } }
        : candidate);
}

function archiveMessage(timeline: AgentChatItem[], sessionId: string, entry: PiSessionEntrySnapshot, turnId: string, context: PiSessionProjectionContext): AgentChatItem[] {
    const projected = projectMessageEntry(sessionId, entry, turnId, context);
    const role = entry.role || string(messageOf(entry).role);
    if (role === "user") {
        const candidates = timeline.filter((item) => item.role === "user" && item.threadId === sessionId && turnOf(item) === turnId && !detailOf(item).entryId);
        const source = candidates.at(-1);
        // Archiving a live prompt is not task completion. Only a terminal agent event settles it.
        const live = projected.map((item) => ({
            ...item,
            // 发送时已挂到实时用户消息上的附件（含 assetRef）在 entry 归档时保留，不能被纯文本投影抹掉。
            attachments: item.attachments ?? source?.attachments,
            startedAt: source?.startedAt ?? item.startedAt,
            completedAt: source?.completedAt,
            durationMs: source?.durationMs,
        }));
        return replaceItems(timeline, candidates.slice(-1), live);
    }
    if (role === "assistant") {
        const groups = assistantGroups(timeline, sessionId, turnId);
        const text = extractText(messageOf(entry).content);
        let selected = groups.at(-1);
        for (const group of groups) {
            const candidate = timeline.filter((item) => item.role === "assistant" && detailOf(item).liveMessageIndex === group && turnOf(item) === turnId);
            if (candidate.length && candidate.map((item) => item.text).join("") === text) {
                selected = group;
                break;
            }
        }
        const replaced = typeof selected === "number" ? timeline.filter((item) => detailOf(item).liveMessageIndex === selected && turnOf(item) === turnId) : [];
        return replaceItems(timeline, replaced, projected);
    }
    if (role === "toolResult") {
        const toolCallId = string(messageOf(entry).toolCallId);
        const existing = timeline.filter((item) => item.role === "tool" && detailOf(item).toolCallId === toolCallId && item.threadId === sessionId && turnOf(item) === turnId);
        const source = existing[0];
        const merged = projected.map((item) => source ? { ...item, detail: { ...detailOf(source), ...detailOf(item), input: detailOf(source).input } } : item);
        return replaceItems(timeline, existing, merged);
    }
    return replaceItems(timeline, [], projected);
}

function compactionItem(sessionId: string, turnId: string, detail: AgentCompactionDetail, id: string, now: number): AgentChatItem {
    return {
        id,
        itemId: id.includes(":") ? id.slice(id.lastIndexOf(":") + 1) : id,
        threadId: sessionId,
        turnId,
        role: "compaction",
        text: detail.summary,
        detail,
        ...(detail.status === "running" ? { startedAt: now } : { completedAt: now }),
    };
}

function normalizeReason(value: unknown): AgentCompactionDetail["reason"] {
    return value === "threshold" || value === "overflow" ? value : "manual";
}

function liveCoveredRange(timeline: AgentChatItem[], sessionId: string, firstKeptEntryId: string): AgentCompactionDetail["range"] | undefined {
    const keptIndex = timeline.findIndex((item) => item.threadId === sessionId && item.itemId === firstKeptEntryId);
    if (keptIndex <= 0) return undefined;
    const covered = timeline.slice(0, keptIndex).filter((item) =>
        item.threadId === sessionId && item.role !== "compaction" && typeof item.itemId === "string" && item.itemId.startsWith("live-") === false
    );
    const from = covered.at(0)?.itemId;
    const to = covered.at(-1)?.itemId;
    return from && to && from !== firstKeptEntryId ? { fromEntryId: from, toEntryId: to } : undefined;
}

export function applyLiveEnvelope(
    timeline: AgentChatItem[],
    envelope: PiSessionEnvelope,
    context: PiSessionProjectionContext = {},
): AgentChatItem[] {
    if (!envelope || envelope.sessionId !== (timeline.find((item) => item.threadId === envelope.sessionId)?.threadId ?? envelope.sessionId)) {
        // Session filtering remains the caller's policy; projection itself is session-safe.
    }
    const sessionId = envelope.sessionId;
    const turnId = context.activeTurnId || timeline.at(-1)?.turnId || "";
    const now = nowOf(context);
    if (envelope.kind === "session_compact_failed" || envelope.kind === "error") {
        const message = string(object(envelope.payload).message) || string(object(envelope.payload).error) || "Compaction failed";
        if (envelope.kind === "error") {
            return [...timeline, {
                id: `${sessionId}:${turnId}:error:${now}`,
                itemId: `error:${now}`,
                threadId: sessionId,
                turnId,
                role: "error",
                text: message,
                detail: { kind: "error", status: "error" },
                completedAt: now,
            }];
        }
        const target = [...timeline].reverse().find((item) => item.role === "compaction" && item.threadId === sessionId);
        if (!target) return timeline;
        return timeline.map((item) => item === target
            ? { ...item, detail: { ...detailOf(item), kind: "compaction", status: "failed", error: message } as AgentCompactionDetail, completedAt: now }
            : item);
    }
    if (envelope.kind !== "agent") return timeline;
    const event = object(envelope.payload);
    const type = string(event.type);
    if (type === "message_start" || type === "message_update" || type === "message_end") {
        const message = object(event.message);
        const role = string(message.role);
        if (role !== "assistant") {
            if (role === "user" && type === "message_start") {
                const existing = timeline.find((item) => item.role === "user" && item.threadId === sessionId && turnOf(item) === turnId);
                if (existing) return timeline;
                return [...timeline, {
                    id: `${sessionId}:${turnId}:user`,
                    itemId: "user",
                    threadId: sessionId,
                    turnId,
                    role: "user",
                    text: extractText(message.content),
                    startedAt: now,
                }];
            }
            return timeline;
        }
        const groups = assistantGroups(timeline, sessionId, turnId);
        const group = groups.at(-1);
        if (type === "message_start" || group === undefined) {
            const index = (group ?? 0) + 1;
            const next = liveAssistantItems(message, sessionId, turnId, index, true, context);
            return replaceItems(timeline, [], next);
        }
        const replaced = timeline.filter((item) => detailOf(item).liveMessageIndex === group && turnOf(item) === turnId);
        return replaceItems(timeline, replaced, liveAssistantItems(message, sessionId, turnId, group, type !== "message_end", context));
    }
    if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
        const toolCallId = string(event.toolCallId);
        const name = string(event.toolName);
        const id = `${sessionId}:${turnId}:tool:${toolCallId}`;
        if (type === "tool_execution_end") {
            const existing = timeline.find((item) => item.id === id);
            const startedAt = (existing ? number(detailOf(existing).startedAt) : undefined) ?? now;
            const isError = event.isError === true;
            return upsertLiveTool(timeline, {
                id,
                itemId: `tool:${toolCallId}`,
                threadId: sessionId,
                turnId,
                role: "tool",
                title: context.format?.toolTitle?.(name) || name,
                text: toolSummary(context, name, event.result, isError),
                detail: {
                    ...toolDetail(context, name, undefined, isError ? "failed" : "completed"),
                    toolCallId,
                    output: payloadText(event.result),
                    startedAt,
                    completedAt: now,
                    durationMs: Math.max(0, now - startedAt),
                },
            });
        }
        const input = event.args;
        return upsertLiveTool(timeline, {
            id,
            itemId: `tool:${toolCallId}`,
            threadId: sessionId,
            turnId,
            role: "tool",
            title: context.format?.toolTitle?.(name) || name,
            text: context.format?.toolText?.(name) || name,
            detail: {
                ...toolDetail(context, name, input, "running"),
                toolCallId,
                input: payloadText(input),
                ...(type === "tool_execution_update" ? { output: payloadText(event.partialResult) } : { startedAt: now }),
            },
        });
    }
    if (type === "entry_appended") {
        const entry = snapshotFromEntry(event.entry);
        if (!entry) return timeline;
        if (entry.type === "compaction") {
            const existing = timeline.filter((item) => item.role === "compaction" && item.threadId === sessionId && !detailOf(item).entryId);
            const projected = projectSessionEntries(sessionId, [entry], context.turnBindings || {}, context);
            const latestCompaction = existing.at(-1);
            const next = projected.map((item) => ({ ...item, turnId, detail: { ...detailOf(item), ...(latestCompaction ? detailOf(latestCompaction) : {}), entryId: entry.id } }));
            return replaceItems(timeline, existing.slice(-1), next);
        }
        if (entry.type !== "message") return timeline;
        return archiveMessage(timeline, sessionId, entry, context.turnBindings?.[entry.id] || turnId, context);
    }
    if (type === "compaction_start" || type === "compaction_end") {
        const reason = normalizeReason(event.reason);
        const existing = timeline.find((item) => item.role === "compaction" && item.threadId === sessionId && detailOf(item).reason === reason && !detailOf(item).entryId);
        if (type === "compaction_start") {
            if (existing) return timeline;
            const id = `${sessionId}:${turnId}:compaction:${reason}`;
            return [...timeline, compactionItem(sessionId, turnId, { kind: "compaction", status: "running", reason, summary: "", tokensBefore: 0 }, id, now)];
        }
        const result = object(event.result);
        const firstKeptEntryId = string(result.firstKeptEntryId);
        const detail: AgentCompactionDetail = {
            kind: "compaction",
            status: event.aborted === true ? "aborted" : event.willRetry === true ? "running" : "completed",
            reason,
            summary: string(result.summary),
            tokensBefore: number(result.tokensBefore) || 0,
            ...(number(result.estimatedTokensAfter) !== undefined ? { tokensAfter: number(result.estimatedTokensAfter) } : {}),
            ...(liveCoveredRange(timeline, sessionId, firstKeptEntryId) ? { range: liveCoveredRange(timeline, sessionId, firstKeptEntryId) } : {}),
            ...(string(event.errorMessage) ? { error: string(event.errorMessage) } : {}),
        };
        if (existing) {
            return timeline.map((item) => item === existing
                ? { ...item, text: detail.summary, detail: { ...detailOf(item), ...detail }, completedAt: now }
                : item);
        }
        return [...timeline, compactionItem(sessionId, turnId, detail, `${sessionId}:${turnId}:compaction:${reason}`, now)];
    }
    if ((type === "agent_end" && event.willRetry !== true) || type === "agent_settled") {
        return timeline.map((item) => {
            if (item.threadId !== sessionId || turnOf(item) !== turnId) return item;
            if (item.role === "user" && item.completedAt === undefined) return { ...item, completedAt: now, durationMs: Math.max(0, now - (item.startedAt || now)) };
            if (item.streamId) return { ...item, streamId: undefined };
            return item;
        });
    }
    return timeline;
}
