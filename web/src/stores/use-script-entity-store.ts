import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { nanoid } from "nanoid";

import { localForageStorage } from "@/lib/localforage-storage";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";

export type ScriptEntityGroup = "character" | "scene" | "item";

/** v0.5：参考图为单图槽列表——每槽恰好一张图，可增删。 */
export type ScriptEntityRefSlot = {
    id: string;
    label: string;
    state: "empty" | "queued" | "ready";
    source?: "generated" | "canvas" | "library";
    /** 来源/生成归属节点：ready 时供消费边推导；queued 时为在途生成的归属标记（回写守卫按它丢弃过期结果） */
    nodeId?: string;
    assetId?: string;
    storageKey?: string;
    assetRef?: CanvasAssetRef;
};

export type ScriptEntity = {
    id: string;
    projectId: string;
    group: ScriptEntityGroup;
    name: string;
    role?: string;
    appearance?: string;
    consistency?: string;
    imagePrompt?: string;
    refs: ScriptEntityRefSlot[];
    createdAt: string;
    updatedAt: string;
    /** 旧结构（v0.4 slots.sheet/portrait）迁移前的原始形态，仅迁移读取用 */
    slots?: { sheet?: { state?: string; source?: string; nodeId?: string; assetId?: string; storageKey?: string }; portrait?: { state?: string; source?: string; nodeId?: string; assetId?: string; storageKey?: string } };
};

export type ScriptEntityInput = Omit<ScriptEntity, "createdAt" | "updatedAt" | "id" | "refs"> & Partial<Pick<ScriptEntity, "id" | "refs">>;

export type EntityAssetMigrationPatch = { entityId: string; refId: string; assetRef: CanvasAssetRef; clearStorageKey?: boolean };

type ScriptEntityStore = {
    hydrated: boolean;
    entities: ScriptEntity[];
    markHydrated: () => void;
    upsertEntity: (input: ScriptEntityInput) => string;
    removeEntity: (id: string) => void;
    /** v0.5 槽列表操作（替代 v0.4 的 setSlot） */
    addRef: (entityId: string, label?: string) => string;
    removeRef: (entityId: string, refId: string) => void;
    /** 唯一写入口：整组替换槽位来源字段（未提供的显式置空），杜绝来源切换残留 */
    assignRefSource: (entityId: string, refId: string, value: { state: ScriptEntityRefSlot["state"]; source?: ScriptEntityRefSlot["source"]; nodeId?: string; assetId?: string; storageKey?: string; assetRef?: CanvasAssetRef }) => void;
    /** 资产迁移专用：批量给参考槽挂 project-file 引用，单次 set 提交；未知实体/槽位静默跳过。 */
    applyEntityAssetMigration: (patches: EntityAssetMigrationPatch[]) => void;
    entitiesByProject: (projectId: string) => ScriptEntity[];
};

function makeRef(label: string): ScriptEntityRefSlot {
    return { id: `ref_${nanoid(8)}`, label, state: "empty" };
}

/** 各类型的初始参考图槽：角色 sheet+portrait、场景一张、道具一张（每槽一图，v0.5）。 */
export function defaultRefsFor(group: ScriptEntityGroup): ScriptEntityRefSlot[] {
    if (group === "character") return [makeRef("sheet"), makeRef("portrait")];
    if (group === "scene") return [makeRef("场景图")];
    return [makeRef("物品图")];
}

/** 旧数据迁移：slots.sheet/portrait → refs 两条；损坏结构回退默认槽；已是 refs 直通。 */
export function migrateEntitySlots(entity: ScriptEntity): ScriptEntity {
    if (Array.isArray(entity.refs)) return entity;
    const slots = entity.slots;
    const toRef = (label: string, slot?: { state?: string; source?: string; nodeId?: string; assetId?: string; storageKey?: string }): ScriptEntityRefSlot => {
        const base = makeRef(label);
        if (!slot || typeof slot !== "object") return base;
        const state = slot.state === "queued" || slot.state === "ready" ? slot.state : "empty";
        const source = slot.source === "generated" || slot.source === "canvas" || slot.source === "library" ? slot.source : undefined;
        return { ...base, state, ...(source ? { source } : {}), ...(slot.nodeId ? { nodeId: slot.nodeId } : {}), ...(slot.assetId ? { assetId: slot.assetId } : {}), ...(slot.storageKey ? { storageKey: slot.storageKey } : {}) };
    };
    const refs =
        slots && typeof slots === "object" && (slots.sheet || slots.portrait)
            ? [toRef("sheet", slots.sheet), toRef("portrait", slots.portrait)]
            : defaultRefsFor(entity.group);
    const { slots: _dropped, ...rest } = entity;
    void _dropped;
    return { ...rest, refs };
}

