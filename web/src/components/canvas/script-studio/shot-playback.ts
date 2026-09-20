import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CanvasNodeData } from "@/types/canvas";
import type { ScriptShot } from "@/types/script-node";

/** 分镜图状态（原在 compose-step，移到本模块避免循环依赖；compose-step 再导出以兼容既有导入）。 */
export type StoryboardImageState = "none" | "generating" | "ready" | "error";

const REMOTE_ACTIVE_STATUSES = ["submitting", "pending", "waiting_network", "waiting_configuration"];

/** 视频节点是否生成中：本地 loading 或在途 remoteTask（与 resetInterruptedGeneration 口径一致）。 */
export function isVideoNodeGenerating(node: CanvasNodeData): boolean {
    return node.metadata?.status === "loading" || REMOTE_ACTIVE_STATUSES.includes(node.metadata?.remoteTask?.status || "");
}

export function isVideoNodeFailed(node: CanvasNodeData): boolean {
    return node.metadata?.status === "error";
}

export type PlaybackItemKind = "video" | "still" | "placeholder";

/** 连播/单镜共用的一个时间轴条目。时间轴与 shots 一一对应（等长同序），下标即镜头下标。 */
export type PlaybackItem = {
    shotId: string;
    no: number;
    kind: PlaybackItemKind;
    /** 名义时长（秒）：静帧/占位按此推进；视频以真实 ended 为准，此值仅作进度条兜底 */
    duration: number;
    url?: string;
    stillUrl?: string;
    /** 有视频但不可用而降级的缘故（舞台角标提示） */
    degraded?: "generating" | "error";
};

/** 单镜名义时长：duration 为 0（未设置）时按 4s 兜底。 */
export function nominalDuration(shot: ScriptShot): number {
    return shot.duration > 0 ? shot.duration : 4;
}

/**
 * 三优先级（spec D2）：① 可用视频 → video；② storyboardFirst 且分镜图 ready → still；③ 其余 → placeholder。
 * 生成中/失败的视频降级为 ②/③ 并带 degraded，连播不中断、不跳镜。
 */
export function buildPlaybackTimeline(args: {
    shots: ScriptShot[];
    currentVideoByShotId: Map<string, CanvasNodeData>;
    storyboardFirst: boolean;
    storyboardImageState: Record<string, { state: StoryboardImageState; thumbUrl?: string }>;
}): PlaybackItem[] {
    return args.shots.map((shot) => {
        const node = args.currentVideoByShotId.get(shot.shotId);
        const url = node?.metadata?.content || "";
        const generating = node ? isVideoNodeGenerating(node) : false;
        const failed = node ? isVideoNodeFailed(node) : false;
        const base = { shotId: shot.shotId, no: shot.no, duration: nominalDuration(shot) };
        if (node && url && !generating && !failed) {
            return { ...base, kind: "video" as const, url };
        }
        const degraded = generating ? ("generating" as const) : failed ? ("error" as const) : undefined;
        const still = args.storyboardFirst ? args.storyboardImageState[shot.shotId] : undefined;
        if (still?.state === "ready" && still.thumbUrl) {
            return { ...base, kind: "still" as const, stillUrl: still.thumbUrl, degraded };
        }
        return { ...base, kind: "placeholder" as const, degraded };
    });
}

export type PlaybackMode = "shot" | "seq";

export type ShotPlayback = {
    index: number;
    shotId: string | undefined;
    item: PlaybackItem | undefined;
    mode: PlaybackMode;
    playing: boolean;
    elapsed: number;
    videoDuration: number;
    total: number;
    ended: boolean;
    videoRef: React.RefObject<HTMLVideoElement | null>;
    selectShot: (shotId: string) => void;
    step: (dir: -1 | 1) => void;
    setMode: (mode: PlaybackMode) => void;
    toggle: () => void;
    play: () => void;
    pause: () => void;
    startReel: () => void;
    replay: () => void;
    seekRatio: (ratio: number) => void;
    onVideoPlay: () => void;
    onVideoEnded: () => void;
    onVideoTimeUpdate: (seconds: number) => void;
    onVideoDuration: (seconds: number) => void;
};

/**
 * 单一播放状态机：内联预览与全屏播放层共用（spec D12）。
 * 视频镜由 <video> 的 ended 驱动推进；静帧/占位由定时器按名义时长推进。
 * 刻意不绑定 onPause：src 切换会触发浏览器 pause，绑定会把"连播中"误置为暂停。
 */
