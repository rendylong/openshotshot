import { beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptyScriptData, type ScriptNodeData } from "@/types/script-node";
import { useScriptEntityStore } from "@/stores/use-script-entity-store";
import { createOrAttachAsset, makeEntityAttach } from "./asset-create";

const projectId = "p1";

// 与 use-script-entity-store 的 ScriptEntity 形状一致的最小夹具
const baseEntity = () => ({
    id: "ent_old",
    projectId,
    group: "scene",
    name: "猫",
    role: "主角",
    appearance: "黑猫",
    consistency: "",
    imagePrompt: "",
    refs: [{ id: "ref_1", label: "场景图", state: "ready", storageKey: "k1" }],
    createdAt: "",
    updatedAt: "",
});

describe("createOrAttachAsset", () => {
    beforeEach(() => {
        useScriptEntityStore.setState({ entities: [] });
    });

    it("项目级同名（挂在其他脚本）→ 不 upsert，只挂接既有实体并返回既有 meta", () => {
        useScriptEntityStore.setState({ entities: [baseEntity()] as never });
        const attach = vi.fn();
        const { meta, created } = createOrAttachAsset({ projectId, group: "character", name: "猫", attach });
        expect(created).toBe(false);
        expect(attach).toHaveBeenCalledTimes(1);
        expect(attach).toHaveBeenCalledWith("ent_old");
        expect(meta).toEqual({ id: "ent_old", name: "猫", group: "scene", ready: true });
        // 既有实体的分组与文本字段未被改写（upsertEntity 碰撞分支会覆盖，必须绕开）
        const after = useScriptEntityStore.getState().entities.find((e) => e.id === "ent_old");
        expect(after?.group).toBe("scene");
        expect(after?.role).toBe("主角");
        expect(after?.appearance).toBe("黑猫");
    });

    it("无同名 → upsert 只含 projectId/group/name（可选字段不传），挂接新 id 并返回 ready:false", () => {
        const attach = vi.fn();
        const { meta, created } = createOrAttachAsset({ projectId, group: "item", name: " 钥匙 ", attach });
        expect(created).toBe(true);
        const stored = useScriptEntityStore.getState().entities.find((e) => e.id === meta.id);
        expect(stored?.name).toBe("钥匙");
        expect(stored?.group).toBe("item");
        expect(stored?.projectId).toBe(projectId);
        expect(stored?.role).toBeUndefined();
        expect(stored?.refs.length).toBeGreaterThan(0); // store 自动补默认参考图槽
        expect(attach).toHaveBeenCalledTimes(1);
        expect(attach).toHaveBeenCalledWith(meta.id);
        expect(meta.ready).toBe(false);
    });
});

describe("makeEntityAttach", () => {
    it("幂等：entityIds 已含该 id 时 updater 原样返回同一引用", () => {
        let updater: ((data: ScriptNodeData) => ScriptNodeData) | undefined;
        const attach = makeEntityAttach((u) => {
            updater = u;
        });
        attach("ent_x");
        const once = updater!(createEmptyScriptData());
        expect(once.entityIds).toEqual(["ent_x"]);
        attach("ent_x");
        const twice = updater!(once);
        expect(twice).toBe(once);
        expect(twice.entityIds).toEqual(["ent_x"]);
    });
});
