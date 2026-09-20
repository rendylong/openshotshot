import { randomUUID } from "node:crypto";

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { AgentApprovalDecision, AgentApprovalEvent, AgentApprovalMode, AgentApprovalRequest, PiSessionEnvelope } from "@/lib/agent/pi-agent-types";
import { isAgentApprovalMode } from "@/lib/agent/pi-session-contract";

export { isAgentApprovalMode };
export type { AgentApprovalDecision, AgentApprovalMode, AgentApprovalRequest };

export const DEFAULT_AGENT_APPROVAL_MODE: AgentApprovalMode = "confirm_changes";

/** 需要审批门拦下的 SDK 内置工具；read 与画布域工具不在其列。 */
export const APPROVAL_GATED_TOOLS: ReadonlySet<string> = new Set(["bash", "edit", "write"]);

/** 模型可见的拒绝理由：明确"不要原样重试"，避免模型反复弹同一请求。 */
export const APPROVAL_DENIED_REASON = "用户拒绝了这次操作。不要原样重试；先询问用户或调整方案后再继续。";

export type AgentApprovalRequestDetail = Omit<AgentApprovalRequest, "requestId">;

export type PiApprovalBroker = {
    request: (sessionId: string, detail: AgentApprovalRequestDetail) => Promise<AgentApprovalDecision | undefined>;
    respond: (sessionId: string, requestId: string, decision: AgentApprovalDecision) => { ok: true } | { ok: false; error: string };
    disposeSession: (sessionId: string) => void;
    dispose: () => void;
};

type BrokerOptions = {
    send: (envelope: PiSessionEnvelope) => void;
    onWaitingChange?: (sessionId: string, waiting: boolean) => void;
    createRequestId?: () => string;
};

type PendingApproval = {
    sessionId: string;
    requestId: string;
    finish: (decision?: AgentApprovalDecision) => void;
};

function requestKey(sessionId: string, requestId: string) {
    return `${sessionId}:${requestId}`;
}

/**
 * 审批请求/响应桥：主进程扩展发起 request → `approval_request` 信封推给 renderer，
 * 用户在审批卡片上决策后经 `agent:respond-to-approval` 回来。会话关闭或 dispose 时
 * 所有挂起请求以 undefined 结束（调用方按拒绝处理）。
 */
export function createPiApprovalBroker(options: BrokerOptions): PiApprovalBroker {
    const pending = new Map<string, PendingApproval>();
    const createRequestId = options.createRequestId ?? randomUUID;

    const notifyWaiting = (sessionId: string) => {
        const waiting = [...pending.values()].some((entry) => entry.sessionId === sessionId);
        options.onWaitingChange?.(sessionId, waiting);
    };

    const cleanup = (entry: PendingApproval) => {
        pending.delete(requestKey(entry.sessionId, entry.requestId));
        options.send({ sessionId: entry.sessionId, kind: "approval_request", payload: { type: "resolved", requestId: entry.requestId } satisfies AgentApprovalEvent });
        notifyWaiting(entry.sessionId);
    };

    return {
        request: (sessionId, detail) => {
            const requestId = createRequestId();
            return new Promise<AgentApprovalDecision | undefined>((resolve) => {
                const entry: PendingApproval = {
                    sessionId,
                    requestId,
                    finish: (decision) => {
                        if (pending.get(requestKey(sessionId, requestId)) !== entry) return;
                        cleanup(entry);
                        resolve(decision);
                    },
                };
                pending.set(requestKey(sessionId, requestId), entry);
                options.send({
                    sessionId,
                    kind: "approval_request",
                    payload: { type: "request", requestId, approval: detail } satisfies AgentApprovalEvent,
                });
                notifyWaiting(sessionId);
            });
        },
        respond: (sessionId, requestId, decision) => {
            const entry = pending.get(requestKey(sessionId, requestId));
            if (!entry) return { ok: false, error: "审批请求不存在或已结束" };
            entry.finish(decision);
            return { ok: true };
        },
        disposeSession: (sessionId) => {
            [...pending.values()].filter((entry) => entry.sessionId === sessionId).forEach((entry) => entry.finish());
        },
        dispose: () => {
            [...pending.values()].forEach((entry) => entry.finish());
        },
    };
}

/** 从 tool_call 事件提炼审批详情；非受控工具返回 undefined（直接放行）。cwd 仅 bash 详情携带。 */
function approvalDetailFor(toolName: string, input: unknown, cwd?: string): AgentApprovalRequestDetail | undefined {
    if (!APPROVAL_GATED_TOOLS.has(toolName)) return undefined;
    const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    if (toolName === "bash") {
        if (typeof source.command !== "string" || !source.command) return undefined;
        return {
            method: "exec/command/requestApproval",
            command: source.command,
            ...(cwd ? { cwd } : {}),
            reason: "请求执行 shell 命令",
        };
    }
    if (typeof source.path !== "string" || !source.path) return undefined;
    return toolName === "edit"
        ? { method: "item/fileChange/requestApproval", path: source.path, reason: "请求编辑文件内容" }
        : { method: "item/fileChange/requestApproval", path: source.path, reason: "请求创建或覆盖文件" };
}

/** 「本会话允许」的记忆键：bash 记完整命令，edit/write 记目标文件路径。 */
function approvalAllowKey(toolName: string, input: unknown): string {
    const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    return toolName === "bash" ? String(source.command ?? "") : String(source.path ?? "");
}

export type ApprovalGateOptions = {
    getMode: () => AgentApprovalMode;
    /** 会话工作目录（runtime cwd）；undefined = 无工作区，bash 详情不带 cwd。 */
    getCwd?: () => string | undefined;
    request: (detail: AgentApprovalRequestDetail) => Promise<AgentApprovalDecision | undefined>;
};

/**
 * codex 式审批门：confirm_changes 模式下 bash/edit/write 每次调用先问用户；
 * full_access 全部放行。挂起请求被 dispose/中断结束时按拒绝处理并 block。
 */
export function createApprovalGate(options: ApprovalGateOptions): ExtensionFactory {
    const sessionAllowlist = new Set<string>();
    return (pi) => {
        pi.on("tool_call", (event) => {
            const detail = approvalDetailFor(event.toolName, event.input, options.getCwd?.());
            if (!detail) return undefined;
            if (options.getMode() === "full_access") return undefined;
            const allowKey = `${event.toolName}\0${approvalAllowKey(event.toolName, event.input)}`;
            if (sessionAllowlist.has(allowKey)) return undefined;
            return (async (): Promise<{ block: true; reason: string } | undefined> => {
                const decision = await options.request(detail);
                if (decision === "acceptForSession") {
                    sessionAllowlist.add(allowKey);
                    return undefined;
                }
                if (decision === "accept") return undefined;
                return { block: true, reason: APPROVAL_DENIED_REASON };
            })();
        });
    };
}
