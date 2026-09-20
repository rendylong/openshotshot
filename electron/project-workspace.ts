// electron/project-workspace.ts
import { cp, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ipcMain, type IpcMain, type WebContents } from "electron";

import type { ProjectAssetManifest, ProjectWorkspaceRelocationInput } from "@/lib/project-assets/project-asset-types";
import { resolveProjectAssetPath } from "./project-asset-store";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
// 与 project-asset-store 的 manifest 位置保持一致（store 内常量未导出，这里按约定复写）。
const MANIFEST_RELATIVE_PATH = ".shotshot/assets.json";

/** 目录名 = sanitize(title) 截断 40 字符 + "-" + projectId 末 8 位；项目改名不改目录。 */
export function sanitizeWorkspaceDirName(title: string, projectId: string): string {
    const cleaned = (title || "")
        .replace(/[^\p{L}\p{N}_-]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/^-+|-+$/g, "");
    return `${cleaned || "project"}-${projectId.slice(-8)}`;
}

/** 幂等创建 `<root>/<dirName>/` 并返回 realpath；目录已存在直接返回。 */
export async function ensureWorkspaceDir(root: string, projectId: string, title: string): Promise<string> {
    if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error(`非法项目 id：${projectId}`);
    const target = join(root, sanitizeWorkspaceDirName(title, projectId));
    await mkdir(target, { recursive: true });
    return realpath(target);
}

const withinRoot = (path: string, root: string): boolean => {
    const fromRoot = relative(root, path);
    return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
};

/** 读取目录下 `.shotshot/assets.json`；不存在返回 null，损坏或版本未知一律拒绝（不覆盖原目录）。 */
async function readManifestAt(directory: string): Promise<ProjectAssetManifest | null> {
    const manifestPath = join(directory, MANIFEST_RELATIVE_PATH);
    let text: string;
    try {
        text = await readFile(manifestPath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`资产索引损坏，拒绝覆盖：${manifestPath}`);
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as ProjectAssetManifest).assets)) {
        throw new Error(`资产索引损坏，拒绝覆盖：${manifestPath}`);
    }
    const manifest = parsed as ProjectAssetManifest;
    if (manifest.app !== "shotshot" || manifest.version !== 1) throw new Error(`资产索引版本不受支持，拒绝覆盖：${manifestPath}`);
    return manifest;
}

/**
 * 非破坏性迁移：把源工作区整体复制到目标（不删除源数据），复制后加载目标 manifest
 * 并确认每条资产记录的文件都已落盘，全部通过才返回目标的 realpath。
 * 目标必须是不存在的/空目录，或 manifest 声明同一项目（中断重试）；其余一律拒绝。
 */
