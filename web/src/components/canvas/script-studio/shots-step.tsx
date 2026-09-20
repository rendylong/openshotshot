import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Popconfirm } from "antd";
import { Clapperboard, Music2, Plus } from "lucide-react";

import { buildShot, normalizeShots, type ScriptEntityGroupLike } from "@/lib/canvas/script-node-model";
import { type ScriptNodeData, type ScriptShot, type ShotAudioRef, type ShotAudioSlot } from "@/types/script-node";
import { EmptyState } from "@/components/ui/empty-state";
import { RichDescriptionCell, type RichEntityMeta } from "./rich-description-cell";
import { ShotAudioChip } from "./shot-audio-chip";
import { ShotAudioPicker, type AudioNodeLite } from "./shot-audio-picker";
import { ShotCellCombo } from "./shot-cell-combo";
import { ShotListRow, type ShotStoryboardState } from "./shot-list-row";
import { ANGLES, MOVES, SHOT_SIZES } from "./shot-vocab";
import type { StoryboardImageState } from "./compose-step";

type Props = {
    script: ScriptNodeData;
    storyboardFirst: boolean;
    entities: RichEntityMeta[];
    audioNodes: AudioNodeLite[];
    /** shotId -> 分镜图状态 + 就绪缩略（ScriptStudio 透传，spec D9 缩略与失败 chip） */
    storyboardImageState: Record<string, { state: StoryboardImageState; thumbUrl?: string }>;
    /** 单元格内上传本地音频（project.tsx 注入）；origin 携带槽位归属用于项目资产来源溯源（资产存储合入后的新签名） */
    onImportAudio: (file: File, origin: { shotId: string; slot: ShotAudioSlot }) => Promise<ShotAudioRef>;
    onUpdateScript: (updater: (data: ScriptNodeData) => ScriptNodeData) => void;
    onToast: (message: string) => void;
    onGoAssets?: () => void;
    onCreateAsset?: (name: string, group: ScriptEntityGroupLike) => RichEntityMeta;
    /** 「让 Agent 重新编排」确认后的执行入口（ScriptStudio 注入；未注入则隐藏该按钮） */
    onReorchestrate?: () => void;
};

const toRowState = (state: StoryboardImageState | undefined): ShotStoryboardState =>
    state === "ready" ? "ready" : state === "generating" ? "generating" : state === "error" ? "error" : "none";

