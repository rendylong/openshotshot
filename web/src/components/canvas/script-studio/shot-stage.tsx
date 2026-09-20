import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Clapperboard, Film, Image as ImageIcon, Maximize, Pause, Play, RefreshCw, RotateCcw, Sparkles } from "lucide-react";

import { Spinner } from "@/components/ui/spinner";
import type { ScriptEntity } from "@/stores/use-script-entity-store";
import type { ScriptShot } from "@/types/script-node";
import type { PlaybackItem, PlaybackMode, StoryboardImageState } from "./shot-playback";

/** 展示用元信息串：空字段跳过（时长 0 = 未设置不产 "0s"），全空显示 —（与提示词卡/画格共用）。 */
export function shotMeta(shot: ScriptShot): string {
    return [shot.shotSize, shot.angle, shot.movement, shot.duration > 0 ? `${shot.duration}s` : "", shot.mood].filter(Boolean).join(" · ") || "—";
}

const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

type ShotStageProps = {
    item?: PlaybackItem;
    shot?: ScriptShot;
    entities: ScriptEntity[];
    playing: boolean;
    /** 全屏层打开时内联舞台让位：不渲染真实 <video>，避免两个元素抢同一个 ref */
    suppressVideo?: boolean;
    videoRef?: RefObject<HTMLVideoElement | null>;
    storyboardFirst: boolean;
    sbState: StoryboardImageState;
    sbThumbUrl?: string;
    videoGenerating: boolean;
    errorDetails?: string;
    replayEnded?: boolean;
    onReplay?: () => void;
    onGenerate?: () => void;
    onGenerateStoryboard?: () => void;
    onRegenerateStoryboard?: () => void;
    onPickStoryboard?: (source: "canvas" | "library") => void;
    /** 双击画面 / 控制条按钮进入全屏 */
    onOpenFullscreen?: () => void;
    onVideoPlay?: () => void;
    onVideoEnded?: () => void;
    onVideoTimeUpdate?: (seconds: number) => void;
    onVideoDuration?: (seconds: number) => void;
    variant?: "inline" | "fullscreen";
    /** 镜头总数（全屏层传入，舞台本身暂不使用） */
    shotCount?: number;
    /** 控制条（内联与全屏注入不同密度） */
    controls?: ReactNode;
};

/**
 * 预览舞台（spec D13）：无视频时分镜图满幅作为首帧；连播静帧复用同一渲染路径。
 * 只负责画面与覆盖层，控制条由调用方经 controls 注入。
 */
