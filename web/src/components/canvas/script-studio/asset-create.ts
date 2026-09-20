import type { ScriptNodeData } from "@/types/script-node";
import type { ScriptEntityGroupLike } from "@/lib/canvas/script-node-model";
import { useScriptEntityStore } from "@/stores/use-script-entity-store";

/** 与 rich-description-cell 的 RichEntityMeta 结构相同（结构化兼容） */
export type CreatedAssetMeta = {
    id: string;
    name: string;
    group: ScriptEntityGroupLike;
    ready: boolean;
};

/**
 * @ 弹层「新建资产」的落库语义：先按 projectId+name 全项目查同名——
 * 命中只挂接既有实体（upsertEntity 的碰撞分支会用 {...existing,...normalized}
 * 覆写分组（可选字段不传入则被既有值保留，refs 另有显式保护），创建路径必须绕开）；未命中才 upsert 新建，
 * 只传必填三字段，role/appearance 等留空待第二步补。
 * 返回 created 供调用方区分「新建」与「挂接」选 toast 文案。
 * 注意：assets-step 的 upsertEntity 用法是整份表单草稿的编辑语义，与本项目的不强并；
 * 若第三处出现同类创建再抽共享 hook。
 */
export function createOrAttachAsset(args: { projectId: string; group: ScriptEntityGroupLike; name: string; attach: (entityId: string) => void }): { meta: CreatedAssetMeta; created: boolean } {
    const store = useScriptEntityStore.getState();
    const name = args.name.trim();
    const existing = store.entities.find((e) => e.projectId === args.projectId && e.name === name);
    if (existing) {
        args.attach(existing.id);
        return { meta: { id: existing.id, name: existing.name, group: existing.group, ready: existing.refs.some((r) => r.state === "ready") }, created: false };
    }
    const id = store.upsertEntity({ projectId: args.projectId, group: args.group, name });
    args.attach(id);
    return { meta: { id, name, group: args.group, ready: false }, created: true };
}

/** 生成把实体 id 并入 script.entityIds 的 attach 函数（幂等：已含则原样返回） */
export function makeEntityAttach(updateScript: (updater: (data: ScriptNodeData) => ScriptNodeData) => void): (entityId: string) => void {
    return (entityId: string) => {
        updateScript((data) => (data.entityIds.includes(entityId) ? data : { ...data, entityIds: [...data.entityIds, entityId] }));
    };
}
