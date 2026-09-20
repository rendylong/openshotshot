import { Check, Loader2, Plus, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { ScriptRichSegment, ScriptShot } from "@/types/script-node";
import type { RichEntityMeta } from "./rich-description-cell";

export type ShotStoryboardState = "none" | "generating" | "ready" | "error";

type Props = {
    shot: ScriptShot;
    selected: boolean;
    entities: RichEntityMeta[];
    storyboardState: ShotStoryboardState;
    /** 已水合分镜缩略 URL；无则渲染「镜号+景别」虚线格 */
    thumb?: string;
    refCount: number;
    onSelect: () => void;
    /** 行 hover「+」：在该镜头后插入新镜头（spec D9；未传不渲染） */
    onInsertAfter?: () => void;
};

/** 列表行 ref 段按语序渲染为内联芯片（spec D9：芯片随文本排版，非独立 chips 行）。 */
function inlineRich(rich: ScriptRichSegment[], nameOf: (id: string) => string | undefined) {
    return rich.map((seg, i) =>
        seg.t === "ref" ? (
            <span key={i} className="iref">
                @{nameOf(seg.entityId) ?? "?"}
            </span>
        ) : (
            <span key={i}>{seg.v}</span>
        ),
    );
}

/** 导演式镜头列表行（spec D9）：镜号 → 缩略图 → 描述主体 → 逐值元信息 → 状态 chips。 */
export function ShotListRow({ shot, selected, entities, storyboardState, thumb, refCount, onSelect, onInsertAfter }: Props) {
    const { t } = useTranslation();
    const nameOf = (id: string) => entities.find((e) => e.id === id)?.name;
    const metaValues: Array<{ v: string; title: string; truncate: boolean }> = [
        { v: shot.shotSize, title: shot.shotSize, truncate: true },
        { v: shot.angle, title: shot.angle, truncate: true },
        { v: shot.movement, title: shot.movement, truncate: true },
        { v: shot.duration ? `${shot.duration}s` : "", title: `${shot.duration}s`, truncate: false },
    ].filter((m) => m.v);

    return (
        <div
            role="option"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={`group relative flex cursor-pointer items-center gap-3 border-b border-border px-4 py-2.5 transition-colors last:border-b-0 hover:bg-secondary/60 ${
                selected ? "bg-secondary/60" : "bg-background"
            }`}
            onClick={onSelect}
        >
            {selected ? <span className="absolute inset-y-0 left-0 w-0.5 bg-foreground" aria-hidden /> : null}
            <span className="w-5 flex-none text-xs font-semibold tabular-nums text-stone-400 dark:text-stone-500">
                {String(shot.no).padStart(2, "0")}
            </span>
            <div className="group/thumb relative h-9 w-16 flex-none overflow-hidden rounded-md">
                {thumb ? (
                    <img src={thumb} alt="" className="h-full w-full object-cover" draggable={false} />
                ) : (
                    <div className="flex h-full flex-col items-center justify-center border border-dashed border-border text-[10px] leading-none text-muted-foreground">
                        <span className="font-semibold tabular-nums">{String(shot.no).padStart(2, "0")}</span>
                        {shot.shotSize ? <span className="mt-0.5 whitespace-nowrap">{shot.shotSize}</span> : null}
                    </div>
                )}
                {onInsertAfter ? (
                    <button
                        type="button"
                        tabIndex={-1}
                        aria-label={t("canvas.scriptStudio.insertAfter", { no: shot.no })}
                        title={t("canvas.scriptStudio.insertAfter", { no: shot.no })}
                        className="absolute inset-0 hidden items-center justify-center bg-background/70 text-foreground opacity-0 transition-opacity group-hover/thumb:flex group-hover/thumb:opacity-100"
                        onClick={(event) => {
                            event.stopPropagation();
                            onInsertAfter();
                        }}
                    >
                        <Plus className="size-4" aria-hidden />
                    </button>
                ) : null}
            </div>
            <div className="min-w-0 flex-1">
                <div data-testid="shot-desc" className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
                    {shot.descriptionRich.length ? inlineRich(shot.descriptionRich, nameOf) : shot.description || <span className="font-normal text-muted-foreground">{t("canvas.scriptStudio.descPending")}</span>}
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    {metaValues.map((m, i) => (
                        <span key={i} className="flex min-w-0 items-center gap-1.5">
                            {i > 0 ? <span className="flex-none text-stone-300 dark:text-stone-600">·</span> : null}
                            <span title={m.title} className={m.truncate ? "min-w-0 truncate" : "flex-none tabular-nums"}>
                                {m.v}
                            </span>
                        </span>
                    ))}
                    <span className="ml-auto flex flex-none items-center gap-1.5">
                        {shot.dialogue ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] leading-none text-foreground">
                                <Volume2 className="size-3" aria-hidden />
                                {t("canvas.scriptStudio.chipDialogue")}
                            </span>
                        ) : null}
                        {refCount > 0 ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                                <Check className="size-3" aria-hidden />
                                {t("canvas.scriptStudio.chipRefs", { count: refCount })}
                            </span>
                        ) : null}
                        {storyboardState === "generating" ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] leading-none text-warning">
                                <Loader2 className="size-3 animate-spin" aria-hidden />
                                {t("canvas.scriptStudio.chipStoryboardGenerating")}
                            </span>
                        ) : null}
                        {storyboardState === "error" ? (
                            <span className="inline-flex items-center rounded-full bg-danger/10 px-1.5 py-0.5 text-[10px] leading-none text-danger">
                                {t("canvas.scriptStudio.chipStoryboardError")}
                            </span>
                        ) : null}
                    </span>
                </div>
            </div>
        </div>
    );
}
