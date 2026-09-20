import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image as ImageIcon, Mountain, Package, Plus, User, X } from "lucide-react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useScriptEntityStore, type ScriptEntity, type ScriptEntityGroup, type ScriptEntityRefSlot } from "@/stores/use-script-entity-store";
import { useAssetStore } from "@/stores/use-asset-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";
import { EntityRefThumb } from "./entity-ref-thumb";

export type EntityDraft = {
    id?: string;
    group: ScriptEntityGroup;
    name: string;
    role: string;
    appearance: string;
    consistency: string;
    imagePrompt: string;
};

type Props = {
    entity: ScriptEntity | null; // null = 新建
    defaultGroup: ScriptEntityGroup;
    canvasImageNodes: CanvasNodeData[];
    onClose: () => void;
    /** 表单草稿落库（新建实体） */
    onSaveDraft: (draft: EntityDraft) => void;
    /** 槽级三来源（v0.5）：在指定槽生成参考图（经画布图片生成节点） */
    onGenerateRef: (draft: EntityDraft, entityId: string, refId: string) => void;
    onPickCanvas: (draft: EntityDraft, entityId: string, refId: string, nodeId: string) => void;
    /** 库来源挑选（project.tsx 注入链，spec D1）：物化（复用/复制为派生节点）在 project.tsx 执行，这里只透传 */
    onPickLibrary: (draft: EntityDraft, entityId: string, refId: string, assetId: string, storageKey?: string, assetRef?: CanvasAssetRef) => void;
    onToast: (message: string) => void;
};

export const GROUP_ICON: Record<ScriptEntityGroup, typeof User> = { character: User, scene: Mountain, item: Package };

// zustand v5 要求 selector 快照稳定：新建实体时 find 落空需回退到同一个空数组，否则无限重渲染
const EMPTY_REFS: ScriptEntityRefSlot[] = [];

/** 旧数据里的英文槽位名在界面上本地化显示；其余标签原样展示 */
export function localizedRefLabel(label: string, t: (key: string) => string): string {
    if (label === "sheet") return t("canvas.scriptAssets.slotLabelSheet");
    if (label === "portrait") return t("canvas.scriptAssets.slotLabelPortrait");
    return label;
}

/**
 * 资产详情抽屉（v0.5）：表单文案按类型差异化；参考图为单图槽列表，
 * 每槽行内提供「生成 / 从画布选择 / 从资产库选择」；无「交给 Agent 生成」。Esc 关闭。
 */
