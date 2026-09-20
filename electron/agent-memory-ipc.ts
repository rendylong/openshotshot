// electron/agent-memory-ipc.ts
import { ipcMain } from "electron";
import { isAbsolute } from "node:path";

import {
    memoryRoot,
    readProjectMemory,
    readUserMemory,
    writeProjectMemory,
    writeUserMemory,
    type MemoryMode,
} from "./agent-memory";

export const AGENT_MEMORY_CHANNELS = {
    read: "agent:memory-read",
    write: "agent:memory-write",
} as const;

const fail = (error: string) => ({ ok: false as const, error });

type MemoryReadParsed = { ok: true; scope: "user" } | { ok: true; scope: "project"; workspacePath: string } | { ok: false; error: string };

export function parseMemoryReadInput(scope: unknown, workspacePath?: unknown): MemoryReadParsed {
    if (scope === "user") return { ok: true, scope: "user" };
    if (scope === "project") {
        if (workspacePath === undefined || workspacePath === null || workspacePath === "") return fail("缺少工作区路径");
        if (typeof workspacePath !== "string" || !isAbsolute(workspacePath)) return fail("工作区路径必须是绝对路径");
        return { ok: true, scope: "project", workspacePath };
    }
    return fail("非法范围");
}

type MemoryWriteParsed =
    | { ok: true; value: { scope: "user"; mode: MemoryMode; content: string } }
    | { ok: true; value: { scope: "project"; workspacePath: string; mode: MemoryMode; content: string } }
    | { ok: false; error: string };

export function parseMemoryWriteInput(raw: unknown): MemoryWriteParsed {
    if (typeof raw !== "object" || raw === null) return fail("非法请求");
    const input = raw as Record<string, unknown>;
    if (input.scope === undefined) return fail("非法请求");
    if (input.scope !== "user" && input.scope !== "project") return fail("非法范围");
    if (input.mode !== "append" && input.mode !== "replace") return fail("非法写入模式");
    // 空 content 合法：面板「清空」= replace 空串；工具层（memory_write）另行拒绝空 content
    if (typeof input.content !== "string") return fail("非法内容");
    if (input.content.length > 8000) return fail("内容过长（上限 8000 字符）");
    if (input.scope === "project") {
        if (input.workspacePath === undefined || input.workspacePath === null || input.workspacePath === "") return fail("缺少工作区路径");
        if (typeof input.workspacePath !== "string" || !isAbsolute(input.workspacePath)) return fail("工作区路径必须是绝对路径");
        return { ok: true, value: { scope: "project", workspacePath: input.workspacePath, mode: input.mode, content: input.content } };
    }
    return { ok: true, value: { scope: "user", mode: input.mode, content: input.content } };
}

/** 注册记忆读写 IPC；返回反注册函数（生命周期结束时调用，避免重复注册）。目录存在性由 IO 层校验并转为 error 结果。 */
export function registerAgentMemoryIpc(root = memoryRoot()): () => void {
    ipcMain.handle(AGENT_MEMORY_CHANNELS.read, (_event, scope: unknown, workspacePath?: unknown) => {
        const parsed = parseMemoryReadInput(scope, workspacePath);
        if (!parsed.ok) return Promise.resolve(fail(parsed.error));
        const contentPromise = parsed.scope === "user"
            ? readUserMemory(root)
            : readProjectMemory(parsed.workspacePath);
        return contentPromise
            .then((content) => ({ ok: true as const, content }))
            .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
    });
    ipcMain.handle(AGENT_MEMORY_CHANNELS.write, (_event, raw: unknown) => {
        const parsed = parseMemoryWriteInput(raw);
        if (!parsed.ok) return Promise.resolve(fail(parsed.error));
        const writePromise = parsed.value.scope === "user"
            ? writeUserMemory(root, { mode: parsed.value.mode, content: parsed.value.content })
            : writeProjectMemory(parsed.value.workspacePath, { mode: parsed.value.mode, content: parsed.value.content });
        return writePromise
            .then(() => ({ ok: true as const }))
            .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
    });
    return () => {
        for (const channel of Object.values(AGENT_MEMORY_CHANNELS)) ipcMain.removeHandler(channel);
    };
}
