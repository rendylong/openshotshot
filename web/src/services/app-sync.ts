import localforage from "localforage";
import { nanoid } from "nanoid";

import {
    classifyProjectAsset,
    isProjectFileAssetRef,
    rewriteProjectAssetRefs,
    type ProjectAssetKind,
    type ProjectAssetRecord,
    type ProjectAssetSource,
    type ProjectFileAssetRef,
} from "@/lib/project-assets/project-asset-types";
import i18n from "@/i18n";
import { getMediaBlob, resolveMediaUrl, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, resolveImageUrl, setImageBlob } from "@/services/image-storage";
import { readSyncedProjectAsset, restoreSyncedAsset, statSyncedProjectAsset } from "@/services/project-asset-storage";
import { downloadWebdavFile, uploadWebdavFile, WEBDAV_MANIFEST_FILE_NAME } from "@/services/webdav-sync";
import type { Asset } from "@/stores/use-asset-store";
import { useAssetStore } from "@/stores/use-asset-store";
import type { WebdavSyncConfig } from "@/stores/use-config-store";
import type { Project } from "@/types/project";
import { useProjectStore } from "@/stores/canvas/use-project-store";

type StoredLog = Record<string, unknown> & { id?: string };
export type AppSyncDomainKey = "canvas" | "assets" | "image-workbench" | "video-workbench";
type DomainKey = AppSyncDomainKey;
type CanvasDomainData = { projects: Project[] };
type AssetDomainData = { assets: Asset[] };
type LogDomainData = { logs: StoredLog[] };

type AppSyncFile = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
    /** project-file 资产的可移植身份字段（不含本机绝对路径）；旧条目缺失时按既有 IndexedDB 行为处理。 */
    assetId?: string;
    projectId?: string;
    relativePath?: string;
    revision?: number;
    sha256?: string;
    originalName?: string;
    kind?: ProjectAssetKind;
    createdAt?: string;
    source?: ProjectAssetSource;
};

type DomainManifest<T> = {
    app: "shotshot";
    version: 1;
    domain: DomainKey;
    exportedAt: string;
    data: T;
    files: AppSyncFile[];
};

type SyncDomainOptions<T> = {
    key: DomainKey;
    label: string;
    localData: () => Promise<T>;
    emptyData: T;
    mergeData: (local: T, remote: T) => T;
    applyData?: (data: T) => Promise<void>;
};

type SyncDomainResult<T> = {
    data: T;
    mergedRemote: boolean;
    files: number;
    manifestBytes: number;
    uploadedFiles: number;
    uploadedBytes: number;
};

export type AppSyncResult = {
    syncedAt: string;
    mergedRemote: boolean;
    projects: number;
    assets: number;
    imageLogs: number;
    videoLogs: number;
    files: number;
    manifestBytes: number;
    uploadedFiles: number;
    uploadedBytes: number;
};

export type AppSyncProgressEvent = {
    domain?: AppSyncDomainKey;
    label?: string;
    stage: string;
    current?: number;
    total?: number;
    status?: "active" | "success" | "exception";
};

export type AppSyncProgress = (event: AppSyncProgressEvent) => void;

const FILE_CONCURRENCY = 3;
const imageLogStore = localforage.createInstance({ name: "shotshot", storeName: "image_generation_logs" });
const videoLogStore = localforage.createInstance({ name: "shotshot", storeName: "video_generation_logs" });
type LogStore = typeof imageLogStore;
const storageKeyPattern = /^(image|video|audio|file|video-reference|audio-reference):/;

