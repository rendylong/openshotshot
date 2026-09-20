import { useEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Z_LAYERS } from "@/lib/design/z-layers";
import type { ShotPlayback } from "./shot-playback";
import { PlaybackControls, ShotStage } from "./shot-stage";

type ShotStageProps = Parameters<typeof ShotStage>[0];

type Props = {
    open: boolean;
    playback: ShotPlayback;
    stageProps: Omit<ShotStageProps, "controls" | "variant" | "suppressVideo" | "onOpenFullscreen" | "videoRef" | "playing">;
    onClose: () => void;
};

/** 控制条自动隐藏延迟（鼠标静止）。 */
const HIDE_DELAY_MS = 2500;

/**
 * 全屏播放层（spec D9/D11）：portal 到 body，z = Z_LAYERS.dialog；
 * 进入时 best-effort 调原生 requestFullscreen，失败静默降级为窗口内覆盖层；
 * Esc 在捕获阶段拦截并 stopPropagation，只关全屏层、不关 studio。
 */
export function VideoLightbox({ open, playback, stageProps, onClose }: Props): ReactElement | null {
    const { t } = useTranslation();
    const layerRef = useRef<HTMLDivElement | null>(null);
    const [controlsHidden, setControlsHidden] = useState(false);
    const hideTimer = useRef<number | null>(null);

    // 原生全屏：best-effort，失败静默降级（jsdom/旧环境无该 API 或被拒绝都不影响覆盖层）
    useEffect(() => {
        if (!open) return;
        const layer = layerRef.current;
        Promise.resolve()
            .then(() => {
                try {
                    void layer?.requestFullscreen?.()?.catch?.(() => {});
                } catch {
                    /* 原生全屏被拒绝：静默降级为窗口内覆盖层 */
                }
            })
            .catch(() => {});
        return () => {
            try {
                if (document.fullscreenElement) void document.exitFullscreen?.()?.catch?.(() => {});
            } catch {
                /* 静默降级 */
            }
        };
    }, [open]);

    // 键盘：捕获阶段拦截，分层关闭（只关全屏层，不冒泡到 studio 的快捷键）
    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); onClose(); return; }
            if (event.key === " ") { event.stopPropagation(); event.preventDefault(); playback.toggle(); return; }
            if (event.key === "ArrowLeft") { event.stopPropagation(); playback.step(-1); return; }
            if (event.key === "ArrowRight") { event.stopPropagation(); playback.step(1); }
        };
        document.addEventListener("keydown", onKeyDown, true);
        return () => document.removeEventListener("keydown", onKeyDown, true);
    }, [open, onClose, playback]);

    // 控制条自动隐藏：鼠标静止 HIDE_DELAY_MS 后隐藏，移动即恢复
    useEffect(() => {
        if (!open) return;
        const arm = () => {
            setControlsHidden(false);
            if (hideTimer.current) window.clearTimeout(hideTimer.current);
            hideTimer.current = window.setTimeout(() => setControlsHidden(true), HIDE_DELAY_MS);
        };
        arm();
        window.addEventListener("mousemove", arm);
        return () => {
            window.removeEventListener("mousemove", arm);
            if (hideTimer.current) window.clearTimeout(hideTimer.current);
        };
    }, [open]);

    if (!open) return null;

    return createPortal(
        <div ref={layerRef} role="dialog" aria-modal="true" aria-label={t("canvas.scriptCompose.fullscreen")} className="fixed inset-0 flex items-center justify-center bg-black" style={{ zIndex: Z_LAYERS.dialog }}>
            <button
                type="button"
                className={`absolute right-5 top-4 z-20 flex size-8 items-center justify-center rounded-md border border-border bg-background text-foreground transition-opacity hover:bg-accent ${controlsHidden ? "opacity-0" : "opacity-100"}`}
                aria-label={t("canvas.scriptCompose.exitFullscreen")}
                onClick={onClose}
            >
                <X className="size-4" />
            </button>
            <div className="w-full">
                <ShotStage
                    {...stageProps}
                    playing={playback.playing}
                    videoRef={playback.videoRef}
                    variant="fullscreen"
                    onVideoPlay={playback.onVideoPlay}
                    onVideoEnded={playback.onVideoEnded}
                    onVideoTimeUpdate={playback.onVideoTimeUpdate}
                    onVideoDuration={playback.onVideoDuration}
                    controls={
                        <div className={`flex-none transition-opacity ${controlsHidden ? "opacity-0" : "opacity-100"}`}>
                        <PlaybackControls
                            item={playback.item}
                            index={playback.index}
                            count={stageProps.shotCount ?? 0}
                            mode={playback.mode}
                            playing={playback.playing}
                            elapsed={playback.elapsed}
                            total={playback.total}
                            variant="fullscreen"
                            onToggle={playback.toggle}
                            onSeekRatio={playback.seekRatio}
                            onSetMode={playback.setMode}
                            onCloseFullscreen={onClose}
                        />
                        </div>
                    }
                />
            </div>
            <div className={`absolute left-1/2 z-20 -translate-x-1/2 rounded-md bg-background px-2 py-1 text-[11px] text-muted-foreground transition-opacity ${controlsHidden ? "opacity-0" : "opacity-100"}`} style={{ bottom: 78 }}>
                {t("canvas.scriptCompose.keyboardHint")}
            </div>
        </div>,
        document.body,
    );
}
