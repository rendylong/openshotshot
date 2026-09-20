// electron/agent-workspace.ts
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/**
 * createSession 传入的工作区校验：undefined / 非字符串 / 空白 = 无工作区；
 * 相对路径或目录不存在时抛错（创建时可修复，调用方让会话创建失败）。
 * 成功返回 realpath 规范路径（symlink 落定，entry 与展示统一用它）。
 */
export async function resolveWorkspaceCwd(raw: unknown): Promise<string | undefined> {
    if (typeof raw !== "string" || !raw.trim()) return undefined;
    if (!isAbsolute(raw)) throw new Error("工作区必须是绝对路径");
    const resolved = await realpath(raw).catch(() => null);
    if (!resolved) throw new Error(`工作区目录不存在：${raw}`);
    const details = await stat(resolved).catch(() => null);
    if (!details?.isDirectory()) throw new Error(`工作区目录不存在：${raw}`);
    return resolved;
}

/**
 * 打开旧会话时的工作区恢复：候选路径可用则 realpath 返回，不可用一律回退
 * fallback（agent-sessions）。会话必须永远能打开，这里不抛错。
 */
export async function restoreWorkspaceCwd(candidate: unknown, fallback: string): Promise<string> {
    if (typeof candidate !== "string" || !isAbsolute(candidate)) return fallback;
    const resolved = await realpath(candidate).catch(() => null);
    if (!resolved) return fallback;
    const details = await stat(resolved).catch(() => null);
    return details?.isDirectory() ? resolved : fallback;
}
