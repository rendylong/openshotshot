import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Image as ImageIcon, Loader2, Plus, Trash2 } from "lucide-react";

import type { ScriptNodeData } from "@/types/script-node";
import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";
import { useScriptEntityStore, type ScriptEntity, type ScriptEntityGroup } from "@/stores/use-script-entity-store";
import { EntityDrawer, localizedRefLabel, GROUP_ICON, type EntityDraft } from "./entity-drawer";
import { EntityRefThumb } from "./entity-ref-thumb";

const GROUPS: Array<{ key: ScriptEntityGroup }> = [{ key: "character" }, { key: "scene" }, { key: "item" }];

type Props = {
    script: ScriptNodeData;
    projectId: string;
    entities: ScriptEntity[];
    canvasImageNodes: CanvasNodeData[];
    onUpdateScript: (updater: (data: ScriptNodeData) => ScriptNodeData) => void;
    /** 槽级生成：在指定参考图槽经画布图片生成节点执行（project.tsx 注入，v0.5） */
    onGenerateRef: (draft: EntityDraft, entityId: string, refId: string) => void;
    /** 库来源挑选物化（project.tsx 注入，spec D1）：复用优先，否则复制为派生节点；物化逻辑在 project.tsx */
    onPickLibrary: (draft: EntityDraft, entityId: string, refId: string, assetId: string, storageKey?: string, assetRef?: CanvasAssetRef) => void;
    onToast: (message: string) => void;
};

