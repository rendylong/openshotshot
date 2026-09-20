import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Clapperboard, Film, History, Image as ImageIcon, Music2, PenLine, Play, RefreshCw, Sparkles } from "lucide-react";

import { composeFinalPrompt, composeStoryboardPrompt, deriveDescription, inlineEntityClasses, normalizeShotVideoVersions, stripDanglingAt } from "@/lib/canvas/script-node-model";
import { parseAssetTokenSegments, type AssetMentionCandidate } from "@/lib/canvas/asset-mentions";
import { isImeComposing } from "@/lib/keyboard-event";
import type { ScriptNodeData, ScriptShot, ShotAudioRef } from "@/types/script-node";
import type { CanvasNodeData } from "@/types/canvas";
import type { ScriptEntity } from "@/stores/use-script-entity-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { GROUP_ICON } from "./entity-drawer";
import { ShotAudioChip } from "./shot-audio-chip";
import { GenerateVideoDialog, type ShotVideoSettings } from "./generate-video-dialog";
import { buildPlaybackTimeline, isVideoNodeGenerating, useShotPlayback, type PlaybackItem, type StoryboardImageState } from "./shot-playback";
import { PlaybackControls, ShotStage, shotMeta } from "./shot-stage";
import { VideoLightbox } from "./video-lightbox";

export type { StoryboardImageState } from "./shot-playback";

type Props = {
    nodeId: string;
    script: ScriptNodeData;
    entities: ScriptEntity[];
    onUpdateScript: (updater: (data: ScriptNodeData) => ScriptNodeData) => void;
    onToast: (message: string) => void;
    /** 画布视频节点（按 shotVideoVersions 解析每镜版本；project.tsx 注入） */
    videoNodes?: CanvasNodeData[];
    /** 生成/重新生成当前镜头视频（project.tsx 注入） */
    onGenerateShotVideo?: (shotId: string, settings?: ShotVideoSettings) => void;
    /** 切换镜头当前视频版本（project.tsx 注入） */
    onSwitchShotVideo?: (shotId: string, nodeId: string) => void;
    /** 「我的素材」@ 菜单候选与 finalPrompt token chip 渲染来源（project.tsx 注入） */
    assetCandidates?: AssetMentionCandidate[];
    /** 分镜图先行（spec D1/D9）：开关关闭时本组件无任何分镜图元素 */
    storyboardFirst: boolean;
    storyboardImageState: Record<string, { state: StoryboardImageState; thumbUrl?: string }>;
    onGenerateStoryboard: (shotId: string) => void;
    onPickStoryboard?: (shotId: string, source: "canvas" | "library") => void;
    onBatchGenerateStoryboards: () => void;
};

export type ShotVideoView = {
    nodeId: string;
    no: number;
    node: CanvasNodeData;
};

/** 分镜图 caption 摘要（spec D7）：model 只显示 :: 后短名；空 imageGen 返回空串（不渲染）。 */
function imageGenSummaryText(script: ScriptNodeData): string {
    const gen = script.template?.imageGen;
    if (!gen) return "";
    const modelShort = gen.model?.includes("::") ? gen.model.slice(gen.model.indexOf("::") + 2) : gen.model;
    return [modelShort, gen.size, gen.quality, gen.background, gen.count ? `×${gen.count}` : ""].filter(Boolean).join(" · ");
}

/**
 * 第3步 合成提示词：左列播放舞台（单镜/连播共用同一条时间轴，spec D1/D2/D3——
 * 无视频镜头以分镜图静帧补位、连播不跳镜）+ 分镜画面条（点击跳镜续播）→
 * 右列固定唯一的提示词卡（‹ › 导航，内容随选中镜头切换，切换前自动保存编辑）。
 * 批量生成入口由外壳底栏统一提供，这里不重复放置。
 */
