// 渲染端项目资产门面：Electron 桥（项目文件）与 Web IndexedDB（既有上传服务）二选一，
// 并集中管理项目资产对象 URL 的生命周期。URL 只存内存缓存，绝不持久化。
import { nanoid } from "nanoid";

import type {
    CanvasAssetRef,
    ProjectAssetChangedEvent,
    ProjectAssetKind,
    ProjectAssetRecord,
    ProjectAssetSource,
    ProjectFileAssetRef,
} from "@/lib/project-assets/project-asset-types";
import i18n from "@/i18n";
import { getImageBlob, loadImageMeta, resolveImageUrl, setImageBlob, uploadImage, type UploadedImage } from "@/services/image-storage";
import { getMediaBlob, readAudioMeta, readVideoMeta, resolveMediaUrl, setMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { useProjectStore } from "@/stores/canvas/use-project-store";

export type ProjectAssetWriteContext = {
    projectId: string;
    projectTitle?: string;
    workspacePath?: string;
    canvasId: string;
    nodeId?: string;
    source: ProjectAssetSource;
};

/** 每次写入显式携带的上下文 + 单次写入字段；无全局活动项目状态。 */
export type CanvasAssetWriteInput = ProjectAssetWriteContext & { name?: string; mimeType?: string };

export type StoredCanvasMedia = Omit<UploadedFile, "storageKey"> & { storageKey?: string };

export type ProjectAssetWorkspaceResult = { ok: true; path: string } | { ok: false; error: string };

const assetUrls = new Map<string, string>();
const missingAssets = new Set<string>();
const changeListeners = new Set<(event: ProjectAssetChangedEvent) => void>();
let unsubscribeChanged: (() => void) | null = null;

const assetKey = (projectId: string, assetId: string) => `${projectId}:${assetId}`;
const urlCacheKey = (projectId: string, assetId: string, revision: number) => `${projectId}:${assetId}:${revision}`;

function errorText(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

/** 解析写入用的项目工作区：显式路径直用；缺失时幂等 ensure 并写回项目 store，后续写入复用。 */
export async function ensureProjectAssetWorkspace(context: ProjectAssetWriteContext): Promise<ProjectAssetWorkspaceResult> {
    if (context.workspacePath) return { ok: true, path: context.workspacePath };
    const agent = window.shotshot?.agent;
    if (!agent?.ensureProjectWorkspace) return { ok: false, error: "Project workspace is unavailable on this platform" };
    const result = await agent.ensureProjectWorkspace(context.projectId, context.projectTitle ?? "").catch((error: unknown) => ({ ok: false as const, error: errorText(error) }));
    if (!result.ok) return { ok: false, error: result.error };
    useProjectStore.getState().setProjectWorkspacePath(context.projectId, result.path);
    return { ok: true, path: result.path };
}

function projectWorkspacePath(projectId: string): string | null {
    return useProjectStore.getState().projects.find((project) => project.id === projectId)?.workspacePath ?? null;
}

/** 撤销同一资产的全部已缓存 URL（跨项目事件天然按 projectId 隔离）。 */
function revokeAssetUrls(projectId: string, assetId: string) {
    const prefix = `${projectId}:${assetId}:`;
    for (const [key, url] of [...assetUrls]) {
        if (!key.startsWith(prefix)) continue;
        URL.revokeObjectURL(url);
        assetUrls.delete(key);
    }
}

function handleChangedEvent(event: ProjectAssetChangedEvent) {
    if (event.type === "changed") {
        revokeAssetUrls(event.record.projectId, event.record.assetId);
        missingAssets.delete(assetKey(event.record.projectId, event.record.assetId));
    } else {
        revokeAssetUrls(event.ref.projectId, event.ref.assetId);
        missingAssets.add(assetKey(event.ref.projectId, event.ref.assetId));
    }
    for (const listener of [...changeListeners]) listener(event);
}

/** 惰性建立唯一一条 onChanged 订阅；无桌面桥时不订阅。 */
function ensureChangedSubscription() {
    if (unsubscribeChanged) return;
    const bridge = window.shotshot?.projectAssets;
    if (!bridge) return;
    unsubscribeChanged = bridge.onChanged(handleChangedEvent);
}

/** 组件级订阅：只接收指定 project+asset 的事件；返回取消函数。 */
export function onCanvasAssetChanged(projectId: string, assetId: string, listener: (event: ProjectAssetChangedEvent) => void): () => void {
    ensureChangedSubscription();
    const scoped = (event: ProjectAssetChangedEvent) => {
        const matches = event.type === "changed"
            ? event.record.projectId === projectId && event.record.assetId === assetId
            : event.ref.projectId === projectId && event.ref.assetId === assetId;
        if (matches) listener(event);
    };
    changeListeners.add(scoped);
    return () => { changeListeners.delete(scoped); };
}

function seedAssetUrl(record: ProjectAssetRecord, bytes: Uint8Array): string {
    ensureChangedSubscription();
    // 经 new Uint8Array 归一为 ArrayBuffer 视图，满足 BlobPart 的类型约束。
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: record.mimeType }));
    assetUrls.set(urlCacheKey(record.projectId, record.assetId, record.revision), url);
    missingAssets.delete(assetKey(record.projectId, record.assetId));
    return url;
}

