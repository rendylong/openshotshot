// electron/project-asset-store.ts
import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
    classifyProjectAsset,
    projectAssetDirectory,
    type ProjectAssetKind,
    type ProjectAssetManifest,
    type ProjectAssetRecord,
    type ProjectAssetSource,
    type ProjectFileAssetRef,
} from "@/lib/project-assets/project-asset-types";

export type ProjectAssetWriteInput = {
    projectId: string;
    workspacePath: string;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    source: ProjectAssetSource;
};

export type ProjectAssetImportPathInput = Omit<ProjectAssetWriteInput, "bytes"> & { sourcePath: string };

export type ProjectAssetReadInput = { workspacePath: string; ref: ProjectFileAssetRef };

export type ProjectAssetRestoreInput = {
    projectId: string;
    workspacePath: string;
    assetId: string;
    relativePath: string;
    revision: number;
    originalName: string;
    kind: ProjectAssetKind;
    mimeType: string;
    bytes: Uint8Array;
    /** 同步包声明的远端哈希；与字节不符时拒绝恢复。缺省时按字节计算。 */
    sha256?: string;
    createdAt?: string;
    source: ProjectAssetSource;
};

export type ProjectAssetResult = { record: ProjectAssetRecord; ref: ProjectFileAssetRef };

export type ProjectAssetStatResult = { status: "ready"; record: ProjectAssetRecord } | { status: "missing" };

export type ProjectAssetMissingEvent = { type: "missing"; ref: ProjectFileAssetRef };

export type ProjectAssetWatchEvent = ProjectAssetRecord | ProjectAssetMissingEvent;

export type ProjectAssetWatchListener = (event: ProjectAssetWatchEvent) => void;

export type ProjectAssetStoreOptions = Record<string, never>;

const MANIFEST_DIRECTORY = ".shotshot";
const MANIFEST_RELATIVE_PATH = ".shotshot/assets.json";
const ASSETS_ROOT = "assets";
const FILE_NAME_ID_LENGTH = 8;
const FILE_NAME_STEM_LIMIT = 40;

const hashBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const nowIso = (): string => new Date().toISOString();

const refFromRecord = (record: ProjectAssetRecord): ProjectFileAssetRef => ({
    backend: "project-file",
    assetId: record.assetId,
    projectId: record.projectId,
    relativePath: record.relativePath,
    revision: record.revision,
});

const withinRoot = (path: string, root: string): boolean => {
    const fromRoot = relative(root, path);
    return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
};

/** 文件名 = 可读词干 + "--" + assetId 前 8 位 hex + 规范化扩展名；冲突安全靠 assetId。 */
export function sanitizeProjectAssetFileName(name: string, assetId: string): string {
    const dot = name.lastIndexOf(".");
    const rawStem = dot > 0 ? name.slice(0, dot) : name;
    const rawExtension = dot > 0 ? name.slice(dot + 1) : "";
    const stem = rawStem
        .replace(/[^\p{L}\p{N}_-]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, FILE_NAME_STEM_LIMIT)
        .replace(/^-+|-+$/g, "");
    const extension = rawExtension.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16);
    return `${stem || "asset"}--${assetId.slice(0, FILE_NAME_ID_LENGTH)}.${extension || "bin"}`;
}

/** 把 manifest 风格的相对路径解析到工作区内绝对路径；拒绝 `..`、绝对路径、越界前缀和 symlink 逃逸。 */
export async function resolveProjectAssetPath(workspacePath: string, relativePath: string): Promise<string> {
    const workspace = await realpath(workspacePath);
    const normalized = relativePath.replaceAll("\\", "/");
    const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
    const unsafe =
        !normalized ||
        isAbsolute(normalized) ||
        segments.includes("..") ||
        !(normalized.startsWith(`${ASSETS_ROOT}/`) || normalized.startsWith(`${MANIFEST_DIRECTORY}/`));
    if (unsafe) throw new Error(`项目资产目录之外的相对路径：${relativePath}`);
    const resolved = resolve(workspace, ...segments);
    if (!withinRoot(resolved, workspace)) throw new Error(`项目资产目录之外的相对路径：${relativePath}`);
    // 目标可能尚不存在：向上找最深已存在的祖先，realpath 后确认没有借 symlink 逃出工作区。
    let probe = resolved;
    let realAncestor: string | undefined;
    while (probe !== dirname(probe)) {
        try {
            realAncestor = await realpath(probe);
            break;
        } catch {
            probe = dirname(probe);
        }
    }
    if (realAncestor && !withinRoot(realAncestor, workspace)) throw new Error(`项目资产目录之外的相对路径：${relativePath}`);
    return resolved;
}

