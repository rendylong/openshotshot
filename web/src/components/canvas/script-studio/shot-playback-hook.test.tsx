import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlaybackItem } from "./shot-playback";
import { useShotPlayback } from "./shot-playback";

const item = (shotId: string, kind: PlaybackItem["kind"], duration: number): PlaybackItem => ({ shotId, no: Number(shotId.slice(1)), kind, duration });

const timeline: PlaybackItem[] = [
    item("s1", "video", 5),
    item("s2", "still", 6),
    item("s3", "placeholder", 3),
];

describe("useShotPlayback", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("初始停在第 1 镜、单镜模式、未播放", () => {
        const { result } = renderHook(() => useShotPlayback({ timeline }));
        expect(result.current.index).toBe(0);
        expect(result.current.shotId).toBe("s1");
        expect(result.current.mode).toBe("shot");
        expect(result.current.playing).toBe(false);
        expect(result.current.ended).toBe(false);
    });

    it("startReel：回到第 1 镜、连播模式、开始播放", () => {
        const { result } = renderHook(() => useShotPlayback({ timeline }));
        act(() => result.current.selectShot("s3"));
        act(() => result.current.startReel());
        expect(result.current.mode).toBe("seq");
        expect(result.current.index).toBe(0);
        expect(result.current.playing).toBe(true);
    });

    it("连播：静帧按名义时长到点后推进下一镜；末镜结束标记 ended", () => {
        const { result } = renderHook(() => useShotPlayback({ timeline }));
        act(() => result.current.selectShot("s2"));
        act(() => result.current.startReel());
        act(() => result.current.selectShot("s2"));
        expect(result.current.playing).toBe(true);
        act(() => { vi.advanceTimersByTime(6000); });
        expect(result.current.shotId).toBe("s3"); // 6s 静帧结束 → 推进
        act(() => { vi.advanceTimersByTime(3000); });
        expect(result.current.playing).toBe(false); // 末镜结束
        expect(result.current.ended).toBe(true);
    });

    it("连播中 selectShot：跳镜续播（保持 playing 与 seq）", () => {
        const { result } = renderHook(() => useShotPlayback({ timeline }));
        act(() => result.current.startReel());
        act(() => result.current.selectShot("s3"));
        expect(result.current.shotId).toBe("s3");
        expect(result.current.playing).toBe(true);
        expect(result.current.mode).toBe("seq");
    });

    it("replay：清 ended、回第 1 镜、继续播放", () => {
        const { result } = renderHook(() => useShotPlayback({ timeline }));
        act(() => result.current.selectShot("s3"));
        act(() => result.current.startReel());
        act(() => result.current.selectShot("s3"));
        act(() => { vi.advanceTimersByTime(3000); });
        expect(result.current.ended).toBe(true);
        act(() => result.current.replay());
        expect(result.current.ended).toBe(false);
        expect(result.current.index).toBe(0);
        expect(result.current.playing).toBe(true);
    });

    it("单镜模式：静帧到点后停播、不推进（与连播区分）", () => {
        const { result } = renderHook(() => useShotPlayback({ timeline }));
        act(() => result.current.selectShot("s2"));
        act(() => result.current.toggle());
        act(() => { vi.advanceTimersByTime(6000); });
        expect(result.current.shotId).toBe("s2");
        expect(result.current.playing).toBe(false);
        expect(result.current.ended).toBe(false);
    });

    it("toggle 在 ended 态等价于 replay", () => {
        const { result } = renderHook(() => useShotPlayback({ timeline }));
        act(() => result.current.selectShot("s3"));
        act(() => result.current.startReel());
        act(() => result.current.selectShot("s3"));
        act(() => { vi.advanceTimersByTime(3000); });
        act(() => result.current.toggle());
        expect(result.current.ended).toBe(false);
        expect(result.current.playing).toBe(true);
    });

    it("seekRatio：静帧按名义时长定位", () => {
        const { result } = renderHook(() => useShotPlayback({ timeline }));
        act(() => result.current.selectShot("s2"));
        act(() => result.current.seekRatio(0.5));
        expect(result.current.elapsed).toBe(3);
    });

    it("时间轴变短（删镜）时下标收敛，不越界", () => {
        const { result, rerender } = renderHook(({ tl }) => useShotPlayback({ timeline: tl }), { initialProps: { tl: timeline } });
        act(() => result.current.selectShot("s3"));
        expect(result.current.index).toBe(2);
        rerender({ tl: timeline.slice(0, 2) });
        expect(result.current.index).toBe(1);
        expect(result.current.shotId).toBe("s2");
    });

    it("step 越界钳制", () => {
        const { result } = renderHook(() => useShotPlayback({ timeline }));
        act(() => result.current.step(-1));
        expect(result.current.index).toBe(0);
        act(() => result.current.selectShot("s3"));
        act(() => result.current.step(1));
        expect(result.current.index).toBe(2);
    });

    it("StrictMode：静帧到点只推进一镜（updater 双调用不跳镜）", () => {
        // 4 镜时间轴：若 updater 内 advance 被 StrictMode 双调用，会从 s2 跳到 s4 而非 s3
        const four = [...timeline, item("s4", "placeholder", 3)];
        const { result } = renderHook(() => useShotPlayback({ timeline: four }), { wrapper: StrictMode });
        act(() => result.current.selectShot("s2"));
        act(() => result.current.startReel());
        act(() => result.current.selectShot("s2"));
        act(() => { vi.advanceTimersByTime(6000); });
        expect(result.current.shotId).toBe("s3");
    });

    it("暂停续播：进度不丢、不重播整段（到点仍只推进一镜）", () => {
        const { result } = renderHook(() => useShotPlayback({ timeline }), { wrapper: StrictMode });
        act(() => result.current.selectShot("s2"));
        act(() => result.current.startReel());
        act(() => result.current.selectShot("s2")); // 连播中停在 6s 静帧
        act(() => { vi.advanceTimersByTime(3000); }); // 播到一半
        expect(result.current.elapsed).toBe(3);
        act(() => result.current.pause());
        act(() => { vi.advanceTimersByTime(60000); }); // 暂停中不推进
        expect(result.current.elapsed).toBe(3);
        act(() => result.current.play()); // 续播：剩余 3s 到点
        act(() => { vi.advanceTimersByTime(3000); });
        expect(result.current.shotId).toBe("s3"); // 恰好推进一镜，而非重播整段
        expect(result.current.ended).toBe(false);
    });

    it("seek 后续播：seek 位置生效，到点推进下一镜", () => {
        const { result } = renderHook(() => useShotPlayback({ timeline }));
        act(() => result.current.selectShot("s2"));
        act(() => result.current.startReel());
        act(() => result.current.selectShot("s2"));
        act(() => result.current.seekRatio(0.9)); // 6s 静帧定位到 5.4s
        expect(result.current.elapsed).toBe(5.4);
        act(() => { vi.advanceTimersByTime(1000); }); // 5.4 → 5.65 → 5.9 → 6.15 ≥ 6 → 推进
        expect(result.current.shotId).toBe("s3");
    });

    it("连播真实视频：ended 事件恰好推进一镜且继续播放；末镜视频 ended 停播并标记 ended", () => {
        // 全视频时间轴：定时器跳过 kind=video 不参与推进，onVideoEnded（真实 <video> ended 事件）是唯一推进机制
        const videoTl: PlaybackItem[] = [item("s1", "video", 5), item("s2", "video", 6)];
        const { result } = renderHook(() => useShotPlayback({ timeline: videoTl }));
        act(() => result.current.startReel());
        expect(result.current.index).toBe(0);
        act(() => result.current.onVideoEnded()); // 第 1 镜视频真实播完
        expect(result.current.index).toBe(1); // 恰好推进一镜，不跳镜
        expect(result.current.shotId).toBe("s2");
        expect(result.current.playing).toBe(true); // 连播不中断
        act(() => result.current.onVideoEnded()); // 末镜（视频）播完
        expect(result.current.ended).toBe(true);
        expect(result.current.playing).toBe(false);
    });
});
