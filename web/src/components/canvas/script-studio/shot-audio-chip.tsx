import { useEffect, useState } from "react";
import { Pause, Play, TriangleAlert, X } from "lucide-react";

import { useProjectAssetUrl } from "@/hooks/use-project-asset-url";
import { resolveMediaUrl } from "@/services/file-storage";
import type { ShotAudioRef } from "@/types/script-node";
import { playAudioPreview, stopAudioPreview, subscribeAudioPreview } from "./audio-preview";

const formatDuration = (durationMs?: number) => {
    if (!durationMs || durationMs <= 0) return "";
    const total = Math.round(durationMs / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

type Labels = { play: string; pause: string; remove?: string; invalid: string };

type Props = {
    audio: ShotAudioRef;
    labels: Labels;
    /** 不传 = 只读（compose 右栏），不渲染移除按钮 */
    onRemove?: () => void;
    className?: string;
};

/** 镜头音频 chip（spec 4.1）：高 24px 与实体胶囊同比例；播放经 studio 级单例互斥；失败态可点重试。
    桌面项目资产经 useProjectAssetUrl 解析（assetRef）；无 assetRef 才走旧 IndexedDB 解析器。 */
export function ShotAudioChip({ audio, labels, onRemove, className = "" }: Props) {
    const [legacyUrl, setLegacyUrl] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const [playing, setPlaying] = useState(false);
    const project = useProjectAssetUrl(audio.assetRef, "");
    const url = audio.assetRef ? (project.status === "ready" ? project.url || null : null) : legacyUrl;

    useEffect(() => subscribeAudioPreview((state) => setPlaying(state.url !== null && state.url === url)), [url]);
    // 幽灵播放防护：chip 卸载（移除/行删除/切步）时若正在播放本源 → 立即停止
    useEffect(
        () => () => {
            if (url) stopAudioPreview(url);
        },
        [url],
    );

    const toggle = async () => {
        if (playing) {
            stopAudioPreview(url ?? undefined);
            return;
        }
        let next = url;
        if (!next && audio.storageKey) {
            next = await resolveMediaUrl(audio.storageKey);
            setLegacyUrl(next);
        }
        if (!next) {
            setFailed(true);
            return;
        }
        setFailed(false);
        playAudioPreview(next, () => setFailed(true));
    };

    const Icon = failed ? TriangleAlert : playing ? Pause : Play;
    const duration = formatDuration(audio.durationMs);
    return (
        <span className={`flex h-6 w-full items-center gap-1 rounded-md bg-foreground/5 pl-1 pr-0.5 ${className}`} title={audio.name}>
            <button
                type="button"
                className={`flex size-6 flex-none items-center justify-center rounded ${failed ? "text-red-500" : "text-stone-400"} hover:bg-stone-500/10 hover:text-foreground`}
                aria-label={failed ? labels.invalid : playing ? labels.pause : labels.play}
                title={failed ? labels.invalid : undefined}
                onClick={() => void toggle()}
            >
                <Icon className="size-3" aria-hidden />
            </button>
            <span className="min-w-0 flex-1 truncate text-xs">{audio.name}</span>
            {duration ? <span className="flex-none text-[11px] tabular-nums text-stone-400">{duration}</span> : null}
            {onRemove ? (
                <button
                    type="button"
                    className="flex size-6 flex-none items-center justify-center rounded text-stone-400 hover:text-red-500"
                    aria-label={labels.remove ?? ""}
                    onClick={onRemove}
                >
                    <X className="size-3" aria-hidden />
                </button>
            ) : null}
        </span>
    );
}
