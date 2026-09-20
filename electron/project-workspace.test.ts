import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectAssetManifest } from "@/lib/project-assets/project-asset-types";
import { ensureWorkspaceDir, registerProjectWorkspaceIpc, relocateProjectWorkspace, sanitizeWorkspaceDirName } from "./project-workspace";

const tempRoots: string[] = [];
afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("sanitizeWorkspaceDirName", () => {
    it("keeps cjk, alphanumerics, hyphen and underscore; folds the rest", () => {
        // projectId 末 8 位为 "GQ53b-Ah"（brief 原稿误写为 9 字符 "QGQ53b-Ah"）。
        expect(sanitizeWorkspaceDirName("产品 发布_v2!!", "ldq_XefxlQQfQGQ53b-Ah")).toBe("产品-发布_v2-GQ53b-Ah");
    });

    it("falls back to project when title sanitizes to empty and truncates long titles", () => {
        expect(sanitizeWorkspaceDirName("///", "abc12345")).toBe("project-abc12345");
        expect(sanitizeWorkspaceDirName("很长的项目名".repeat(20), "abc12345")).toMatch(/-abc12345$/);
        expect(sanitizeWorkspaceDirName("很长的项目名".repeat(20), "abc12345").length).toBeLessThanOrEqual(49);
    });
});

describe("ensureWorkspaceDir", () => {
    it("creates root/title-id directory once and is idempotent", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-root-"));
        tempRoots.push(root);
        const first = await ensureWorkspaceDir(root, "ldq_XefxlQQfQGQ53b-Ah", "产品 发布");
        const second = await ensureWorkspaceDir(root, "ldq_XefxlQQfQGQ53b-Ah", "产品 发布");
        expect(first).toBe(second);
        expect((await stat(first)).isDirectory()).toBe(true);
        expect(first).toContain("产品-发布-GQ53b-Ah");
    });

    it("rejects invalid projectId", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-root-"));
        tempRoots.push(root);
        await expect(ensureWorkspaceDir(root, "bad id!", "t")).rejects.toThrow();
    });
});

// Task 10（project-asset-storage）：更改目录 = 复制 + 校验后绑定；任何失败都不得改动源目录，
// 也不得把 Project.workspacePath 指到未验证完整性的目标。
async function writeManifestAt(dir: string, manifest: ProjectAssetManifest): Promise<void> {
    await mkdir(join(dir, ".shotshot"), { recursive: true });
    await writeFile(join(dir, ".shotshot", "assets.json"), JSON.stringify(manifest));
}

function manifestFor(projectId: string, relativePaths: string[]): ProjectAssetManifest {
    return {
        app: "shotshot",
        version: 1,
        projectId,
        assets: relativePaths.map((relativePath) => ({
            backend: "project-file" as const,
            assetId: `id-${relativePath}`,
            projectId,
            relativePath,
            revision: 1,
            originalName: "a.png",
            kind: "image" as const,
            mimeType: "image/png",
            bytes: 3,
            sha256: "hash",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            source: { type: "canvas-import" as const },
        })),
    };
}

async function seedSourceWorkspace(root: string, options?: { omitAssetFile?: boolean }): Promise<{ source: string; target: string }> {
    const source = join(root, "source");
    const target = join(root, "target");
    await mkdir(join(source, "assets", "imported"), { recursive: true });
    await writeFile(join(source, "memory.md"), "memory");
    await writeManifestAt(source, manifestFor("p1", ["assets/imported/a.png"]));
    if (!options?.omitAssetFile) await writeFile(join(source, "assets", "imported", "a.png"), "abc");
    return { source, target };
}

