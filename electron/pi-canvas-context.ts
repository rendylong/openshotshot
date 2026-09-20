import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { PiSessionEnvelope, PiSessionScope } from "@/lib/agent/pi-agent-types";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-op-types";

export type CanvasSnapshotCache = {
    set(scope: PiSessionScope, snapshot: CanvasAgentSnapshot): void;
    get(canvasId: string): CanvasAgentSnapshot | undefined;
};

export function createCanvasSnapshotCache(): CanvasSnapshotCache {
    const snapshots = new Map<string, CanvasAgentSnapshot>();
    return {
        set(scope, snapshot) {
            snapshots.set(scope.canvasId, snapshot);
        },
        get(canvasId) {
            return snapshots.get(canvasId);
        },
    };
}

/**
 * Extension 在 SDK 支持的入口应用本轮系统提示并转发 compaction 事件；画布快照由 `canvas_get_state` 工具按需读取，
 * 不作为 user 消息注入每次 LLM 请求，避免模型把画布状态误认为用户意图。
 */
export function createShotshotSessionExtension(input: {
    sessionId: string | (() => string);
    send: (envelope: PiSessionEnvelope) => void;
    getSystemPrompt?: () => string | undefined;
}): ExtensionFactory {
    const getSessionId = () => (typeof input.sessionId === "function" ? input.sessionId() : input.sessionId);
    let compacting = false;
    return (extension) => {
        extension.on("before_provider_request", (event, ctx) => {
            const payload = event.payload as { instructions?: string; input?: Array<{ role?: string; content?: unknown }>; tools?: Array<{ name?: string; function?: { name?: string } }> };
            const prompt = payload.instructions ?? JSON.stringify(payload.input?.filter((entry) => entry.role === "system" || entry.role === "developer") ?? []);
            extension.appendEntry("shotshot:prompt-diagnostic", {
                model: ctx.model?.id,
                imageInput: ctx.model?.input.includes("image"),
                tools: payload.tools?.map((tool) => tool.name ?? tool.function?.name),
                hostRule: prompt.includes("当前运行时能力高于对话历史中的旧结论"),
            });
        });
        extension.on("before_agent_start", () => {
            const systemPrompt = input.getSystemPrompt?.();
            return systemPrompt === undefined ? undefined : { systemPrompt };
        });

        extension.on("session_before_compact", (event) => {
            compacting = true;
            input.send({
                sessionId: getSessionId(),
                kind: "agent",
                payload: {
                    type: event.type,
                    reason: event.reason,
                    willRetry: event.willRetry,
                    firstKeptEntryId: event.preparation.firstKeptEntryId,
                    isSplitTurn: event.preparation.isSplitTurn,
                    tokensBefore: event.preparation.tokensBefore,
                },
            });
        });

        extension.on("session_compact", () => {
            compacting = false;
        });

        extension.on("session_compact_failed", (event) => {
            compacting = false;
            input.send({
                sessionId: getSessionId(),
                kind: "session_compact_failed",
                payload: event,
            });
        });
    };
}
