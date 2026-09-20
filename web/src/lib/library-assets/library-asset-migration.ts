// 旧 localforage 素材 → 素材库目录的一次性迁移（仅桌面）。
// 只复制不删源：IndexedDB 旧键原样保留（cleanup 纠缠不在本任务处理）。
// copy-verify-commit：逐条读字节 → bridge.write（保留原 assetId/createdAt/tags）→ 全部成功才 markLegacyMigrated。
// 写失败即整体失败且不标记（下次启动重试；固定 id 冲突语义保证幂等）；字节缺失计 missing 后跳过。
import type { LibraryAssetsBridge } from "@/lib/library-assets/library-asset-types";
import { localForageStorage } from "@/lib/localforage-storage";
import { getImageBlob } from "@/services/image-storage";
import { getMediaBlob } from "@/services/file-storage";
import { ASSET_STORE_KEY } from "@/stores/use-asset-store";

export type LegacyMigrationResult = { migrated: number; missing: number };

type LegacyEntry = {
    id: string;
    kind: "text" | "image" | "video";
    title: string;
    tags?: string[];
    source?: string;
    note?: string;
    createdAt: string;
    data: { content?: string; dataUrl?: string; storageKey?: string; mimeType?: string };
};

async function legacyBlobOf(entry: LegacyEntry): Promise<Blob | null> {
    if (entry.kind === "text") {
        return typeof entry.data.content === "string" ? new Blob([entry.data.content], { type: "text/markdown" }) : null;
    }
    if (entry.data.storageKey) {
        const blob = entry.data.storageKey.startsWith("image:") ? await getImageBlob(entry.data.storageKey) : await getMediaBlob(entry.data.storageKey);
        if (blob) return blob;
    }
    if (entry.kind === "image" && typeof entry.data.dataUrl === "string" && entry.data.dataUrl.startsWith("data:image/")) {
        try {
            return await (await fetch(entry.data.dataUrl)).blob();
        } catch {
            return null;
        }
    }
    return null;
}

const EXTENSION_BY_MIME: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "text/markdown": "md", "text/plain": "txt",
};

/** 主入口：无桥 / 已迁移 / 无旧数据 时为 no-op。写失败抛错（调用方负责日志），不写迁移标记。 */
export async function migrateLegacyAssetsToLibrary(): Promise<LegacyMigrationResult> {
    const bridge = window.shotshot?.libraryAssets;
    if (!bridge) return { migrated: 0, missing: 0 };
    const listed = await bridge.list();
    if (!listed.ok) throw new Error(listed.error);
    if (listed.value.legacyMigratedAt) return { migrated: 0, missing: 0 };
    const existingIds = new Set(listed.value.assets.map((record) => record.assetId));

    // 旧 store 由 zustand persist JSON.stringify 后写入（use-asset-store assetStorage），这里取回需 parse。
    const raw = JSON.parse((await localForageStorage.getItem(ASSET_STORE_KEY)) ?? "null") as { state?: { assets?: unknown[] } } | null;
    const legacyAssets = (raw?.state?.assets ?? []) as LegacyEntry[];
    const candidates = legacyAssets.filter((entry) => entry && typeof entry.id === "string" && !existingIds.has(entry.id) && ["text", "image", "video"].includes(entry.kind));
    if (candidates.length === 0) {
        await bridge.markLegacyMigrated();
        return { migrated: 0, missing: 0 };
    }

    let migrated = 0;
    let missing = 0;
    for (const entry of candidates) {
        // 坏条目（data 缺失/畸形）只计 missing 跳过，不让单条异常中止整个迁移。
        let blob: Blob | null;
        try {
            blob = await legacyBlobOf(entry);
        } catch {
            missing += 1;
            continue;
        }
        if (!blob) {
            missing += 1;
            continue;
        }
        const mimeType = blob.type || entry.data.mimeType || "application/octet-stream";
        const extension = EXTENSION_BY_MIME[mimeType.split(";")[0]] ?? "bin";
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const result = await (bridge as LibraryAssetsBridge).write({
            name: `${entry.title || entry.id}.${extension}`,
            mimeType,
            bytes,
            title: entry.title || entry.id,
            ...(entry.tags ? { tags: entry.tags } : {}),
            ...(entry.source ? { source: entry.source } : {}),
            ...(entry.note ? { note: entry.note } : {}),
            assetId: entry.id,
            createdAt: entry.createdAt,
        });
        if (!result.ok) throw new Error(result.error);
        migrated += 1;
    }
    await bridge.markLegacyMigrated();
    return { migrated, missing };
}
