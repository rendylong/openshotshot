import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { APPROVAL_DENIED_REASON, createApprovalGate, createPiApprovalBroker, DEFAULT_AGENT_APPROVAL_MODE, isAgentApprovalMode } from "./pi-agent-approval";
import type { AgentApprovalDecision, PiSessionEnvelope } from "@/lib/agent/pi-agent-types";

// 与 pi-agent-wait.test.ts 相同的宿主 mock：只收集 tool_call 处理器。
function gateHarness(gate: ReturnType<typeof createApprovalGate>) {
    const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
    const pi = {
        on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
            handlers.set(event, [...handlers.get(event) ?? [], handler]);
        },
    } as unknown as ExtensionAPI;
    gate(pi);
    const toolCallHandlers = handlers.get("tool_call") ?? [];
    return async (toolName: string, input: unknown) => {
        const results = await Promise.all(toolCallHandlers.map((handler) => handler({ type: "tool_call", toolCallId: "t1", toolName, input }, {} as ExtensionContext)));
        return results.at(-1);
    };
}

function envelopes(send: ReturnType<typeof vi.fn>) {
    return send.mock.calls.map((call: unknown[]) => call[0] as PiSessionEnvelope);
}

describe("agent approval mode", () => {
    it("defaults to confirm_changes and validates mode values", () => {
        expect(DEFAULT_AGENT_APPROVAL_MODE).toBe("confirm_changes");
        expect(isAgentApprovalMode("confirm_changes")).toBe(true);
        expect(isAgentApprovalMode("full_access")).toBe(true);
        expect(isAgentApprovalMode("auto")).toBe(false);
        expect(isAgentApprovalMode(undefined)).toBe(false);
    });
});