export async function syncAppDataToWebdav(config: WebdavSyncConfig, onProgress?: AppSyncProgress): Promise<AppSyncResult> {
    emitProgress(onProgress, { stage: "等待本地数据加载" });
    await Promise.all([waitForHydration(useProjectStore), waitForHydration(useAssetStore)]);

    const [canvas, assets, imageLogs, videoLogs] = await Promise.all([
        syncDomain<CanvasDomainData>(config, onProgress, {
            key: "canvas",
            label: "画布",
            emptyData: { projects: [] },
            localData: async () => ({ projects: useProjectStore.getState().projects }),
            mergeData: (local, remote) => ({ projects: mergeById(local.projects, remote.projects, "updatedAt") }),
            applyData: async (data) => useProjectStore.getState().replaceProjects(data.projects),
        }),
        syncDomain<AssetDomainData>(config, onProgress, {
            key: "assets",
            label: "我的资产",
            emptyData: { assets: [] },
            localData: async () => ({ assets: useAssetStore.getState().assets }),
            mergeData: (local, remote) => ({ assets: mergeById(local.assets, remote.assets, "updatedAt") }),
            applyData: async (data) => useAssetStore.getState().replaceAssets(await Promise.all(data.assets.map(hydrateAsset))),
        }),
        syncDomain<LogDomainData>(config, onProgress, {
            key: "image-workbench",
            label: "生图工作台",
            emptyData: { logs: [] },
            localData: async () => ({ logs: await readStoredLogs(imageLogStore) }),
            mergeData: (local, remote) => ({ logs: mergeById(local.logs, remote.logs, "createdAt") }),
            applyData: async (data) => replaceStoredLogs(imageLogStore, data.logs),
        }),
        syncDomain<LogDomainData>(config, onProgress, {
            key: "video-workbench",
            label: "视频创作台",
            emptyData: { logs: [] },
            localData: async () => ({ logs: await readStoredLogs(videoLogStore) }),
            mergeData: (local, remote) => ({ logs: mergeById(local.logs, remote.logs, "createdAt") }),
            applyData: async (data) => replaceStoredLogs(videoLogStore, data.logs),
        }),
    ]);

    const result = {
        syncedAt: new Date().toISOString(),
        mergedRemote: [canvas, assets, imageLogs, videoLogs].some((item) => item.mergedRemote),
        projects: canvas.data.projects.length,
        assets: assets.data.assets.length,
        imageLogs: imageLogs.data.logs.length,
        videoLogs: videoLogs.data.logs.length,
        files: canvas.files + assets.files + imageLogs.files + videoLogs.files,
        manifestBytes: canvas.manifestBytes + assets.manifestBytes + imageLogs.manifestBytes + videoLogs.manifestBytes,
        uploadedFiles: canvas.uploadedFiles + assets.uploadedFiles + imageLogs.uploadedFiles + videoLogs.uploadedFiles,
        uploadedBytes: canvas.uploadedBytes + assets.uploadedBytes + imageLogs.uploadedBytes + videoLogs.uploadedBytes,
    };
    emitProgress(onProgress, { stage: "同步完成", status: "success" });
    return result;
}

