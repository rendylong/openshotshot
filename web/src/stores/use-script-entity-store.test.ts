import { beforeEach, describe, expect, it, vi } from "vitest";

const storageMock = vi.hoisted(() => ({
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
}));

vi.mock("@/lib/localforage-storage", () => ({ default: storageMock }));

import { migrateEntitySlots, useScriptEntityStore, type ScriptEntityRefSlot } from "./use-script-entity-store";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";

beforeEach(() => {
    useScriptEntityStore.setState({ entities: [], hydrated: false });
});

describe("useScriptEntityStore", () => {
    it("upsert 新建并返回 id；同 id 幂等更新", () => {
        const id1 = useScriptEntityStore.getState().upsertEntity({ projectId: "p1", group: "character", name: "狸花猫大厨", appearance: "三花狸纹" });
        const id2 = useScriptEntityStore.getState().upsertEntity({ id: id1, projectId: "p1", group: "character", name: "狸花猫大厨", role: "主角" });
        expect(id2).toBe(id1);
        const entities = useScriptEntityStore.getState().entities;
        expect(entities).toHaveLength(1);
        expect(entities[0].role).toBe("主角");
        expect(entities[0].appearance).toBe("三花狸纹"); // 更新保留未覆盖字段
    });

    it("无 id 时按 (projectId, name) 幂等", () => {
        useScriptEntityStore.getState().upsertEntity({ projectId: "p1", group: "scene", name: "太空餐厅" });
        const id2 = useScriptEntityStore.getState().upsertEntity({ projectId: "p1", group: "scene", name: "太空餐厅", imagePrompt: "scifi diner" });
        expect(useScriptEntityStore.getState().entities).toHaveLength(1);
        expect(useScriptEntityStore.getState().entities[0].id).toBe(id2);
        expect(useScriptEntityStore.getState().entities[0].imagePrompt).toBe("scifi diner");
    });

    it("默认槽按类型生成；addRef/removeRef/assignRefSource 管理槽列表", () => {
        const id = useScriptEntityStore.getState().upsertEntity({ projectId: "p1", group: "character", name: "狸花猫大厨" });
        let entity = useScriptEntityStore.getState().entities[0];
        expect(entity.refs.map((r) => r.label)).toEqual(["sheet", "portrait"]);
        const refId = useScriptEntityStore.getState().addRef(id, "全身立绘");
        entity = useScriptEntityStore.getState().entities[0];
        expect(entity.refs).toHaveLength(3);
        useScriptEntityStore.getState().assignRefSource(id, refId, { state: "ready", source: "generated", nodeId: "n1", storageKey: "k1" });
        expect(useScriptEntityStore.getState().entities[0].refs.find((r) => r.id === refId)).toMatchObject({ label: "全身立绘", state: "ready", nodeId: "n1" });
        useScriptEntityStore.getState().removeRef(id, refId);
        expect(useScriptEntityStore.getState().entities[0].refs).toHaveLength(2);
    });

    it("migrateEntitySlots：旧 slots.sheet/portrait 无损迁移为 refs 两条", () => {
        const legacy = { id: "e9", projectId: "p1", group: "character", name: "旧角色", createdAt: "", updatedAt: "",
            slots: { sheet: { state: "ready", source: "generated", nodeId: "n1", storageKey: "k1" }, portrait: { state: "empty" } } } as never as import("./use-script-entity-store").ScriptEntity;
        const migrated = migrateEntitySlots(legacy);
        expect(migrated.refs.map((r) => r.label)).toEqual(["sheet", "portrait"]);
        expect(migrated.refs[0]).toMatchObject({ state: "ready", source: "generated", nodeId: "n1", storageKey: "k1" });
    });

    it("migrateEntitySlots：损坏 slots 回退默认槽；已是 refs 结构直通", () => {
        const broken = { id: "e8", projectId: "p1", group: "item", name: "x", createdAt: "", updatedAt: "", slots: "corrupted" } as never as import("./use-script-entity-store").ScriptEntity;
        expect(migrateEntitySlots(broken).refs.map((r) => r.label)).toEqual(["物品图"]);
        const fresh = { id: "e7", projectId: "p1", group: "scene", name: "y", createdAt: "", updatedAt: "", refs: [{ id: "r1", label: "场景图", state: "ready" }] } as never as import("./use-script-entity-store").ScriptEntity;
        expect(migrateEntitySlots(fresh).refs).toHaveLength(1);
    });

    it("removeEntity 删除；entitiesByProject 过滤", () => {
        const a = useScriptEntityStore.getState().upsertEntity({ projectId: "p1", group: "item", name: "辣椒" });
        useScriptEntityStore.getState().upsertEntity({ projectId: "p2", group: "item", name: "锅" });
        expect(useScriptEntityStore.getState().entitiesByProject("p1")).toHaveLength(1);
        useScriptEntityStore.getState().removeEntity(a);
        expect(useScriptEntityStore.getState().entities).toHaveLength(1);
        expect(useScriptEntityStore.getState().entities[0].projectId).toBe("p2");
    });
});

