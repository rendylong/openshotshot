// web/src/lib/desktop/managed-catalog-store.ts
import localforage from "localforage";
import type { ManagedModelDescriptor } from "./managed-model-types";

// 套餐目录的本地持久化：只作启动注水与展示兜底，真值始终在云端目录。
// 单条记录整体覆盖；结构非法或版本不认识时删除记录，按无缓存处理。
export const MANAGED_CATALOG_KEY = "shotshot:managed-catalog";
export const managedCatalogStorage = localforage.createInstance({ name: "shotshot", storeName: "managed_catalog" });

export type ManagedCatalogRecord = {
    version: 1;
    subjectId: string;
    fetchedAt: number;
    models: ManagedModelDescriptor[];
};

// 只接受 ["text"] 与 ["text", "image"] 两个规范数组；其余整体按无缓存处理。
function isCanonicalInputModalities(value: unknown): value is Array<"text" | "image"> {
    return Array.isArray(value) && (
        (value.length === 1 && value[0] === "text") ||
        (value.length === 2 && value[0] === "text" && value[1] === "image"));
}

export function parseManagedCatalogRecord(raw: unknown): ManagedCatalogRecord | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (value.version !== 1) return null;
    if (typeof value.subjectId !== "string" || !value.subjectId.trim()) return null;
    if (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt) || value.fetchedAt <= 0) return null;
    if (!Array.isArray(value.models)) return null;
    const models: ManagedModelDescriptor[] = [];
    for (const item of value.models) {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const model = item as Record<string, unknown>;
        if (typeof model.id !== "string" || !model.id.trim()) return null;
        if (typeof model.name !== "string") return null;
        if (model.capability !== "text" && model.capability !== "image" && model.capability !== "video" && model.capability !== "audio") return null;
        if (model.execution !== "direct" && model.execution !== "remote_task") return null;
        if (model.input_modalities !== undefined &&
            (model.capability !== "text" || !isCanonicalInputModalities(model.input_modalities))) return null;
        models.push(item as ManagedModelDescriptor);
    }
    return { version: 1, subjectId: value.subjectId, fetchedAt: value.fetchedAt, models };
}

export async function readManagedCatalogRecord(): Promise<ManagedCatalogRecord | null> {
    const raw: unknown = await managedCatalogStorage.getItem(MANAGED_CATALOG_KEY);
    const record = parseManagedCatalogRecord(raw);
    if (!record && raw != null) await managedCatalogStorage.removeItem(MANAGED_CATALOG_KEY).catch(() => undefined);
    return record;
}

export async function writeManagedCatalogRecord(record: ManagedCatalogRecord): Promise<void> {
    await managedCatalogStorage.setItem(MANAGED_CATALOG_KEY, record);
}

export async function clearManagedCatalogRecord(): Promise<void> {
    await managedCatalogStorage.removeItem(MANAGED_CATALOG_KEY);
}
