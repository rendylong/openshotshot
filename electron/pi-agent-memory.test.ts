// electron/pi-agent-memory.test.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MEMORY_TOOL_NAME, MEMORY_TOOL_SUMMARY, createShotshotMemoryExtension } from "./pi-agent-memory";

function harness(getWorkspacePath: () => string | undefined, root: string) {
    const tools: ToolDefinition<any>[] = [];
    createShotshotMemoryExtension({ getWorkspacePath, root })({
        registerTool: (tool: ToolDefinition<any>) => tools.push(tool),
    } as unknown as ExtensionAPI);
    const ctx = { hasUI: false } as unknown as ExtensionContext;
    const run = (params: unknown) =>
        tools[0]!.execute("memory-call", params, undefined, undefined, ctx) as Promise<{ content: Array<{ type: string; text: string }> }>;
    return { tools, run };
}

let dir: string;   // 用户记忆 root
let wsDir: string; // 模拟项目工作区

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "shotshot-memory-ext-"));
    wsDir = await mkdtemp(join(tmpdir(), "shotshot-memory-ext-ws-"));
});
afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(wsDir, { recursive: true, force: true });
});

describe("shotshot memory extension", () => {
    it("注册且仅注册 memory_write，摘要即工具名", () => {
        const h = harness(() => undefined, dir);
        expect(h.tools.map((t) => t.name)).toEqual([MEMORY_TOOL_NAME]);
        expect(MEMORY_TOOL_SUMMARY.name).toBe("memory_write");
    });

    it("append 写入用户记忆，确认文本含写入内容与生效时机", async () => {
        const h = harness(() => undefined, dir);
        const result = await h.run({ level: "user", mode: "append", content: "品牌色 #0EA5E9" });
        expect(result.content[0]!.text).toContain("品牌色 #0EA5E9");
        expect(result.content[0]!.text).toContain("下次会话生效");
        await expect(readFile(join(dir, "MEMORY.md"), "utf-8")).resolves.toContain("品牌色");
    });

    it("project 级写入落到工作区 .shotshot/memory.md", async () => {
        const h = harness(() => wsDir, dir);
        await h.run({ level: "project", mode: "append", content: "文案用水墨风" });
        await expect(readFile(join(wsDir, ".shotshot", "memory.md"), "utf-8")).resolves.toContain("水墨风");
    });

    it("无工作区时 project 级返回错误文本", async () => {
        const h = harness(() => undefined, dir);
        const result = await h.run({ level: "project", mode: "append", content: "x" });
        expect(result.content[0]!.text).toContain("项目工作区");
    });

    it("append 超限返回错误文本且不写盘", async () => {
        const fresh = await mkdtemp(join(tmpdir(), "shotshot-memory-ext-limit-")); // 独立 root，避免依赖其他用例是否已写盘
        try {
            const h = harness(() => undefined, fresh);
            const result = await h.run({ level: "user", mode: "append", content: "a".repeat(2001) });
            expect(result.content[0]!.text).toContain("2000");
            await expect(readFile(join(fresh, "MEMORY.md"), "utf-8")).rejects.toThrow();
        } finally {
            await rm(fresh, { recursive: true, force: true });
        }
    });

    it("replace 超限返回错误文本", async () => {
        const h = harness(() => undefined, dir);
        const result = await h.run({ level: "user", mode: "replace", content: "a".repeat(8001) });
        expect(result.content[0]!.text).toContain("8000");
    });

    it("空 content 返回错误文本", async () => {
        const h = harness(() => undefined, dir);
        const result = await h.run({ level: "user", mode: "append", content: "   " });
        expect(result.content[0]!.text).toContain("不能为空");
    });

    it("memory_write 不在审批闸门集合内", async () => {
        const { APPROVAL_GATED_TOOLS } = await import("./pi-agent-approval");
        expect((APPROVAL_GATED_TOOLS as ReadonlySet<string>).has(MEMORY_TOOL_NAME)).toBe(false);
    });

    it("vi.fn 校验 registry 只收到一次注册", () => {
        const registerTool = vi.fn();
        createShotshotMemoryExtension({ getWorkspacePath: () => undefined, root: dir })({
            registerTool,
        } as unknown as ExtensionAPI);
        expect(registerTool).toHaveBeenCalledTimes(1);
    });
});