export function ShotsStep({ script, storyboardFirst, entities, audioNodes, storyboardImageState, onImportAudio, onUpdateScript, onToast, onGoAssets, onCreateAsset, onReorchestrate }: Props) {
    const { t } = useTranslation();
    const shots = script.output.shots;
    const [selectedId, setSelectedId] = useState<string | null>(shots[0]?.shotId ?? null);
    const selected = shots.find((s) => s.shotId === selectedId) ?? null;

    const patchShot = (shotId: string, patch: Partial<ScriptShot>) => {
        onUpdateScript((data) => ({
            ...data,
            output: {
                ...data.output,
                shots: data.output.shots.map((s) =>
                    s.shotId === shotId ? { ...s, ...patch, composed: false, finalPrompt: patch.finalPrompt ?? undefined } : s,
                ),
            },
        }));
    };

    const addShot = () => {
        onUpdateScript((data) => ({
            ...data,
            output: { ...data.output, shots: normalizeShots([...data.output.shots, buildShot(data.output.shots.length + 1, { duration: storyboardFirst ? 5 : 0 })]) },
        }));
    };

    const insertShotAfter = (shotId: string) => {
        onUpdateScript((data) => {
            const index = data.output.shots.findIndex((s) => s.shotId === shotId);
            const next = [...data.output.shots];
            next.splice(index + 1, 0, buildShot(index + 2, { duration: storyboardFirst ? 5 : 0 }));
            return { ...data, output: { ...data.output, shots: normalizeShots(next) } };
        });
    };

    // 有无生成产物（spec D11）：视频/音频/展开节点任一存在 → Modal 确认；纯净镜头 Popconfirm
    const shotHasArtifacts = (shotId: string) =>
        Boolean(script.output.expandedShotNodes?.[shotId] || script.output.shotVideoVersions?.[shotId]?.length || script.output.shotAudioNodes?.[shotId]);

    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

    const removeShot = (shotId: string) => {
        onUpdateScript((data) => ({ ...data, output: { ...data.output, shots: normalizeShots(data.output.shots.filter((s) => s.shotId !== shotId)) } }));
        if (selectedId === shotId) setSelectedId(null);
        setConfirmDeleteId(null);
    };

    const [audioPicker, setAudioPicker] = useState<{ shotId: string; slot: ShotAudioSlot; anchor: HTMLElement } | null>(null);
    const [uploadingAudio, setUploadingAudio] = useState(false);

    const patchSlotText = (shotId: string, slot: ShotAudioSlot, value: string) => patchShot(shotId, slot === "sfx" ? { sfx: value } : { dialogue: value });
    const patchSlotAudio = (shotId: string, slot: ShotAudioSlot, value: ShotAudioRef | undefined) => patchShot(shotId, slot === "sfx" ? { sfxAudio: value } : { dialogueAudio: value });

    const handleUploadAudio = async (file: File) => {
        const target = audioPicker;
        if (!target) return;
        setUploadingAudio(true);
        try {
            const ref = await onImportAudio(file, { shotId: target.shotId, slot: target.slot });
            patchSlotAudio(target.shotId, target.slot, ref);
            setAudioPicker(null);
            (target.anchor.querySelector("input") as HTMLInputElement | null)?.focus();
        } catch {
            onToast(t("canvas.scriptStudio.audioUploadFailed"));
            setAudioPicker(null);
        } finally {
            setUploadingAudio(false);
        }
    };

    const listRef = useRef<HTMLDivElement | null>(null);

    const moveSelection = (delta: 1 | -1) => {
        const index = shots.findIndex((s) => s.shotId === selectedId);
        const next = shots[index + delta];
        if (!next) return;
        setSelectedId(next.shotId);
        // 键盘移动后把新选中行滚入可视区（block: nearest：已在视口内时不产生滚动）
        const rows = listRef.current?.querySelectorAll('[role="option"]');
        rows?.[index + delta]?.scrollIntoView({ block: "nearest" });
    };

    const onListKeyDown = (event: React.KeyboardEvent) => {
        if (event.key === "ArrowDown") {
            event.preventDefault();
            moveSelection(1);
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            moveSelection(-1);
        }
    };

    const audioField = (shot: ScriptShot, slot: ShotAudioSlot) => {
        const audio = slot === "sfx" ? shot.sfxAudio : shot.dialogueAudio;
        const value = slot === "sfx" ? (shot.sfx ?? "") : (shot.dialogue ?? "");
        const open = audioPicker?.shotId === shot.shotId && audioPicker.slot === slot;
        const label = slot === "sfx" ? t("canvas.scriptStudio.colSfx") : t("canvas.scriptStudio.colDialogue");
        return (
            <div className="relative">
                <input
                    className="script-cell-input pr-6 w-full"
                    type="text"
                    value={value}
                    placeholder={audio ? "" : t("canvas.scriptStudio.nonePlaceholder")}
                    aria-label={label}
                    onChange={(event) => patchSlotText(shot.shotId, slot, event.target.value)}
                />
                <button
                    type="button"
                    className={`absolute right-0.5 top-0.5 flex size-6 items-center justify-center rounded text-stone-400 transition-opacity hover:bg-stone-500/10 hover:text-foreground ${open ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
                    aria-label={t("canvas.scriptStudio.audioAdd")}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    onClick={(event) => setAudioPicker(open ? null : { shotId: shot.shotId, slot, anchor: event.currentTarget.parentElement as HTMLElement })}
                >
                    <Music2 className="size-3.5" aria-hidden />
                </button>
                {audio ? (
                    <div className="mt-1">
                        <ShotAudioChip
                            audio={audio}
                            onRemove={() => patchSlotAudio(shot.shotId, slot, undefined)}
                            labels={{
                                play: t("canvas.scriptStudio.audioPlay", { name: audio.name }),
                                pause: t("canvas.scriptStudio.audioPause", { name: audio.name }),
                                remove: t("canvas.scriptStudio.audioRemove", { name: audio.name }),
                                invalid: t("canvas.scriptStudio.audioInvalid"),
                            }}
                        />
                    </div>
                ) : null}
                {open ? (
                    <ShotAudioPicker
                        anchor={audioPicker.anchor}
                        audioNodes={audioNodes}
                        uploading={uploadingAudio}
                        pickedId={audio?.audioNodeId}
                        onPick={(node) => {
                            patchSlotAudio(shot.shotId, slot, { name: node.title, storageKey: node.storageKey, assetRef: node.assetRef, audioNodeId: node.id });
                            const anchor = audioPicker?.anchor;
                            setAudioPicker(null);
                            (anchor?.querySelector("input") as HTMLInputElement | null)?.focus();
                        }}
                        onUpload={handleUploadAudio}
                        onClose={() => setAudioPicker(null)}
                    />
                ) : null}
            </div>
        );
    };

    // 编排失败落地（spec D11）：节点 errorHint 承诺「双击进入 Script Studio 查看完整信息」，这里给出错误横幅；
    // 「让 Agent 继续编排」仅在 onReorchestrate 注入时渲染，横幅本身在 error 状态恒展示
    const errorBanner = script.output.status === "error" ? (
        <div className="flex items-center gap-3 rounded-lg border border-danger/40 bg-danger/10 px-4 py-2" role="alert">
            <span className="size-2 flex-none rounded-full bg-danger" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-sm text-danger" title={script.output.errorMessage}>
                {script.output.errorMessage}
            </span>
            {onReorchestrate ? (
                <button
                    type="button"
                    className="flex-none rounded-md border border-danger/40 px-3 py-1.5 text-sm text-danger transition-colors hover:bg-danger/20"
                    onClick={onReorchestrate}
                >
                    {t("canvas.scriptStudio.errorBannerRetry")}
                </button>
            ) : null}
        </div>
    ) : null;

    if (shots.length === 0) {
        return (
            <div className="flex flex-col gap-4">
                {errorBanner}
                <div className="rounded-xl border border-dashed border-border">
                    <EmptyState
                        icon={Clapperboard}
                        title={t("canvas.scriptStudio.emptyShotsTitle")}
                        description={t("canvas.scriptStudio.emptyShots")}
                        action={
                            <button
                                type="button"
                                className="mt-1 flex items-center gap-1 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background transition-opacity hover:opacity-90"
                                onClick={addShot}
                            >
                                <Plus className="size-4" aria-hidden />
                                {t("canvas.scriptStudio.addShot")}
                            </button>
                        }
                    />
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex items-center gap-2">
                    <span className="mr-auto text-xs text-muted-foreground">{t("canvas.scriptStudio.shotsSummary", { count: shots.length, duration: shots.reduce((s, x) => s + (x.duration || 0), 0) })}</span>
                    <button
                        type="button"
                        className="flex items-center gap-1 rounded-md px-3 py-1.5 text-sm text-stone-600 transition-colors hover:bg-secondary dark:text-stone-300"
                        onClick={addShot}
                    >
                        <Plus className="size-4" aria-hidden />
                        {t("canvas.scriptStudio.addShot")}
                    </button>
                </div>
                {script.output.status === "generating" ? (
                    <div className="rounded-lg border border-border bg-secondary/50 px-4 py-2 text-xs text-muted-foreground" role="status">
                        {t("canvas.scriptStudio.orchestratingStatus")}
                    </div>
                ) : null}
                {errorBanner}
                <div ref={listRef} role="listbox" aria-label={t("canvas.scriptStudio.navLabel")} className="max-h-[calc(100vh-15rem)] overflow-y-auto rounded-xl border border-border bg-background" onKeyDown={onListKeyDown}>
                    {shots.map((shot) => {
                        const sbState = storyboardImageState[shot.shotId];
                        return (
                            <ShotListRow
                                key={shot.shotId}
                                shot={shot}
                                selected={shot.shotId === selectedId}
                                entities={entities}
                                storyboardState={toRowState(sbState?.state)}
                                thumb={sbState?.state === "ready" ? sbState.thumbUrl : undefined}
                                refCount={shot.entityRefs.length}
                                onSelect={() => setSelectedId(shot.shotId)}
                                onInsertAfter={() => insertShotAfter(shot.shotId)}
                            />
                        );
                    })}
                    {script.output.status === "generating"
                        ? Array.from({ length: Math.max(0, (script.template?.shotCount ?? shots.length) - shots.length) }).map((_, i) => (
                              <div key={`pending-${i}`} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0" aria-hidden>
                                  <span className="h-4 w-5 animate-pulse rounded bg-secondary" />
                                  <span className="h-9 w-16 animate-pulse rounded-md bg-secondary" />
                                  <span className="h-4 flex-1 animate-pulse rounded bg-secondary" />
                              </div>
                          ))
                        : null}
                </div>
            </div>

            {selected ? (
                <aside className="w-full flex-none rounded-xl border border-border bg-background p-4 xl:sticky xl:top-14 xl:w-[330px]">
                    <div className="mb-3 flex items-baseline gap-2">
                        <span className="text-base font-bold tabular-nums">SH {String(selected.no).padStart(2, "0")}</span>
                        <span className="text-[10px] text-muted-foreground">
                            {selected.origin === "generated" ? t("canvas.scriptStudio.originGenerated") : t("canvas.scriptStudio.originManual")}
                        </span>
                    </div>
                    <div className="mb-3">
                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("canvas.scriptStudio.groupDescription")}</div>
                        <RichDescriptionCell
                            variant="inspector"
                            shot={selected}
                            entities={entities}
                            onChange={(patch) => patchShot(selected.shotId, patch)}
                            onDuplicateRef={(name) => onToast(`${name} · ${t("canvas.scriptStudio.pickerKindReady")}`)}
                            onGoAssets={onGoAssets}
                            onCreateAsset={onCreateAsset}
                        />
                    </div>
                    <div className="mb-3">
                        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("canvas.scriptStudio.groupLanguage")}</div>
                        <div className="flex flex-col gap-2.5">
                            <div>
                                <label className="mb-1 block text-[11px] text-muted-foreground" htmlFor="insp-size">{t("canvas.scriptStudio.colShotSize")}</label>
                                <ShotCellCombo id="insp-size" value={selected.shotSize} options={SHOT_SIZES} placeholder="—" ariaLabel={t("canvas.scriptStudio.colShotSize")} onChange={(v) => patchShot(selected.shotId, { shotSize: v })} />
                            </div>
                            <div>
                                <label className="mb-1 block text-[11px] text-muted-foreground" htmlFor="insp-angle">{t("canvas.scriptStudio.colAngle")}</label>
                                <ShotCellCombo id="insp-angle" value={selected.angle} options={ANGLES} placeholder="—" ariaLabel={t("canvas.scriptStudio.colAngle")} onChange={(v) => patchShot(selected.shotId, { angle: v })} />
                            </div>
                            <div>
                                <label className="mb-1 block text-[11px] text-muted-foreground" htmlFor="insp-move">{t("canvas.scriptStudio.colMovement")}</label>
                                <ShotCellCombo id="insp-move" value={selected.movement} options={MOVES} placeholder="—" ariaLabel={t("canvas.scriptStudio.colMovement")} onChange={(v) => patchShot(selected.shotId, { movement: v })} />
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="mb-1 block text-[11px] text-muted-foreground" htmlFor="insp-dur">{t("canvas.scriptStudio.colDuration")}</label>
                                    <input
                                        id="insp-dur"
                                        className="script-cell-input w-full"
                                        type="number"
                                        min={1}
                                        max={60}
                                        placeholder="—"
                                        value={selected.duration || ""}
                                        onChange={(event) => {
                                            const raw = event.target.value;
                                            patchShot(selected.shotId, { duration: raw === "" ? 0 : Math.max(1, Math.round(Number(raw) || 1)) });
                                        }}
                                    />
                                </div>
                                <div>
                                    <label className="mb-1 block text-[11px] text-muted-foreground" htmlFor="insp-mood">{t("canvas.scriptStudio.colMood")}</label>
                                    <input id="insp-mood" className="script-cell-input w-full" type="text" value={selected.mood} placeholder="—" onChange={(event) => patchShot(selected.shotId, { mood: event.target.value })} />
                                </div>
                            </div>
                        </div>
                    </div>
                    <div>
                        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("canvas.scriptStudio.groupSound")}</div>
                        <div className="flex flex-col gap-2.5">
                            <div>
                                <label className="mb-1 block text-[11px] text-muted-foreground">{t("canvas.scriptStudio.colSfx")}</label>
                                <div className="group">{audioField(selected, "sfx")}</div>
                            </div>
                            <div>
                                <label className="mb-1 block text-[11px] text-muted-foreground">{t("canvas.scriptStudio.colDialogue")}</label>
                                <div className="group">{audioField(selected, "dialogue")}</div>
                            </div>
                        </div>
                    </div>
                    <div className="mt-4 border-t border-border pt-3">
                        {shotHasArtifacts(selected.shotId) ? (
                            <button
                                type="button"
                                className="rounded-md px-2 py-1.5 text-sm text-danger transition-colors hover:bg-danger/10"
                                onClick={() => setConfirmDeleteId(selected.shotId)}
                            >
                                {t("canvas.scriptStudio.deleteShot")}
                            </button>
                        ) : (
                            <Popconfirm
                                title={t("canvas.scriptStudio.deleteShotConfirm")}
                                okText={t("canvas.scriptStudio.deleteShotOk")}
                                cancelText={t("canvas.scriptStudio.deleteShotCancel")}
                                onConfirm={() => removeShot(selected.shotId)}
                            >
                                <button type="button" className="rounded-md px-2 py-1.5 text-sm text-danger transition-colors hover:bg-danger/10">
                                    {t("canvas.scriptStudio.deleteShot")}
                                </button>
                            </Popconfirm>
                        )}
                    </div>
                    <Modal
                        open={confirmDeleteId !== null}
                        onCancel={() => setConfirmDeleteId(null)}
                        onOk={() => confirmDeleteId && removeShot(confirmDeleteId)}
                        title={t("canvas.scriptStudio.deleteShotTitle")}
                        okText={t("canvas.scriptStudio.deleteShotOk")}
                        cancelText={t("canvas.scriptStudio.deleteShotCancel")}
                        okButtonProps={{ danger: true }}
                    >
                        {t("canvas.scriptStudio.deleteShotContent")}
                    </Modal>
                </aside>
            ) : null}
        </div>
    );
}
