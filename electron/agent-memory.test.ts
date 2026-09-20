// electron/agent-memory.test.ts
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    PROJECT_HIDDEN_DIR,
    PROJECT_MEMORY_BUDGET,
    PROJECT_MEMORY_FILENAME,
    USER_MEMORY_BUDGET,
    buildMemoryBlock,
    ensureMemorySnapshot,
    memoryRoot,
    readProjectMemory,
    readUserMemory,
    resolveProjectMemoryFile,
    writeProjectMemory,
    writeUserMemory,
} from "./agent-memory";

let dir: string;          // 用户记忆 root
let wsDir: string;        // 模拟项目工作区目录

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "shotshot-memory-"));
    wsDir = await mkdtemp(join(tmpdir(), "shotshot-ws-"));
});
afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(wsDir, { recursive: true, force: true });
});

describe("agent-memory", () => {
    it("memoryRoot 默认基于 ~/.shotshot/agent", () => {
        expect(memoryRoot()).toContain(join("agent", "memory"));
        expect(memoryRoot("/tmp/ad")).toBe(join("/tmp/ad", "memory"));
    });

    it("resolveProjectMemoryFile 校验绝对路径，固定 .shotshot/memory.md", () => {
        expect(resolveProjectMemoryFile("/tmp/ws")).toBe(join("/tmp/ws", PROJECT_HIDDEN_DIR, PROJECT_MEMORY_FILENAME));
        expect(() => resolveProjectMemoryFile(undefined)).toThrow(/项目工作区/);
        expect(() => resolveProjectMemoryFile("relative/path")).toThrow(/项目工作区/);
    });

    it("readUserMemory / readProjectMemory 文件不存在返回空串", async () => {
        await expect(readUserMemory(dir)).resolves.toBe("");
        await expect(readProjectMemory(wsDir)).resolves.toBe("");
    });

    it("writeUserMemory replace 覆盖并自动建目录", async () => {
        await writeUserMemory(dir, { mode: "replace", content: "# 用户记忆\n- 条目" });
        await expect(readFile(join(dir, "MEMORY.md"), "utf-8")).resolves.toBe("# 用户记忆\n- 条目");
    });

    it("writeUserMemory append 追加且补换行", async () => {
        await writeUserMemory(dir, { mode: "replace", content: "第一条" });
        await writeUserMemory(dir, { mode: "append", content: "第二条" });
        await expect(readFile(join(dir, "MEMORY.md"), "utf-8")).resolves.toBe("第一条\n第二条\n");
    });

    it("并发 append 经队列串行化不丢条目", async () => {
        await Promise.all(
            Array.from({ length: 20 }, (_, i) => writeUserMemory(dir, { mode: "append", content: `条目${i}` })),
        );
        const content = await readFile(join(dir, "MEMORY.md"), "utf-8");
        for (let i = 0; i < 20; i += 1) expect(content).toContain(`条目${i}`);
        expect(content.split("\n").filter(Boolean)).toHaveLength(22); // 22 = 2 条先前的 + 20 条并发
    });

    it("writeProjectMemory 写入工作区 .shotshot/memory.md 并代建隐藏目录，工作区缺失时抛错", async () => {
        await writeProjectMemory(wsDir, { mode: "append", content: "客户 A 的电商海报系列" });
        await expect(readFile(join(wsDir, PROJECT_HIDDEN_DIR, "memory.md"), "utf-8")).resolves.toBe("客户 A 的电商海报系列\n");
        const missing = join(dir, "no-such-ws");
        await expect(writeProjectMemory(missing, { mode: "append", content: "x" })).rejects.toThrow(/项目工作区/);
        await expect(stat(missing)).rejects.toThrow(); // 被删工作区不静默重建
    });

    it("旧版根目录 memory.md 首次读取时一次性迁入 .shotshot/（rename，内容保留）", async () => {
        const legacy = await mkdtemp(join(tmpdir(), "shotshot-ws-legacy-"));
        try {
            await writeFile(join(legacy, PROJECT_MEMORY_FILENAME), "旧版记忆条目");
            await expect(readProjectMemory(legacy)).resolves.toBe("旧版记忆条目");
            await expect(readFile(join(legacy, PROJECT_HIDDEN_DIR, "memory.md"), "utf-8")).resolves.toBe("旧版记忆条目");
            await expect(stat(join(legacy, PROJECT_MEMORY_FILENAME))).rejects.toThrow(); // 根目录旧文件已移走
            await expect(readProjectMemory(legacy)).resolves.toBe("旧版记忆条目"); // 再次读取走新位置
        } finally {
            await rm(legacy, { recursive: true, force: true });
        }
    });

    it("新位置已有记忆时不迁移，根目录旧文件保持原样", async () => {
        const both = await mkdtemp(join(tmpdir(), "shotshot-ws-both-"));
        try {
            await mkdir(join(both, PROJECT_HIDDEN_DIR), { recursive: true });
            await writeFile(join(both, PROJECT_HIDDEN_DIR, "memory.md"), "新记忆");
            await writeFile(join(both, PROJECT_MEMORY_FILENAME), "旧记忆");
            await expect(readProjectMemory(both)).resolves.toBe("新记忆");
            await expect(readFile(join(both, PROJECT_MEMORY_FILENAME), "utf-8")).resolves.toBe("旧记忆");
        } finally {
            await rm(both, { recursive: true, force: true });
        }
    });

    it("resolveProjectMemoryFile 指向被删目录时读取返回空串、写入抛错（不代建）", async () => {
        const gone = join(wsDir, "gone-dir");
        await mkdir(gone);
        await expect(readProjectMemory(gone)).resolves.toBe("");
        await rm(gone, { recursive: true });
        await expect(writeProjectMemory(gone, { mode: "append", content: "x" })).rejects.toThrow(/项目工作区/);
    });

    it("buildMemoryBlock 无任何记忆时返回空串（零差异）", async () => {
        const fresh = await mkdtemp(join(tmpdir(), "shotshot-memory-empty-"));
        const freshWs = await mkdtemp(join(tmpdir(), "shotshot-ws-empty-")); // 独立空工作区，避免依赖其他用例的 wsDir 写入顺序
        try {
            await expect(buildMemoryBlock(fresh)).resolves.toBe("");
            await expect(buildMemoryBlock(fresh, freshWs)).resolves.toBe("");
        } finally {
            await rm(fresh, { recursive: true, force: true });
            await rm(freshWs, { recursive: true, force: true });
        }
    });

    it("buildMemoryBlock 单侧为空只出另一节", async () => {
        const fresh = await mkdtemp(join(tmpdir(), "shotshot-memory-one-"));
        try {
            await writeUserMemory(fresh, { mode: "append", content: "品牌色 #0EA5E9" });
            const block = await buildMemoryBlock(fresh);
            expect(block).toContain("### 用户记忆（跨项目生效）");
            expect(block).not.toContain("### 项目记忆");
            expect(block).toContain("memory_write");
            await writeProjectMemory(wsDir, { mode: "replace", content: "文案用水墨风" });
            const both = await buildMemoryBlock(fresh, wsDir);
            expect(both).toContain("### 项目记忆（仅当前画布项目生效）");
        } finally {
            await rm(fresh, { recursive: true, force: true });
        }
    });

    it("buildMemoryBlock 工作区无效时忽略项目记忆而非报错", async () => {
        const fresh = await mkdtemp(join(tmpdir(), "shotshot-memory-badws-"));
        try {
            await writeUserMemory(fresh, { mode: "append", content: "偏好" });
            const block = await buildMemoryBlock(fresh, join(dir, "no-such-ws"));
            expect(block).toContain("### 用户记忆");
            expect(block).not.toContain("### 项目记忆");
        } finally {
            await rm(fresh, { recursive: true, force: true });
        }
    });

    it("buildMemoryBlock 超预算保留头部截尾部并提示", async () => {
        const fresh = await mkdtemp(join(tmpdir(), "shotshot-memory-clip-"));
        try {
            await writeProjectMemory(wsDir, { mode: "replace", content: "a".repeat(PROJECT_MEMORY_BUDGET + 100) });
            const block = await buildMemoryBlock(fresh, wsDir);
            expect(block).toContain("（记忆过长已截断，请整理）");
            expect(block.indexOf("aaaa")).toBeLessThan(block.indexOf("（记忆过长已截断"));
        } finally {
            await rm(fresh, { recursive: true, force: true });
        }
    });

    it("ensureMemorySnapshot 首轮读盘一次、之后复用缓存", async () => {
        const fresh = await mkdtemp(join(tmpdir(), "shotshot-memory-snap-"));
        try {
            await writeUserMemory(fresh, { mode: "append", content: "v1" });
            const state: { memorySnapshot?: string } = {};
            const first = await ensureMemorySnapshot(state, fresh);
            await writeUserMemory(fresh, { mode: "append", content: "v2" });
            const second = await ensureMemorySnapshot(state, fresh);
            expect(first).toBe(second);
            expect(first).toContain("v1");
            expect(first).not.toContain("v2");
            expect(USER_MEMORY_BUDGET).toBe(2000);
        } finally {
            await rm(fresh, { recursive: true, force: true });
        }
    });

    it("writeFile 预置内容不被 append 破坏换行", async () => {
        const noTrailing = join(wsDir, "..", "shotshot-ws-notrailing");
        await mkdir(join(noTrailing, PROJECT_HIDDEN_DIR), { recursive: true });
        await writeFile(join(noTrailing, PROJECT_HIDDEN_DIR, "memory.md"), "旧内容无换行");
        await writeProjectMemory(noTrailing, { mode: "append", content: "新条目" });
        await expect(readFile(join(noTrailing, PROJECT_HIDDEN_DIR, "memory.md"), "utf-8")).resolves.toBe("旧内容无换行\n新条目\n");
        await rm(noTrailing, { recursive: true, force: true });
    });
});
