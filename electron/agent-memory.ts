// electron/agent-memory.ts
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { APP_DATA_DIR } from "./app-data-paths";

export const USER_MEMORY_FILE = "MEMORY.md";
export const PROJECT_MEMORY_FILENAME = "memory.md";
/** 项目工作区内 app 托管文件的隐藏目录（与 .shotshot/assets.json 同目录约定）。 */
export const PROJECT_HIDDEN_DIR = ".shotshot";
export const USER_MEMORY_BUDGET = 2000;
export const PROJECT_MEMORY_BUDGET = 3000;
export const MEMORY_APPEND_LIMIT = 2000;
export const MEMORY_REPLACE_LIMIT = 8000;
const TRUNCATION_NOTICE = "（记忆过长已截断，请整理）";
const NO_WORKSPACE_MESSAGE = "当前会话未绑定项目工作区，无法访问项目记忆";

export type MemoryMode = "append" | "replace";
export type MemoryWriteOptions = { mode: MemoryMode; content: string };

export function memoryRoot(agentDir = join(APP_DATA_DIR, "agent")): string {
    return join(agentDir, "memory");
}

/** 项目记忆文件 = 项目工作区隐藏目录 .shotshot/memory.md；workspacePath 必须是绝对路径（目录存在性在 IO 层校验）。 */
export function resolveProjectMemoryFile(workspacePath?: string): string {
    if (!workspacePath || !isAbsolute(workspacePath)) throw new Error(NO_WORKSPACE_MESSAGE);
    return join(workspacePath, PROJECT_HIDDEN_DIR, PROJECT_MEMORY_FILENAME);
}

async function readTextFile(filePath: string): Promise<string> {
    try {
        return await readFile(filePath, "utf-8");
    } catch {
        return "";
    }
}

async function assertWorkspaceDir(workspacePath: string): Promise<void> {
    try {
        if (!(await stat(workspacePath)).isDirectory()) throw new Error("项目工作区路径不是目录");
    } catch (error) {
        if (error instanceof Error && error.message === "项目工作区路径不是目录") throw error;
        throw new Error(NO_WORKSPACE_MESSAGE);
    }
}

// append 是"读→拼接→写"的非原子序列；模块级队列串行化，避免 agent 会话与面板弹窗并发写交错丢条目。
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueueWrite(task: () => Promise<void>): Promise<void> {
    const result = writeQueue.then(task, task);
    writeQueue = result.catch(() => undefined);
    return result;
}

async function writeTextFile(filePath: string, input: MemoryWriteOptions, createDir?: string): Promise<void> {
    await enqueueWrite(async () => {
        if (createDir) await mkdir(createDir, { recursive: true });
        if (input.mode === "replace") {
            await writeFile(filePath, input.content, "utf-8");
            return;
        }
        const existing = await readTextFile(filePath);
        const separator = existing && !existing.endsWith("\n") ? "\n" : "";
        await writeFile(filePath, `${existing}${separator}${input.content}\n`, "utf-8");
    });
}

export async function readUserMemory(root: string): Promise<string> {
    return readTextFile(join(root, USER_MEMORY_FILE));
}

export async function writeUserMemory(root: string, input: MemoryWriteOptions): Promise<void> {
    await writeTextFile(join(root, USER_MEMORY_FILE), input, root);
}

export async function readProjectMemory(workspacePath: string): Promise<string> {
    const filePath = resolveProjectMemoryFile(workspacePath);
    try {
        return await readFile(filePath, "utf-8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return "";
    }
    // 新位置缺失：老版本把项目记忆放在工作区根目录 memory.md，读时一次性迁入 .shotshot/
    await enqueueWrite(() => migrateLegacyProjectMemory(workspacePath, filePath));
    return readTextFile(filePath);
}

/** 旧版根目录 memory.md → .shotshot/memory.md 的一次性迁移；工作区缺失不代建，迁移失败保持原样（按无记忆处理）。 */
async function migrateLegacyProjectMemory(workspacePath: string, targetPath: string): Promise<void> {
    try {
        if (!(await stat(workspacePath)).isDirectory()) return;
    } catch {
        return;
    }
    try {
        await stat(targetPath);
        return; // 新位置已有记忆（并发写入先到）：不迁移，避免覆盖
    } catch {
        // 目标不存在才继续迁移
    }
    try {
        await mkdir(join(workspacePath, PROJECT_HIDDEN_DIR), { recursive: true });
        await rename(join(workspacePath, PROJECT_MEMORY_FILENAME), targetPath);
    } catch {
        // 旧文件不存在或迁移失败：保持原样，本次按无记忆处理
    }
}

export async function writeProjectMemory(workspacePath: string, input: MemoryWriteOptions): Promise<void> {
    const filePath = resolveProjectMemoryFile(workspacePath);
    await assertWorkspaceDir(workspacePath);
    // 项目工作区目录必须已存在（由项目工作区功能保证），只代建其中的 .shotshot/ 隐藏目录
    await writeTextFile(filePath, input, join(workspacePath, PROJECT_HIDDEN_DIR));
}

function clip(content: string, budget: number): string {
    // 保留头部（更早写入、通常更核心的条目），截尾部。
    return content.length <= budget ? content : `${content.slice(0, budget)}${TRUNCATION_NOTICE}`;
}

const MEMORY_GUIDE =
    "以上是已保存的记忆，供参考；与用户当前指令冲突时以当前指令为准。当用户表达稳定的偏好、约定或项目背景时，主动调用 memory_write 保存（level 按归属选 user/project；一次性的琐碎信息不存）。禁止在记忆中保存 API Key、令牌等敏感信息。";

export async function buildMemoryBlock(root: string, workspacePath?: string): Promise<string> {
    const userMemory = clip((await readUserMemory(root)).trim(), USER_MEMORY_BUDGET);
    let projectMemory = "";
    if (workspacePath) {
        try {
            projectMemory = clip((await readProjectMemory(workspacePath)).trim(), PROJECT_MEMORY_BUDGET);
        } catch {
            projectMemory = ""; // 工作区无效（被删/非目录）→ 视为无项目记忆
        }
    }
    if (!userMemory && !projectMemory) return "";
    return [
        "## 长期记忆",
        userMemory ? `### 用户记忆（跨项目生效）\n${userMemory}` : "",
        projectMemory ? `### 项目记忆（仅当前画布项目生效）\n${projectMemory}` : "",
        MEMORY_GUIDE,
    ].filter(Boolean).join("\n\n");
}

/** 会话级快照：首个 prompt 轮读盘一次并缓存在 runtimeState，会话内不再变化（保前缀缓存 + 防指令漂移）。 */
export async function ensureMemorySnapshot(state: { memorySnapshot?: string }, root: string, workspacePath?: string): Promise<string> {
    if (state.memorySnapshot === undefined) state.memorySnapshot = await buildMemoryBlock(root, workspacePath);
    return state.memorySnapshot;
}