export function EntityDrawer({ entity, defaultGroup, canvasImageNodes, onClose, onSaveDraft, onGenerateRef, onPickCanvas, onPickLibrary, onToast }: Props) {
    const { t } = useTranslation();
    const allAssets = useAssetStore((state) => state.assets);
    const imageAssets = useMemo(() => allAssets.filter((a) => a.kind === "image"), [allAssets]);
    const refs = useScriptEntityStore((state) => state.entities.find((e) => e.id === entity?.id)?.refs ?? EMPTY_REFS);
    const addRef = useScriptEntityStore((state) => state.addRef);
    const [draft, setDraft] = useState<EntityDraft>(() => ({
        id: entity?.id,
        group: entity?.group ?? defaultGroup,
        name: entity?.name ?? "",
        role: entity?.role ?? "",
        appearance: entity?.appearance ?? "",
        consistency: entity?.consistency ?? "",
        imagePrompt: entity?.imagePrompt ?? "",
    }));
    const [pickerFor, setPickerFor] = useState<{ refId: string; source: "canvas" | "library" } | null>(null);
    const [openMenuRefId, setOpenMenuRefId] = useState<string | null>(null);

    // 菜单开启时在 window 捕获阶段拦截 Escape：window 捕获先于 Radix 挂在 document 捕获上的 dismiss 监听，
    // 在此吞掉事件并直接置空受控状态；否则 Radix 会先把状态同步置空，抽屉的冒泡监听会把整个抽屉一起关掉
    useEffect(() => {
        if (!openMenuRefId) return;
        const onKeyCapture = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setOpenMenuRefId(null);
        };
        window.addEventListener("keydown", onKeyCapture, true);
        return () => window.removeEventListener("keydown", onKeyCapture, true);
    }, [openMenuRefId]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            // 菜单开启时 Escape 已在 window 捕获阶段被吞掉；此守卫兜底，无菜单时 Esc 关抽屉
            if (openMenuRefId) return;
            onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose, openMenuRefId]);

    const groupKey = draft.group === "character" ? "Character" : draft.group === "scene" ? "Scene" : "Item";
    const groupLabel = t(`canvas.scriptAssets.group${groupKey}`);
    const patch = (part: Partial<EntityDraft>) => setDraft((d) => ({ ...d, ...part }));

    return (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/45" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
            <aside className="flex h-full w-[470px] flex-col border-l bg-background">
                <header className="flex items-center justify-between border-b px-4 py-3">
                    <span className="flex items-center gap-1.5 text-sm font-semibold">
                        {(() => {
                            const Icon = GROUP_ICON[draft.group];
                            return <Icon className="size-4 text-stone-400" aria-hidden />;
                        })()}
                        {entity ? t("canvas.scriptAssets.drawerEdit", { group: groupLabel }) : t("canvas.scriptAssets.drawerNew", { group: groupLabel })}
                    </span>
                    <button type="button" className="-m-1 rounded p-1 text-stone-400 transition-colors hover:text-foreground" aria-label={t("canvas.scriptAssets.cancel")} onClick={onClose}>
                        <X className="size-4" />
                    </button>
                </header>

                <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4 text-sm">
                    <label className="flex flex-col gap-1 text-xs">
                        <span className="text-stone-500 dark:text-stone-400">{t("canvas.scriptAssets.fieldName")}</span>
                        <input className="rounded-md border border-stone-300 bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-stone-400 dark:border-stone-700 dark:focus:border-stone-500" value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                        <span className="text-stone-500 dark:text-stone-400">{t(`canvas.scriptAssets.role${groupKey}`)}</span>
                        <input className="rounded-md border border-stone-300 bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-stone-400 dark:border-stone-700 dark:focus:border-stone-500" placeholder={t(`canvas.scriptAssets.role${groupKey}Placeholder`)} value={draft.role} onChange={(e) => patch({ role: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                        <span className="text-stone-500 dark:text-stone-400">{t(`canvas.scriptAssets.appearance${groupKey}`)}</span>
                        <textarea className="min-h-16 rounded-md border border-stone-300 bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-stone-400 dark:border-stone-700 dark:focus:border-stone-500" placeholder={t(`canvas.scriptAssets.appearance${groupKey}Placeholder`)} value={draft.appearance} onChange={(e) => patch({ appearance: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                        <span className="text-stone-500 dark:text-stone-400">{t("canvas.scriptAssets.fieldConsistency")}</span>
                        <textarea className="min-h-12 rounded-md border border-stone-300 bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-stone-400 dark:border-stone-700 dark:focus:border-stone-500" placeholder={t("canvas.scriptAssets.fieldConsistencyPlaceholder")} value={draft.consistency} onChange={(e) => patch({ consistency: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                        <span className="text-stone-500 dark:text-stone-400">{t("canvas.scriptAssets.fieldImagePrompt")}</span>
                        <textarea className="min-h-14 rounded-md border border-stone-300 bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-stone-400 dark:border-stone-700 dark:focus:border-stone-500" placeholder={t("canvas.scriptAssets.fieldImagePromptPlaceholder")} value={draft.imagePrompt} onChange={(e) => patch({ imagePrompt: e.target.value })} />
                    </label>

                    {entity ? (
                        <div className="flex flex-col gap-3">
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-medium text-stone-500 dark:text-stone-400">
                                    {t("canvas.scriptAssets.refsCount", { ready: refs.filter((r) => r.state === "ready").length, total: refs.length })}
                                </span>
                                <button type="button" className="flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs transition-colors hover:bg-accent" onClick={() => addRef(entity.id)}>
                                    <Plus className="size-3.5" aria-hidden />
                                    {t("canvas.scriptAssets.addRef")}
                                </button>
                            </div>
                            {refs.map((ref) => (
                                <RefRow
                                    key={ref.id}
                                    refSlot={ref}
                                    draft={draft}
                                    entityId={entity.id}
                                    canvasImageNodes={canvasImageNodes}
                                    imageAssets={imageAssets}
                                    pickerFor={pickerFor}
                                    setPickerFor={setPickerFor}
                                    menuOpen={openMenuRefId === ref.id}
                                    onMenuOpenChange={(open) => setOpenMenuRefId(open ? ref.id : null)}
                                    onGenerateRef={onGenerateRef}
                                    onPickCanvas={onPickCanvas}
                                    onPickLibrary={onPickLibrary}
                                    onToast={onToast}
                                />
                            ))}
                        </div>
                    ) : null}
                </div>

                <footer className="flex justify-end gap-2 border-t px-4 py-3">
                    <button type="button" className="rounded-md border border-input px-3 py-1.5 text-sm text-stone-600 hover:bg-accent dark:text-stone-300" onClick={onClose}>
                        {t("canvas.scriptAssets.cancel")}
                    </button>
                    <button
                        type="button"
                        className="rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background hover:opacity-90"
                        onClick={() => {
                            if (!draft.name.trim()) return onToast(t("canvas.scriptAssets.nameRequired"));
                            onSaveDraft(draft);
                        }}
                    >
                        {entity ? t("canvas.scriptAssets.done") : t("canvas.scriptAssets.createEntity")}
                    </button>
                </footer>
            </aside>
        </div>
    );
}

/** 单个参考图槽：状态 + 槽级「生成 / 从画布选择 / 从资产库选择」。 */
function RefRow({ refSlot, draft, entityId, canvasImageNodes, imageAssets, pickerFor, setPickerFor, menuOpen, onMenuOpenChange, onGenerateRef, onPickCanvas, onPickLibrary, onToast }: {
    refSlot: ScriptEntityRefSlot;
    draft: EntityDraft;
    entityId: string;
    canvasImageNodes: CanvasNodeData[];
    imageAssets: Array<{ id: string; title: string; kind: string; data: { storageKey?: string; assetRef?: CanvasAssetRef } }>;
    pickerFor: { refId: string; source: "canvas" | "library" } | null;
    setPickerFor: (value: { refId: string; source: "canvas" | "library" } | null) => void;
    menuOpen: boolean;
    onMenuOpenChange: (open: boolean) => void;
    onGenerateRef: Props["onGenerateRef"];
    onPickCanvas: Props["onPickCanvas"];
    onPickLibrary: Props["onPickLibrary"];
    onToast: (message: string) => void;
}) {
    const { t } = useTranslation();
    const removeRef = useScriptEntityStore((state) => state.removeRef);
    const active = pickerFor?.refId === refSlot.id;
    const stateLabel = refSlot.state === "ready" ? (refSlot.source ? t(`canvas.scriptAssets.src${refSlot.source === "generated" ? "Generated" : refSlot.source === "canvas" ? "Canvas" : "Library"}`) : "✓") : refSlot.state === "queued" ? "…" : t("canvas.scriptAssets.noSource");

    return (
        <div className="rounded-lg border border-stone-200 p-2.5 dark:border-stone-800">
            <div className="mb-2 flex items-center gap-2 text-xs">
                <span className="font-medium">{localizedRefLabel(refSlot.label, t)}</span>
                <span className={refSlot.state === "ready" ? "text-success" : "text-stone-400"}>{stateLabel}</span>
                <button type="button" className="-m-1 ml-auto rounded p-1.5 text-stone-400 transition-colors hover:text-danger" title={t("canvas.scriptAssets.removeRef")} aria-label={t("canvas.scriptAssets.removeRef")} onClick={() => removeRef(entityId, refSlot.id)}>
                    <X className="size-3.5" />
                </button>
            </div>
            {refSlot.state === "ready" ? (
                <div className="mb-2 flex h-72 w-full items-center justify-center overflow-hidden rounded-md border border-stone-200 dark:border-stone-700">
                    <EntityRefThumb refSlot={refSlot} canvasImageNodes={canvasImageNodes} iconClassName="size-6" />
                </div>
            ) : null}
            <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
                <DropdownMenuTrigger asChild>
                    {refSlot.state === "empty" ? (
                        <button
                            type="button"
                            className="flex items-center rounded border border-dashed border-stone-300 px-2.5 py-1 text-xs text-stone-400 transition-colors hover:border-stone-400 hover:text-foreground dark:border-stone-700"
                            title={t("canvas.scriptAssets.pickSource")}
                            aria-label={t("canvas.scriptAssets.pickSource")}
                        >
                            <Plus className="size-3.5" aria-hidden />
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="rounded-md border border-input px-2.5 py-1 text-xs transition-colors hover:bg-accent"
                        >
                            {t("canvas.scriptAssets.replaceRef")}
                        </button>
                    )}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                    <DropdownMenuItem
                        onClick={() => {
                            if (!draft.name.trim()) return onToast(t("canvas.scriptAssets.nameRequired"));
                            onGenerateRef(draft, entityId, refSlot.id);
                        }}
                    >
                        {t("canvas.scriptAssets.generate")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setPickerFor({ refId: refSlot.id, source: "canvas" })}>
                        {t("canvas.scriptAssets.fromCanvas")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setPickerFor({ refId: refSlot.id, source: "library" })}>
                        {t("canvas.scriptAssets.fromLibrary")}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            {active && pickerFor?.source === "canvas" ? (
                <div className="mt-2 flex flex-col gap-1.5">
                    {canvasImageNodes.length === 0 ? (
                        <div className="rounded border border-dashed border-stone-400/50 px-3 py-3 text-center text-xs text-stone-500">{t("canvas.scriptAssets.canvasEmpty")}</div>
                    ) : (
                        canvasImageNodes.slice(0, 6).map((node) => (
                            <div key={node.id} className="flex items-center gap-2.5 rounded border border-stone-200 px-2.5 py-1.5 text-xs dark:border-stone-700">
                                <span className="truncate">{node.title}</span>
                                <button type="button" className="ml-auto rounded-md border border-input px-1.5 py-0.5 hover:bg-accent" onClick={() => { onPickCanvas(draft, entityId, refSlot.id, node.id); setPickerFor(null); }}>
                                    {t("canvas.scriptAssets.pick")}
                                </button>
                            </div>
                        ))
                    )}
                </div>
            ) : null}
            {active && pickerFor?.source === "library" ? (
                <div className="mt-2 flex max-h-44 flex-col gap-1.5 overflow-y-auto">
                    {imageAssets.length === 0 ? (
                        <div className="rounded border border-dashed border-stone-400/50 px-3 py-3 text-center text-xs text-stone-500">{t("canvas.scriptAssets.libraryEmpty")}</div>
                    ) : (
                        imageAssets.slice(0, 10).map((asset) => (
                            <div key={asset.id} className="flex items-center gap-2.5 rounded border border-stone-200 px-2.5 py-1.5 text-xs dark:border-stone-700">
                                <span className="truncate">{asset.title}</span>
                                <button type="button" className="ml-auto rounded-md border border-input px-1.5 py-0.5 hover:bg-accent" onClick={() => { onPickLibrary(draft, entityId, refSlot.id, asset.id, asset.data.storageKey, asset.data.assetRef); setPickerFor(null); }}>
                                    {t("canvas.scriptAssets.pick")}
                                </button>
                            </div>
                        ))
                    )}
                </div>
            ) : null}
        </div>
    );
}