export function ShotStage({
    item, shot, entities, playing, suppressVideo, videoRef, storyboardFirst, sbState, sbThumbUrl,
    videoGenerating, errorDetails, replayEnded, onReplay, onGenerate, onGenerateStoryboard, onRegenerateStoryboard, onPickStoryboard,
    onOpenFullscreen, onVideoPlay, onVideoEnded, onVideoTimeUpdate, onVideoDuration, variant = "inline", controls,
}: ShotStageProps) {
    const { t } = useTranslation();
    // 视频/分镜图静帧加载失败：隐藏坏元素，避免 broken-image 图标盖在舞台上；URL 变化后重置以便重试
    const [mediaFailed, setMediaFailed] = useState(false);
    useEffect(() => { setMediaFailed(false); }, [item?.url, item?.stillUrl]);
    const kind = item?.kind;
    const showVideo = kind === "video" && !suppressVideo && Boolean(item?.url) && !mediaFailed;
    const showStill = kind === "still" && Boolean(item?.stillUrl) && !mediaFailed;
    const Glyph = shot?.composed ? Clapperboard : shot?.entityRefs.length && entities.length ? Film : ImageIcon;
    const sbReady = storyboardFirst && sbState === "ready" && Boolean(sbThumbUrl);
    const hasMedia = showVideo || showStill;
    const sbBusy = storyboardFirst && sbState === "generating";
    const sbEmpty = storyboardFirst && !hasMedia && sbState === "none";
    const sbError = storyboardFirst && !hasMedia && sbState === "error";
    const showVideoStatus = !hasMedia && !sbBusy && !sbEmpty && !sbError;
    const actionClass = "inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent";
    const sourceActions = storyboardFirst && !sbBusy && onPickStoryboard ? (["canvas", "library"] as const).map((source) => (
        <button key={source} type="button" className={actionClass}
            onClick={(event) => { event.stopPropagation(); onPickStoryboard(source); }}>
            {t(source === "canvas" ? "canvas.scriptAssets.fromCanvas" : "canvas.scriptAssets.fromLibrary")}
        </button>
    )) : null;

    return (
        <div
            className={`group/stage relative mx-auto flex aspect-video w-full flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground ${
                variant === "fullscreen" ? "max-h-full w-auto max-w-full" : ""
            }`}
            style={variant === "inline" ? { maxWidth: "min(100%, calc(min(58vh, 740px) * 16 / 9))" } : undefined}
            data-shot-stage={variant}
        >
            <div className="flex flex-none flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border bg-background px-3 py-2">
                <span className="min-w-0 text-xs font-medium">
                    {t("canvas.scriptCompose.previewLabel", { no: shot?.no ?? 0, meta: shot ? shotMeta(shot) : "—" })}
                </span>
                <span className="text-[11px] text-muted-foreground">{t("canvas.scriptCompose.previewRes")}</span>
                {hasMedia ? <div className="flex w-full flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {sbReady && !showVideo ? <span>{t("canvas.scriptCompose.firstFrameBadge")}</span> : null}
                        {showVideo ? <span>{t("canvas.scriptCompose.videoFirstFrame")}</span> : null}
                        {item?.degraded === "generating" ? <span className="text-foreground">{t("canvas.scriptCompose.videoDegradedGenerating")}</span> : null}
                        {item?.degraded === "error" ? <span className="text-danger">{t("canvas.scriptCompose.videoDegradedFailed")}</span> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                        {sourceActions}
                        {sbReady && !showVideo ? <button type="button" className={actionClass} onClick={onRegenerateStoryboard}>
                            <RefreshCw className="size-3.5" aria-hidden />{t("canvas.scriptCompose.sbRegenerate")}
                        </button> : null}
                    </div>
                </div> : null}
            </div>

            <div className="relative min-h-0 flex-1 bg-background" onDoubleClick={onOpenFullscreen}>
                {showVideo ? <video
                    ref={videoRef} src={item?.url} autoPlay={playing} playsInline
                    className="absolute inset-0 size-full object-contain"
                    onPlay={onVideoPlay} onEnded={onVideoEnded} onError={() => setMediaFailed(true)}
                    onTimeUpdate={(event) => onVideoTimeUpdate?.(event.currentTarget.currentTime)}
                    onLoadedMetadata={(event) => onVideoDuration?.(event.currentTarget.duration || 0)}
                /> : null}
                {!showVideo && showStill ? <img src={item?.stillUrl} alt="" className="absolute inset-0 size-full object-contain" onError={() => setMediaFailed(true)} /> : null}

                {/* 状态互斥：不在占位文字上再叠加分镜图或生成提示。 */}
                {!hasMedia || sbBusy || replayEnded ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-y-auto bg-background px-6 py-4 text-center" data-stage-state
                        onDoubleClick={(event) => event.stopPropagation()}>
                        {replayEnded ? <>
                            <RotateCcw className="size-7 text-muted-foreground" aria-hidden />
                            <span className="text-sm font-medium">{t("canvas.scriptCompose.replayEnded")}</span>
                            <button type="button" className={actionClass} onClick={onReplay}>{t("canvas.scriptCompose.replay")}</button>
                        </> : sbBusy || (showVideoStatus && videoGenerating) ? <div role="status" className="flex flex-col items-center gap-3">
                            <Spinner className="size-6" />
                            <span className="text-sm font-medium">{t(sbBusy ? "canvas.scriptCompose.sbStageGenTitle" : "canvas.scriptCompose.videoGenerating")}</span>
                            <span className="max-w-md text-xs leading-relaxed text-muted-foreground">{t(sbBusy ? "canvas.scriptCompose.sbStageGenSub" : "canvas.scriptCompose.videoGeneratingSub")}</span>
                        </div> : sbEmpty || sbError ? <>
                            <ImageIcon className="size-8 text-muted-foreground" aria-hidden />
                            <span className={`text-sm font-medium ${sbError ? "text-danger" : ""}`}>{t(sbError ? "canvas.scriptCompose.sbError" : "canvas.scriptCompose.sbStageNoneTitle")}</span>
                            <span className="max-w-md text-xs leading-relaxed text-muted-foreground">{t(sbError ? "canvas.scriptCompose.sbErrorHint" : "canvas.scriptCompose.sbInputHint")}</span>
                            <div className="mt-1 flex flex-wrap items-center justify-center gap-1">
                                {sourceActions}
                                <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3 text-xs font-medium text-background"
                                    onClick={sbError ? onRegenerateStoryboard : onGenerateStoryboard}>
                                    <Sparkles className="size-3.5" aria-hidden />{t(sbError ? "canvas.scriptCompose.sbRegenerate" : "canvas.scriptCompose.sbGenerate")}
                                </button>
                            </div>
                        </> : showVideoStatus && errorDetails ? <>
                            <span className="max-w-md text-sm text-danger">{t("canvas.scriptCompose.videoErrorPrefix")}：{errorDetails}</span>
                            {sourceActions}
                        </> : <>
                            <Glyph className="size-8 text-muted-foreground" aria-hidden />
                            <span className="text-sm text-muted-foreground">{sbReady ? t("canvas.scriptCompose.firstFrameBadge") : shot?.composed ? t("canvas.scriptCompose.previewPlaceholderConfirmed") : t("canvas.scriptCompose.previewPlaceholderShort")}</span>
                            {!sbReady && shot?.composed ? <button type="button" className={actionClass} onClick={onGenerate}>
                                <Sparkles className="size-3.5" aria-hidden />{t("canvas.scriptCompose.generateVideo")}
                            </button> : null}
                            {sourceActions}
                        </>}
                    </div>
                ) : null}
            </div>
            {controls}
        </div>
    );
}