describe("assignRefSource（槽位来源唯一写入口）", () => {
    beforeEach(() => {
        useScriptEntityStore.setState({ entities: [] });
    });

    const addItemEntity = () => {
        const id = useScriptEntityStore.getState().upsertEntity({ projectId: "p1", group: "item", name: "道具A" });
        const refId = useScriptEntityStore.getState().entities.find((e) => e.id === id)!.refs[0].id;
        return { id, refId };
    };

    const refOf = (id: string) => useScriptEntityStore.getState().entities.find((e) => e.id === id)!.refs[0];

    it("切换来源整组覆盖：library → canvas 后 assetId/storageKey 不残留", () => {
        const { id, refId } = addItemEntity();
        const s = useScriptEntityStore.getState();
        s.assignRefSource(id, refId, { state: "ready", source: "library", assetId: "a1", storageKey: "k1" });
        s.assignRefSource(id, refId, { state: "ready", source: "canvas", nodeId: "img-9" });
        const ref = refOf(id);
        expect(ref.state).toBe("ready");
        expect(ref.source).toBe("canvas");
        expect(ref.nodeId).toBe("img-9");
        expect(ref.assetId).toBeUndefined();
        expect(ref.storageKey).toBeUndefined();
    });

    it("切换来源整组覆盖：generated → library 后 nodeId 不残留；label/id 保留", () => {
        const { id, refId } = addItemEntity();
        const s = useScriptEntityStore.getState();
        const before = refOf(id);
        s.assignRefSource(id, refId, { state: "queued", source: "generated", nodeId: "img-1" });
        s.assignRefSource(id, refId, { state: "ready", source: "library", assetId: "a2" });
        const ref = refOf(id);
        expect(ref.id).toBe(before.id);
        expect(ref.label).toBe(before.label);
        expect(ref.source).toBe("library");
        expect(ref.assetId).toBe("a2");
        expect(ref.nodeId).toBeUndefined();
        expect(ref.storageKey).toBeUndefined();
    });

    it("新资产无 storageKey 时旧值清空（替换不残留旧图指针）", () => {
        const { id, refId } = addItemEntity();
        const s = useScriptEntityStore.getState();
        s.assignRefSource(id, refId, { state: "ready", source: "library", assetId: "a1", storageKey: "k1" });
        s.assignRefSource(id, refId, { state: "ready", source: "library", assetId: "a2" });
        expect(refOf(id).storageKey).toBeUndefined();
    });

    it("不影响其他槽与其他实体", () => {
        const { id, refId } = addItemEntity();
        const otherId = useScriptEntityStore.getState().upsertEntity({ projectId: "p1", group: "scene", name: "场景B" });
        useScriptEntityStore.getState().assignRefSource(id, refId, { state: "ready", source: "canvas", nodeId: "img-1" });
        const other = useScriptEntityStore.getState().entities.find((e) => e.id === otherId)!;
        expect(other.refs[0].state).toBe("empty");
        expect(other.name).toBe("场景B");
    });
});

describe("ScriptEntityRefSlot assetRef 契约", () => {
    it("槽位接受 assetRef（IndexedDB 与项目文件两种后端），旧字段保留", () => {
        const indexedDbRef: CanvasAssetRef = { backend: "indexeddb", storageKey: "k1" };
        const fileRef: CanvasAssetRef = { backend: "project-file", assetId: "a1", projectId: "p1", relativePath: "assets/imported/a1.png", revision: 1 };
        const slot: ScriptEntityRefSlot = { id: "r1", label: "sheet", state: "ready", assetId: "a1", storageKey: "k1", assetRef: indexedDbRef };
        expect(slot.assetRef).toEqual(indexedDbRef);
        slot.assetRef = fileRef;
        expect(slot.assetRef).toEqual(fileRef);
        expect(slot.assetId).toBe("a1");
        expect(slot.storageKey).toBe("k1");
    });

    it("assignRefSource 持久化生成的 assetRef；换源未提供时清空（不残留旧资产指针）", () => {
        const fileRef: CanvasAssetRef = { backend: "project-file", assetId: "a9", projectId: "p1", relativePath: "assets/generated/images/a9.png", revision: 1 };
        const id = useScriptEntityStore.getState().upsertEntity({ projectId: "p1", group: "item", name: "道具A" });
        const refId = useScriptEntityStore.getState().entities.find((e) => e.id === id)!.refs[0].id;
        const s = useScriptEntityStore.getState();
        s.assignRefSource(id, refId, { state: "ready", source: "generated", nodeId: "img-1", storageKey: "k1", assetRef: fileRef });
        let ref = useScriptEntityStore.getState().entities.find((e) => e.id === id)!.refs[0];
        expect(ref.state).toBe("ready");
        expect(ref.nodeId).toBe("img-1");
        expect(ref.assetRef).toEqual(fileRef);
        // 换成画布来源（无 assetRef）：旧资产指针随整组覆盖被清空
        s.assignRefSource(id, refId, { state: "ready", source: "canvas", nodeId: "img-2" });
        ref = useScriptEntityStore.getState().entities.find((e) => e.id === id)!.refs[0];
        expect(ref.source).toBe("canvas");
        expect(ref.assetRef).toBeUndefined();
        expect(ref.storageKey).toBeUndefined();
    });
});
