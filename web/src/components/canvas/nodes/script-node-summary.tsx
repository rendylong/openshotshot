import { useTranslation } from "react-i18next";
import { Clapperboard, Loader2 } from "lucide-react";

import type { ScriptNodeSummary } from "@/lib/canvas/script-node-model";

type Props = {
    title: string;
    summary: ScriptNodeSummary;
    /** shotId -> 已水合分镜缩略 URL（调用方从画布节点 metadata.content 收集） */
    storyboardThumbs: Record<string, string>;
    /** 语义缩放（spec D3）：画布 scale < 0.75 时隐藏微文案，只留标题/状态/大数字/胶片带/进度线 */
    compact?: boolean;
};

/** 脚本节点卡身 = 场记板摘要（spec D1-D4）：看状态、识别进度；编辑在 Script Studio。 */
export function ScriptNodeSummaryCard({ title, summary, storyboardThumbs, compact = false }: Props) {
    const { t } = useTranslation();
    const generating = summary.status === "generating";
    const error = summary.status === "error";
    const empty = summary.shotCount === 0;

    return (
        <div className="flex h-full flex-col gap-2 p-3.5 text-stone-800 dark:text-stone-100">
            <div className="flex flex-none items-center gap-1.5">
                <Clapperboard className="size-3.5 flex-none text-stone-500 dark:text-stone-400" aria-hidden />
                <span className="min-w-0 truncate text-xs font-semibold">{title}</span>
                {error ? (
                    <span className="ml-auto flex flex-none items-center gap-1 text-[10px] text-danger">
                        <span className="size-[5px] rounded-full bg-danger" aria-hidden />
                        {t("canvas.scriptNode.statusError")}
                    </span>
                ) : generating ? (
                    <span className="ml-auto flex flex-none items-center gap-1 text-[10px] text-stone-500 dark:text-stone-400">
                        <Loader2 className="size-3 animate-spin" aria-hidden />
                        {t("canvas.scriptNode.statusGenerating")}
                    </span>
                ) : !empty ? (
                    <span className="ml-auto flex flex-none items-center gap-1 text-[10px] text-stone-500 dark:text-stone-400">
                        <span className="size-[5px] rounded-full bg-success" aria-hidden />
                        {t("canvas.scriptNode.statusReady")}
                    </span>
                ) : null}
            </div>

            {empty && !generating && !error ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-1.5 text-center">
                    <Clapperboard className="size-8 text-stone-300 dark:text-stone-600" aria-hidden />
                    <div className="text-xs font-medium">{t("canvas.scriptNode.emptyTitle")}</div>
                    <div className="text-[10px] text-stone-400 dark:text-stone-500">{t("canvas.scriptNode.emptyHint")}</div>
                </div>
            ) : (
                <>
                    <div className="flex flex-none items-baseline gap-4">
                        <span className="flex items-baseline gap-1.5">
                            <span className="text-xl font-semibold leading-none tabular-nums">{summary.shotCount}</span>
                            <span className="text-[10px] text-stone-500 dark:text-stone-400">
                                {generating ? t("canvas.scriptNode.unitShotsWritten") : t("canvas.scriptNode.unitShots")}
                            </span>
                        </span>
                        {!generating && !error ? (
                            <>
                                <span className="h-4 w-px flex-none bg-stone-200 dark:bg-stone-700" aria-hidden />
                                <span className="flex items-baseline gap-1.5">
                                    <span className="text-xl font-semibold leading-none tabular-nums">{summary.totalDuration}</span>
                                    <span className="text-[10px] text-stone-500 dark:text-stone-400">{t("canvas.scriptNode.unitSeconds")}</span>
                                </span>
                            </>
                        ) : null}
                    </div>

                    {error ? (
                        <div className="line-clamp-2 text-[11px] leading-relaxed text-danger">{summary.errorMessage}</div>
                    ) : (
                        <>
                            {compact ? null : (
                                <div className="flex flex-none gap-3 text-[10px] tabular-nums text-stone-500 dark:text-stone-400">
                                    <span>{t("canvas.scriptNode.assetsMeta", { ready: summary.assetsReady, total: summary.assetsTotal })}</span>
                                    <span>{t("canvas.scriptNode.promptsMeta", { done: summary.promptsComposed, total: summary.shotCount })}</span>
                                </div>
                            )}
                            <div className="flex flex-none gap-1.5" aria-hidden>
                                {summary.frames.map((frame) => {
                                    const thumb = storyboardThumbs[frame.shotId];
                                    return (
                                        <div key={frame.shotId} className="relative h-9 min-w-11 flex-1 overflow-hidden rounded-md">
                                            {frame.hasStoryboard && thumb ? (
                                                <img src={thumb} alt="" className="h-full w-full object-cover" draggable={false} />
                                            ) : (
                                                <div className="flex h-full flex-col items-center justify-center border border-dashed border-stone-300 dark:border-stone-600">
                                                    <span className="text-[10px] font-semibold leading-none tabular-nums text-stone-500 dark:text-stone-400">
                                                        {String(frame.no).padStart(2, "0")}
                                                    </span>
                                                    {frame.shotSize ? (
                                                        <span className="mt-0.5 whitespace-nowrap text-[10px] leading-none text-stone-400 dark:text-stone-500">{frame.shotSize}</span>
                                                    ) : null}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                                {generating
                                    ? Array.from({ length: Math.min(2, Math.max(1, 4 - summary.frames.length)) }).map((_, i) => (
                                          <div
                                              key={i}
                                              className="h-9 min-w-0 flex-1 animate-pulse rounded-md border border-dashed border-stone-300 bg-stone-100 dark:border-stone-600 dark:bg-stone-800"
                                          />
                                      ))
                                    : null}
                                {summary.extraCount > 0 ? (
                                    <div className="flex h-9 flex-none items-center justify-center text-[10px] tabular-nums text-stone-400 dark:text-stone-500">
                                        +{summary.extraCount}
                                    </div>
                                ) : null}
                            </div>
                        </>
                    )}

                    <div className="mt-auto flex flex-none items-center gap-2">
                        <div className="h-[3px] flex-1 overflow-hidden rounded-sm border border-stone-200 bg-stone-100 dark:border-stone-700 dark:bg-stone-800">
                            <div
                                className={`h-full rounded-sm bg-foreground ${summary.progress < 0 ? "w-full animate-pulse" : ""}`}
                                style={summary.progress < 0 ? undefined : { width: `${Math.round(summary.progress * 100)}%` }}
                            />
                        </div>
                        {!generating && !empty && !error ? (
                            <span className="flex-none text-[10px] tabular-nums text-stone-400 dark:text-stone-500">
                                {Math.round(summary.progress * 100)}%
                            </span>
                        ) : null}
                    </div>
                    {compact ? null : (
                        <div className="flex-none text-center text-[10px] text-stone-400 dark:text-stone-500">
                            {error ? t("canvas.scriptNode.errorHint") : t("canvas.scriptNode.openHint")}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
