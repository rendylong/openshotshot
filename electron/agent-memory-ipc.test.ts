// electron/agent-memory-ipc.test.ts
import { describe, expect, it } from "vitest";
import { parseMemoryReadInput, parseMemoryWriteInput } from "./agent-memory-ipc";

describe("parseMemoryReadInput", () => {
    it("接受 user", () => {
        expect(parseMemoryReadInput("user")).toEqual({ ok: true, scope: "user" });
    });
    it("接受 project + 绝对路径", () => {
        expect(parseMemoryReadInput("project", "/tmp/ws")).toEqual({ ok: true, scope: "project", workspacePath: "/tmp/ws" });
    });
    it.each([
        ["all", undefined, "非法范围"],
        ["project", undefined, "缺少工作区路径"],
        ["project", "relative/ws", "工作区路径必须是绝对路径"],
        ["project", 123, "工作区路径必须是绝对路径"],
    ])("拒绝 %j", (scope, workspacePath, message) => {
        const parsed = parseMemoryReadInput(scope, workspacePath);
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) expect(parsed.error).toContain(message as string);
    });
});

describe("parseMemoryWriteInput", () => {
    it("接受合法 user replace（含空串——面板清空语义）", () => {
        expect(parseMemoryWriteInput({ scope: "user", mode: "replace", content: "" })).toEqual({
            ok: true,
            value: { scope: "user", mode: "replace", content: "" },
        });
    });
    it("接受合法 project append（携带绝对 workspacePath）", () => {
        expect(parseMemoryWriteInput({ scope: "project", workspacePath: "/tmp/ws", mode: "append", content: "x" })).toEqual({
            ok: true,
            value: { scope: "project", workspacePath: "/tmp/ws", mode: "append", content: "x" },
        });
    });
    it.each([
        [null, "非法请求"],
        [{}, "非法请求"],
        [{ scope: "all", mode: "append", content: "x" }, "非法范围"],
        [{ scope: "user", mode: "upsert", content: "x" }, "非法写入模式"],
        [{ scope: "user", mode: "append" }, "非法内容"],
        [{ scope: "user", mode: "append", content: "x".repeat(8001) }, "内容过长"],
        [{ scope: "project", mode: "append", content: "x" }, "缺少工作区路径"],
        [{ scope: "project", workspacePath: "relative", mode: "append", content: "x" }, "工作区路径必须是绝对路径"],
    ])("拒绝 %j（含 %s）", (raw, message) => {
        const parsed = parseMemoryWriteInput(raw);
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) expect(parsed.error).toContain(message as string);
    });
});