async function syncDomain<T>(config: WebdavSyncConfig, onProgress: AppSyncProgress | undefined, options: SyncDomainOptions<T>): Promise<SyncDomainResult<T>> {
    try {
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: "读取远端清单", status: "active" });
        const remoteManifest = await readDomainManifest(config, options.key, options.emptyData);
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: "读取本地数据", status: "active" });
        const localData = await options.localData();
        if (remoteManifest) {
            // merge 前处理远端 project-file 资产：桌面做同 assetId 内容冲突再定基；纯 Web 物化到 IndexedDB 并改写引用。
            emitProgress(onProgress, { domain: options.key, label: options.label, stage: "恢复远端项目资产", status: "active" });
            await prepareRemoteProjectAssets(config, options.key, remoteManifest, onProgress);
        }
        const mergedData = remoteManifest ? options.mergeData(localData, remoteManifest.data) : localData;

        if (remoteManifest) {
            emitProgress(onProgress, { domain: options.key, label: options.label, stage: "下载缺失媒体", status: "active" });
            await downloadMissingFiles(config, options.key, mergedData, remoteManifest.files, onProgress);
            emitProgress(onProgress, { domain: options.key, label: options.label, stage: "写入本地合并结果", status: "active" });
            await options.applyData?.(mergedData);
        }

        emitProgress(onProgress, { domain: options.key, label: options.label, stage: "上传新增媒体", status: "active" });
        const uploaded = await uploadChangedFiles(config, options.key, mergedData, remoteManifest?.files || [], onProgress);
        const manifest: DomainManifest<T> = { app: "shotshot", version: 1, domain: options.key, exportedAt: new Date().toISOString(), data: portableSyncData(mergedData), files: uploaded.files };
        const manifestFile = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: `上传清单 ${formatBytes(manifestFile.size)}`, status: "active" });
        await uploadWebdavFile(config, domainPath(options.key, WEBDAV_MANIFEST_FILE_NAME), manifestFile, "application/json");
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: "完成", current: 1, total: 1, status: "success" });

        return {
            data: mergedData,
            mergedRemote: Boolean(remoteManifest),
            files: uploaded.files.length,
            manifestBytes: manifestFile.size,
            uploadedFiles: uploaded.uploadedFiles,
            uploadedBytes: uploaded.uploadedBytes,
        };
    } catch (error) {
        emitProgress(onProgress, { domain: options.key, label: options.label, stage: error instanceof Error ? error.message : i18n.t("config.webdav.errors.syncFailed"), status: "exception" });
        throw error;
    }
}

async function readDomainManifest<T>(config: WebdavSyncConfig, domain: DomainKey, emptyData: T): Promise<DomainManifest<T> | null> {
    const file = await downloadWebdavFile(config, domainPath(domain, WEBDAV_MANIFEST_FILE_NAME));
    if (!file) return null;
    const data = JSON.parse(await file.text()) as DomainManifest<T>;
    if (data.app !== "shotshot" || data.domain !== domain) throw new Error(i18n.t("config.webdav.errors.invalidManifest", { domain }));
    return {
        app: "shotshot",
        version: 1,
        domain,
        exportedAt: data.exportedAt || new Date().toISOString(),
        data: data.data || emptyData,
        files: Array.isArray(data.files) ? data.files : [],
    };
}

export async function downloadMissingFiles<T>(config: WebdavSyncConfig, domain: DomainKey, data: T, remoteFiles: AppSyncFile[], onProgress?: AppSyncProgress) {
    const remoteFileMap = new Map(remoteFiles.map((item) => [item.storageKey, item]));
    const tasks: AppSyncFile[] = [];
    const ensuredWorkspaces = new Map<string, string>();
    const items = collectSyncAssets(data);
    let scanned = 0;
    for (const item of items) {
        let missing = false;
        if (item.ref) {
            missing = !(await statSyncedProjectAsset(item.ref));
        } else if (item.storageKey) {
            const localBlob = item.storageKey.startsWith("image:") ? await getImageBlob(item.storageKey) : await getMediaBlob(item.storageKey);
            missing = !localBlob;
        }
        scanned += 1;
        if (missing) {
            const remoteFile = remoteFileMap.get(item.key);
            if (remoteFile) tasks.push(remoteFile);
        }
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "检查缺失媒体", current: scanned, total: items.length, status: "active" });
    }
    if (!tasks.length) {
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "媒体已齐全", current: 1, total: 1, status: "active" });
        return;
    }
    let downloaded = 0;
    await runWithConcurrency(tasks, FILE_CONCURRENCY, async (remoteFile) => {
        const blob = await downloadWebdavFile(config, remoteFile.path);
        if (!blob) return;
        const typedBlob = blob.type ? blob : blob.slice(0, blob.size, remoteFile.mimeType);
        const ref = entryRef(remoteFile);
        if (ref) {
            const restored = await restoreSyncedAsset({
                projectId: ref.projectId,
                assetId: ref.assetId,
                relativePath: ref.relativePath,
                revision: ref.revision,
                originalName: remoteFile.originalName || fileNameOf(ref.relativePath),
                kind: remoteFile.kind || classifyProjectAsset(fileNameOf(ref.relativePath), remoteFile.mimeType),
                mimeType: remoteFile.mimeType,
                sha256: remoteFile.sha256,
                createdAt: remoteFile.createdAt,
                source: remoteFile.source,
                blob: typedBlob,
            });
            if (restored.ok && restored.workspacePath) ensuredWorkspaces.set(ref.projectId, restored.workspacePath);
        } else if (remoteFile.storageKey && !isProjectAssetEntry(remoteFile)) {
            // 残缺的 project-file 条目（缺 revision 等）不落入旧 IndexedDB 分支，避免写坏 key。
            await (remoteFile.storageKey.startsWith("image:") ? setImageBlob(remoteFile.storageKey, typedBlob) : setMediaBlob(remoteFile.storageKey, typedBlob));
        }
        downloaded += 1;
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "下载媒体", current: downloaded, total: tasks.length, status: "active" });
    });
    applyEnsuredWorkspaces(data, ensuredWorkspaces);
}