export async function relocateProjectWorkspace({ projectId, sourcePath, targetPath }: ProjectWorkspaceRelocationInput): Promise<{ path: string }> {
    if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error(`非法项目 id：${projectId}`);
    if (!targetPath || !isAbsolute(targetPath)) throw new Error(`目标目录必须是绝对路径：${targetPath}`);
    const source = await realpath(sourcePath);
    if (!(await stat(source)).isDirectory()) throw new Error(`项目工作区不是目录：${sourcePath}`);
    const sourceManifest = await readManifestAt(source);
    if (sourceManifest && sourceManifest.projectId !== projectId) {
        throw new Error(`资产索引属于其他项目，拒绝覆盖：${join(source, MANIFEST_RELATIVE_PATH)}`);
    }

    // 词法预检（realpath 之前）：目标是源工作区本身 → 无需迁移；目标在源内部 → 直接拒绝，
    // 避免后续复制递归或在源目录里留下杂项；穿透 symlink 的情况由 mkdir 后的 realpath 复查兜底。
    const lexicalTarget = resolve(targetPath);
    if (lexicalTarget === source) return { path: source };
    if (withinRoot(lexicalTarget, source)) throw new Error(`目标目录不能在源工作区内：${targetPath}`);

    // 目标预检：非空目录必须声明同一项目；损坏 / 未知版本 / 其他项目的 manifest 在写入前就拒绝。
    let targetEntries: string[] | null = null;
    try {
        if (!(await stat(targetPath)).isDirectory()) throw new Error(`目标已存在且不是目录，拒绝覆盖：${targetPath}`);
        targetEntries = await readdir(targetPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    if (targetEntries && targetEntries.length > 0) {
        const targetManifest = await readManifestAt(targetPath);
        if (!targetManifest) throw new Error(`目标目录非空且未声明所属项目，拒绝覆盖：${targetPath}`);
        if (targetManifest.projectId !== projectId) throw new Error(`目标目录属于其他项目，拒绝覆盖：${targetPath}`);
    }

    await mkdir(targetPath, { recursive: true });
    const target = await realpath(targetPath);
    if (source === target) return { path: target };
    if (withinRoot(target, source)) throw new Error(`目标目录不能在源工作区内：${targetPath}`);

    // 整体复制（含 dotfiles 与 .shotshot/ 内的资产索引、项目记忆等全部内容）。
    await cp(source, target, { recursive: true, force: true });

    // 复制完成后再验证：目标 manifest 可读、属于本项目，且每条记录的文件都真实存在。
    const copiedManifest = await readManifestAt(target);
    if (copiedManifest) {
        if (copiedManifest.projectId !== projectId) throw new Error(`资产索引属于其他项目，拒绝覆盖：${join(target, MANIFEST_RELATIVE_PATH)}`);
        for (const record of copiedManifest.assets) {
            const assetPath = await resolveProjectAssetPath(target, record.relativePath);
            let assetStat;
            try {
                assetStat = await stat(assetPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new Error(`资产文件缺失，拒绝绑定：${record.relativePath}`);
                throw error;
            }
            if (!assetStat.isFile()) throw new Error(`资产文件缺失，拒绝绑定：${record.relativePath}`);
        }
    }
    return { path: target };
}

const parseRelocationInput = (input: unknown): ProjectWorkspaceRelocationInput => {
    if (!input || typeof input !== "object") throw new Error("非法参数");
    const { projectId, sourcePath, targetPath } = input as Record<string, unknown>;
    if (typeof projectId !== "string" || typeof sourcePath !== "string" || typeof targetPath !== "string") throw new Error("非法参数");
    return { projectId, sourcePath, targetPath };
};

type ProjectWorkspaceIpcOptions = {
    /** 供测试注入 handle 收集器；缺省用真实 electron ipcMain。 */
    ipcMain?: Pick<IpcMain, "handle">;
    root?: string;
    /** 与 project-assets 通道同级的信任校验：只放行主窗口 webContents。 */
    isTrustedSender(sender: WebContents): boolean;
};

const UNTRUSTED_SENDER_ERROR = "不受信任的渲染进程";

/** 注册 project:ensure-workspace / project:relocate-workspace handler；失败一律返回 {ok:false,error}，不向 renderer 抛错。 */
export function registerProjectWorkspaceIpc(options: ProjectWorkspaceIpcOptions): void {
    const ipc = options.ipcMain ?? ipcMain;
    const root = options.root ?? join(os.homedir(), "shotshot-workspace");
    ipc.handle("project:ensure-workspace", async (event, projectId: unknown, projectTitle: unknown) => {
        if (!options.isTrustedSender(event.sender)) return { ok: false as const, error: UNTRUSTED_SENDER_ERROR };
        try {
            if (typeof projectId !== "string" || typeof projectTitle !== "string") throw new Error("非法参数");
            return { ok: true as const, path: await ensureWorkspaceDir(root, projectId, projectTitle) };
        } catch (error) {
            return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
        }
    });
    ipc.handle("project:relocate-workspace", async (event, input: unknown) => {
        if (!options.isTrustedSender(event.sender)) return { ok: false as const, error: UNTRUSTED_SENDER_ERROR };
        try {
            return { ok: true as const, path: (await relocateProjectWorkspace(parseRelocationInput(input))).path };
        } catch (error) {
            return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
        }
    });
}