const writeAtomic = async (target: string, bytes: Uint8Array | string): Promise<void> => {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, bytes);
        await rename(temporary, target);
    } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
    }
};

const canonicalizeWorkspace = async (workspacePath: string): Promise<string> => {
    const workspace = await realpath(workspacePath);
    if (!(await stat(workspace)).isDirectory()) throw new Error(`项目工作区不是目录：${workspacePath}`);
    return workspace;
};

const freshManifest = (projectId: string): ProjectAssetManifest => ({ app: "shotshot", version: 1, projectId, assets: [] });

const readManifest = async (workspace: string, projectId: string): Promise<ProjectAssetManifest> => {
    const manifestPath = join(workspace, MANIFEST_DIRECTORY, "assets.json");
    let text: string;
    try {
        text = await readFile(manifestPath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return freshManifest(projectId);
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
    if (manifest.projectId !== projectId) throw new Error(`资产索引属于其他项目，拒绝覆盖：${manifestPath}`);
    return manifest;
};

const writeManifest = async (workspace: string, manifest: ProjectAssetManifest): Promise<void> => {
    await mkdir(join(workspace, MANIFEST_DIRECTORY), { recursive: true });
    await writeAtomic(join(workspace, MANIFEST_DIRECTORY, "assets.json"), `${JSON.stringify(manifest, null, 2)}\n`);
};

export function createProjectAssetStore(options: ProjectAssetStoreOptions = {}) {
    void options;
    // 每个工作区的 manifest 变更串行化：键是 canonical realpath，值是该工作区的队尾。
    const manifestQueues = new Map<string, Promise<void>>();
    type WatcherEntry = { workspace: string; assetsDir: string; watcher: FSWatcher; listeners: Set<ProjectAssetWatchListener> };
    const watchers = new Map<string, WatcherEntry>();

    const enqueue = <T>(workspace: string, task: () => Promise<T>): Promise<T> => {
        const previous = manifestQueues.get(workspace) ?? Promise.resolve();
        const run = previous.then(() => task());
        const tail = run.then(
            () => undefined,
            () => undefined,
        );
        manifestQueues.set(workspace, tail);
        void tail.then(() => {
            if (manifestQueues.get(workspace) === tail) manifestQueues.delete(workspace);
        });
        return run;
    };

    /** 冲突校验 → 物化文件 → 采用进 manifest；manifest 失败时只删除本次新建的目标文件。 */
    const commitNewAsset = async (
        workspace: string,
        projectId: string,
        asset: { assetId: string; relativePath: string; originalName: string; kind: ProjectAssetKind; mimeType: string; source: ProjectAssetSource },
        materialize: (target: string) => Promise<{ bytes: number; sha256: string }>,
    ): Promise<ProjectAssetResult> => {
        const manifest = await readManifest(workspace, projectId);
        if (manifest.assets.some((existing) => existing.assetId === asset.assetId)) throw new Error(`资产 id 冲突，拒绝覆盖：${asset.assetId}`);
        if (manifest.assets.some((existing) => existing.relativePath === asset.relativePath)) {
            throw new Error(`目标文件已被其他资产占用，拒绝覆盖：${asset.relativePath}`);
        }
        const target = await resolveProjectAssetPath(workspace, asset.relativePath);
        await mkdir(dirname(target), { recursive: true });
        const { bytes, sha256 } = await materialize(target);
        const record: ProjectAssetRecord = {
            backend: "project-file",
            assetId: asset.assetId,
            projectId,
            relativePath: asset.relativePath,
            revision: 1,
            originalName: asset.originalName,
            kind: asset.kind,
            mimeType: asset.mimeType,
            bytes,
            sha256,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            source: asset.source,
        };
        try {
            await writeManifest(workspace, { ...manifest, assets: [...manifest.assets, record] });
        } catch (error) {
            await unlink(target).catch(() => undefined);
            throw error;
        }
        return { record, ref: refFromRecord(record) };
    };

    const writeBytes = async (input: ProjectAssetWriteInput): Promise<ProjectAssetResult> => {
        const workspace = await canonicalizeWorkspace(input.workspacePath);
        return enqueue(workspace, async () => {
            const assetId = randomUUID();
            const kind = classifyProjectAsset(input.name, input.mimeType);
            const relativePath = `${projectAssetDirectory(input.source, kind)}/${sanitizeProjectAssetFileName(input.name, assetId)}`;
            const bytes = input.bytes;
            return commitNewAsset(
                workspace,
                input.projectId,
                {
                    assetId,
                    relativePath,
                    originalName: input.name,
                    kind,
                    mimeType: input.mimeType || "application/octet-stream",
                    source: input.source,
                },
                async (target) => {
                    await writeAtomic(target, bytes);
                    return { bytes: bytes.byteLength, sha256: hashBytes(bytes) };
                },
            );
        });
    };

    const importPath = async (input: ProjectAssetImportPathInput): Promise<ProjectAssetResult> => {
        const details = await lstat(input.sourcePath);
        if (details.isSymbolicLink()) throw new Error(`不允许导入符号链接：${input.sourcePath}`);
        if (!details.isFile()) throw new Error(`只允许导入普通文件：${input.sourcePath}`);
        const source = await realpath(input.sourcePath);
        if (!(await stat(source)).isFile()) throw new Error(`只允许导入普通文件：${input.sourcePath}`);
        const workspace = await canonicalizeWorkspace(input.workspacePath);
        return enqueue(workspace, async () => {
            const assetId = randomUUID();
            const kind = classifyProjectAsset(input.name, input.mimeType);
            const relativePath = `${projectAssetDirectory(input.source, kind)}/${sanitizeProjectAssetFileName(input.name, assetId)}`;
            return commitNewAsset(
                workspace,
                input.projectId,
                {
                    assetId,
                    relativePath,
                    originalName: input.name,
                    kind,
                    mimeType: input.mimeType || "application/octet-stream",
                    source: input.source,
                },
                async (target) => {
                    await copyFile(source, target);
                    const copied = await readFile(target);
                    return { bytes: copied.byteLength, sha256: hashBytes(copied) };
                },
            );
        });
    };

    const resolveKnownRef = async (workspacePath: string, ref: ProjectFileAssetRef) => {
        const workspace = await canonicalizeWorkspace(workspacePath);
        const manifest = await readManifest(workspace, ref.projectId);
        const record = manifest.assets.find((asset) => asset.assetId === ref.assetId);
        if (!record) throw new Error(`资产不在索引中：${ref.assetId}`);
        if (record.projectId !== ref.projectId) throw new Error(`资产项目不匹配：${ref.assetId}`);
        if (record.relativePath !== ref.relativePath) throw new Error(`资产路径不匹配：${ref.relativePath}`);
        const target = await resolveProjectAssetPath(workspace, record.relativePath);
        return { workspace, manifest, record, target };
    };

    const read = async (input: ProjectAssetReadInput): Promise<{ bytes: Uint8Array; record: ProjectAssetRecord }> => {
        const { record, target } = await resolveKnownRef(input.workspacePath, input.ref);
        return { bytes: await readFile(target), record };
    };

    const statAsset = async (input: ProjectAssetReadInput): Promise<ProjectAssetStatResult> => {
        const { record, target } = await resolveKnownRef(input.workspacePath, input.ref);
        try {
            if (!(await stat(target)).isFile()) return { status: "missing" };
            return { status: "ready", record };
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "missing" };
            throw error;
        }
    };

    const restore = async (input: ProjectAssetRestoreInput): Promise<ProjectAssetResult> => {
        const workspace = await canonicalizeWorkspace(input.workspacePath);
        // manifest 路径保留给 store 自己的索引写入器：远端同步条目不得借 restore 物化字节覆盖索引。
        // 与 resolveProjectAssetPath 同样先规范化（./ 与多余分隔符等价写法一并拒绝）。
        const normalized = input.relativePath.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0 && segment !== ".").join("/");
        if (normalized === MANIFEST_RELATIVE_PATH) throw new Error(`目标路径是资产索引，拒绝恢复：${input.relativePath}`);
        return enqueue(workspace, async () => {
            const target = await resolveProjectAssetPath(workspace, input.relativePath);
            const bytes = input.bytes;
            const sha256 = hashBytes(bytes);
            if (input.sha256 && input.sha256 !== sha256) throw new Error(`恢复内容与声明哈希冲突，拒绝写入：${input.relativePath}`);
            const manifest = await readManifest(workspace, input.projectId);
            const existing = manifest.assets.find((asset) => asset.assetId === input.assetId);
            if (existing) {
                if (existing.relativePath !== input.relativePath) throw new Error(`同一资产 id 已有不同路径，拒绝覆盖：${input.assetId}`);
                if (existing.sha256 !== sha256) throw new Error(`同一资产 id 内容冲突，拒绝覆盖：${input.assetId}`);
                // 幂等：记录一致时不改 manifest；文件丢失则按同一身份重新物化。
                try {
                    await stat(target);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
                    await mkdir(dirname(target), { recursive: true });
                    await writeAtomic(target, bytes);
                }
                return { record: existing, ref: refFromRecord(existing) };
            }
            if (manifest.assets.some((asset) => asset.relativePath === input.relativePath)) {
                throw new Error(`目标文件已被其他资产占用，拒绝覆盖：${input.relativePath}`);
            }
            await mkdir(dirname(target), { recursive: true });
            await writeAtomic(target, bytes);
            const record: ProjectAssetRecord = {
                backend: "project-file",
                assetId: input.assetId,
                projectId: input.projectId,
                relativePath: input.relativePath,
                revision: input.revision,
                originalName: input.originalName,
                kind: input.kind,
                mimeType: input.mimeType,
                bytes: bytes.byteLength,
                sha256,
                createdAt: input.createdAt ?? nowIso(),
                updatedAt: nowIso(),
                source: input.source,
            };
            try {
                await writeManifest(workspace, { ...manifest, assets: [...manifest.assets, record] });
            } catch (error) {
                await unlink(target).catch(() => undefined);
                throw error;
            }
            return { record, ref: refFromRecord(record) };
        });
    };

    const emit = (entry: WatcherEntry, event: ProjectAssetWatchEvent): void => {
        for (const listener of entry.listeners) listener(event);
    };

    const handleAssetChange = async (projectId: string, filename: string | null): Promise<void> => {
        const entry = watchers.get(projectId);
        if (!entry || filename === null) return;
        const eventPath = isAbsolute(filename) ? filename : join(entry.assetsDir, filename);
        const inWorkspace = relative(entry.workspace, eventPath);
        if (!inWorkspace || inWorkspace === ".." || inWorkspace.startsWith(`..${sep}`) || isAbsolute(inWorkspace)) return;
        const relativePath = inWorkspace.split(sep).join("/");
        if (!relativePath.startsWith(`${ASSETS_ROOT}/`)) return;
        await enqueue(entry.workspace, async () => {
            const manifest = await readManifest(entry.workspace, projectId);
            const record = manifest.assets.find((asset) => asset.relativePath === relativePath);
            if (!record) return;
            const target = await resolveProjectAssetPath(entry.workspace, relativePath);
            let bytes: Uint8Array;
            try {
                if (!(await stat(target)).isFile()) {
                    emit(entry, { type: "missing", ref: refFromRecord(record) });
                    return;
                }
                bytes = await readFile(target);
            } catch (error) {
                if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
                    emit(entry, { type: "missing", ref: refFromRecord(record) });
                    return;
                }
                throw error;
            }
            const sha256 = hashBytes(bytes);
            if (sha256 === record.sha256) return;
            const updated: ProjectAssetRecord = {
                ...record,
                bytes: bytes.byteLength,
                sha256,
                revision: record.revision + 1,
                updatedAt: nowIso(),
            };
            const assets = manifest.assets.map((asset) => (asset.assetId === updated.assetId ? updated : asset));
            await writeManifest(entry.workspace, { ...manifest, assets });
            emit(entry, updated);
        }).catch(() => undefined);
    };

    const watchWorkspace = async (projectId: string, workspacePath: string, listener: ProjectAssetWatchListener): Promise<() => void> => {
        const workspace = await canonicalizeWorkspace(workspacePath);
        let entry = watchers.get(projectId);
        if (entry && entry.workspace !== workspace) {
            await unwatch(projectId);
            entry = undefined;
        }
        if (!entry) {
            const assetsDir = join(workspace, ASSETS_ROOT);
            await mkdir(assetsDir, { recursive: true });
            const watcher = watch(assetsDir, { recursive: true }, (_event, filename) => {
                void handleAssetChange(projectId, filename);
            });
            watcher.on("error", () => undefined);
            entry = { workspace, assetsDir, watcher, listeners: new Set() };
            watchers.set(projectId, entry);
        }
        entry.listeners.add(listener);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            entry.listeners.delete(listener);
        };
    };

    const unwatch = async (projectId: string): Promise<void> => {
        const entry = watchers.get(projectId);
        if (!entry) return;
        watchers.delete(projectId);
        entry.watcher.close();
    };

    const close = async (): Promise<void> => {
        for (const projectId of [...watchers.keys()]) await unwatch(projectId);
    };

    return { writeBytes, importPath, read, stat: statAsset, restore, watch: watchWorkspace, unwatch, close };
}

export type ProjectAssetStore = ReturnType<typeof createProjectAssetStore>;