export function ComposeStep({ nodeId, script, entities, onUpdateScript, onToast, videoNodes = [], onGenerateShotVideo, onSwitchShotVideo, assetCandidates = [], storyboardFirst, storyboardImageState, onGenerateStoryboard, onPickStoryboard, onBatchGenerateStoryboards }: Props) {
    const { t } = useTranslation();
    const shots = script.output.shots;
    // 生成设置弹窗（spec D12）：null = 关闭；mode 由触发入口（有无版本）决定
    const [genDialog, setGenDialog] = useState<{ mode: "generate" | "regenerate" } | null>(null);
    // 全屏播放层（spec D8/D11）：打开时内联舞台 suppressVideo 让位，<video> 元素唯一持有权交给 lightbox
    const [fsOpen, setFsOpen] = useState(false);

    const videoNodeIds = useMemo(() => new Set(videoNodes.map((n) => n.id)), [videoNodes]);
    const videoNodeById = useMemo(() => new Map(videoNodes.map((n) => [n.id, n])), [videoNodes]);
    // 版本解析（spec D2/D8）：过滤已删节点（自愈）；legacy 画布无版本表时以 expandedShotNodes 合成只读视图
    const versionsByShotId = useMemo(() => {
        const map = new Map<string, ShotVideoView[]>();
        for (const [shotId, versions] of Object.entries(script.output.shotVideoVersions ?? {})) {
            const views = normalizeShotVideoVersions(versions, videoNodeIds)
                .map((version) => ({ ...version, node: videoNodeById.get(version.nodeId)! }))
                .filter((view) => Boolean(view.node));
            if (views.length) map.set(shotId, views);
        }
        for (const shot of shots) {
            if (map.has(shot.shotId)) continue;
            const legacyId = script.output.expandedShotNodes?.[shot.shotId];
            const legacyNode = legacyId ? videoNodeById.get(legacyId) : undefined;
            if (legacyNode) map.set(shot.shotId, [{ nodeId: legacyNode.id, no: 1, node: legacyNode }]);
        }
        return map;
    }, [script.output.shotVideoVersions, script.output.expandedShotNodes, videoNodeIds, videoNodeById, shots]);

    // 当前选中版本节点（时间轴取每镜 versions[0]）
    const currentVideoByShotId = useMemo(() => {
        const map = new Map<string, CanvasNodeData>();
        for (const [shotId, views] of versionsByShotId) if (views[0]) map.set(shotId, views[0].node);
        return map;
    }, [versionsByShotId]);

    // 播放时间轴与状态机（spec D1/D2/D3）：静帧/占位补位，连播不跳镜
    const timeline = useMemo(
        () => buildPlaybackTimeline({ shots, currentVideoByShotId, storyboardFirst, storyboardImageState }),
        [shots, currentVideoByShotId, storyboardFirst, storyboardImageState],
    );
    const playback = useShotPlayback({ timeline });
    const activeShot = useMemo(() => shots.find((s) => s.shotId === playback.shotId) ?? shots[0], [shots, playback.shotId]);
    const activeItem = playback.item;
    const activeViews = activeShot ? versionsByShotId.get(activeShot.shotId) ?? [] : [];
    const current = activeViews[0];
    const videoGenerating = current ? isVideoNodeGenerating(current.node) : false;
    const errorDetails = current?.node.metadata?.status === "error" ? current.node.metadata?.errorDetails : undefined;

    // 分镜图派生（spec D6/D9）：关闭模式一律 none/0，舞台/画格渲染层再闸一道（D9 双层防御）
    const sbEntry = storyboardFirst ? storyboardImageState[activeShot?.shotId ?? ""] : undefined;
    const sbState: StoryboardImageState = sbEntry?.state ?? "none";
    const sbThumbUrl = sbEntry?.thumbUrl;
    const sbPromptFallback = activeShot ? composeStoryboardPrompt(activeShot, entities, script.globalStyle) : "";
    const pendingStoryboardCount = storyboardFirst
        ? shots.filter((s) => { const v = storyboardImageState[s.shotId]?.state ?? "none"; return v !== "ready" && v !== "generating"; }).length
        : 0;

    // 可选的「优化提示词」：把全部分镜交给画布 Agent，按 shotshot-director 技能的 prompt-compiler 规范
    // 逐镜打磨 finalPrompt 并经 canvas_script_compile_prompts 回写。拼好的 prompt 本身即最终出货，
    // 质量主责在分镜写入时；此按钮只是用户可选的二次优化。
    const aiComposeAll = () => {
        useAgentStore.getState().submitPrompt(
            [
                `/shotshot-director 优化脚本节点提示词，目标节点 ${nodeId}。`,
                `请先用 canvas_get_state 读取该节点的全部分镜、实体与全局风格，然后按技能内 prompt-compiler 的出货规范为每镜打磨模型定制的 finalPrompt：`,
                `运镜全文唯一（不在正文复述头部参数）、声音用官方符号（音效<> / 音乐（）/ 台词{}）、结尾带约束段、资产名内联出现在描述句中、单一语言到底、不做与分镜氛围相悖的堆砌。`,
                `打磨完成后调用 canvas_script_compile_prompts 一次性回写全部镜头（nodeId=${nodeId}，逐条 {shotId, finalPrompt}）。`,
                `只回写 finalPrompt，绝不修改分镜其他字段；回写完成后汇报每镜一句话的优化要点。`,
            ].join("\n"),
        );
        onToast(t("canvas.scriptCompose.aiComposeQueued"));
    };
    // 分镜条滚动状态：驱动两端渐隐提示（有更多内容的一侧显示渐隐 + 细滚动条）
    const stripRef = useRef<HTMLDivElement | null>(null);
    const [stripEdges, setStripEdges] = useState({ left: false, right: false });

    const updateStripEdges = () => {
        const el = stripRef.current;
        if (!el) return;
        setStripEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
    };

    // 活动镜头变化时把对应卡片滚入视野（不居中，就近贴边）；顺带刷新边缘渐隐
    useEffect(() => {
        const el = stripRef.current;
        const shotId = activeShot?.shotId;
        if (!el || !shotId) return;
        const card = el.querySelector(`[data-frame-shot-id="${shotId}"]`) as HTMLElement | null;
        if (!card) return;
        if (card.offsetLeft < el.scrollLeft) {
            el.scrollTo({ left: card.offsetLeft - 10, behavior: "smooth" });
        } else if (card.offsetLeft + card.offsetWidth > el.scrollLeft + el.clientWidth) {
            el.scrollTo({ left: card.offsetLeft + card.offsetWidth - el.clientWidth + 10, behavior: "smooth" });
        }
        updateStripEdges();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeShot?.shotId, shots.length]);

    // 视口尺寸变化时刷新两端渐隐
    useEffect(() => {
        window.addEventListener("resize", updateStripEdges);
        return () => window.removeEventListener("resize", updateStripEdges);
    }, []);

    if (!shots.length) {
        return <div className="rounded-lg border border-dashed border-stone-300 px-4 py-8 text-center text-sm text-stone-500 dark:border-stone-700">{t("canvas.scriptCompose.emptyShots")}</div>;
    }

    return (
        <>
            <div className="flex flex-col gap-4 xl:flex-row xl:items-stretch">
                {/* 左列：播放舞台 + 分镜条（连播/单镜共用时间轴，spec D1/D2/D3） */}
                <div className="flex min-w-0 flex-1 flex-col gap-4">
                    <ShotStage
                        item={activeItem}
                        shot={activeShot}
                        entities={entities}
                        playing={playback.playing}
                        videoRef={playback.videoRef}
                        shotCount={shots.length}
                        suppressVideo={fsOpen}
                        onOpenFullscreen={() => setFsOpen(true)}
                        storyboardFirst={storyboardFirst}
                        sbState={sbState}
                        sbThumbUrl={sbThumbUrl}
                        videoGenerating={videoGenerating}
                        errorDetails={errorDetails}
                        replayEnded={playback.ended}
                        onReplay={playback.replay}
                        onGenerate={() => activeShot && setGenDialog({ mode: activeViews.length ? "regenerate" : "generate" })}
                        onGenerateStoryboard={() => activeShot && onGenerateStoryboard(activeShot.shotId)}
                        onRegenerateStoryboard={() => activeShot && onGenerateStoryboard(activeShot.shotId)}
                        onPickStoryboard={onPickStoryboard && ((source) => activeShot && onPickStoryboard(activeShot.shotId, source))}
                        onVideoPlay={playback.onVideoPlay}
                        onVideoEnded={playback.onVideoEnded}
                        onVideoTimeUpdate={playback.onVideoTimeUpdate}
                        onVideoDuration={playback.onVideoDuration}
                        controls={
                            <PlaybackControls
                                item={activeItem}
                                index={playback.index}
                                count={shots.length}
                                mode={playback.mode}
                                playing={playback.playing}
                                elapsed={playback.elapsed}
                                total={playback.total}
                                onToggle={playback.toggle}
                                onSeekRatio={playback.seekRatio}
                                onSetMode={playback.setMode}
                                onOpenFullscreen={() => setFsOpen(true)}
                                extra={
                                    activeViews.length > 0 && current ? (
                                        <VersionControl
                                            current={current}
                                            views={activeViews}
                                            generating={videoGenerating}
                                            canGenerate={Boolean(activeShot?.composed) && !videoGenerating}
                                            onSwitch={(nodeId) => activeShot && onSwitchShotVideo?.(activeShot.shotId, nodeId)}
                                            onGenerate={() => setGenDialog({ mode: "regenerate" })}
                                        />
                                    ) : null
                                }
                            />
                        }
                    />
                    {storyboardFirst && imageGenSummaryText(script) ? (
                        <div className="text-[11px] text-stone-400 dark:text-stone-500" title={t("canvas.scriptCompose.sbImageGenHint")}>
                            {t("canvas.scriptCompose.sbImageGenCaption", { params: imageGenSummaryText(script) })}
                        </div>
                    ) : null}
                    <section className="flex min-w-0 flex-col gap-2">
                        <div className="flex items-baseline gap-2 text-sm font-semibold">
                            <Film className="size-4 self-center text-stone-400" aria-hidden />
                            {t("canvas.scriptCompose.frameStrip")}
                            <span className="text-xs font-normal text-stone-500 dark:text-stone-400">{t("canvas.scriptCompose.frameStripHint")}</span>
                            <span className="ml-auto flex flex-none items-center gap-2">
                                <button type="button" className="rounded border border-stone-300 px-2 py-1 text-[11px] text-stone-600 transition-colors hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800"
                                    onClick={playback.startReel}>
                                    <Play className="mr-1 inline size-3" aria-hidden />
                                    {playback.playing && playback.mode === "seq" ? t("canvas.scriptCompose.reelPlaying") : t("canvas.scriptCompose.reelButton")}
                                </button>
                                {storyboardFirst && pendingStoryboardCount > 0 ? (
                                    <button type="button" className="rounded border border-stone-300 px-2 py-1 text-[11px] text-stone-600 transition-colors hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800"
                                        onClick={onBatchGenerateStoryboards}>
                                        {t("canvas.scriptCompose.sbBatchButton", { count: pendingStoryboardCount })}
                                    </button>
                                ) : null}
                            </span>
                        </div>
                        <div className="relative">
                            {/* 两端渐隐：向用户提示对应方向还有内容可滑 */}
                            <div
                                aria-hidden
                                className={`pointer-events-none absolute inset-y-0 -left-px z-10 w-8 rounded-l-lg bg-gradient-to-r from-stone-200 to-transparent transition-opacity dark:from-stone-900 ${stripEdges.left ? "opacity-100" : "opacity-0"}`}
                            />
                            <div
                                aria-hidden
                                className={`pointer-events-none absolute inset-y-0 -right-px z-10 w-8 rounded-r-lg bg-gradient-to-l from-stone-200 to-transparent transition-opacity dark:from-stone-900 ${stripEdges.right ? "opacity-100" : "opacity-0"}`}
                            />
                            <div ref={stripRef} className="thin-scrollbar flex gap-2.5 overflow-x-auto pb-2" onScroll={updateStripEdges}>
                                {shots.map((shot, i) => (
                                    <FrameCard key={shot.shotId} shot={shot} item={timeline[i]} views={versionsByShotId.get(shot.shotId) ?? []} entities={entities} active={shot.shotId === activeShot?.shotId} onClick={() => playback.selectShot(shot.shotId)} />
                                ))}
                            </div>
                        </div>
                    </section>
                </div>
                {/* 右列：镜头提示词卡（内含分镜图提示词折叠节，仅 storyboardFirst 时渲染，spec D16） */}
                <PromptColumn
                    shots={shots}
                    activeShot={activeShot}
                    entities={entities}
                    script={script}
                    storyboardFirst={storyboardFirst}
                    assetCandidates={assetCandidates}
                    onUpdateScript={onUpdateScript}
                    onStepShot={playback.step}
                    onOptimize={aiComposeAll}
                    title={t("canvas.scriptCompose.cardTitle")}
                    hint={t("canvas.scriptCompose.cardTitleHint")}
                    storyboardPromptFallback={sbPromptFallback}
                />
            </div>
            <VideoLightbox
                open={fsOpen}
                playback={playback}
                onClose={() => setFsOpen(false)}
                stageProps={{
                    item: activeItem,
                    shot: activeShot,
                    entities,
                    storyboardFirst,
                    sbState,
                    sbThumbUrl,
                    videoGenerating,
                    errorDetails,
                    shotCount: shots.length,
                    replayEnded: playback.ended,
                    onReplay: playback.replay,
                    onGenerateStoryboard: () => { setFsOpen(false); if (activeShot) onGenerateStoryboard(activeShot.shotId); },
                    onRegenerateStoryboard: () => { setFsOpen(false); if (activeShot) onGenerateStoryboard(activeShot.shotId); },
                    onPickStoryboard: onPickStoryboard && ((source) => { setFsOpen(false); if (activeShot) onPickStoryboard(activeShot.shotId, source); }),
                    // 全屏层内占位「生成视频」同样可用：先关全屏层，再按有无版本打开对应生成弹窗
                    onGenerate: () => { setFsOpen(false); if (activeShot) setGenDialog({ mode: activeViews.length ? "regenerate" : "generate" }); },
                }}
            />
            <GenerateVideoDialog
                open={Boolean(genDialog)}
                mode={genDialog?.mode ?? "generate"}
                shotNo={activeShot?.no ?? 0}
                versionNo={activeViews[0]?.no}
                node={activeViews[0]?.node}
                onCancel={() => setGenDialog(null)}
                onConfirm={(settings) => {
                    setGenDialog(null);
                    if (activeShot) onGenerateShotVideo?.(activeShot.shotId, settings);
                }}
            />
        </>
    );
}