describe("relocateProjectWorkspace", () => {
    it("copies and verifies a project before returning the target path", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-relocate-"));
        tempRoots.push(root);
        const { source, target } = await seedSourceWorkspace(root);

        const result = await relocateProjectWorkspace({ projectId: "p1", sourcePath: source, targetPath: target });

        expect(result.path).toBe(await realpath(target));
        expect(await readFile(join(target, "assets/imported/a.png"), "utf8")).toBe("abc");
        expect(await readFile(join(target, ".shotshot/assets.json"), "utf8")).toContain("p1");
        expect(await readFile(join(target, "memory.md"), "utf8")).toBe("memory");
        // 源目录整体保留：不删除、不改写任何文件。
        expect((await stat(source)).isDirectory()).toBe(true);
        expect(await readFile(join(source, "assets/imported/a.png"), "utf8")).toBe("abc");
        expect(await readFile(join(source, "memory.md"), "utf8")).toBe("memory");
    });

    it("refuses a non-empty directory owned by another project", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-relocate-"));
        tempRoots.push(root);
        const { source, target } = await seedSourceWorkspace(root);
        await mkdir(target, { recursive: true });
        await writeManifestAt(target, { app: "shotshot", version: 1, projectId: "p2", assets: [] });

        await expect(relocateProjectWorkspace({ projectId: "p1", sourcePath: source, targetPath: target })).rejects.toThrow(/其他项目/);

        // 目标声明未被覆盖，源目录未改动。
        expect(await readFile(join(target, ".shotshot/assets.json"), "utf8")).toContain("p2");
        expect(await readFile(join(source, "memory.md"), "utf8")).toBe("memory");
        await expect(stat(join(target, "memory.md"))).rejects.toThrow();
    });

    it("refuses a corrupt or unsupported target manifest instead of overwriting it", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-relocate-"));
        tempRoots.push(root);
        const { source, target } = await seedSourceWorkspace(root);
        await mkdir(join(target, ".shotshot"), { recursive: true });
        await writeFile(join(target, ".shotshot", "assets.json"), "{oops");

        await expect(relocateProjectWorkspace({ projectId: "p1", sourcePath: source, targetPath: target })).rejects.toThrow(/拒绝覆盖/);

        await writeFile(join(target, ".shotshot", "assets.json"), JSON.stringify({ app: "shotshot", version: 2, projectId: "p1", assets: [] }));
        await expect(relocateProjectWorkspace({ projectId: "p1", sourcePath: source, targetPath: target })).rejects.toThrow(/拒绝覆盖/);
        expect(await readFile(join(target, ".shotshot/assets.json"), "utf8")).toContain('"version":2');
    });

    it("verifies every manifest record after the copy and refuses to bind a broken target", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-relocate-"));
        tempRoots.push(root);
        // 源 manifest 声明了 a.png 但文件缺失：复制后校验必须失败。
        const { source, target } = await seedSourceWorkspace(root, { omitAssetFile: true });

        await expect(relocateProjectWorkspace({ projectId: "p1", sourcePath: source, targetPath: target })).rejects.toThrow(/assets\/imported\/a\.png/);

        // 源目录保持原样；目标是未绑定的部分副本（重试同一目标依赖"同项目 manifest 可续传"）。
        expect(await readFile(join(source, "memory.md"), "utf8")).toBe("memory");
        expect(await readFile(join(target, "memory.md"), "utf8")).toBe("memory");
    });

    it("accepts a target that already declares the same project id", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-relocate-"));
        tempRoots.push(root);
        const { source, target } = await seedSourceWorkspace(root);
        await mkdir(target, { recursive: true });
        await writeManifestAt(target, { app: "shotshot", version: 1, projectId: "p1", assets: [] });

        const result = await relocateProjectWorkspace({ projectId: "p1", sourcePath: source, targetPath: target });

        expect(result.path).toBe(await realpath(target));
        expect(await readFile(join(target, "assets/imported/a.png"), "utf8")).toBe("abc");
        expect(await readFile(join(target, "memory.md"), "utf8")).toBe("memory");
    });

    it("rejects a target inside the source workspace and invalid projectId", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-relocate-"));
        tempRoots.push(root);
        const { source } = await seedSourceWorkspace(root);

        await expect(relocateProjectWorkspace({ projectId: "p1", sourcePath: source, targetPath: join(source, "nested") })).rejects.toThrow(/源工作区内/);
        await expect(relocateProjectWorkspace({ projectId: "bad id!", sourcePath: source, targetPath: join(root, "t2") })).rejects.toThrow(/非法项目 id/);
    });

    it("refuses a missing or non-directory source and keeps everything untouched", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-relocate-"));
        tempRoots.push(root);
        const { source, target } = await seedSourceWorkspace(root);

        await expect(relocateProjectWorkspace({ projectId: "p1", sourcePath: join(root, "missing"), targetPath: target })).rejects.toThrow();
        await expect(relocateProjectWorkspace({ projectId: "p1", sourcePath: join(source, "memory.md"), targetPath: target })).rejects.toThrow(/不是目录/);
        expect((await readdir(source)).sort()).toEqual([".shotshot", "assets", "memory.md"]);
    });
});

// 两个工作区通道都必须带 trusted-sender 判定（与 project-assets 通道一致）；
// 不可信渲染进程在进入业务逻辑前就收到统一 {ok:false,error}。
function makeWorkspaceHarness(root: string) {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerProjectWorkspaceIpc({
        ipcMain: {
            handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
                handlers.set(channel, handler);
            }),
        } as never,
        root,
        isTrustedSender: (sender) => sender.id === 7,
    });
    return {
        handlers,
        trustedEvent: { sender: { id: 7 } },
        untrustedEvent: { sender: { id: 99 } },
    };
}

describe("project workspace IPC trust boundary", () => {
    it("registers exactly the two workspace channels", () => {
        const { handlers } = makeWorkspaceHarness(join(tmpdir(), "ws-ipc-root-unused"));
        expect([...handlers.keys()].sort()).toEqual(["project:ensure-workspace", "project:relocate-workspace"]);
    });

    it("rejects untrusted senders on both workspace channels before doing any work", async () => {
        const { handlers, untrustedEvent } = makeWorkspaceHarness(join(tmpdir(), "ws-ipc-root-unused"));
        await expect(handlers.get("project:ensure-workspace")!(untrustedEvent, "p1", "t")).resolves.toEqual({ ok: false, error: expect.stringContaining("不受信任") });
        await expect(handlers.get("project:relocate-workspace")!(untrustedEvent, { projectId: "p1", sourcePath: "/a", targetPath: "/b" })).resolves.toEqual({ ok: false, error: expect.stringContaining("不受信任") });
    });

    it("serves trusted senders and reports business errors instead of trust failures", async () => {
        const root = await mkdtemp(join(tmpdir(), "ws-ipc-root-"));
        tempRoots.push(root);
        const { handlers, trustedEvent } = makeWorkspaceHarness(root);

        await expect(handlers.get("project:ensure-workspace")!(trustedEvent, "p1", "T")).resolves.toMatchObject({ ok: true, path: expect.any(String) });
        // 源不存在：业务失败，但绝不是信任失败。
        await expect(handlers.get("project:relocate-workspace")!(trustedEvent, { projectId: "p1", sourcePath: join(root, "missing"), targetPath: join(root, "target") })).resolves.toMatchObject({
            ok: false,
            error: expect.not.stringContaining("不受信任"),
        });
    });
});