/** 画布资产统一取 URL 入口：project-file 走桥读字节，indexeddb 委托旧解析器；失败回退 fallback。 */
export async function resolveCanvasAssetUrl(assetRef: CanvasAssetRef | undefined, fallback = ""): Promise<string> {
    if (!assetRef) return fallback;
    if (assetRef.backend === "indexeddb") {
        return assetRef.storageKey.startsWith("image:") ? resolveImageUrl(assetRef.storageKey, fallback) : resolveMediaUrl(assetRef.storageKey, fallback);
    }
    const cached = assetUrls.get(urlCacheKey(assetRef.projectId, assetRef.assetId, assetRef.revision));
    if (cached) return cached;
    if (missingAssets.has(assetKey(assetRef.projectId, assetRef.assetId))) return fallback;
    const workspacePath = projectWorkspacePath(assetRef.projectId);
    const bridge = window.shotshot?.projectAssets;
    if (!workspacePath || !bridge) return fallback;
    ensureChangedSubscription();
    const result = await bridge.read({ workspacePath, ref: assetRef });
    if (!result.ok) return fallback;
    return seedAssetUrl(result.value.record, result.value.bytes);
}

export function isCanvasAssetMissing(assetRef: CanvasAssetRef | undefined): boolean {
    return Boolean(assetRef && assetRef.backend === "project-file" && missingAssets.has(assetKey(assetRef.projectId, assetRef.assetId)));
}

export async function getCanvasAssetBlob(assetRef: CanvasAssetRef): Promise<Blob | null> {
    if (assetRef.backend === "indexeddb") {
        return assetRef.storageKey.startsWith("image:") ? getImageBlob(assetRef.storageKey) : getMediaBlob(assetRef.storageKey);
    }
    const workspacePath = projectWorkspacePath(assetRef.projectId);
    const bridge = window.shotshot?.projectAssets;
    if (!workspacePath || !bridge) return null;
    const result = await bridge.read({ workspacePath, ref: assetRef });
    return result.ok ? new Blob([new Uint8Array(result.value.bytes)], { type: result.value.record.mimeType }) : null;
}

/** 读取 project-file 资产字节与可移植 record（同步/导出需要 sha256、revision 等字段）；无桥、无工作区或读取失败返回 null。 */
export async function readSyncedProjectAsset(assetRef: ProjectFileAssetRef): Promise<{ blob: Blob; record: ProjectAssetRecord } | null> {
    const workspacePath = projectWorkspacePath(assetRef.projectId);
    const bridge = window.shotshot?.projectAssets;
    if (!workspacePath || !bridge) return null;
    const result = await bridge.read({ workspacePath, ref: assetRef });
    if (!result.ok) return null;
    return { blob: new Blob([new Uint8Array(result.value.bytes)], { type: result.value.record.mimeType }), record: result.value.record };
}

