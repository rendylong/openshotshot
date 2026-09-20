// electron/library-asset-store.ts
import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rename, stat, unlink, writeFile, lstat } from "node:fs/promises";
import os from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { sanitizeProjectAssetFileName } from "./project-asset-store";

export type LibraryAssetKind = "image" | "video" | "audio" | "text" | "other";

export type LibraryAssetRef = { backend: "library-file"; assetId: string; relativePath: string; revision: number };

export type LibraryAssetRecord = LibraryAssetRef & {
    originalName: string;
    kind: LibraryAssetKind;
    mimeType: string;
    bytes: number;
    sha256: string;
    title: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
};

export type LibraryAssetManifest = { app: "shotshot"; version: 1; scope: "library"; assets: LibraryAssetRecord[]; legacyMigratedAt?: string };

export type LibraryAssetWriteInput = {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    title: string;
    tags?: string[];
    source?: string;
    note?: string;
    /** 迁移保留原身份用；与已有 id 冲突时拒绝。 */
    assetId?: string;
    createdAt?: string;
};

export type LibraryAssetImportInput = { sourcePath: string; title: string; tags?: string[]; source?: string; note?: string };
export type LibraryAssetReadInput = { ref: LibraryAssetRef };
export type LibraryAssetResult = { record: LibraryAssetRecord; ref: LibraryAssetRef };
export type LibraryAssetListResult = { assets: LibraryAssetRecord[]; legacyMigratedAt?: string };
export type LibraryWatchEvent = { type: "changed"; record: LibraryAssetRecord } | { type: "missing"; ref: LibraryAssetRef };
export type LibraryWatchListener = (event: LibraryWatchEvent) => void;

const MANIFEST_DIRECTORY = ".shotshot";
const MANIFEST_RELATIVE_PATH = ".shotshot/assets.json";
const KIND_DIRECTORIES: Record<LibraryAssetKind, string> = { image: "images", video: "videos", audio: "audio", text: "texts", other: "files" };
const ALLOWED_PREFIXES = [...Object.values(KIND_DIRECTORIES), MANIFEST_DIRECTORY];
const EXTENSIONS_BY_MIME: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a",
    "text/markdown": "md", "text/plain": "txt",
};

export function extForMimeType(mimeType: string): string {
    return EXTENSIONS_BY_MIME[mimeType.split(";")[0].toLowerCase()] ?? "bin";
}

const hashBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const nowIso = (): string => new Date().toISOString();
const refFromRecord = (record: LibraryAssetRecord): LibraryAssetRef => ({ backend: "library-file", assetId: record.assetId, relativePath: record.relativePath, revision: record.revision });

const withinRoot = (path: string, root: string): boolean => {
    const fromRoot = relative(root, path);
    return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
};

const classifyKind = (name: string, mimeType: string): LibraryAssetKind => {
    const mime = mimeType.toLowerCase().split(";", 1)[0];
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("text/")) return "text";
    const extension = name.toLowerCase().split(".").pop() ?? "";
    if (["png", "jpg", "jpeg", "webp", "gif", "avif"].includes(extension)) return "image";
    if (["mp4", "webm", "mov", "m4v"].includes(extension)) return "video";
    if (["md", "markdown", "txt"].includes(extension)) return "text";
    return "other";
};

/** 把相对路径解析到素材库内绝对路径；只放行分类目录与 .shotshot 前缀，拒 `..`、绝对路径与 symlink 逃逸。 */
export async function resolveLibraryAssetPath(libraryPath: string, relativePath: string): Promise<string> {
    const library = await realpath(libraryPath);
    const normalized = relativePath.replaceAll("\\", "/");
    const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
    const unsafe =
        !normalized ||
        isAbsolute(normalized) ||
        segments.includes("..") ||
        !ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(`${prefix}/`));
    if (unsafe) throw new Error(`素材库目录之外的相对路径：${relativePath}`);
    const resolved = resolve(library, ...segments);
    if (!withinRoot(resolved, library)) throw new Error(`素材库目录之外的相对路径：${relativePath}`);
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
    if (realAncestor && !withinRoot(realAncestor, library)) throw new Error(`素材库目录之外的相对路径：${relativePath}`);
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