/* ================= 控制条右侧：版本下拉 + 重新生成（spec D7；mock 已确认） ================= */

function VersionControl({ current, views, generating, canGenerate, onSwitch, onGenerate }: {
    current: ShotVideoView;
    views: ShotVideoView[];
    generating: boolean;
    canGenerate: boolean;
    onSwitch: (nodeId: string) => void;
    onGenerate: () => void;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    return (
        <div className="relative flex flex-none items-center gap-1.5">
            <button
                type="button"
                className="flex items-center gap-1.5 rounded-md border border-white/35 bg-black/35 px-2 py-1 text-xs text-stone-100 transition-colors hover:bg-black/50 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={generating}
                onClick={() => setOpen((value) => !value)}
            >
                <History className="size-3" aria-hidden />
                {t("canvas.scriptCompose.versionLabel", { no: current.no, count: views.length })}
                <ChevronDown className="size-3" aria-hidden />
            </button>
            <button
                type="button"
                className="flex items-center gap-1.5 rounded-md border border-white/40 bg-white/90 px-2.5 py-1 text-xs font-semibold text-stone-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!canGenerate}
                title={!canGenerate && !generating ? t("canvas.scriptCompose.confirmFirst") : undefined}
                onClick={onGenerate}
            >
                <RefreshCw className="size-3" aria-hidden />
                {generating ? t("canvas.scriptCompose.generatingVideo") : t("canvas.scriptCompose.regenerateVideo")}
            </button>
            {open ? (
                <>
                    <div className="fixed inset-0 z-20" aria-hidden onClick={() => setOpen(false)} />
                    <div className="absolute bottom-10 right-0 z-30 min-w-52 rounded-xl border border-white/10 bg-stone-900/95 p-1.5 shadow-xl backdrop-blur">
                        {views.map((view, index) => {
                            const viewGenerating = isVideoNodeGenerating(view.node);
                            const failed = view.node.metadata?.status === "error";
                            return (
                                <button
                                    key={view.nodeId}
                                    type="button"
                                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-stone-100 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                                    disabled={viewGenerating}
                                    onClick={() => { setOpen(false); if (index !== 0) onSwitch(view.nodeId); }}
                                >
                                    <span className={`size-1.5 flex-none rounded-full ${failed ? "bg-red-500" : viewGenerating ? "bg-amber-400" : "bg-emerald-500"}`} aria-hidden />
                                    <span>V{view.no}</span>
                                    <span className="text-stone-400">
                                        {viewGenerating ? t("canvas.scriptCompose.versionGenerating") : failed ? t("canvas.scriptCompose.versionFailed") : `${view.node.metadata?.seconds ?? "—"}s`}
                                    </span>
                                    {index === 0 ? <span className="ml-auto text-emerald-400">{t("canvas.scriptCompose.versionLatest")}</span> : null}
                                </button>
                            );
                        })}
                    </div>
                </>
            ) : null}
        </div>
    );
}

/* ================= 右列：提示词卡（标题行 + ShotPromptCard） ================= */

function PromptColumn({ shots, activeShot, entities, script, storyboardFirst, assetCandidates, onUpdateScript, onStepShot, onOptimize, title, hint, storyboardPromptFallback }: {
    shots: ScriptShot[];
    activeShot?: ScriptShot;
    entities: ScriptEntity[];
    script: ScriptNodeData;
    storyboardFirst: boolean;
    assetCandidates: AssetMentionCandidate[];
    onUpdateScript: Props["onUpdateScript"];
    onStepShot: (dir: -1 | 1) => void;
    onOptimize: () => void;
    title: string;
    hint: string;
    /** 分镜图提示词模板兜底（storyboardPrompt 为空时折叠节内展示） */
    storyboardPromptFallback: string;
}) {
    const { t } = useTranslation();
    return (
        <section className="flex w-full flex-none flex-col gap-2 xl:w-[430px]">
            <div className="flex items-baseline gap-2 text-sm font-semibold">
                <PenLine className="size-4 self-center text-stone-400" aria-hidden />
                {title}
                <span className="text-xs font-normal text-stone-500 dark:text-stone-400">{hint}</span>
                <button
                    type="button"
                    className="ml-auto flex flex-none items-center gap-1 self-center rounded border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={shots.length === 0}
                    title={t("canvas.scriptCompose.aiComposeAllHint")}
                    onClick={onOptimize}
                >
                    <Sparkles className="size-3" aria-hidden />
                    {t("canvas.scriptCompose.aiComposeAll")}
                </button>
            </div>
            {activeShot ? (
                <ShotPromptCard
                    key={activeShot.shotId}
                    shot={activeShot}
                    entities={entities}
                    globalStyle={script.globalStyle}
                    storyboardFirst={storyboardFirst}
                    assetCandidates={assetCandidates}
                    onUpdateScript={onUpdateScript}
                    onStepShot={onStepShot}
                    shotIndex={shots.findIndex((s) => s.shotId === activeShot.shotId)}
                    shotTotal={shots.length}
                    storyboardPromptFallback={storyboardPromptFallback}
                />
            ) : null}
        </section>
    );
}

/* ================= 中部：分镜画面条（缩略随时间轴：视频 > 分镜图静帧 > glyph） ================= */

function FrameCard({ shot, item, views, entities, active, onClick }: { shot: ScriptShot; item: PlaybackItem; views: ShotVideoView[]; entities: ScriptEntity[]; active: boolean; onClick: () => void }) {
    const { t } = useTranslation();
    const readyIds = new Set(entities.filter((e) => e.refs.some((r) => r.state === "ready")).map((e) => e.id));
    const Glyph = shot.composed ? Clapperboard : shot.entityRefs.length && shot.entityRefs.every((id) => readyIds.has(id)) ? Film : ImageIcon;
    const current = views[0];
    const generating = current ? isVideoNodeGenerating(current.node) : item.degraded === "generating";
    const failed = current?.node.metadata?.status === "error" || item.degraded === "error";

    return (
        <button
            type="button"
            data-frame-shot-id={shot.shotId}
            className={`group/frame relative w-[148px] flex-none rounded-lg border p-1.5 text-left transition-colors xl:w-[170px] ${
                active ? "border-stone-500 shadow-[0_0_0_1px_rgba(128,128,128,0.35)] dark:border-stone-300" : "border-stone-200 hover:border-stone-400 dark:border-stone-800 dark:hover:border-stone-600"
            }`}
            onClick={onClick}
        >
            <div className="relative mb-1 flex aspect-video items-center justify-center overflow-hidden rounded-md bg-stone-900 text-stone-500">
                {item.kind === "still" && item.stillUrl ? (
                    <img src={item.stillUrl} alt="" className="absolute inset-0 size-full object-cover" />
                ) : item.kind === "video" && item.url ? (
                    <video src={item.url} muted preload="metadata" className="absolute inset-0 size-full object-cover" />
                ) : (
                    <Glyph className="size-4.5" aria-hidden />
                )}
                {item.kind === "still" ? <span className="absolute bottom-1 left-1.5 z-10 rounded bg-violet-500/85 px-1 text-[9px] font-bold text-violet-950">{t("canvas.scriptCompose.sbBadge")}</span> : null}
                {generating && item.kind !== "video" ? <span className="absolute size-4 animate-spin rounded-full border-2 border-white/25 border-t-white" aria-hidden /> : null}
                <span className="absolute left-2.5 top-2 z-10 rounded bg-black/60 px-1.5 text-[11px] text-stone-100">{shot.no}</span>
                <span className={`absolute right-2.5 top-2 z-10 rounded bg-black/60 px-1.5 text-[10px] ${failed ? "text-red-400" : generating ? "text-amber-300" : shot.composed ? "text-emerald-400" : "text-stone-300"}`}>
                    {failed ? t("canvas.scriptCompose.versionFailed") : generating ? t("canvas.scriptCompose.versionGenerating") : shot.composed ? "✓" : t("canvas.scriptCompose.draftState")}
                </span>
                <span className="absolute inset-x-1.5 bottom-1 flex flex-wrap gap-1">
                    {[shot.shotSize, shot.movement, shot.duration > 0 ? `${shot.duration}s` : "", shot.mood].filter(Boolean).map((label) => (
                        <span key={label} className="rounded bg-black/70 px-1 text-[11px] leading-4 text-stone-200">{label}</span>
                    ))}
                </span>
            </div>
            <div className="flex min-h-5 gap-1">
                {shot.entityRefs.length ? (
                    shot.entityRefs.map((id) => {
                        const entity = entities.find((e) => e.id === id);
                        const ChipIcon = GROUP_ICON[entity?.group ?? "character"];
                        return (
                            <span
                                key={id}
                                title={`${entity?.name ?? id}${readyIds.has(id) ? " · ✓" : " · ⚠"}`}
                                className={`flex size-5 items-center justify-center rounded border ${inlineEntityClasses(entity?.group ?? "character")}`}
                            >
                                <ChipIcon className="size-3" />
                            </span>
                        );
                    })
                ) : (
                    <span className="rounded border border-stone-300 bg-background px-1 text-[11px] leading-4 text-stone-400 dark:border-stone-700">{t("canvas.scriptAssets.noSource")}</span>
                )}
                {shot.sfxAudio ? (
                    <span title={`${t("canvas.scriptStudio.chipLabelSfx")}：${shot.sfxAudio.name}`} className="flex size-5 flex-none items-center justify-center rounded border border-stone-300 bg-background text-stone-400 dark:border-stone-700">
                        <Music2 className="size-3" aria-hidden />
                    </span>
                ) : null}
                {shot.dialogueAudio ? (
                    <span title={`${t("canvas.scriptStudio.chipLabelDialogue")}：${shot.dialogueAudio.name}`} className="flex size-5 flex-none items-center justify-center rounded border border-stone-300 bg-background text-stone-400 dark:border-stone-700">
                        <Music2 className="size-3" aria-hidden />
                    </span>
                ) : null}
            </div>
            <div className="mt-1 line-clamp-1 text-[11px] leading-snug text-stone-400 xl:line-clamp-2" title={stripDanglingAt(deriveDescription(shot.descriptionRich, () => undefined) || shot.description) || "—"}>
                {stripDanglingAt(deriveDescription(shot.descriptionRich, () => undefined) || shot.description) || "—"}
            </div>
        </button>
    );
}

/* ================= 底部：固定提示词卡（唯一，内容随镜头切换） ================= */

function ShotPromptCard({
    shot,
    entities,
    globalStyle,
    storyboardFirst,
    storyboardPromptFallback,
    assetCandidates,
    onUpdateScript,
    onStepShot,
    shotIndex,
    shotTotal,
}: {
    shot: ScriptShot;
    entities: ScriptEntity[];
    globalStyle: string;
    storyboardFirst: boolean;
    /** storyboardPrompt 为空时折叠节内展示的模板兜底文案 */
    storyboardPromptFallback: string;
    assetCandidates: AssetMentionCandidate[];
    onUpdateScript: Props["onUpdateScript"];
    onStepShot: (dir: -1 | 1) => void;
    shotIndex: number;
    shotTotal: number;
}) {
    const { t } = useTranslation();
    const blockRef = useRef<HTMLDivElement | null>(null);
    // 回显守卫：仅外部 finalPrompt 变化（重新合成 / Agent 回写 / 切镜）或候选刷新重建 DOM；自身输入的落库回声不重建
    const lastEmittedRef = useRef(shot.finalPrompt ?? "");
    const syncedSigRef = useRef<{ assets: Map<string, AssetMentionCandidate>; label: string } | null>(null);
    const assetById = useMemo(() => new Map(assetCandidates.map((item) => [item.assetId, item])), [assetCandidates]);
    const unknownLabel = t("canvas.composer.assetUnknown");
    const [mention, setMention] = useState<{ query: string } | null>(null);
    const [mentionIndex, setMentionIndex] = useState(0);
    const menuCandidates = useMemo(() => {
        if (!mention) return [];
        const query = mention.query.trim().toLowerCase();
        return assetCandidates.filter((item) => !query || item.title.toLowerCase().includes(query));
    }, [mention, assetCandidates]);

    // 草稿且无 finalPrompt 时按当前数据合成一次并落库（保证「重新合成」文案与状态一致）；已确认的不覆盖用户编辑。
    useLayoutEffect(() => {
        if (blockRef.current && !shot.composed && !shot.finalPrompt) {
            const text = composeFinalPrompt(shot, entities, globalStyle, { storyboardFirst });
            renderFinalPrompt(blockRef.current, text, assetById, unknownLabel);
            lastEmittedRef.current = text;
            syncedSigRef.current = { assets: assetById, label: unknownLabel };
            saveDraft(text);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shot.shotId]);

    useLayoutEffect(() => {
        const editor = blockRef.current;
        if (!editor) return;
        // 草稿首帧合成刚写入 DOM：等待落库回声，不用旧 props 清空
        if (!shot.finalPrompt && lastEmittedRef.current) return;
        const next = shot.finalPrompt ?? "";
        const synced = syncedSigRef.current;
        if (next === lastEmittedRef.current && synced && synced.assets === assetById && synced.label === unknownLabel) return;
        renderFinalPrompt(editor, next, assetById, unknownLabel);
        lastEmittedRef.current = next;
        syncedSigRef.current = { assets: assetById, label: unknownLabel };
    }, [shot.finalPrompt, assetById, unknownLabel]);

    const saveDraft = (text: string) => {
        onUpdateScript((data) => ({
            ...data,
            output: { ...data.output, shots: data.output.shots.map((s) => (s.shotId === shot.shotId ? { ...s, finalPrompt: text } : s)) },
        }));
    };

    const syncMention = () => {
        const selection = window.getSelection();
        if (!selection?.rangeCount) return setMention(null);
        const range = selection.getRangeAt(0);
        if (range.startContainer.nodeType !== Node.TEXT_NODE) return setMention(null);
        const match = /@([^\s@]*)$/.exec((range.startContainer.textContent || "").slice(0, range.startOffset));
        if (!match) return setMention(null);
        setMention({ query: match[1] });
        setMentionIndex(0);
    };

    const removeActiveMentionText = () => {
        const selection = window.getSelection();
        if (!selection?.rangeCount) return;
        const range = selection.getRangeAt(0);
        const match = /@([^\s@]*)$/.exec((range.startContainer.textContent || "").slice(0, range.startOffset));
        if (!match) return;
        range.setStart(range.startContainer, Math.max(0, range.startOffset - (match[1] || "").length - 1));
        range.deleteContents();
    };

    const insertAsset = (candidate: AssetMentionCandidate) => {
        const editor = blockRef.current;
        if (!editor) return;
        removeActiveMentionText();
        const chip = createFinalPromptAssetChip(candidate.assetId, assetById.get(candidate.assetId), unknownLabel);
        const space = document.createTextNode(" ");
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (range) {
            range.insertNode(space);
            range.insertNode(chip);
            range.setStartAfter(space);
            range.collapse(true);
            selection?.removeAllRanges();
            selection?.addRange(range);
        } else {
            editor.append(chip, space);
        }
        const next = serializeFinalPrompt(editor);
        lastEmittedRef.current = next;
        saveDraft(next);
        setMention(null);
    };

    const byId = new Map(entities.map((e) => [e.id, e]));

    return (
        <div className="flex flex-1 flex-col rounded-lg border border-stone-200 bg-card p-3.5 dark:border-stone-800">
            <div className="mb-2 flex items-center gap-2.5">
                <span className="flex size-6 flex-none items-center justify-center rounded-md bg-stone-200 text-xs font-bold text-stone-700 dark:bg-stone-700 dark:text-stone-100">{shot.no}</span>
                <span className="truncate text-xs text-stone-400">{shotMeta(shot)}</span>
                <span className={`ml-auto flex-none text-xs ${shot.composed ? "text-emerald-600" : "text-stone-400"}`}>
                    {shot.composed ? t("canvas.scriptCompose.composedState") : t("canvas.scriptCompose.draftState")}
                </span>
            </div>
            <div className="mb-2.5 flex items-center justify-end gap-1.5">
                <button
                    type="button"
                    className="flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-xs text-stone-600 transition-colors hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800"
                    onClick={() =>
                        onUpdateScript((data) => ({
                            ...data,
                            output: {
                                ...data.output,
                                shots: data.output.shots.map((s) => (s.shotId === shot.shotId ? { ...s, finalPrompt: composeFinalPrompt(s, entities, globalStyle, { storyboardFirst }), composed: false } : s)),
                            },
                        }))
                    }
                >
                    <RefreshCw className="size-3" aria-hidden />
                    {t("canvas.scriptCompose.recompose")}
                </button>
                <button
                    type="button"
                    className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition-opacity ${
                        shot.composed
                            ? "border border-stone-300 text-stone-600 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800"
                            : "bg-foreground text-background hover:opacity-90"
                    }`}
                    onClick={() => {
                        const text = blockRef.current ? serializeFinalPrompt(blockRef.current) : shot.finalPrompt ?? "";
                        onUpdateScript((data) => ({
                            ...data,
                            output: { ...data.output, shots: data.output.shots.map((s) => (s.shotId === shot.shotId ? { ...s, finalPrompt: text, composed: !s.composed } : s)) },
                        }));
                    }}
                >
                    {shot.composed ? null : <Check className="size-3" aria-hidden />}
                    {shot.composed ? t("canvas.scriptCompose.unconfirm") : t("canvas.scriptCompose.confirm")}
                </button>
                <span className="mx-1 flex items-center gap-1">
                    <button
                        type="button"
                        aria-label={t("canvas.scriptCompose.prevShot")}
                        className="flex size-6 items-center justify-center rounded border border-stone-300 text-stone-500 transition-colors hover:text-foreground disabled:opacity-30 dark:border-stone-700"
                        disabled={shotIndex <= 0}
                        onClick={() => onStepShot(-1)}
                    >
                        <ChevronLeft className="size-3.5" />
                    </button>
                    <span className="text-[11px] tabular-nums text-stone-400">{shotIndex + 1}/{shotTotal}</span>
                    {shot.composed && shotIndex < shotTotal - 1 ? (
                        // 已确认 → 推进是主操作：带文字的主按钮
                        <button
                            type="button"
                            className="ml-1 flex items-center gap-0.5 rounded bg-foreground px-2.5 py-1 text-xs font-medium text-background transition-opacity hover:opacity-90"
                            onClick={() => onStepShot(1)}
                        >
                            {t("canvas.scriptCompose.nextShotLabel")}
                            <ChevronRight className="size-3.5" />
                        </button>
                    ) : (
                        <button
                            type="button"
                            aria-label={t("canvas.scriptCompose.nextShot")}
                            className="flex size-6 items-center justify-center rounded border border-stone-300 text-stone-500 transition-colors hover:text-foreground disabled:opacity-30 dark:border-stone-700"
                            disabled={shotIndex >= shotTotal - 1}
                            onClick={() => onStepShot(1)}
                        >
                            <ChevronRight className="size-3.5" />
                        </button>
                    )}
                </span>
            </div>
            <div className="mb-2 flex flex-wrap gap-1.5 text-[11px]">
                {shot.entityRefs.length ? (
                    <>
                        {shot.entityRefs.map((id) => {
                            const entity = byId.get(id);
                            return entity ? (
                                <span key={id} className={`flex items-center gap-1 rounded border px-1.5 py-0.5 ${inlineEntityClasses(entity.group)}`}>
                                    {(() => {
                                        const ChipIcon = GROUP_ICON[entity.group];
                                        return <ChipIcon className="size-3" aria-hidden />;
                                    })()}
                                    {entity.name}
                                    {entity.refs.some((r) => r.state === "ready") ? "" : <span className="text-stone-400 dark:text-stone-500"> ⚠</span>}
                                </span>
                            ) : null;
                        })}
                        <span className="self-center text-stone-500 dark:text-stone-400">— {t("canvas.scriptCompose.refsNote")}</span>
                    </>
                ) : (
                    <span className="text-stone-400">{t("canvas.scriptCompose.noRefs")}</span>
                )}
            </div>
            {shot.sfxAudio || shot.dialogueAudio ? (
                <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                    {shot.sfxAudio ? <AudioChipLabeled label={t("canvas.scriptStudio.chipLabelSfx")} audio={shot.sfxAudio} /> : null}
                    {shot.dialogueAudio ? <AudioChipLabeled label={t("canvas.scriptStudio.chipLabelDialogue")} audio={shot.dialogueAudio} /> : null}
                </div>
            ) : null}
            {/* 分镜图提示词折叠节（spec D9/D16）：仅 storyboardFirst 渲染；写回 storyboardPrompt 不翻转 composed */}
            {storyboardFirst ? (
                <details className="mb-2.5">
                    <summary className="cursor-pointer list-none rounded border border-stone-200 px-2 py-1.5 text-[11.5px] text-stone-500 dark:border-stone-700 dark:text-stone-400">
                        {t("canvas.scriptCompose.sbPromptTitle")}
                    </summary>
                    <textarea
                        className="mt-2 w-full rounded-md border border-stone-200 bg-stone-50 p-2 text-[11.5px] leading-relaxed text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200"
                        rows={5}
                        value={shot.storyboardPrompt ?? storyboardPromptFallback}
                        onChange={(e) => {
                            const value = e.target.value;
                            onUpdateScript((data) => ({ ...data, output: { ...data.output, shots: data.output.shots.map((s) => (s.shotId === shot.shotId ? { ...s, storyboardPrompt: value } : s)) } }));
                        }}
                    />
                </details>
            ) : null}
            <div className="relative flex min-h-0 flex-1 flex-col rounded-md border border-transparent bg-stone-100/40 p-1 transition-colors hover:border-stone-300 focus-within:border-stone-400 dark:bg-stone-900/40 dark:hover:border-stone-600 dark:focus-within:border-stone-500">
                <div
                    ref={blockRef}
                    className="rich-desc prompt-block flex-1 whitespace-pre-wrap text-sm"
                    contentEditable
                    suppressContentEditableWarning
                    onInput={(event) => {
                        const editor = event.target as HTMLElement;
                        const next = serializeFinalPrompt(editor);
                        lastEmittedRef.current = next;
                        saveDraft(next);
                        syncMention();
                    }}
                    onKeyDown={(event) => {
                        if (isImeComposing(event)) return;
                        if (mention && menuCandidates.length) {
                            if (event.key === "ArrowDown") { event.preventDefault(); setMentionIndex((index) => (index + 1) % menuCandidates.length); return; }
                            if (event.key === "ArrowUp") { event.preventDefault(); setMentionIndex((index) => (index - 1 + menuCandidates.length) % menuCandidates.length); return; }
                            if (event.key === "Enter") { event.preventDefault(); insertAsset(menuCandidates[Math.min(mentionIndex, menuCandidates.length - 1)]); return; }
                            if (event.key === "Escape") { event.preventDefault(); setMention(null); return; }
                        }
                        requestAnimationFrame(syncMention);
                    }}
                    onBlur={() => window.setTimeout(() => setMention(null), 120)}
                />
                {mention && menuCandidates.length ? (
                    <div className="absolute bottom-full left-2 z-20 mb-1 max-h-48 w-64 overflow-y-auto rounded-lg border border-stone-200 bg-card p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900">
                        {menuCandidates.map((candidate, index) => (
                            <button
                                key={candidate.assetId}
                                type="button"
                                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${index === Math.min(mentionIndex, menuCandidates.length - 1) ? "bg-stone-200 dark:bg-stone-700" : ""}`}
                                onMouseDown={(mouseEvent) => { mouseEvent.preventDefault(); insertAsset(candidate); }}
                            >
                                {candidate.coverUrl ? <img src={candidate.coverUrl} alt="" className="size-7 rounded object-cover" /> : <span className="grid size-7 place-items-center rounded bg-stone-200 dark:bg-stone-700"><ImageIcon className="size-3.5" /></span>}
                                <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                                <span className="flex-none text-[10px] text-stone-400">{t(candidate.kind === "video" ? "canvas.composer.assetTag.video" : "canvas.composer.assetTag.image")}</span>
                            </button>
                        ))}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