/** 本地工作区资产检查：就绪返回本地 record（供 sha256 冲突比较），缺失/无桥/无工作区返回 null。 */
export async function statSyncedProjectAsset(assetRef: ProjectFileAssetRef): Promise<ProjectAssetRecord | null> {
    const workspacePath = projectWorkspacePath(assetRef.projectId);
    const bridge = window.shotshot?.projectAssets;
    if (!workspacePath || !bridge) return null;
    const result = await bridge.stat({ workspacePath, ref: assetRef });
    if (!result.ok || result.value.status !== "ready") return null;
    return result.value.record;
}

export type SyncedAssetRestoreInput = {
    projectId: string;
    projectTitle?: string;
    canvasId?: string;
    /** 已知本机工作区时直用；缺失时幂等 ensure。 */
    workspacePath?: string;
    assetId: string;
    relativePath: string;
    revision: number;
    originalName: string;
    kind: ProjectAssetKind;
    mimeType: string;
    sha256?: string;
    createdAt?: string;
    source?: ProjectAssetSource;
    blob: Blob;
};

export type SyncedAssetRestoreResult = { ok: true; ref: CanvasAssetRef; workspacePath?: string } | { ok: false; error: string };

/** 物化同步/导入包中的远端资产：桌面 ensure 工作区后按原身份 bridge.restore；纯 Web 存 IndexedDB 并改发 indexeddb ref。 */
export async function restoreSyncedAsset(input: SyncedAssetRestoreInput): Promise<SyncedAssetRestoreResult> {
    const source: ProjectAssetSource = input.source ?? { type: "webdav-restore" };
    const bridge = window.shotshot?.projectAssets;
    if (!bridge) {
        const storageKey = await storeSyncedBlob(input.blob);
        return { ok: true, ref: { backend: "indexeddb", storageKey } };
    }
    const ensured = await ensureProjectAssetWorkspace({
        projectId: input.projectId,
        projectTitle: input.projectTitle,
        workspacePath: input.workspacePath,
        canvasId: input.canvasId ?? "",
        source,
    });
    if (!ensured.ok) return { ok: false, error: ensured.error || "Project workspace is unavailable on this platform" };
    const bytes = new Uint8Array(await input.blob.arrayBuffer());
    const result = await bridge.restore({
        projectId: input.projectId,
        workspacePath: ensured.path,
        assetId: input.assetId,
        relativePath: input.relativePath,
        revision: input.revision,
        originalName: input.originalName,
        kind: input.kind,
        mimeType: input.mimeType,
        bytes,
        ...(input.sha256 ? { sha256: input.sha256 } : {}),
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        source,
    });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, ref: result.value.ref, workspacePath: ensured.path };
}

function syncedStoragePrefix(mimeType: string): string {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType.startsWith("audio/")) return "audio";
    return "file";
}

async function storeSyncedBlob(blob: Blob): Promise<string> {
    const storageKey = `${syncedStoragePrefix(blob.type)}:${nanoid()}`;
    if (blob.type.startsWith("image/")) await setImageBlob(storageKey, blob);
    else await setMediaBlob(storageKey, blob);
    return storageKey;
}

/** 只释放精确 revision 的 URL；IndexedDB 引用的 URL 仍由旧缓存管理。 */
export function releaseCanvasAssetUrl(assetRef: CanvasAssetRef): void {
    if (assetRef.backend !== "project-file") return;
    const key = urlCacheKey(assetRef.projectId, assetRef.assetId, assetRef.revision);
    const url = assetUrls.get(key);
    if (!url) return;
    URL.revokeObjectURL(url);
    assetUrls.delete(key);
}

async function projectBlob(input: string | Blob): Promise<Blob> {
    return typeof input === "string" ? await (await fetch(input)).blob() : input;
}

function mediaPrefix(mimeType: string): string {
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType.startsWith("audio/")) return "audio";
    return "file";
}

function fallbackName(mimeType: string): string {
    const extension = mimeType.split(";")[0]?.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
    return `asset-${nanoid(8)}.${extension}`;
}

function writeSource(context: ProjectAssetWriteContext): ProjectAssetSource {
    return {
        ...context.source,
        canvasId: context.source.canvasId ?? context.canvasId,
        ...(context.nodeId && !context.source.nodeId ? { nodeId: context.nodeId } : {}),
    };
}