describe("createApprovalGate", () => {
    it("allows everything in full_access without asking", async () => {
        const request = vi.fn(async () => "accept" as AgentApprovalDecision);
        const call = gateHarness(createApprovalGate({ getMode: () => "full_access", request }));
        await expect(call("bash", { command: "rm -rf /" })).resolves.toBeUndefined();
        await expect(call("edit", { path: "/tmp/a.md", edits: [] })).resolves.toBeUndefined();
        await expect(call("write", { path: "/tmp/b.md", content: "x" })).resolves.toBeUndefined();
        expect(request).not.toHaveBeenCalled();
    });

    it("lets read and canvas tools through in confirm mode", async () => {
        const request = vi.fn(async () => "accept" as AgentApprovalDecision);
        const call = gateHarness(createApprovalGate({ getMode: () => "confirm_changes", request }));
        await expect(call("read", { path: "/tmp/a.md" })).resolves.toBeUndefined();
        await expect(call("canvas_get_state", {})).resolves.toBeUndefined();
        expect(request).not.toHaveBeenCalled();
    });

    it("blocks bash/edit/write until approved in confirm mode", async () => {
        let decision: AgentApprovalDecision | undefined = "accept";
        const request = vi.fn(async () => decision);
        const call = gateHarness(createApprovalGate({ getMode: () => "confirm_changes", request }));

        await expect(call("bash", { command: "ls" })).resolves.toBeUndefined();
        await expect(call("edit", { path: "/tmp/a.md", edits: [] })).resolves.toBeUndefined();
        await expect(call("write", { path: "/tmp/b.md", content: "x" })).resolves.toBeUndefined();
        expect(request).toHaveBeenCalledTimes(3);

        decision = "decline";
        const blocked = await call("bash", { command: "ls" });
        expect(blocked).toEqual({ block: true, reason: APPROVAL_DENIED_REASON });

        // 会话关闭/中断导致请求被丢弃（undefined 决议）时同样按拒绝处理。
        decision = undefined;
        await expect(call("bash", { command: "ls" })).resolves.toEqual({ block: true, reason: APPROVAL_DENIED_REASON });
    });

    it("remembers acceptForSession per tool+target for the rest of the session", async () => {
        let decision: AgentApprovalDecision | undefined = "acceptForSession";
        const request = vi.fn(async () => decision);
        const call = gateHarness(createApprovalGate({ getMode: () => "confirm_changes", request }));

        await expect(call("bash", { command: "npm test" })).resolves.toBeUndefined();
        await expect(call("bash", { command: "npm test" })).resolves.toBeUndefined();
        expect(request).toHaveBeenCalledTimes(1);

        // 其它命令、其它路径仍然要问。
        await expect(call("bash", { command: "npm run build" })).resolves.toBeUndefined();
        expect(request).toHaveBeenCalledTimes(2);

        await expect(call("write", { path: "/tmp/b.md", content: "x" })).resolves.toBeUndefined();
        await expect(call("write", { path: "/tmp/b.md", content: "y" })).resolves.toBeUndefined();
        expect(request).toHaveBeenCalledTimes(3);
        await expect(call("write", { path: "/tmp/c.md", content: "y" })).resolves.toBeUndefined();
        expect(request).toHaveBeenCalledTimes(4);

        decision = "decline";
        await expect(call("edit", { path: "/tmp/d.md", edits: [] })).resolves.toEqual({ block: true, reason: APPROVAL_DENIED_REASON });
    });

    // 直接断言 request mock 收到的详情，不经 broker。
    it("includes cwd in bash details when the gate provides one and omits it otherwise", async () => {
        const request = vi.fn(async () => "accept" as AgentApprovalDecision);
        const call = gateHarness(createApprovalGate({ getMode: () => "confirm_changes", getCwd: () => "/Users/me/project", request }));

        await call("bash", { command: "ls" });
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            method: "exec/command/requestApproval",
            command: "ls",
            cwd: "/Users/me/project",
        }));

        // edit/write 详情不带 cwd（路径已足够定位）。vitest 4 的 objectContaining
        // 把 `cwd: undefined` 视为"键必须存在"，这里沿用 not.objectContaining 语义。
        await call("write", { path: "/tmp/x.md", content: "y" });
        expect(request).toHaveBeenLastCalledWith(expect.objectContaining({
            method: "item/fileChange/requestApproval",
            path: "/tmp/x.md",
        }));
        expect(request).toHaveBeenLastCalledWith(expect.not.objectContaining({ cwd: expect.anything() }));

        // getCwd 未提供（无工作区）时 bash 详情不含 cwd 键。
        const noCwd = gateHarness(createApprovalGate({ getMode: () => "confirm_changes", request }));
        await noCwd("bash", { command: "pwd" });
        expect(request).toHaveBeenLastCalledWith(expect.not.objectContaining({ cwd: expect.anything() }));
    });
});

describe("createPiApprovalBroker", () => {
    it("sends request envelopes and resolves with the user decision", async () => {
        const send = vi.fn();
        const broker = createPiApprovalBroker({ send, createRequestId: () => "req-1" });
        const pending = broker.request("session-1", { method: "exec/command/requestApproval", command: "ls" });

        expect(envelopes(send)).toEqual([
            { sessionId: "session-1", kind: "approval_request", payload: { type: "request", requestId: "req-1", approval: { method: "exec/command/requestApproval", command: "ls" } } },
        ]);
        expect(broker.respond("session-1", "req-1", "acceptForSession")).toEqual({ ok: true });
        await expect(pending).resolves.toBe("acceptForSession");
        expect(envelopes(send).at(-1)?.payload).toEqual({ type: "resolved", requestId: "req-1" });

        expect(broker.respond("session-1", "req-1", "accept")).toEqual({ ok: false, error: "审批请求不存在或已结束" });
    });

    it("resolves dangling requests as undefined on dispose", async () => {
        const send = vi.fn();
        const broker = createPiApprovalBroker({ send, createRequestId: () => "req-2" });
        const pending = broker.request("session-1", { method: "item/fileChange/requestApproval", path: "/tmp/a.md" });
        const other = broker.request("session-2", { method: "exec/command/requestApproval", command: "pwd" });

        broker.disposeSession("session-1");
        await expect(pending).resolves.toBeUndefined();
        expect(other).toBeInstanceOf(Promise);

        broker.dispose();
        await expect(other).resolves.toBeUndefined();
        expect(broker.respond("session-2", "req-2", "decline").ok).toBe(false);
    });
});