/** 右栏只读音频 chip：前置槽位标签（音效/台词），可试听、不可移除（移除回第 1 步，spec D19）。 */
function AudioChipLabeled({ label, audio }: { label: string; audio: ShotAudioRef }) {
    const { t } = useTranslation();
    return (
        <span className="flex items-center gap-1">
            <span className="flex-none text-stone-400">{label}</span>
            <span className="w-44">
                <ShotAudioChip
                    audio={audio}
                    className="w-full"
                    labels={{
                        play: t("canvas.scriptStudio.audioPlay", { name: audio.name }),
                        pause: t("canvas.scriptStudio.audioPause", { name: audio.name }),
                        invalid: t("canvas.scriptStudio.audioInvalid"),
                    }}
                />
            </span>
        </span>
    );
}

/* ================= finalPrompt 多行 chip 编辑器的 DOM helper（contentEditable 直操作，React 不接管其子树） ================= */

function renderFinalPrompt(editor: HTMLElement, value: string, assetById: Map<string, AssetMentionCandidate>, unknownLabel: string) {
    editor.textContent = "";
    for (const segment of parseAssetTokenSegments(value)) {
        if (segment.type === "text") {
            editor.appendChild(document.createTextNode(segment.value));
            continue;
        }
        editor.appendChild(createFinalPromptAssetChip(segment.assetId, assetById.get(segment.assetId), unknownLabel));
    }
}