/** 远端-only 项目在 applyData 前把 ensure 出的本机工作区路径补进合并快照，避免 restore 后引用无法解析。 */
function applyEnsuredWorkspaces<T>(data: T, ensuredWorkspaces: Map<string, string>) {
    if (!ensuredWorkspaces.size || !data || typeof data !== "object") return;
    const container = data as { projects?: Project[] };
    if (!Array.isArray(container.projects)) return;
    container.projects = container.projects.map((project) => {
        const workspacePath = ensuredWorkspaces.get(project.id);
        return workspacePath && !project.workspacePath ? { ...project, workspacePath } : project;
    });
}

/** 序列化清单时剥离本机工作区绝对路径：跨设备定位只靠 projectId + assetId + relativePath；
    本地 store 与 applyData 仍使用带路径的项目对象，不受影响。 */
function portableSyncData<T>(data: T): T {
    if (!data || typeof data !== "object") return data;
    const container = data as { projects?: Project[] };
    if (!Array.isArray(container.projects)) return data;
    const projects = container.projects.map((project) => (project.workspacePath === undefined ? project : { ...project, workspacePath: undefined }));
    return { ...container, projects } as T;
}

async function uploadChangedFiles<T>(config: WebdavSyncConfig, domain: DomainKey, data: T, remoteFiles: AppSyncFile[], onProgress?: AppSyncProgress) {
    const remoteFileMap = new Map(remoteFiles.map((item) => [item.storageKey, item]));
    const files: AppSyncFile[] = [];
    const tasks: Array<{ item: AppSyncFile; blob: Blob }> = [];
    let uploadedFiles = 0;
    let uploadedBytes = 0;

    const items = collectSyncAssets(data);
    let scanned = 0;
    for (const item of items) {
        if (item.ref) {
            const remoteFile = remoteFileMap.get(item.key);
            const read = await readSyncedProjectAsset(item.ref);
            if (!read) {
                // 本地读不到（工作区缺失等）：保留远端已有条目，避免清单丢失该资产身份。
                if (remoteFile) files.push(remoteFile);
            } else {
                const entry = projectSyncEntry(domain, read.record);
                files.push(entry);
                // 内容一致（sha256 相同）时跳过上传；revision 变化必然伴随内容变化。
                if (remoteFile?.sha256 !== read.record.sha256) tasks.push({ item: entry, blob: read.blob });
            }
            scanned += 1;
            emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "检查本地媒体", current: scanned, total: items.length, status: "active" });
            continue;
        }
        const storageKey = item.storageKey!;
        const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        const remoteFile = remoteFileMap.get(storageKey);
        if (!blob) {
            if (remoteFile) files.push(remoteFile);
            scanned += 1;
            emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "检查本地媒体", current: scanned, total: items.length, status: "active" });
            continue;
        }
        const entry: AppSyncFile = {
            storageKey,
            path: remoteFile?.path || domainPath(domain, `files/${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`),
            mimeType: blob.type || remoteFile?.mimeType || "application/octet-stream",
            bytes: blob.size,
        };
        files.push(entry);
        if (!remoteFile || remoteFile.bytes !== blob.size) tasks.push({ item: entry, blob });
        scanned += 1;
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "检查本地媒体", current: scanned, total: items.length, status: "active" });
    }

    if (!tasks.length) {
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "媒体无需上传", current: 1, total: 1, status: "active" });
        return { files, uploadedFiles, uploadedBytes };
    }

    await runWithConcurrency(tasks, FILE_CONCURRENCY, async ({ item, blob }) => {
        await uploadWebdavFile(config, item.path, blob, item.mimeType);
        uploadedFiles += 1;
        uploadedBytes += blob.size;
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: `上传媒体 ${formatBytes(blob.size)}`, current: uploadedFiles, total: tasks.length, status: "active" });
    });

    return { files, uploadedFiles, uploadedBytes };
}

