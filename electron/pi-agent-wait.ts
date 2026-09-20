import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import agentWait from "pi-agent-wait/index";
import type { GenerationStatusEntry } from "@/lib/agent/generation-status";

export const WAIT_TOOL_SUMMARY = {
    name: "wait",
    label: "Wait",
    promptSnippet: '提交生成后立即调用 wait 并传 nodeIds=[生成节点id]（图片建议 seconds=120、视频建议 seconds=300），宿主会等到全部节点到终态或提前失败才返回，期间无需也无法插入其他工具调用；超时后带相同 nodeIds 续等，多次续等仍超时则向用户报告当前状态。仅在与生成无关的等待场景才用无 nodeIds 的 blind wait（30-60 秒量级），不能把 wait 和 generation_get_status 放在同一批并行调用中。',
};

export type WaitStatusProvider = (nodeIds: string[]) =>
    Promise<{ ok: true; entries: GenerationStatusEntry[] } | { ok: false; error: string }>;

export type WaitToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

export type CreateShotshotWaitExtensionOptions = { waitStatus?: WaitStatusProvider };

const BLIND_WAIT_MAX_SECONDS = 300;
export const SMART_WAIT_MAX_SECONDS = 1800;
export const SMART_WAIT_RUN_BUDGET_MS = 3_600_000;
export const SMART_POLL_INTERVAL_MS = 5_000;
export const SMART_NOT_FOUND_GRACE_MS = 30_000;

const WAIT_DESCRIPTION = [
    'Wait host-side without model inference. Only mode="block" is supported (default). Two modes:',
    '(1) smart wait — pass nodeIds (1-20 generation node ids). The host polls the local generation cache every 5s and returns as soon as ALL nodes reach terminal state; it returns EARLY when any node fails or is interrupted (outcome="failed", react instead of waiting), or when every unresolved id has been not_found for 30s (outcome="not_found", verify with generation_get_status before doing anything, never resubmit blindly). seconds 1-1800: images ~120, videos ~300. On outcome="timeout" re-wait with the same nodeIds; after repeated timeouts report the current status to the user instead of chaining more waits.',
    '(2) blind wait — no nodeIds, seconds 1-300, for delays unrelated to generation only.',
    'Never put wait and generation_get_status in the same parallel batch. Cancellation stops waiting only, not the generation tasks. Elapsed time does not prove generation succeeded.',
].join(" ");

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(false);
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve(true);
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            resolve(false);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function formatDuration(ms: number): string {
    const seconds = Math.round(ms / 1000);
    return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
}

type SmartOutcome = "completed" | "failed" | "timeout" | "not_found" | "cancelled";

function entryView(entry: GenerationStatusEntry) {
    const status = String((entry as { status?: string }).status);
    return {
        nodeId: entry.nodeId,
        status,
        error: (entry as { error?: string }).error,
        notFound: status === "not_found",
        terminal: status !== "not_found" && (entry as { terminal?: boolean }).terminal === true,
        hardFailure: status === "failed" || status === "interrupted",
    };
}

function smartSummary(outcome: SmartOutcome, waitedMs: number, entries: GenerationStatusEntry[], trigger: { nodeId: string; status: string; error?: string } | undefined): string {
    const views = entries.map(entryView);
    const succeeded = views.filter((v) => v.status === "succeeded").length;
    const failed = views.filter((v) => v.status === "failed" || v.status === "interrupted").length;
    const timedOut = views.filter((v) => v.status === "timed_out").length;
    const elapsed = formatDuration(waitedMs);
    let line: string;
    if (outcome === "completed") {
        line = `等待结束（${elapsed}）：${views.length} 个节点全部到终态（成功 ${succeeded}、失败 ${failed}、超时 ${timedOut}）。`;
    } else if (outcome === "failed" && trigger) {
        line = `节点 ${trigger.nodeId} 失败（${trigger.error || trigger.status}），等待提前结束（${elapsed}）；可对剩余节点带其余 nodeIds 继续 wait。`;
    } else if (outcome === "timeout") {
        line = `已等待 ${elapsed} 未全部到终态；可带相同 nodeIds 再次 wait 续等，若已多次续等仍超时，请向用户报告当前状态。`;
    } else if (outcome === "not_found") {
        line = `连续 ${formatDuration(SMART_NOT_FOUND_GRACE_MS)} 未找到生成记录；先用 generation_get_status 排查或向用户确认，勿直接重新提交（防双计费）。`;
    } else {
        line = `等待已取消（${elapsed}）；生成任务本身未受影响。`;
    }
    return `${line}\n${JSON.stringify({ outcome, waitedMs, ...(trigger ? { trigger } : {}), tasks: entries })}`;
}

