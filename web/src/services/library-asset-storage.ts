// 渲染端素材库门面（桌面专用；Web 无桥直接不用本模块）。
// 负责：字节读→objectURL（集中缓存/missing 记账）、写库、以及把 LibraryAssetRecord 组装成 useAssetStore 的 Asset。
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";
import type { LibraryAssetChangedEvent, LibraryAssetRecord, LibraryAssetRef } from "@/lib/library-assets/library-asset-types";
import { getImageBlob, loadImageMeta } from "@/services/image-storage";
import { getMediaBlob, readVideoMeta } from "@/services/file-storage";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";

const assetUrls = new Map<string, string>();
const missingAssets = new Set<string>();
const changeListeners = new Set<(event: LibraryAssetChangedEvent) => void>();
let unsubscribeChanged: (() => void) | null = null;

const urlCacheKey = (ref: LibraryAssetRef) => `${ref.assetId}:${ref.revision}`;

function errorText(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

export function libraryRefOf(record: Pick<LibraryAssetRecord, "assetId" | "relativePath" | "revision">): LibraryAssetRef {
    return { backend: "library-file", assetId: record.assetId, relativePath: record.relativePath, revision: record.revision };
}

function ensureChangedSubscription() {
    if (unsubscribeChanged) return;
    const bridge = window.shotshot?.libraryAssets;
    if (!bridge) return;
    unsubscribeChanged = bridge.onChanged((event) => {
        if (event.type === "changed") {
            for (const [key, url] of [...assetUrls]) {
                if (key.startsWith(`${event.record.assetId}:`)) {
                    URL.revokeObjectURL(url);
                    assetUrls.delete(key);
                }
            }
            missingAssets.delete(event.record.assetId);
        } else {
            missingAssets.add(event.ref.assetId);
        }
        for (const listener of [...changeListeners]) listener(event);
    });
}

export function onLibraryAssetChanged(listener: (event: LibraryAssetChangedEvent) => void): () => void {
    ensureChangedSubscription();
    changeListeners.add(listener);
    return () => {
        changeListeners.delete(listener);
    };
}

export function seedLibraryAssetUrl(record: LibraryAssetRecord, bytes: Uint8Array): string {
    ensureChangedSubscription();
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: record.mimeType }));
    assetUrls.set(urlCacheKey(libraryRefOf(record)), url);
    missingAssets.delete(record.assetId);
    return url;
}

export async function resolveLibraryAssetUrl(ref: LibraryAssetRef, fallback = ""): Promise<string> {
    const cached = assetUrls.get(urlCacheKey(ref));
    if (cached) return cached;
    if (missingAssets.has(ref.assetId)) return fallback;
    const bridge = window.shotshot?.libraryAssets;
    if (!bridge) return fallback;
    ensureChangedSubscription();
    const result = await bridge.read({ ref });
    if (!result.ok) return fallback;
    return seedLibraryAssetUrl(result.value.record, result.value.bytes);
}

export async function getLibraryAssetBlob(ref: LibraryAssetRef): Promise<Blob | null> {
    const bridge = window.shotshot?.libraryAssets;
    if (!bridge) return null;
    const result = await bridge.read({ ref });
    return result.ok ? new Blob([new Uint8Array(result.value.bytes)], { type: result.value.record.mimeType }) : null;
}

export function releaseLibraryAssetUrl(ref: LibraryAssetRef): void {
    const key = urlCacheKey(ref);
    const url = assetUrls.get(key);
    if (!url) return;
    URL.revokeObjectURL(url);
    assetUrls.delete(key);
}

const EXTENSION_BY_MIME: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "text/markdown": "md", "text/plain": "txt",
};

export type LibraryAssetBuildMeta = { title: string; tags?: string[]; source?: string; note?: string; assetId?: string; createdAt?: string };

/** 把 Blob 写入素材库并组装成可直接 addAsset 的 Asset（桌面端调用；无桥抛错）。 */
export async function buildLibraryAsset(blob: Blob, meta: LibraryAssetBuildMeta): Promise<Asset> {
    const bridge = window.shotshot?.libraryAssets;
    if (!bridge) throw new Error("素材库不可用");
    const mimeType = blob.type || "application/octet-stream";
    const extension = EXTENSION_BY_MIME[mimeType.split(";")[0]] ?? "bin";
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const result = await bridge.write({
        name: `${meta.title || "asset"}.${extension}`,
        mimeType,
        bytes,
        title: meta.title,
        ...(meta.tags ? { tags: meta.tags } : {}),
        ...(meta.source ? { source: meta.source } : {}),
        ...(meta.note ? { note: meta.note } : {}),
        ...(meta.assetId ? { assetId: meta.assetId } : {}),
        ...(meta.createdAt ? { createdAt: meta.createdAt } : {}),
    });
    if (!result.ok) throw new Error(result.error);
    const asset = await assetFromRecord(result.value.record, seedLibraryAssetUrl(result.value.record, bytes));
    if (!asset) throw new Error("素材库不支持该素材类型");
    return asset;
}