async function hydrateAsset(asset: Asset): Promise<Asset> {
    if (asset.kind === "image" && asset.data.storageKey) {
        const dataUrl = await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl);
        return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? dataUrl : asset.coverUrl, data: { ...asset.data, dataUrl } };
    }
    if (asset.kind === "video" && asset.data.storageKey) {
        const url = await resolveMediaUrl(asset.data.storageKey, asset.data.url);
        return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? url : asset.coverUrl, data: { ...asset.data, url } };
    }
    return asset;
}

async function readStoredLogs(store: LogStore) {
    const logs: StoredLog[] = [];
    await store.iterate<StoredLog, void>((value) => {
        if (value && typeof value === "object") logs.push(value);
    });
    return logs;
}

async function replaceStoredLogs(store: LogStore, logs: StoredLog[]) {
    await store.clear();
    await runWithConcurrency(logs, FILE_CONCURRENCY, async (log) => {
        const id = getStringField(log, "id");
        if (id) await store.setItem(id, log);
    });
}

function mergeById<T extends { id?: string }>(local: T[], remote: T[], timeKey: string) {
    const items = new Map<string, T>();
    remote.forEach((item) => {
        const id = item.id || "";
        if (id) items.set(id, item);
    });
    local.forEach((item) => {
        const id = item.id || "";
        if (!id) return;
        const current = items.get(id);
        if (!current || getTime(item as Record<string, unknown>, timeKey) >= getTime(current as Record<string, unknown>, timeKey)) items.set(id, item);
    });
    return Array.from(items.values()).sort((a, b) => getTime(b as Record<string, unknown>, timeKey) - getTime(a as Record<string, unknown>, timeKey));
}

type SyncAssetItem = { key: string; storageKey?: string; ref?: ProjectFileAssetRef };

const projectSyncKey = (projectId: string, assetId: string) => `project:${projectId}:${assetId}`;

function entryRef(entry: AppSyncFile): ProjectFileAssetRef | null {
    if (!entry.assetId || !entry.projectId || !entry.relativePath || typeof entry.revision !== "number") return null;
    return { backend: "project-file", assetId: entry.assetId, projectId: entry.projectId, relativePath: entry.relativePath, revision: entry.revision };
}

function isProjectAssetEntry(entry: AppSyncFile): boolean {
    return Boolean(entry.assetId && entry.projectId && entry.relativePath);
}

function fileNameOf(relativePath: string) {
    return relativePath.split("/").pop() || "asset";
}

