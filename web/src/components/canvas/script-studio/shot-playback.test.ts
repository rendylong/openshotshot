import { describe, expect, it } from "vitest";

import type { CanvasNodeData } from "@/types/canvas";
import type { ScriptShot } from "@/types/script-node";
import { buildPlaybackTimeline, isVideoNodeFailed, isVideoNodeGenerating, nominalDuration } from "./shot-playback";

const shot = (shotId: string, over: Partial<ScriptShot> = {}): ScriptShot => ({
    shotId, no: 1, origin: "manual", shotSize: "中景", angle: "平视", movement: "固定",
    duration: 5, mood: "", sfx: "", dialogue: "", descriptionRich: [], description: "", entityRefs: [], composed: false, ...over,
});

const vnode = (over: Record<string, unknown> = {}): CanvasNodeData =>
    ({ id: over.id ?? "v1", type: "video", title: "v", position: { x: 0, y: 0 }, width: 480, height: 270, metadata: { content: "blob:v1", status: "success", ...over } }) as CanvasNodeData;

const sb = (state: "none" | "generating" | "ready" | "error", thumbUrl?: string) => ({ state, thumbUrl });

describe("nominalDuration", () => {
    it("duration>0 用自身，0/未设置按 4s 兜底", () => {
        expect(nominalDuration(shot("a", { duration: 7 }))).toBe(7);
        expect(nominalDuration(shot("a", { duration: 0 }))).toBe(4);
    });
});

describe("isVideoNodeGenerating / isVideoNodeFailed", () => {
    it("loading 与在途 remoteTask 都算生成中", () => {
        expect(isVideoNodeGenerating(vnode({ status: "loading" }))).toBe(true);
        expect(isVideoNodeGenerating(vnode({ status: "idle", remoteTask: { id: "t", status: "pending", submittedAt: 1 } }))).toBe(true);
        expect(isVideoNodeGenerating(vnode({ status: "success" }))).toBe(false);
    });
    it("status=error 视为失败", () => {
        expect(isVideoNodeFailed(vnode({ status: "error" }))).toBe(true);
        expect(isVideoNodeFailed(vnode({ status: "success" }))).toBe(false);
    });
});

describe("buildPlaybackTimeline（spec D2 三优先级）", () => {
    it("可用视频 → kind=video，duration 为名义时长", () => {
        const items = buildPlaybackTimeline({
            shots: [shot("s1", { duration: 6 })],
            currentVideoByShotId: new Map([["s1", vnode({ content: "blob:ok" })]]),
            storyboardFirst: false,
            storyboardImageState: {},
        });
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ shotId: "s1", kind: "video", duration: 6, url: "blob:ok" });
    });

    it("无视频 + 分镜图 ready → kind=still（storyboardFirst 开启）", () => {
        const items = buildPlaybackTimeline({
            shots: [shot("s1")],
            currentVideoByShotId: new Map(),
            storyboardFirst: true,
            storyboardImageState: { s1: sb("ready", "blob:still") },
        });
        expect(items[0]).toMatchObject({ kind: "still", stillUrl: "blob:still", duration: 5 });
    });

    it("storyboardFirst 关闭时即使分镜图 ready 也走占位（D9 无痕）", () => {
        const items = buildPlaybackTimeline({
            shots: [shot("s1")],
            currentVideoByShotId: new Map(),
            storyboardFirst: false,
            storyboardImageState: { s1: sb("ready", "blob:still") },
        });
        expect(items[0].kind).toBe("placeholder");
        expect(items[0].stillUrl).toBeUndefined();
    });

    it("视频生成中 → 降级为分镜图静帧并标 degraded=generating", () => {
        const items = buildPlaybackTimeline({
            shots: [shot("s1")],
            currentVideoByShotId: new Map([["s1", vnode({ status: "loading", content: "" })]]),
            storyboardFirst: true,
            storyboardImageState: { s1: sb("ready", "blob:still") },
        });
        expect(items[0]).toMatchObject({ kind: "still", degraded: "generating" });
    });

    it("视频失败 → 同样降级并标 degraded=error", () => {
        const items = buildPlaybackTimeline({
            shots: [shot("s1")],
            currentVideoByShotId: new Map([["s1", vnode({ status: "error" })]]),
            storyboardFirst: true,
            storyboardImageState: { s1: sb("ready", "blob:still") },
        });
        expect(items[0]).toMatchObject({ kind: "still", degraded: "error" });
    });

    it("无视频无分镜图 → 占位", () => {
        const items = buildPlaybackTimeline({
            shots: [shot("s1")],
            currentVideoByShotId: new Map(),
            storyboardFirst: true,
            storyboardImageState: { s1: sb("none") },
        });
        expect(items[0].kind).toBe("placeholder");
    });

    it("时间轴与 shots 等长同序（下标即镜头下标）", () => {
        const items = buildPlaybackTimeline({
            shots: [shot("s1"), shot("s2"), shot("s3")],
            currentVideoByShotId: new Map([["s2", vnode({ id: "v2" })]]),
            storyboardFirst: true,
            storyboardImageState: { s1: sb("ready", "u1"), s3: sb("generating") },
        });
        expect(items.map((i) => i.shotId)).toEqual(["s1", "s2", "s3"]);
        expect(items.map((i) => i.kind)).toEqual(["still", "video", "placeholder"]);
    });
});