export function useShotPlayback({ timeline }: { timeline: PlaybackItem[] }): ShotPlayback {
    const [index, setIndex] = useState(0);
    const [mode, setMode] = useState<PlaybackMode>("shot");
    const [playing, setPlaying] = useState(false);
    const [elapsed, setElapsed] = useState(0);
    const [videoDuration, setVideoDuration] = useState(0);
    const [ended, setEnded] = useState(false);
    const videoRef = useRef<HTMLVideoElement | null>(null);

    const lastIndex = Math.max(0, timeline.length - 1);
    const safeIndex = Math.min(index, lastIndex);
    const item = timeline[safeIndex];
    const itemKey = item ? `${item.shotId}:${item.kind}:${item.url ?? ""}` : "";

    // 命令式读取用 ref，保证推进回调稳定（定时器闭包不取到旧下标）；先声明再被下方回调/定时器读取
    const indexRef = useRef(safeIndex);
    const modeRef = useRef(mode);
    const lengthRef = useRef(timeline.length);
    const timelineRef = useRef(timeline);
    const endedRef = useRef(ended);
    useEffect(() => {
        indexRef.current = safeIndex;
        modeRef.current = mode;
        lengthRef.current = timeline.length;
    }, [safeIndex, mode, timeline.length]);
    useEffect(() => {
        timelineRef.current = timeline;
    }, [timeline]);
    useEffect(() => {
        endedRef.current = ended;
    }, [ended]);
    const elapsedRef = useRef(elapsed);
    useEffect(() => {
        elapsedRef.current = elapsed;
    }, [elapsed]);
    const playingRef = useRef(playing);
    useEffect(() => {
        playingRef.current = playing;
    }, [playing]);

    // 切 item：进度归零、清结束态
    useEffect(() => {
        setElapsed(0);
        setVideoDuration(0);
    }, [itemKey]);

    // 时间轴缩短：下标收敛
    useEffect(() => {
        if (index > lastIndex) setIndex(lastIndex);
    }, [index, lastIndex]);

    const advance = useCallback(() => {
        if (modeRef.current === "shot") {
            setPlaying(false);
            return;
        }
        const current = indexRef.current;
        if (current < lengthRef.current - 1) {
            indexRef.current = current + 1;
            setIndex(current + 1);
            return;
        }
        setPlaying(false);
        setEnded(true);
    }, []);

    const advanceRef = useRef(advance);
    useEffect(() => {
        advanceRef.current = advance;
    }, [advance]);

    // 静帧/占位：定时器推进（elapsed 为累计的唯一事实源：经 ref 读取，暂停/续播不重建定时器、不丢进度；seekRatio 后下一 tick 生效）
    useEffect(() => {
        if (!item || item.kind === "video") return;
        const total = item.duration;
        const timer = window.setInterval(() => {
            if (!playingRef.current) return;
            const next = elapsedRef.current + 0.25;
            if (next >= total) {
                elapsedRef.current = total;
                advanceRef.current();
            } else {
                elapsedRef.current = next;
                setElapsed(next);
            }
        }, 250);
        return () => window.clearInterval(timer);
    }, [itemKey, item?.kind, item?.duration]);

    // 视频：播放意图驱动 play/pause（src 变化后同一元素续播，无 key 重挂载）
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !item || item.kind !== "video") return;
        if (playing && video.paused) void video.play().catch(() => setPlaying(false));
        if (!playing && !video.paused) video.pause();
    }, [playing, itemKey, item?.kind]);

    const selectShot = useCallback((shotId: string) => {
        const next = timelineRef.current.findIndex((entry) => entry.shotId === shotId);
        if (next < 0) return;
        indexRef.current = next;
        setIndex(next);
        setEnded(false);
    }, []);

    const step = useCallback((dir: -1 | 1) => {
        const current = indexRef.current;
        const next = Math.min(lengthRef.current - 1, Math.max(0, current + dir));
        if (next === current) return;
        indexRef.current = next;
        setIndex(next);
    }, []);

    const play = useCallback(() => {
        if (endedRef.current) {
            setEnded(false);
            indexRef.current = 0;
            setIndex(0);
        }
        setPlaying(true);
    }, []);

    const pause = useCallback(() => setPlaying(false), []);
    const toggle = useCallback(() => {
        if (endedRef.current) {
            setEnded(false);
            indexRef.current = 0;
            setIndex(0);
            setPlaying(true);
            return;
        }
        setPlaying((value) => !value);
    }, []);
    const startReel = useCallback(() => {
        setMode("seq");
        modeRef.current = "seq";
        setEnded(false);
        indexRef.current = 0;
        setIndex(0);
        setPlaying(true);
    }, []);
    const replay = useCallback(() => {
        setEnded(false);
        indexRef.current = 0;
        setIndex(0);
        setPlaying(true);
    }, []);

    const total = item ? (item.kind === "video" ? videoDuration || item.duration : item.duration) : 0;

    const seekRatio = useCallback(
        (ratio: number) => {
            const ratio01 = Math.max(0, Math.min(1, ratio));
            const current = timelineRef.current[indexRef.current];
            if (!current) return;
            const video = videoRef.current;
            if (current.kind === "video" && video && Number.isFinite(video.duration)) {
                video.currentTime = ratio01 * video.duration;
                return;
            }
            setElapsed(ratio01 * current.duration);
        },
        [],
    );

    const onVideoPlay = useCallback(() => setPlaying(true), []);
    const onVideoEnded = useCallback(() => {
        if (modeRef.current === "seq") {
            advanceRef.current();
            return;
        }
        setPlaying(false);
        const current = indexRef.current;
        if (current < lengthRef.current - 1) {
            indexRef.current = current + 1;
            setIndex(current + 1);
        }
    }, []);
    const onVideoTimeUpdate = useCallback((seconds: number) => setElapsed(seconds), []);
    const onVideoDuration = useCallback((seconds: number) => setVideoDuration(Number.isFinite(seconds) ? seconds : 0), []);

    return useMemo(
        () => ({
            index: safeIndex, shotId: item?.shotId, item, mode, playing, elapsed, videoDuration, total, ended, videoRef,
            selectShot, step, setMode, toggle, play, pause, startReel, replay, seekRatio,
            onVideoPlay, onVideoEnded, onVideoTimeUpdate, onVideoDuration,
        }),
        [safeIndex, item, mode, playing, elapsed, videoDuration, total, ended, selectShot, step, toggle, play, pause, startReel, replay, seekRatio, onVideoPlay, onVideoEnded, onVideoTimeUpdate, onVideoDuration],
    );
}