/** 远端文件条目 → project-file 同步条目；路径由 projectId + relativePath 决定，绝不使用本机绝对路径。 */
function projectSyncEntry(domain: DomainKey, record: ProjectAssetRecord): AppSyncFile {
    return {
        storageKey: projectSyncKey(record.projectId, record.assetId),
        path: domainPath(domain, `files/projects/${record.projectId}/${record.relativePath}`),
        mimeType: record.mimeType || "application/octet-stream",
        bytes: record.bytes,
        assetId: record.assetId,
        projectId: record.projectId,
        relativePath: record.relativePath,
        revision: record.revision,
        sha256: record.sha256,
        originalName: record.originalName,
        kind: record.kind,
        createdAt: record.createdAt,
        source: record.source,
    };
}

/** 同时收集旧 IndexedDB storageKey 与 project-file assetRef；同一身份去重，先出现者优先。 */
function collectSyncAssets(value: unknown, items = new Map<string, SyncAssetItem>()): SyncAssetItem[] {
    if (typeof value === "string") {
        if (storageKeyPattern.test(value)) items.set(value, { key: value, storageKey: value });
        return [...items.values()];
    }
    if (!value || typeof value !== "object") return [...items.values()];
    if (isProjectFileAssetRef(value)) {
        const key = projectSyncKey(value.projectId, value.assetId);
        if (!items.has(key)) items.set(key, { key, ref: value });
        return [...items.values()];
    }
    if ("storageKey" in value && typeof value.storageKey === "string" && storageKeyPattern.test(value.storageKey)) items.set(value.storageKey, { key: value.storageKey, storageKey: value.storageKey });
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectSyncAssets(child, items)) : collectSyncAssets(item, items)));
    return [...items.values()];
}

/** merge 前处理远端 project-file 条目：
    - 桌面：与本地同 assetId 但 sha256 不同视为冲突——保留本地文件，把远端字节以新 assetId 恢复，
      并把远端 Project 快照中全部命中引用改写为新 identity，再进入 mergeById(updatedAt)。
    - 纯 Web：把远端字节存入 IndexedDB，把快照引用改写为 {backend:"indexeddb", storageKey}。 */
async function prepareRemoteProjectAssets<T>(config: WebdavSyncConfig, domain: DomainKey, manifest: DomainManifest<T>, onProgress?: AppSyncProgress) {
    const entries = manifest.files.filter(isProjectAssetEntry);
    if (!entries.length) return;
    const webRestoreKeys = new Map<string, string>();
    for (const entry of entries) {
        const ref = entryRef(entry);
        if (!ref) continue;
        if (window.shotshot?.projectAssets) {
            const local = await statSyncedProjectAsset(ref);
            // 双方都有 sha256 才判定冲突；缺失 sha256 的残缺条目不触发再定基（避免每次同步复制出重复资产）。
            if (local && entry.sha256 && local.sha256 !== entry.sha256) {
                await rebaseConflictingRemoteAsset(config, domain, manifest, entry, ref, onProgress);
                continue;
            }
            // 本地就绪或本地缺失：缺失交给 downloadMissingFiles 按原身份幂等 restore。
            continue;
        }
        const blob = await downloadWebdavFile(config, entry.path);
        if (!blob) continue;
        const restored = await restoreSyncedAsset({
            projectId: ref.projectId,
            assetId: ref.assetId,
            relativePath: ref.relativePath,
            revision: ref.revision,
            originalName: entry.originalName || fileNameOf(ref.relativePath),
            kind: entry.kind || classifyProjectAsset(fileNameOf(ref.relativePath), entry.mimeType),
            mimeType: entry.mimeType,
            sha256: entry.sha256,
            createdAt: entry.createdAt,
            source: entry.source,
            blob,
        });
        if (!restored.ok || restored.ref.backend !== "indexeddb") continue;
        webRestoreKeys.set(projectSyncKey(ref.projectId, ref.assetId), restored.ref.storageKey);
        emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "下载媒体", status: "active" });
    }
    if (webRestoreKeys.size) {
        manifest.data = rewriteProjectAssetRefs(
            manifest.data,
            (ref) => webRestoreKeys.has(projectSyncKey(ref.projectId, ref.assetId)),
            (ref) => ({ backend: "indexeddb", storageKey: webRestoreKeys.get(projectSyncKey(ref.projectId, ref.assetId))! }),
        );
    }
}