/** 多行序列化：文本节点 + 资产 chip（→ token）+ 换行（BR → \n，顶层 DIV 边界 → \n）。 */
function serializeFinalPrompt(editor: HTMLElement): string {
    let out = "";
    editor.childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) { out += node.textContent || ""; return; }
        if (!(node instanceof HTMLElement)) return;
        const assetId = node.dataset.assetId;
        if (assetId) { out += `@[asset:${assetId}]`; return; }
        if (node.tagName === "BR") { out += "\n"; return; }
        out += serializeFinalPrompt(node);
        if (node.tagName === "DIV" && editor.lastChild !== node) out += "\n";
    });
    // contentEditable 兼容性插入的零宽字符（U+FEFF）不进入存储
    return out.replace(/\uFEFF/g, "");
}

function createFinalPromptAssetChip(assetId: string, candidate: AssetMentionCandidate | undefined, unknownLabel: string): HTMLSpanElement {
    const chip = document.createElement("span");
    chip.contentEditable = "false";
    chip.dataset.assetId = assetId;
    chip.title = candidate?.title || unknownLabel;
    chip.className = "mx-px inline-flex h-6 max-w-44 items-center gap-1 overflow-hidden rounded-md border border-stone-300 bg-stone-100 px-1 align-middle text-xs leading-none dark:border-stone-600 dark:bg-stone-800";
    if (!candidate) {
        chip.classList.add("border-dashed", "opacity-70");
        const text = document.createElement("span");
        text.className = "block truncate";
        text.textContent = unknownLabel;
        chip.appendChild(text);
        return chip;
    }
    if (candidate.coverUrl) {
        const img = document.createElement("img");
        img.src = candidate.coverUrl;
        img.alt = candidate.title;
        img.className = "size-5 rounded-sm object-cover";
        chip.appendChild(img);
    }
    const text = document.createElement("span");
    text.className = "block truncate";
    text.textContent = candidate.title;
    chip.appendChild(text);
    return chip;
}