async function imageMetadataOf(blob: Blob): Promise<{ width: number; height: number }> {
    const url = URL.createObjectURL(blob);
    try {
        const meta = await loadImageMeta(url);
        if (!meta) throw new Error(i18n.t("common.imageReadFailed"));
        return meta;
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function mediaMetadataOf(blob: Blob): Promise<{ width?: number; height?: number; durationMs?: number }> {
    const url = URL.createObjectURL(blob);
    try {
        if (blob.type.startsWith("video/")) return await readVideoMeta(url);
        if (blob.type.startsWith("audio/")) return await readAudioMeta(url);
        return {};
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function writeToProjectBridge(blob: Blob, context: CanvasAssetWriteInput, workspaceError: string): Promise<{ record: ProjectAssetRecord; ref: CanvasAssetRef; bytes: Uint8Array }> {
    const bridge = window.shotshot?.projectAssets;
    if (!bridge) throw new Error(workspaceError);
    const ensured = await ensureProjectAssetWorkspace(context);
    if (!ensured.ok) throw new Error(ensured.error || workspaceError);
    const mimeType = context.mimeType || blob.type || "application/octet-stream";
    const name = context.name || fallbackName(mimeType);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const result = await bridge.write({ projectId: context.projectId, workspacePath: ensured.path, name, mimeType, bytes, source: writeSource(context) });
    if (!result.ok) throw new Error(result.error);
    return { record: result.value.record, ref: result.value.ref, bytes };
}

/** 画布图片入库：桌面走项目文件（ensure 失败即可见失败，不回退 IndexedDB），无桥走既有 uploadImage。 */
export async function storeCanvasImage(input: string | Blob, context: CanvasAssetWriteInput): Promise<UploadedImage> {
    const blob = await projectBlob(input);
    if (!window.shotshot?.projectAssets) {
        const uploaded = await uploadImage(blob);
        return uploaded.storageKey ? { ...uploaded, assetRef: { backend: "indexeddb", storageKey: uploaded.storageKey } } : uploaded;
    }
    const workspaceError = "Project workspace is unavailable on this platform";
    const { width, height } = await imageMetadataOf(blob);
    const written = await writeToProjectBridge(blob, context, workspaceError);
    const url = seedAssetUrl(written.record, written.bytes);
    return { url, assetRef: written.ref, width, height, bytes: written.record.bytes, mimeType: written.record.mimeType };
}

/** 画布音视频/文件入库：桌面走项目文件，无桥走既有 uploadMediaFile（video:/audio:/file: 前缀）。 */
export async function storeCanvasMedia(input: string | Blob, context: CanvasAssetWriteInput): Promise<StoredCanvasMedia> {
    const blob = await projectBlob(input);
    if (!window.shotshot?.projectAssets) {
        const stored = await uploadMediaFile(blob, mediaPrefix(blob.type));
        return { ...stored, assetRef: { backend: "indexeddb", storageKey: stored.storageKey } };
    }
    const workspaceError = "Project workspace is unavailable on this platform";
    const meta = await mediaMetadataOf(blob);
    const written = await writeToProjectBridge(blob, context, workspaceError);
    const url = seedAssetUrl(written.record, written.bytes);
    return { url, assetRef: written.ref, bytes: written.record.bytes, mimeType: written.record.mimeType, ...meta };
}

/** 画布 3D 模型文件入库：桌面走项目工作区（assetRef-only），无桥/Web 回退既有 uploadMediaFile（保持 glb: 前缀现状，spec §4）。 */
export async function storeCanvasModelFile(file: File, context?: CanvasAssetWriteInput): Promise<StoredCanvasMedia> {
    if (!context || !window.shotshot?.projectAssets) return uploadMediaFile(file, "glb");
    const meta = await mediaMetadataOf(file);
    const written = await writeToProjectBridge(file, { ...context, name: context.name || file.name, mimeType: file.type || "model/gltf-binary" }, "Project workspace is unavailable on this platform");
    const url = seedAssetUrl(written.record, written.bytes);
    return { url, assetRef: written.ref, bytes: written.record.bytes, mimeType: written.record.mimeType, ...meta };
}