/** 同 assetId/不同 sha256 冲突：本地文件原样保留，远端字节恢复到新 assetId + 新相对路径。 */
async function rebaseConflictingRemoteAsset<T>(config: WebdavSyncConfig, domain: DomainKey, manifest: DomainManifest<T>, entry: AppSyncFile, ref: ProjectFileAssetRef, onProgress?: AppSyncProgress) {
    const blob = await downloadWebdavFile(config, entry.path);
    if (!blob) return;
    const assetId = nanoid();
    const relativePath = rebasedRelativePath(ref.relativePath, assetId);
    const restored = await restoreSyncedAsset({
        projectId: ref.projectId,
        assetId,
        relativePath,
        revision: ref.revision,
        originalName: entry.originalName || fileNameOf(relativePath),
        kind: entry.kind || classifyProjectAsset(fileNameOf(relativePath), entry.mimeType),
        mimeType: entry.mimeType,
        sha256: entry.sha256,
        createdAt: entry.createdAt,
        source: entry.source,
        blob,
    });
    if (!restored.ok || restored.ref.backend !== "project-file") return;
    // 只改写远端 Project 快照引用，不改清单条目：a1′ 恢复成功即本地就绪，下载定位无需新条目；
    // 保留旧条目还能让 uploadChangedFiles 在新 identity 下无远端可比对，从而把字节 PUT 到新路径。
    manifest.data = rewriteProjectAssetRefs(
        manifest.data,
        (item) => item.projectId === ref.projectId && item.assetId === ref.assetId,
        () => restored.ref as ProjectFileAssetRef,
    );
    emitProgress(onProgress, { domain, label: domainLabel(domain), stage: "下载媒体", status: "active" });
}

/** 冲突再定基的相对路径：保留目录与扩展名，把文件名中的 assetId 短标记替换为新 id，避免占用本地已有文件。 */
function rebasedRelativePath(relativePath: string, assetId: string) {
    const segments = relativePath.split("/");
    const fileName = segments.pop() || "asset";
    const dot = fileName.lastIndexOf(".");
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const extension = dot > 0 ? fileName.slice(dot) : "";
    const base = stem.replace(/--[A-Za-z0-9_-]{8}$/i, "") || stem;
    segments.push(`${base}--${assetId.slice(0, 8)}${extension}`);
    return segments.join("/");
}

function domainPath(domain: DomainKey, path: string) {
    return `${domain}/${path}`;
}

function domainLabel(domain: DomainKey) {
    if (domain === "canvas") return "画布";
    if (domain === "assets") return "我的资产";
    if (domain === "image-workbench") return "生图工作台";
    return "视频创作台";
}

function emitProgress(onProgress: AppSyncProgress | undefined, event: AppSyncProgressEvent) {
    onProgress?.(event);
}

function getStringField(item: Record<string, unknown>, key: string) {
    const value = item[key];
    return typeof value === "string" ? value : "";
}

function getTime(item: Record<string, unknown>, key: string) {
    const value = item[key];
    if (typeof value === "number") return value;
    if (typeof value === "string") return Date.parse(value) || 0;
    return 0;
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, storageKey: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
    return storageKey.startsWith("image:") ? "png" : "bin";
}

function waitForHydration<T extends { hydrated: boolean }>(store: { getState: () => T; subscribe: (listener: (state: T) => void) => () => void }) {
    if (store.getState().hydrated) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const unsubscribe = store.subscribe((state) => {
            if (!state.hydrated) return;
            unsubscribe();
            resolve();
        });
    });
}

async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>) {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                results[index] = await worker(items[index], index);
            }
        }),
    );
    return results;
}

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