const freshManifest = (): LibraryAssetManifest => ({ app: "shotshot", version: 1, scope: "library", assets: [] });

const readManifest = async (library: string): Promise<LibraryAssetManifest> => {
    const manifestPath = join(library, MANIFEST_RELATIVE_PATH);
    let text: string;
    try {
        text = await readFile(manifestPath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return freshManifest();
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`资产索引损坏，拒绝覆盖：${manifestPath}`);
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as LibraryAssetManifest).assets)) {
        throw new Error(`资产索引损坏，拒绝覆盖：${manifestPath}`);
    }
    const manifest = parsed as LibraryAssetManifest;
    if (manifest.app !== "shotshot" || manifest.version !== 1 || manifest.scope !== "library") {
        throw new Error(`素材索引版本不受支持，拒绝覆盖：${manifestPath}`);
    }
    return manifest;
};

const writeManifest = async (library: string, manifest: LibraryAssetManifest): Promise<void> => {
    await mkdir(join(library, MANIFEST_DIRECTORY), { recursive: true });
    await writeAtomic(join(library, MANIFEST_RELATIVE_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
};

export type LibraryAssetStore = ReturnType<typeof createLibraryAssetStore>;

export function createLibraryAssetStore(options: { root?: string } = {}) {
    // 与 project-workspace 的根目录约定一致（~/shotshot-workspace），素材库固定为其下 library/。
    const rootPath = options.root ?? join(os.homedir(), "shotshot-workspace", "library");
    // 单一素材库：manifest 写入全局串行即可，无需按工作区分队列。
    let queue: Promise<unknown> = Promise.resolve();
    let watcher: FSWatcher | null = null;
    const listeners = new Set<LibraryWatchListener>();

    const run = <T>(task: () => Promise<T>): Promise<T> => {
        const next = queue.then(task, task);
        queue = next.then(() => undefined, () => undefined);
        return next;
    };

    const ensure = async (): Promise<string> => {
        await mkdir(rootPath, { recursive: true });
        return realpath(rootPath);
    };

    const canonicalLibrary = async (): Promise<string> => {
        const library = await ensure();
        if (!(await stat(library)).isDirectory()) throw new Error(`素材库目录不可用：${rootPath}`);
        return library;
    };

    const emit = (event: LibraryWatchEvent): void => {
        for (const listener of [...listeners]) listener(event);
    };

    const commitNewAsset = async (
        library: string,
        asset: { assetId: string; relativePath: string; originalName: string; kind: LibraryAssetKind; mimeType: string; title: string; tags: string[]; source?: string; note?: string; createdAt?: string },
        materialize: (target: string) => Promise<{ bytes: number; sha256: string }>,
    ): Promise<LibraryAssetResult> => {
        const manifest = await readManifest(library);
        if (manifest.assets.some((existing) => existing.assetId === asset.assetId)) throw new Error(`资产 id 冲突，拒绝覆盖：${asset.assetId}`);
        if (manifest.assets.some((existing) => existing.relativePath === asset.relativePath)) throw new Error(`目标文件已被其他素材占用，拒绝覆盖：${asset.relativePath}`);
        const target = await resolveLibraryAssetPath(library, asset.relativePath);
        await mkdir(dirname(target), { recursive: true });
        const { bytes, sha256 } = await materialize(target);
        const record: LibraryAssetRecord = {
            backend: "library-file",
            assetId: asset.assetId,
            relativePath: asset.relativePath,
            revision: 1,
            originalName: asset.originalName,
            kind: asset.kind,
            mimeType: asset.mimeType,
            bytes,
            sha256,
            title: asset.title,
            tags: asset.tags,
            ...(asset.source ? { source: asset.source } : {}),
            ...(asset.note ? { note: asset.note } : {}),
            createdAt: asset.createdAt ?? nowIso(),
            updatedAt: nowIso(),
        };
        try {
            await writeManifest(library, { ...manifest, assets: [...manifest.assets, record] });
        } catch (error) {
            await unlink(target).catch(() => undefined);
            throw error;
        }
        // 主进程写入主动广播：Agent assets_add 等不经渲染端 watch 自身的路径也能即时通知（fs.watch 自回声因 sha 相同静默）。
        emit({ type: "changed", record });
        return { record, ref: refFromRecord(record) };
    };

    const write = (input: LibraryAssetWriteInput): Promise<LibraryAssetResult> =>
        run(async () => {
            const library = await canonicalLibrary();
            const assetId = input.assetId ?? randomUUID();
            const kind = classifyKind(input.name, input.mimeType);
            const relativePath = `${KIND_DIRECTORIES[kind]}/${sanitizeProjectAssetFileName(input.name, assetId)}`;
            return commitNewAsset(
                library,
                {
                    assetId,
                    relativePath,
                    originalName: input.name,
                    kind,
                    mimeType: input.mimeType || "application/octet-stream",
                    title: input.title,
                    tags: input.tags ?? [],
                    ...(input.source ? { source: input.source } : {}),
                    ...(input.note ? { note: input.note } : {}),
                    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
                },
                async (target) => {
                    await writeAtomic(target, input.bytes);
                    return { bytes: input.bytes.byteLength, sha256: hashBytes(input.bytes) };
                },
            );
        });

    const importPath = (input: LibraryAssetImportInput): Promise<LibraryAssetResult> =>
        run(async () => {
            const details = await lstat(input.sourcePath);
            if (details.isSymbolicLink()) throw new Error(`不允许导入符号链接：${input.sourcePath}`);
            if (!details.isFile()) throw new Error(`只允许导入普通文件：${input.sourcePath}`);
            const source = await realpath(input.sourcePath);
            if (!(await stat(source)).isFile()) throw new Error(`只允许导入普通文件：${input.sourcePath}`);
            const library = await canonicalLibrary();
            const assetId = randomUUID();
            const originalName = input.sourcePath.split(/[\\/]/).pop() || "asset";
            const kind = classifyKind(originalName, "");
            const relativePath = `${KIND_DIRECTORIES[kind]}/${sanitizeProjectAssetFileName(originalName, assetId)}`;
            return commitNewAsset(
                library,
                {
                    assetId,
                    relativePath,
                    originalName,
                    kind,
                    mimeType: guessMimeFromExtension(originalName),
                    title: input.title,
                    tags: input.tags ?? [],
                    ...(input.source ? { source: input.source } : {}),
                    ...(input.note ? { note: input.note } : {}),
                },
                async (target) => {
                    await copyFile(source, target);
                    const copied = await readFile(target);
                    return { bytes: copied.byteLength, sha256: hashBytes(copied) };
                },
            );
        });

    const resolveKnownRef = async (library: string, ref: LibraryAssetRef) => {
        const manifest = await readManifest(library);
        const record = manifest.assets.find((asset) => asset.assetId === ref.assetId);
        if (!record) throw new Error(`不在素材索引中：${ref.assetId}`);
        if (record.relativePath !== ref.relativePath) throw new Error(`素材路径不匹配：${ref.relativePath}`);
        const target = await resolveLibraryAssetPath(library, record.relativePath);
        return { manifest, record, target };
    };

    const read = async (input: LibraryAssetReadInput): Promise<{ bytes: Uint8Array; record: LibraryAssetRecord }> => {
        const library = await canonicalLibrary();
        const { record, target } = await resolveKnownRef(library, input.ref);
        return { bytes: await readFile(target), record };
    };

    const statAsset = async (input: LibraryAssetReadInput): Promise<{ status: "ready"; record: LibraryAssetRecord } | { status: "missing" }> => {
        const library = await canonicalLibrary();
        const { record, target } = await resolveKnownRef(library, input.ref);
        try {
            if (!(await stat(target)).isFile()) return { status: "missing" };
            return { status: "ready", record };
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "missing" };
            throw error;
        }
    };

    const remove = (assetId: string): Promise<void> =>
        run(async () => {
            const library = await canonicalLibrary();
            const manifest = await readManifest(library);
            const record = manifest.assets.find((asset) => asset.assetId === assetId);
            if (!record) throw new Error(`不在素材索引中：${assetId}`);
            await writeManifest(library, { ...manifest, assets: manifest.assets.filter((asset) => asset.assetId !== assetId) });
            const target = await resolveLibraryAssetPath(library, record.relativePath);
            await unlink(target).catch(() => undefined);
        });

    const markLegacyMigrated = (): Promise<void> =>
        run(async () => {
            const library = await canonicalLibrary();
            const manifest = await readManifest(library);
            if (manifest.legacyMigratedAt) return;
            await writeManifest(library, { ...manifest, legacyMigratedAt: nowIso() });
        });

    const list = async (): Promise<LibraryAssetListResult> => {
        const library = await canonicalLibrary();
        const manifest = await readManifest(library);
        return { assets: manifest.assets, ...(manifest.legacyMigratedAt ? { legacyMigratedAt: manifest.legacyMigratedAt } : {}) };
    };

    const guessMimeFromExtension = (name: string): string => {
        const extension = name.toLowerCase().split(".").pop() ?? "";
        const hit = Object.entries(EXTENSIONS_BY_MIME).find(([, ext]) => ext === extension);
        return hit ? hit[0] : "application/octet-stream";
    };

    const handleFileChange = async (filename: string | null): Promise<void> => {
        if (!watcher || filename === null) return;
        const library = await realpath(rootPath).catch(() => "");
        if (!library) return;
        // watcher 挂在 realpath 后的目录上，事件名相对该目录拼接，再与 canonical 路径做越界比较。
        const eventPath = isAbsolute(filename) ? filename : join(library, filename);
        const inLibrary = relative(library, eventPath);
        if (!inLibrary || inLibrary === ".." || inLibrary.startsWith(`..${sep}`) || isAbsolute(inLibrary)) return;
        const relativePath = inLibrary.split(sep).join("/");
        if (!relativePath.startsWith(`${MANIFEST_DIRECTORY}/`) && !ALLOWED_PREFIXES.some((prefix) => relativePath.startsWith(`${prefix}/`))) return;
        if (relativePath.startsWith(`${MANIFEST_DIRECTORY}/`)) return;
        await run(async () => {
            const manifest = await readManifest(library);
            const record = manifest.assets.find((asset) => asset.relativePath === relativePath);
            if (!record) return;
            const target = await resolveLibraryAssetPath(library, relativePath);
            let bytes: Uint8Array;
            try {
                if (!(await stat(target)).isFile()) {
                    emit({ type: "missing", ref: refFromRecord(record) });
                    return;
                }
                bytes = await readFile(target);
            } catch (error) {
                if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
                    emit({ type: "missing", ref: refFromRecord(record) });
                    return;
                }
                throw error;
            }
            const sha256 = hashBytes(bytes);
            if (sha256 === record.sha256) return;
            const updated: LibraryAssetRecord = { ...record, bytes: bytes.byteLength, sha256, revision: record.revision + 1, updatedAt: nowIso() };
            await writeManifest(library, { ...manifest, assets: manifest.assets.map((asset) => (asset.assetId === updated.assetId ? updated : asset)) });
            emit({ type: "changed", record: updated });
        }).catch(() => undefined);
    };

    const watchLibrary = async (listener: LibraryWatchListener): Promise<() => void> => {
        const library = await canonicalLibrary();
        if (!watcher) {
            watcher = watch(library, { recursive: true }, (_event, filename) => {
                void handleFileChange(filename);
            });
            watcher.on("error", () => undefined);
        }
        listeners.add(listener);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            listeners.delete(listener);
        };
    };

    const close = async (): Promise<void> => {
        watcher?.close();
        watcher = null;
        listeners.clear();
    };

    return { ensure, list, write, importPath, read, stat: statAsset, remove, markLegacyMigrated, watch: watchLibrary, close };
}