/** Keep upstream timing/budgeting for blind waits; smart waits poll the host cache. */
export function createShotshotWaitExtension(options: CreateShotshotWaitExtensionOptions = {}): ExtensionFactory {
    const waitStatus = options.waitStatus;
    const active = new Set<AbortController>();
    const cancelWaits = () => {
        for (const controller of active) controller.abort();
    };
    return (pi) => {
        const smartBudget = { remainingMs: SMART_WAIT_RUN_BUDGET_MS };
        pi.on("input", (event) => {
            if (event.source !== "extension") cancelWaits();
            return { action: "continue" };
        });
        pi.on("session_shutdown", cancelWaits);
        pi.on("agent_start", () => {
            smartBudget.remainingMs = SMART_WAIT_RUN_BUDGET_MS;
        });
        const executeSmartWait = async (toolCallId: string, params: { seconds: number; reason: string }, nodeIds: string[], signal: AbortSignal | undefined, onUpdate: unknown): Promise<WaitToolResult> => {
            const seconds = Math.floor(Number(params.seconds));
            if (!Number.isFinite(seconds) || seconds < 1 || seconds > SMART_WAIT_MAX_SECONDS) {
                throw new Error(`wait seconds 必须为 1-${SMART_WAIT_MAX_SECONDS}（nodeIds 模式）。`);
            }
            const allowedMs = Math.min(seconds * 1000, smartBudget.remainingMs);
            if (allowedMs <= 0) {
                throw new Error("smart wait 的本次运行等待预算（3600s）已耗尽；请向用户报告当前生成状态，不要继续等待。");
            }
            if (!waitStatus) {
                throw new Error("当前运行环境不支持按节点等待（缺少状态源）；请改用无 nodeIds 的 wait。");
            }
            const startedAt = Date.now();
            const deadline = startedAt + allowedMs;
            const update = (text: string) => (onUpdate as ((u: unknown) => void) | undefined)?.({ content: [{ type: "text", text }], details: { kind: "duration", smart: true } });
            update(`等待 ${nodeIds.length} 个生成节点（最长 ${formatDuration(allowedMs)}）：${params.reason}`);
            const controller = new AbortController();
            active.add(controller);
            const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
            try {
                let notFoundSince: number | null = null;
                let lastEntries: GenerationStatusEntry[] = [];
                for (;;) {
                    const result = await waitStatus(nodeIds);
                    if (!result.ok) throw new Error(`等待失败：${result.error}`);
                    lastEntries = result.entries;
                    const returned = new Set<string>();
                    for (const entry of lastEntries) {
                        returned.add(entry.nodeId);
                        const sourceNodeId = (entry as { sourceNodeId?: string }).sourceNodeId;
                        if (sourceNodeId !== undefined) returned.add(sourceNodeId);
                    }
                    lastEntries = [...lastEntries, ...nodeIds.filter((id) => !returned.has(id)).map((id) => ({ nodeId: id, status: "not_found" as const }))];
                    const views = lastEntries.map(entryView);
                    const now = Date.now();
                    const triggerView = views.find((v) => v.hardFailure);
                    if (triggerView) {
                        const trigger = { nodeId: triggerView.nodeId, status: triggerView.status, error: triggerView.error };
                        return {
                            content: [{ type: "text", text: smartSummary("failed", now - startedAt, lastEntries, trigger) }],
                            details: { outcome: "failed", mode: "block", smart: true, elapsedMs: now - startedAt, trigger },
                        };
                    }
                    const unresolved = views.filter((v) => !v.terminal);
                    if (unresolved.length === 0) {
                        return {
                            content: [{ type: "text", text: smartSummary("completed", now - startedAt, lastEntries, undefined) }],
                            details: { outcome: "completed", mode: "block", smart: true, elapsedMs: now - startedAt },
                        };
                    }
                    const allNotFound = unresolved.every((v) => v.notFound);
                    if (allNotFound) {
                        if (notFoundSince === null) notFoundSince = now;
                        else if (now - notFoundSince >= SMART_NOT_FOUND_GRACE_MS) {
                            return {
                                content: [{ type: "text", text: smartSummary("not_found", now - startedAt, lastEntries, undefined) }],
                                details: { outcome: "not_found", mode: "block", smart: true, elapsedMs: now - startedAt },
                            };
                        }
                    } else {
                        notFoundSince = null;
                    }
                    if (now >= deadline) {
                        return {
                            content: [{ type: "text", text: smartSummary("timeout", now - startedAt, lastEntries, undefined) }],
                            details: { outcome: "timeout", mode: "block", smart: true, elapsedMs: now - startedAt },
                        };
                    }
                    update(`等待中（已等 ${formatDuration(now - startedAt)}）：${params.reason}`);
                    if (!(await sleep(Math.min(SMART_POLL_INTERVAL_MS, deadline - now), combined))) {
                        const elapsedMs = Date.now() - startedAt;
                        return {
                            content: [{ type: "text", text: smartSummary("cancelled", elapsedMs, lastEntries, undefined) }],
                            details: { outcome: "cancelled", mode: "block", smart: true, elapsedMs },
                        };
                    }
                }
            } finally {
                active.delete(controller);
                smartBudget.remainingMs = Math.max(0, smartBudget.remainingMs - (Date.now() - startedAt));
            }
        };
        const registerTool = (tool: ToolDefinition<any>) => {
            if (tool.name !== "wait") return;
            const adapted: ToolDefinition<any> = {
                ...tool,
                ...WAIT_TOOL_SUMMARY,
                description: WAIT_DESCRIPTION,
                promptGuidelines: [WAIT_TOOL_SUMMARY.promptSnippet],
                parameters: Type.Object({
                    ...tool.parameters.properties,
                    seconds: Type.Number({
                        minimum: 1,
                        maximum: SMART_WAIT_MAX_SECONDS,
                        description: `等待秒数（1-${SMART_WAIT_MAX_SECONDS}）。传 nodeIds 时可取长值（图片建议 120、视频建议 300，超时可续等）；不传 nodeIds 的 blind 等待运行时上限 300 秒，超限会被拒绝。`,
                    }),
                    nodeIds: Type.Optional(Type.Array(Type.String({ description: "生成节点 id（来自提交类工具回执）" }), { minItems: 1, maxItems: 20, description: "生成节点 id 列表：传入后进入 smart 等待，宿主轮询到全部终态/早退条件才返回" })),
                    mode: Type.Optional(Type.Literal("block", { default: "block" })),
                }),
                async execute(toolCallId, raw, signal, onUpdate, ctx) {
                    const params = raw as { seconds: number; reason: string; mode?: string; nodeIds?: string[] };
                    if (params.mode !== undefined && params.mode !== "block") throw new Error('wait supports only mode="block".');
                    const nodeIds = (params.nodeIds ?? []).map((id) => String(id).trim()).filter(Boolean);
                    if (nodeIds.length) return executeSmartWait(toolCallId, params, nodeIds, signal, onUpdate);
                    if (!Number.isInteger(params.seconds) || params.seconds < 1 || params.seconds > BLIND_WAIT_MAX_SECONDS) {
                        throw new Error(`wait seconds 必须为 1-${BLIND_WAIT_MAX_SECONDS}（blind 模式）；传 nodeIds 时上限 ${SMART_WAIT_MAX_SECONDS}。`);
                    }
                    const controller = new AbortController();
                    active.add(controller);
                    try {
                        const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
                        return await tool.execute(toolCallId, { ...params, mode: "block" }, combinedSignal, onUpdate, { ...ctx, hasUI: false });
                    } finally {
                        active.delete(controller);
                    }
                },
            };
            pi.registerTool(adapted);
        };
        // Upstream's input hook detaches block waits and schedules future turns. The
        // host input hook above cancels them instead; other lifecycle hooks stay intact.
        return agentWait(new Proxy(pi, {
            get(target, property) {
                if (property === "registerTool") return registerTool;
                if (property === "on") return (event: string, handler: unknown) => {
                    if (event !== "input") (target.on as (name: string, callback: unknown) => void)(event, handler);
                };
                return Reflect.get(target, property);
            },
        }) as ExtensionAPI);
    };
}