/** 第2步 准备资产：全局风格 + 角色/场景/道具分组卡网格 + 详情抽屉三来源。 */
export function AssetsStep({ script, projectId, entities, canvasImageNodes, onUpdateScript, onGenerateRef, onPickLibrary, onToast }: Props) {
    const { t } = useTranslation();
    const [drawer, setDrawer] = useState<{ entity: ScriptEntity | null; group: ScriptEntityGroup } | null>(null);

    const upsertEntity = (draft: EntityDraft): string => {
        // 不带 refs：由 store 保留已有实体 refs / 为新实体补默认槽，避免编辑时清空参考图状态
        const input = { projectId, group: draft.group, name: draft.name.trim(), role: draft.role, appearance: draft.appearance, consistency: draft.consistency, imagePrompt: draft.imagePrompt };
        const id = useScriptEntityStore.getState().upsertEntity(draft.id ? { ...input, id: draft.id } : input);
        onUpdateScript((data) => (data.entityIds.includes(id) ? data : { ...data, entityIds: [...data.entityIds, id] }));
        return id;
    };

    const groupOf = (key: ScriptEntityGroup) => entities.filter((e) => e.group === key);
    const isReady = (e: ScriptEntity) => e.refs.some((r) => r.state === "ready");

    return (
        <div className="flex flex-col gap-5">
            <div className="flex items-start gap-3">
                <span className="mt-2.5 flex-none rounded-md border border-stone-300 px-2 py-0.5 text-xs text-stone-500 dark:border-stone-600 dark:text-stone-400">{t("canvas.scriptAssets.globalStyle")}</span>
                <textarea
                    className="min-h-11 flex-1 rounded-lg border border-stone-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-stone-400 dark:border-stone-700 dark:focus:border-stone-500"
                    placeholder={t("canvas.scriptAssets.globalStylePlaceholder")}
                    value={script.globalStyle}
                    onChange={(event) => onUpdateScript((data) => ({ ...data, globalStyle: event.target.value }))}
                />
            </div>

            <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-2 xl:grid-cols-3">
            {GROUPS.map((group) => {
                const items = groupOf(group.key);
                const ready = items.filter(isReady).length;
                const Icon = GROUP_ICON[group.key];
                return (
                    <section key={group.key} className="min-w-0">
                        <div className="mb-2.5 flex items-baseline gap-2">
                            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                                <Icon className="size-4 text-stone-400" aria-hidden />
                                {t(`canvas.scriptAssets.group${group.key === "character" ? "Character" : group.key === "scene" ? "Scene" : "Item"}`)}
                            </h3>
                            <span className="text-xs text-stone-400">
                                {items.length ? t("canvas.scriptAssets.readyCount", { ready, total: items.length }) : t("canvas.scriptAssets.noEntities")}
                            </span>
                        </div>
                        {/* 单大图卡（2026-09-18 拍板方案 A）：预览 4:3 占满卡宽填满，原 4 槽摘要收进「n/N 就绪」徽标 + 状态点 */}
                        <div className="flex flex-col gap-3">
                            {items.map((entity) => {
                                const readyRef = entity.refs.find((r) => r.state === "ready");
                                const readyCount = entity.refs.filter((r) => r.state === "ready").length;
                                const anyQueued = entity.refs.some((r) => r.state === "queued");
                                return (
                                    <div
                                        key={entity.id}
                                        className="group relative flex min-w-0 cursor-pointer flex-col rounded-lg border border-stone-200 bg-card p-2 transition-colors hover:border-stone-400 dark:border-stone-800 dark:hover:border-stone-600"
                                        onClick={() => setDrawer({ entity, group: entity.group })}
                                    >
                                        <div
                                            data-testid="entity-preview"
                                            className={`relative mb-2 aspect-[4/3] w-full overflow-hidden rounded-md ${
                                                readyRef
                                                    ? "border border-stone-200 dark:border-stone-800"
                                                    : anyQueued
                                                      ? "border border-stone-300/70 dark:border-stone-700"
                                                      : "border-[1.5px] border-dashed border-stone-300 dark:border-stone-700"
                                            }`}
                                        >
                                            {readyRef ? (
                                                <EntityRefThumb refSlot={readyRef} canvasImageNodes={canvasImageNodes} iconClassName="size-6" />
                                            ) : anyQueued ? (
                                                <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-xs text-stone-400">
                                                    <Loader2 className="size-4 animate-spin" aria-hidden />
                                                    {t("canvas.scriptAssets.previewGenerating")}
                                                </div>
                                            ) : (
                                                <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-xs text-stone-400">
                                                    <ImageIcon className="size-5" aria-hidden />
                                                    {t("canvas.scriptAssets.previewEmpty")}
                                                </div>
                                            )}
                                            <div className="absolute right-2 top-2 hidden gap-1.5 group-hover:flex">
                                                <button
                                                    type="button"
                                                    className="rounded-md border border-input bg-background/90 px-1.5 py-0.5 text-[11px] transition-colors hover:text-foreground"
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        setDrawer({ entity, group: entity.group });
                                                    }}
                                                >
                                                    {t("canvas.scriptAssets.regenerate")}
                                                </button>
                                                <button
                                                    type="button"
                                                    aria-label={t("canvas.scriptAssets.remove")}
                                                    title={t("canvas.scriptAssets.remove")}
                                                    className="flex items-center rounded-md border border-input bg-background/90 px-1.5 py-0.5 text-[11px] text-danger"
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        useScriptEntityStore.getState().removeEntity(entity.id);
                                                        onUpdateScript((data) => ({ ...data, entityIds: data.entityIds.filter((id) => id !== entity.id) }));
                                                    }}
                                                >
                                                    <Trash2 className="size-3" />
                                                </button>
                                            </div>
                                        </div>
                                        <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                                            <span className="truncate">{entity.name}</span>
                                            <span className="flex-none rounded-full border border-stone-300 px-1.5 text-[10px] font-normal text-stone-500 dark:border-stone-600 dark:text-stone-400">
                                                {t("canvas.scriptAssets.cardRefCount", { ready: readyCount, total: entity.refs.length })}
                                            </span>
                                        </div>
                                        <div className="mt-0.5 min-w-0 truncate text-xs text-stone-400">{entity.appearance || entity.role || "—"}</div>
                                        {entity.refs.length ? (
                                            <div className="mt-1.5 flex items-center gap-1.5" data-testid="entity-dots">
                                                {entity.refs.slice(0, 4).map((r) => (
                                                    <span
                                                        key={r.id}
                                                        title={localizedRefLabel(r.label, t)}
                                                        className={`size-1.5 rounded-full ${r.state === "ready" ? "bg-success" : r.state === "queued" ? "bg-warning" : "border border-stone-300 dark:border-stone-600"}`}
                                                    />
                                                ))}
                                            </div>
                                        ) : null}
                                    </div>
                                );
                            })}
                            <button
                                type="button"
                                className="flex h-16 w-full flex-none items-center justify-center gap-1.5 rounded-lg border-[1.5px] border-dashed border-stone-300 text-sm text-stone-400 transition-colors hover:border-stone-400 hover:text-foreground dark:border-stone-700 dark:hover:border-stone-500"
                                onClick={() => setDrawer({ entity: null, group: group.key })}
                            >
                                <Plus className="size-4" aria-hidden />
                                {t("canvas.scriptAssets.addNew")}
                            </button>
                        </div>
                    </section>
                );
            })}
            </div>

            {drawer && (
                <EntityDrawer
                    entity={drawer.entity}
                    defaultGroup={drawer.group}
                    canvasImageNodes={canvasImageNodes}
                    onClose={() => setDrawer(null)}
                    onSaveDraft={(draft) => {
                        upsertEntity(draft);
                        setDrawer(null);
                    }}
                    onGenerateRef={(draft, entityId, refId) => {
                        // 新建实体先落库再生成该槽（已有实体直接用传入 id）
                        const id = drawer.entity ? entityId : upsertEntity(draft);
                        onGenerateRef(draft, id, refId);
                    }}
                    onPickCanvas={(draft, entityId, refId, nodeId) => {
                        const id = drawer.entity ? entityId : upsertEntity(draft);
                        useScriptEntityStore.getState().assignRefSource(id, refId, { state: "ready", source: "canvas", nodeId });
                    }}
                    onPickLibrary={onPickLibrary}
                    onToast={onToast}
                />
            )}
        </div>
    );
}