export const useScriptEntityStore = create<ScriptEntityStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            entities: [],
            markHydrated: () => set({ hydrated: true }),
            upsertEntity: (input) => {
                const now = new Date().toISOString();
                const entities = get().entities;
                const inputRefs = Array.isArray(input.refs) && input.refs.length > 0 ? input.refs : undefined;
                const normalized = { ...input, refs: inputRefs ?? defaultRefsFor(input.group) };
                const existing = input.id
                    ? entities.find((e) => e.id === input.id)
                    : entities.find((e) => e.projectId === input.projectId && e.name === input.name);
                if (existing) {
                    set({
                        entities: entities.map((e) =>
                            e.id === existing.id
                                ? // 调用方未带 refs（如表单编辑）时保留原 refs，避免清空参考图状态
                                  { ...existing, ...normalized, id: existing.id, refs: inputRefs ?? existing.refs, createdAt: existing.createdAt, updatedAt: now }
                                : e,
                        ),
                    });
                    return existing.id;
                }
                const id = input.id || `ent_${nanoid(10)}`;
                set({ entities: [...entities, { ...normalized, id, createdAt: now, updatedAt: now }] });
                return id;
            },
            removeEntity: (id) => set({ entities: get().entities.filter((e) => e.id !== id) }),
            addRef: (entityId, label) => {
                const ref = makeRef(label?.trim() || `参考图${get().entities.find((e) => e.id === entityId)?.refs.length ?? 0 + 1}`);
                set({
                    entities: get().entities.map((e) => (e.id === entityId ? { ...e, refs: [...e.refs, ref], updatedAt: new Date().toISOString() } : e)),
                });
                return ref.id;
            },
            removeRef: (entityId, refId) =>
                set({ entities: get().entities.map((e) => (e.id === entityId ? { ...e, refs: e.refs.filter((r) => r.id !== refId), updatedAt: new Date().toISOString() } : e)) }),
            assignRefSource: (entityId, refId, value) =>
                set({
                    entities: get().entities.map((e) =>
                        e.id === entityId
                            ? { ...e, refs: e.refs.map((r) => (r.id === refId ? { ...r, state: value.state, source: value.source, nodeId: value.nodeId, assetId: value.assetId, storageKey: value.storageKey, assetRef: value.assetRef } : r)), updatedAt: new Date().toISOString() }
                            : e,
                    ),
                }),
            applyEntityAssetMigration: (patches) => {
                if (patches.length === 0) return;
                set({
                    entities: get().entities.map((entity) => {
                        const entityPatches = patches.filter((patch) => patch.entityId === entity.id);
                        if (entityPatches.length === 0) return entity;
                        const byRef = new Map(entityPatches.map((patch) => [patch.refId, patch]));
                        return {
                            ...entity,
                            refs: entity.refs.map((ref) => {
                                const patch = byRef.get(ref.id);
                                if (!patch) return ref;
                                if (!patch.clearStorageKey) return { ...ref, assetRef: patch.assetRef };
                                const { storageKey: _stripped, ...rest } = ref;
                                return { ...rest, assetRef: patch.assetRef };
                            }),
                            updatedAt: new Date().toISOString(),
                        };
                    }),
                });
            },
            entitiesByProject: (projectId) => get().entities.filter((e) => e.projectId === projectId),
        }),
        {
            name: "shotshot:script_entity_store",
            storage: createJSONStorage(() => localForageStorage),
            partialize: (state) => ({ entities: state.entities }),
            onRehydrateStorage: () => (state) => {
                // 旧 slots → refs 迁移挂载点（E2）：hydrate 后逐实体迁移，不动 partialize。
                if (state?.entities?.length) {
                    const migrated = state.entities.map((e) => migrateEntitySlots(e));
                    useScriptEntityStore.setState({ entities: migrated });
                }
                state?.markHydrated();
            },
        },
    ),
);