type PlaybackControlsProps = {
    item?: PlaybackItem;
    index: number;
    count: number;
    mode: PlaybackMode;
    playing: boolean;
    elapsed: number;
    total: number;
    variant?: "inline" | "fullscreen";
    onToggle: () => void;
    onSeekRatio: (ratio: number) => void;
    onSetMode: (mode: PlaybackMode) => void;
    onOpenFullscreen?: () => void;
    onCloseFullscreen?: () => void;
    /** 版本下拉等右侧扩展控件 */
    extra?: ReactNode;
};

/** 播放控制条：内联与全屏共用，只换密度（全屏更大、含退出按钮）。 */
export function PlaybackControls({
    item, index, count, mode, playing, elapsed, total, variant = "inline",
    onToggle, onSeekRatio, onSetMode, onOpenFullscreen, onCloseFullscreen, extra,
}: PlaybackControlsProps) {
    const { t } = useTranslation();
    const progress = Math.min(100, (elapsed / Math.max(total || item?.duration || 1, 0.1)) * 100);
    const fullscreen = variant === "fullscreen";
    return (
        <div
            className={`relative z-10 flex flex-none items-center gap-3 border-t border-border bg-background text-foreground ${
                fullscreen ? "px-6 py-3" : "px-3 py-2"
            }`}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
        >
            <button
                type="button"
                className={`flex flex-none items-center justify-center rounded-full bg-foreground text-background transition-colors ${fullscreen ? "size-11" : "size-9"}`}
                aria-label={playing ? t("canvas.scriptCompose.pause") : t("canvas.scriptCompose.play")}
                onClick={onToggle}
            >
                {playing ? <Pause className={fullscreen ? "size-5" : "size-4.5"} /> : <Play className={fullscreen ? "size-5" : "size-4.5"} />}
            </button>
            <span className="text-xs tabular-nums text-muted-foreground">{fmt(elapsed)} / {fmt(total || item?.duration || 0)}</span>
            <div
                className="group/play relative flex h-6 flex-1 cursor-pointer items-center"
                onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    onSeekRatio((event.clientX - rect.left) / rect.width);
                }}
            >
                <div className="h-1 w-full overflow-hidden rounded bg-border transition-[height] group-hover/play:h-1.5">
                    <div className="h-full rounded bg-foreground transition-[width] duration-200" style={{ width: `${progress}%` }} />
                </div>
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">{index + 1}/{count}</span>
            <div className="flex flex-none overflow-hidden rounded-md border border-border">
                <button
                    type="button"
                    className={`px-2.5 py-1 text-xs transition-colors ${mode === "shot" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    onClick={() => onSetMode("shot")}
                >
                    {t("canvas.scriptCompose.modeShot")}
                </button>
                <button
                    type="button"
                    className={`px-2.5 py-1 text-xs transition-colors ${mode === "seq" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    onClick={() => onSetMode("seq")}
                >
                    {t("canvas.scriptCompose.modeSeq")}
                </button>
            </div>
            {extra}
            {fullscreen ? (
                <button
                    type="button"
                    className="flex size-7 flex-none items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label={t("canvas.scriptCompose.exitFullscreen")}
                    onClick={onCloseFullscreen}
                >
                    <Maximize className="size-3.5" />
                </button>
            ) : (
                <button
                    type="button"
                    className="flex size-7 flex-none items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label={t("canvas.scriptCompose.fullscreen")}
                    onClick={onOpenFullscreen}
                >
                    <Maximize className="size-3.5" />
                </button>
            )}
        </div>
    );
}