/** 从画布节点元数据提取可入库字节：assetRef 优先，其次 storageKey（IndexedDB），最后按 URL 拉取（拒 blob: 死链）。 */
export async function libraryBlobFromMedia(input: { content?: string; storageKey?: string; assetRef?: CanvasAssetRef }): Promise<Blob | null> {
    if (input.assetRef) {
        const { getCanvasAssetBlob } = await import("@/services/project-asset-storage");
        const blob = await getCanvasAssetBlob(input.assetRef);
        if (blob) return blob;
    }
    const storageKey = input.storageKey;
    if (storageKey && /^(image|video|audio|file):/.test(storageKey)) {
        const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        if (blob) return blob;
    }
    if (input.content && !input.content.startsWith("blob:")) {
        try {
            return await (await fetch(input.content)).blob();
        } catch {
            return null;
        }
    }
    return null;
}

export async function removeLibraryAsset(assetId: string): Promise<void> {
    const bridge = window.shotshot?.libraryAssets;
    if (!bridge) throw new Error("素材库不可用");
    const result = await bridge.remove(assetId);
    if (!result.ok) throw new Error(result.error);
}

/** record → useAssetStore 的 Asset。image/video 解析显示 URL 与尺寸；text 解码内容。非三类 kind 返回 null。 */
export async function assetFromRecord(record: LibraryAssetRecord, resolvedUrl?: string): Promise<Asset | null> {
    const base = {
        id: record.assetId,
        title: record.title,
        tags: record.tags ?? [],
        ...(record.source ? { source: record.source } : {}),
        ...(record.note ? { note: record.note } : {}),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        metadata: { storageRef: libraryRefOf(record) },
    };
    if (record.kind === "text") {
        const blob = await getLibraryAssetBlob(libraryRefOf(record));
        const content = blob ? new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer())) : "";
        return { kind: "text", coverUrl: "", ...base, data: { content } } as Asset;
    }
    if (record.kind === "video") {
        const url = resolvedUrl ?? (await resolveLibraryAssetUrl(libraryRefOf(record)));
        const meta = url ? await readVideoMeta(url).catch(() => undefined) : undefined;
        return { kind: "video", coverUrl: "", ...base, data: { url, width: meta?.width ?? 0, height: meta?.height ?? 0, bytes: record.bytes, mimeType: record.mimeType } } as Asset;
    }
    if (record.kind !== "image") return null;
    const url = resolvedUrl ?? (await resolveLibraryAssetUrl(libraryRefOf(record)));
    const dims = url ? await loadImageMeta(url).catch(() => null) : null;
    return { kind: "image", ...base, coverUrl: url, data: { dataUrl: url, width: dims?.width ?? 0, height: dims?.height ?? 0, bytes: record.bytes, mimeType: record.mimeType } } as Asset;
}

/** 全量 hydrate：manifest → Asset[]，按 createdAt 倒序（新素材在前）。 */
export async function hydrateLibraryAssets(): Promise<Asset[]> {
    const bridge = window.shotshot?.libraryAssets;
    if (!bridge) return [];
    const listed = await bridge.list();
    if (!listed.ok) throw new Error(listed.error);
    const assets = await Promise.all(listed.value.assets.map((record) => assetFromRecord(record)));
    return assets
        .filter((asset): asset is Asset => asset !== null)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** changed 事件后刷新单条：记录已被删（其他窗口）则从 store 移除。 */
export async function refreshLibraryAsset(assetId: string): Promise<void> {
    const bridge = window.shotshot?.libraryAssets;
    if (!bridge) return;
    const listed = await bridge.list();
    if (!listed.ok) return;
    const record = listed.value.assets.find((item) => item.assetId === assetId);
    const store = useAssetStore.getState();
    if (!record) {
        if (store.assets.some((asset) => asset.id === assetId)) store.removeAsset(assetId);
        return;
    }
    const asset = await assetFromRecord(record);
    if (!asset) return;
    if (!store.assets.some((item) => item.id === assetId)) {
        store.addAsset(asset);
        return;
    }
    const { createdAt: _createdAt, ...patch } = asset;
    store.updateAsset(assetId, patch);
}

/** missing 事件：清空展示 URL（缩略图退化为空态），条目保留待文件恢复。 */
export function markLibraryAssetMissing(assetId: string): void {
    const store = useAssetStore.getState();
    const asset = store.assets.find((item) => item.id === assetId);
    if (!asset) return;
    if (asset.kind === "image") store.updateAsset(assetId, { coverUrl: "", data: { ...asset.data, dataUrl: "" } });
    else if (asset.kind === "video") store.updateAsset(assetId, { data: { ...asset.data, url: "" } });
}
