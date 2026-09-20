import { describe, expect, it, test, vi } from "vitest";
import { describeAutodlInput, prepareAutodlGenerationRequest, prepareAutodlMediaSource } from "./autodl-generation-input";
import type { NodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { defaultConfig } from "@/stores/use-config-store";

vi.mock("@/services/project-asset-storage", () => ({ getCanvasAssetBlob: vi.fn(async () => new Blob(["x"], { type: "image/png" })) }));
const imageToDataUrl = vi.hoisted(() => vi.fn(async () => ""));
vi.mock("@/services/image-storage", () => ({ imageToDataUrl }));

const context = (): NodeGenerationContext => ({ prompt: "rotate", referenceImages: [], referenceAudios: [], referenceVideos: [], imageCount: 0, audioCount: 0, videoCount: 0, textCount: 0 });
describe("AutoDL input preparation", () => {
    test("binds the exact first/last image order", () => {
        const input = context(); input.referenceImages = ["b", "a"].map(id => ({ id, name: id, type: "image/png", dataUrl: `https://example.com/${id}` }));
        expect(describeAutodlInput("minimax_h3_lightx2v", input).bindings.map(b => [b.sourceId, b.field])).toEqual([["b", "first_frame"], ["a", "last_frame"]]);
    });
    test("rejects unsupported audio instead of dropping it", () => {
        const input = context(); input.referenceAudios = [{ id: "a", name: "a", type: "audio/wav", url: "https://example.com/a" }];
        expect(() => describeAutodlInput("minimax_h3_lightx2v_no_pic", input)).toThrow();
    });
    test("marks motion prompts unused and requires a reference video", () => {
        const input = context(); input.referenceImages = [{ id: "a", name: "a", type: "image/png", dataUrl: "https://example.com/a" }];
        expect(() => describeAutodlInput("wan2.2animate-v4-motion_retargeting", input)).toThrow();
        input.referenceVideos = [{ id: "v", name: "v", type: "video/mp4", url: "https://example.com/v" }];
        expect(describeAutodlInput("wan2.2animate-v4-motion_retargeting", input).promptUsed).toBe(false);
    });
    test("never fetches local file paths", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        await expect(prepareAutodlMediaSource("file:///Users/test/private.mp4", "video")).rejects.toThrow();
        expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore();
    });
    test("preserves public URLs and stops on abort", async () => {
        await expect(prepareAutodlMediaSource("https://example.com/a.wav", "audio")).resolves.toBe("https://example.com/a.wav");
        const c = new AbortController(); c.abort();
        await expect(prepareAutodlMediaSource("https://example.com/a.wav", "audio", undefined, c.signal)).rejects.toThrow();
    });

});

describe("prepareAutodlMediaSource assetRef 分支", () => {
    test("无 storageKey 时走 getCanvasAssetBlob", async () => {
        const out = await prepareAutodlMediaSource("blob:dead", "image", undefined, undefined, { backend: "project-file", projectId: "p1", assetId: "a1", revision: 1, relativePath: "x.png" });
        expect(out.startsWith("data:image/png")).toBe(true);
    });
    test("assetRef 优先于 storageKey：storageKey 字节已删（move 语义）时仍走 assetRef 成功", async () => {
        const { getCanvasAssetBlob } = await import("@/services/project-asset-storage");
        vi.mocked(getCanvasAssetBlob).mockResolvedValueOnce(new Blob(["ref-bytes"], { type: "image/png" }));
        const out = await prepareAutodlMediaSource("blob:dead", "image", "image:deleted", undefined, { backend: "project-file", projectId: "p1", assetId: "a1", revision: 1, relativePath: "x.png" });
        expect(out.startsWith("data:image/png")).toBe(true);
    });
    test("storageKey 读不到且无 assetRef：image 分支显式抛错（不再静默提交空参考）", async () => {
        imageToDataUrl.mockResolvedValueOnce("");
        await expect(prepareAutodlMediaSource("", "image", "image:missing")).rejects.toThrow();
    });
});

describe("minimax_h3_lightx2v_v5 音频槽位", () => {
    const base = { prompt: "p", referenceImages: [], referenceVideos: [], referenceAudios: [], textCount: 0, imageCount: 0, videoCount: 0, audioCount: 0 };
    const images = [{ id: "img", name: "img.png", type: "image/png", dataUrl: "http://x" }];
    it("3 条音频通过预检并产出 ref_audio_0..2 bindings", () => {
        const audios = [0, 1, 2].map((i) => ({ id: `a${i}`, name: `a${i}.mp3`, type: "audio/mpeg", url: "http://x" }));
        const { bindings } = describeAutodlInput("minimax_h3_lightx2v_v5", { ...base, referenceImages: images, referenceAudios: audios });
        expect(bindings.map((b) => b.field)).toEqual(["ref_image_0", "ref_audio_0", "ref_audio_1", "ref_audio_2"]);
    });
    it("第 4 条仍抛 tooManyReferences（预检语义不变）", () => {
        const audios = [0, 1, 2, 3].map((i) => ({ id: `a${i}`, name: `a${i}.mp3`, type: "audio/mpeg", url: "http://x" }));
        expect(() => describeAutodlInput("minimax_h3_lightx2v_v5", { ...base, referenceImages: images, referenceAudios: audios })).toThrow(/最多支持 3 个/);
    });
});

describe("prepare 槽位映射回执", () => {
    const base = { prompt: "p", referenceImages: [], referenceVideos: [], referenceAudios: [], textCount: 0, imageCount: 0, videoCount: 0, audioCount: 0 };
    const configFixture = { ...defaultConfig, model: "default::minimax_h3_lightx2v_v5", videoModel: "default::minimax_h3_lightx2v_v5" };
    it("prepare 阶段输出脱敏槽位映射（无 base64/URL）", async () => {
        const spy = vi.spyOn(console, "info").mockImplementation(() => {});
        await prepareAutodlGenerationRequest(configFixture, { ...base, referenceImages: [{ id: "img1", name: "场景.png", type: "image/png", dataUrl: "data:image/png;base64,AA" }] });
        const line = spy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("[autodl] prepare"));
        expect(line).toContain("ref_image_0");
        expect(line).not.toContain("base64");
        spy.mockRestore();
    });
});
