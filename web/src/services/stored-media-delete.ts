// 画布媒体 move 语义的共用删源工具（P2 spec §1）：迁移与交付两条链路都按前缀分流删除 IDB 源键。
// 删除失败永不抛出——调用方（交付事务路径、迁移提交路径）都不得因删源失败翻转结果；
// 失败键已剥离持久身份，由 pendingCleanup 重试与 cleanupUnused* 兜底回收。
import { deleteStoredImages } from "@/services/image-storage";
import { deleteStoredMedia } from "@/services/file-storage";

export function isImageStorageKey(key: string): boolean {
    return key.startsWith("image:");
}

export async function deleteStoredMediaKeys(keys: Iterable<string>): Promise<string[]> {
    const failures: string[] = [];
    const unique = [...new Set(keys)];
    // 按前缀分成两组，各一次性批量删除；组内失败视为该组全部键失败。
    const routes = [
        { keys: unique.filter(isImageStorageKey), remove: deleteStoredImages },
        { keys: unique.filter((key) => !isImageStorageKey(key)), remove: deleteStoredMedia },
    ];
    await Promise.all(
        routes.map(async ({ keys, remove }) => {
            if (keys.length === 0) return;
            try {
                await remove(keys);
            } catch (error) {
                keys.forEach((key) => console.warn(`[stored-media] delete failed for ${key}:`, error instanceof Error ? error.message : String(error)));
                // 逐键收集（终审 M3）：大批次 spread 可能触发参数上限 RangeError
                for (const key of keys) failures.push(key);
            }
        }),
    );
    return failures;
}
