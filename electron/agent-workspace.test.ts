// electron/agent-workspace.test.ts
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveWorkspaceCwd, restoreWorkspaceCwd } from "./agent-workspace";

const tempRoots: string[] = [];
afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resolveWorkspaceCwd", () => {
    it("treats absent, non-string and blank input as no workspace", async () => {
        await expect(resolveWorkspaceCwd(undefined)).resolves.toBeUndefined();
        await expect(resolveWorkspaceCwd("")).resolves.toBeUndefined();
        await expect(resolveWorkspaceCwd("   ")).resolves.toBeUndefined();
        await expect(resolveWorkspaceCwd(42)).resolves.toBeUndefined();
    });

    it("rejects relative paths", async () => {
        await expect(resolveWorkspaceCwd("relative/dir")).rejects.toThrow("工作区必须是绝对路径");
    });

    it("rejects missing paths and plain files", async () => {
        const root = join(await mkdtemp(join(tmpdir(), "agent-workspace-")));
        tempRoots.push(root);
        const file = join(root, "plain.txt");
        await writeFile(file, "x");
        await expect(resolveWorkspaceCwd(join(root, "missing"))).rejects.toThrow("工作区目录不存在");
        await expect(resolveWorkspaceCwd(file)).rejects.toThrow("工作区目录不存在");
    });

    it("returns the realpath for existing directories (symlinks resolved)", async () => {
        // macOS 的 tmpdir 位于 /var -> /private/var 符号链接下，先取规范路径再构造断言期望值
        const root = await realpath(await mkdtemp(join(tmpdir(), "agent-workspace-")));
        tempRoots.push(root);
        const real = join(root, "real-dir");
        const link = join(root, "link-dir");
        await mkdir(real);
        await symlink(real, link);
        await expect(resolveWorkspaceCwd(link)).resolves.toBe(real);
    });
});

describe("restoreWorkspaceCwd", () => {
    it("falls back for missing, relative or malformed candidate values", async () => {
        const fallback = join(await mkdtemp(join(tmpdir(), "agent-workspace-fallback-")));
        tempRoots.push(fallback);
        await expect(restoreWorkspaceCwd(undefined, fallback)).resolves.toBe(fallback);
        await expect(restoreWorkspaceCwd("relative", fallback)).resolves.toBe(fallback);
        await expect(restoreWorkspaceCwd(join(fallback, "missing"), fallback)).resolves.toBe(fallback);
    });

    it("restores an existing directory via realpath", async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "agent-workspace-")));
        tempRoots.push(root);
        const dir = join(root, "ws");
        await mkdir(dir);
        await expect(restoreWorkspaceCwd(dir, root)).resolves.toBe(dir);
    });
});
