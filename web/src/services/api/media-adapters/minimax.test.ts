import axios from "axios";
import { afterEach, describe, expect, test, vi } from "vitest";

import { defaultConfig, type AiConfig } from "@/stores/use-config-store";

import { snapMinimaxVideoRatio } from "@/services/api/minimax";
import { minimaxImageAdapter, minimaxMusicAdapter, minimaxSpeechAdapter, minimaxVideoAdapter } from "./minimax";
import { getMediaAdapter } from "./registry";
import type { MediaGenerateRequest, MediaResult } from "./types";

function request(baseUrl: string, model: string, overrides: Partial<MediaGenerateRequest> = {}): MediaGenerateRequest {
    const config: AiConfig = {
        ...defaultConfig,
        baseUrl,
        apiKey: "secret",
        model,
        size: "16:9",
        count: "1",
        audioFormat: "mp3",
        audioSpeed: "1",
    };
    return { config, prompt: "prompt", images: [], params: {}, ...overrides };
}

function videoRequest(baseUrl: string, model: string = "MiniMax-Hailuo-2.3"): MediaGenerateRequest {
    return request(baseUrl, model, {
        prompt: "camera moves forward",
        images: ["data:image/png;base64,Zmlyc3Q="],
        params: { seconds: "6", resolution: "720", ratio: "16:9" },
    });
}

function h3Request(baseUrl: string, model: string = "MiniMax-H3", overrides: Partial<MediaGenerateRequest> = {}): MediaGenerateRequest {
    return request(baseUrl, model, {
        prompt: "camera moves forward",
        params: { seconds: "6", resolution: "720", ratio: "16:9" },
        ...overrides,
    });
}

function musicRequest(baseUrl: string, model: string): MediaGenerateRequest {
    return request(baseUrl, model, { prompt: "ambient instrumental" });
}

async function bytesOf(result: MediaResult): Promise<number[]> {
    if (result.kind !== "audio" || !(result.source instanceof Blob)) throw new Error("expected Blob audio result");
    return Array.from(new Uint8Array(await result.source.arrayBuffer()));
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("MiniMax media adapters", () => {
    test("registers every automatic MiniMax adapter by its resolved ID", () => {
        expect([getMediaAdapter("minimax.image"), getMediaAdapter("minimax.video"), getMediaAdapter("minimax.speech"), getMediaAdapter("minimax.music")]).toEqual([minimaxImageAdapter, minimaxVideoAdapter, minimaxSpeechAdapter, minimaxMusicAdapter]);
    });

    test("normalizes image base64 from the official image endpoint", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { image_base64: ["aW1hZ2U="] }, base_resp: { status_code: 0 } } });

        const result = await minimaxImageAdapter.generate!(request("https://api.minimaxi.com", "image-01", { prompt: "draw a cat" }));

        expect(result).toEqual({ kind: "image", sources: ["data:image/jpeg;base64,aW1hZ2U="] });
        expect(axios.post).toHaveBeenCalledWith("https://api.minimaxi.com/v1/image_generation", expect.objectContaining({ model: "image-01", prompt: "draw a cat", response_format: "base64", n: 1, aspect_ratio: "16:9" }), expect.anything());
    });

    test("normalizes TTS hex into an audio Blob", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { audio: "4869", status: 2 }, base_resp: { status_code: 0 } } });

        const result = await minimaxSpeechAdapter.generate!(request("https://api.minimax.io", "speech-2.8-hd", { prompt: "hello", params: { format: "mp3", voice: "male-qn-qingse", speed: "1" } }));

        expect(result).toMatchObject({ kind: "audio", mimeType: "audio/mpeg" });
        expect(await bytesOf(result)).toEqual([72, 105]);
        expect(axios.post).toHaveBeenCalledWith("https://api.minimax.io/v1/t2a_v2", expect.objectContaining({ model: "speech-2.8-hd", text: "hello", output_format: "hex", stream: false }), expect.anything());
    });

    test.each(["https://api.minimaxi.com", "https://api.minimax.io"])("generates music on %s", async (baseUrl) => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { audio: "4869", status: 2 }, base_resp: { status_code: 0 } } });

        const result = await minimaxMusicAdapter.generate!(musicRequest(baseUrl, "music-2.6"));

        expect(result).toMatchObject({ kind: "audio", mimeType: "audio/mpeg" });
        expect(await bytesOf(result)).toEqual([72, 105]);
        expect(axios.post).toHaveBeenCalledWith(`${baseUrl}/v1/music_generation`, expect.objectContaining({ model: "music-2.6", prompt: "ambient instrumental", lyrics_optimizer: true, output_format: "hex", stream: false }), expect.anything());
    });

    test("returns MiniMax music URL output for immediate downstream storage", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { audio: "https://cdn.example/song.mp3", status: 2 }, base_resp: { status_code: 0 } } });

        const result = await minimaxMusicAdapter.generate!(request("https://api.minimax.io", "music-2.6", { params: { output_format: "url", lyrics: "la la" } }));

        expect(result).toEqual({ kind: "audio", source: "https://cdn.example/song.mp3", mimeType: "audio/mpeg" });
        expect(axios.post).toHaveBeenCalledWith("https://api.minimax.io/v1/music_generation", expect.objectContaining({ lyrics: "la la", output_format: "url", stream: false }), expect.anything());
        expect(axios.post).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lyrics_optimizer: true }), expect.anything());
    });

    test("submits MiniMax-H3 text-to-video with the v2 content body and a ratio", async () => {
        const http = vi.spyOn(axios, "request").mockResolvedValue({ data: { task_id: "task-h3" } });

        const submitted = await minimaxVideoAdapter.submit!(h3Request("https://api.minimaxi.com"));

        expect(submitted).toEqual({ taskId: "task-h3" });
        expect(http.mock.calls[0][0]).toMatchObject({
            method: "post",
            url: "https://api.minimaxi.com/v2/video_generation",
            data: {
                model: "MiniMax-H3",
                content: [{ type: "text", text: "camera moves forward" }],
                resolution: "768P",
                duration: 6,
                ratio: "16:9",
            },
        });
    });

    test("submits MiniMax-H3 image-to-video with a first_frame role and no ratio", async () => {
        const http = vi.spyOn(axios, "request").mockResolvedValue({ data: { task_id: "task-h3" } });

        await minimaxVideoAdapter.submit!(h3Request("https://api.minimaxi.com", "MiniMax-H3", { images: ["data:image/png;base64,Zmlyc3Q="] }));

        expect(http.mock.calls[0][0]).toMatchObject({
            url: "https://api.minimaxi.com/v2/video_generation",
            data: {
                model: "MiniMax-H3",
                content: [
                    { type: "text", text: "camera moves forward" },
                    { type: "image_url", image_url: "data:image/png;base64,Zmlyc3Q=", role: "first_frame" },
                ],
                resolution: "768P",
                duration: 6,
            },
        });
        expect(http.mock.calls[0][0].data).not.toHaveProperty("ratio");
    });

    test.each([
        { model: "MiniMax-H3", seconds: "1", duration: 4 },
        { model: "MiniMax-H3", seconds: "20", duration: 15 },
        { model: "MiniMax-H3-Max", seconds: "1", duration: 5 },
        { model: "MiniMax-H3-Max", seconds: "20", duration: 15 },
        { model: "MiniMax-H3", seconds: "", duration: 6 },
    ])("clamps $model duration '$seconds' into the model range", async ({ model, seconds, duration }) => {
        const http = vi.spyOn(axios, "request").mockResolvedValue({ data: { task_id: "task-h3" } });

        await minimaxVideoAdapter.submit!(h3Request("https://api.minimaxi.com", model, { params: { seconds, resolution: "720", ratio: "16:9" } }));

        expect(http.mock.calls[0][0]).toMatchObject({ url: "https://api.minimaxi.com/v2/video_generation", data: { duration } });
    });

    test.each([
        { model: "MiniMax-H3", resolution: "480", expected: "480P" },
        { model: "MiniMax-H3", resolution: "720", expected: "768P" },
        { model: "MiniMax-H3", resolution: "2K", expected: "2K" },
        { model: "MiniMax-H3-Max", resolution: "2K", expected: "768P" },
    ])("maps $model quality '$resolution' to $expected", async ({ model, resolution, expected }) => {
        const http = vi.spyOn(axios, "request").mockResolvedValue({ data: { task_id: "task-h3" } });

        await minimaxVideoAdapter.submit!(h3Request("https://api.minimaxi.com", model, { params: { seconds: "6", resolution, ratio: "16:9" } }));

        expect(http.mock.calls[0][0]).toMatchObject({ data: { resolution: expected } });
    });

    test.each([
        ["16:9", "16:9"],
        ["1280x720", "16:9"],
        ["1792x1024", "16:9"],
        ["720x1280", "9:16"],
        ["1024x1792", "9:16"],
        ["1024x1024", "1:1"],
        ["2560x1080", "21:9"],
        ["auto", "16:9"],
        ["", "16:9"],
    ] as const)("snaps video size %s to the MiniMax ratio %s", (size, expected) => {
        expect(snapMinimaxVideoRatio(size)).toBe(expected);
    });

    test("sends the canonical MiniMax-H3-Max model name", async () => {
        const http = vi.spyOn(axios, "request").mockResolvedValue({ data: { task_id: "task-max" } });

        await minimaxVideoAdapter.submit!(h3Request("https://api.minimax.io", "minimax-h3-max"));

        expect(http.mock.calls[0][0]).toMatchObject({
            url: "https://api.minimax.io/v2/video_generation",
            data: { model: "MiniMax-H3-Max", resolution: "768P", duration: 6, ratio: "16:9" },
        });
    });

    test("passes the watermark preference to H3", async () => {
        const http = vi.spyOn(axios, "request").mockResolvedValue({ data: { task_id: "task-h3" } });

        await minimaxVideoAdapter.submit!(h3Request("https://api.minimaxi.com", "MiniMax-H3", { params: { seconds: "6", resolution: "720", ratio: "16:9", watermark: true } }));

        expect(http.mock.calls[0][0]).toMatchObject({ data: { aigc_watermark: true } });
    });

    test("surfaces the MiniMax H3 submission error message", async () => {
        vi.spyOn(axios, "request").mockRejectedValue({
            isAxiosError: true,
            response: { status: 400, data: { type: "error", error: { type: "bad_request_error", message: "invalid params (2013)" } } },
        });

        await expect(minimaxVideoAdapter.submit!(h3Request("https://api.minimaxi.com"))).rejects.toThrow("invalid params (2013)");
    });

    test("rejects a MiniMax video submission without a prompt", async () => {
        const http = vi.spyOn(axios, "request");

        await expect(minimaxVideoAdapter.submit!(h3Request("https://api.minimaxi.com", "MiniMax-H3", { prompt: "   " }))).rejects.toThrow(/prompt|提示词/);
        expect(http).not.toHaveBeenCalled();
    });

    test("submits and queries Hailuo without a user script", async () => {
        const http = vi
            .spyOn(axios, "request")
            .mockResolvedValueOnce({ data: { task_id: "task-1", base_resp: { status_code: 0 } } })
            .mockResolvedValueOnce({ data: { status: "Success", file_id: "file-1", base_resp: { status_code: 0 } } })
            .mockResolvedValueOnce({ data: { file: { download_url: "https://cdn.example/video.mp4" }, base_resp: { status_code: 0 } } });

        const submitted = await minimaxVideoAdapter.submit!(videoRequest("https://api.minimaxi.com"));
        const queried = await minimaxVideoAdapter.query!({ ...videoRequest("https://api.minimaxi.com"), taskId: submitted.taskId });

        expect(submitted).toEqual({ taskId: "task-1" });
        expect(queried).toEqual({ status: "succeeded", result: { kind: "video", source: "https://cdn.example/video.mp4", mimeType: "video/mp4" } });
        expect(http.mock.calls[0][0]).toMatchObject({
            method: "post",
            url: "https://api.minimaxi.com/v1/video_generation",
            data: { model: "MiniMax-Hailuo-2.3", prompt: "camera moves forward", first_frame_image: "data:image/png;base64,Zmlyc3Q=", resolution: "768P", duration: 6 },
        });
        expect(http.mock.calls[1][0]).toMatchObject({ method: "get", url: "https://api.minimaxi.com/v1/query/video_generation", params: { task_id: "task-1" } });
        expect(http.mock.calls[2][0]).toMatchObject({ method: "get", url: "https://api.minimaxi.com/v1/files/retrieve", params: { file_id: "file-1" } });
    });

    test.each(["queued", "running"] as const)("normalizes H3 %s state", async (status) => {
        const http = vi.spyOn(axios, "request").mockResolvedValue({ data: { task: { status } } });

        const queried = await minimaxVideoAdapter.query!({ ...h3Request("https://api.minimaxi.com"), taskId: "task-h3" });

        expect(queried).toEqual({ status: "pending", phase: status === "queued" ? "queued" : "running" });
        expect(http.mock.calls[0][0]).toMatchObject({ method: "get", url: "https://api.minimaxi.com/v2/query/video_generation/task-h3" });
    });

    test("returns the H3 video URL directly without a file lookup", async () => {
        const http = vi.spyOn(axios, "request").mockResolvedValue({ data: { task: { status: "succeeded", content: { url: "https://cdn.example/h3.mp4" } } } });

        const queried = await minimaxVideoAdapter.query!({ ...h3Request("https://api.minimaxi.com"), taskId: "task-h3" });

        expect(queried).toEqual({ status: "succeeded", result: { kind: "video", source: "https://cdn.example/h3.mp4", mimeType: "video/mp4" } });
        expect(http).toHaveBeenCalledTimes(1);
    });

    test("fails an H3 success without a media URL", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { task: { status: "succeeded" } } });

        await expect(minimaxVideoAdapter.query!({ ...h3Request("https://api.minimaxi.com"), taskId: "task-h3" })).resolves.toEqual({
            status: "failed",
            error: "MiniMax did not return a video download URL",
        });
    });

    test("reports an H3 task failure message", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { task: { status: "failed", error: { code: "1026", message: "video description contains sensitive content" } } } });

        await expect(minimaxVideoAdapter.query!({ ...h3Request("https://api.minimaxi.com"), taskId: "task-h3" })).resolves.toEqual({
            status: "failed",
            error: "video description contains sensitive content",
        });
    });

    test("fails a cancelled H3 task without an error message", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { task: { status: "cancelled" } } });

        await expect(minimaxVideoAdapter.query!({ ...h3Request("https://api.minimaxi.com"), taskId: "task-h3" })).resolves.toEqual({
            status: "failed",
            error: "MiniMax video generation failed",
        });
    });

    test("routes Hailuo-3+ models through the v2 protocol", async () => {
        const http = vi
            .spyOn(axios, "request")
            .mockResolvedValueOnce({ data: { task_id: "task-h3" } })
            .mockResolvedValueOnce({ data: { task: { status: "succeeded", content: { url: "https://cdn.example/h3.mp4" } } } });

        const submitted = await minimaxVideoAdapter.submit!(h3Request("https://api.minimaxi.com", "MiniMax-Hailuo-3", { images: ["data:image/png;base64,Zmlyc3Q="] }));
        const queried = await minimaxVideoAdapter.query!({ ...h3Request("https://api.minimaxi.com", "MiniMax-Hailuo-3"), taskId: submitted.taskId });

        expect(queried).toMatchObject({ status: "succeeded" });
        expect(http.mock.calls[0][0]).toMatchObject({ url: "https://api.minimaxi.com/v2/video_generation" });
        expect(http.mock.calls[1][0]).toMatchObject({ url: "https://api.minimaxi.com/v2/query/video_generation/task-h3" });
    });

    test("routes Hailuo-2.x models to /v1/video_generation", async () => {
        const http = vi.spyOn(axios, "request").mockResolvedValueOnce({ data: { task_id: "task-2x", base_resp: { status_code: 0 } } });
        await minimaxVideoAdapter.submit!(videoRequest("https://api.minimaxi.com", "MiniMax-Hailuo-2.3-Fast"));
        expect(http.mock.calls[0][0]).toMatchObject({ method: "post", url: "https://api.minimaxi.com/v1/video_generation" });
    });

    test.each([
        ["Queueing", { status: "pending", phase: "queued" }],
        ["Preparing", { status: "pending", phase: "queued" }],
        ["Processing", { status: "pending", phase: "running" }],
        ["Failed", { status: "failed", error: "render failed" }],
    ] as const)("normalizes Hailuo %s state", async (status, expected) => {
        vi.spyOn(axios, "request").mockResolvedValue({
            data: status === "Failed" ? { status, error_message: "render failed", base_resp: { status_code: 0 } } : { status, base_resp: { status_code: 0 } },
        });

        await expect(minimaxVideoAdapter.query!({ ...videoRequest("https://api.minimax.io"), taskId: "task-1" })).resolves.toEqual(expected);
    });

    test("fails an unknown Hailuo task status instead of polling forever", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { status: "Expired", base_resp: { status_code: 0 } } });

        await expect(minimaxVideoAdapter.query!({ ...videoRequest("https://api.minimax.io"), taskId: "task-1" })).resolves.toEqual({
            status: "failed",
            error: "MiniMax returned an unsupported video task status",
        });
    });

    test.each([42, { state: "Processing" }] as const)("fails a malformed Hailuo task status without throwing", async (status) => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { status, base_resp: { status_code: 0 } } });

        await expect(minimaxVideoAdapter.query!({ ...videoRequest("https://api.minimax.io"), taskId: "task-1" })).resolves.toEqual({
            status: "failed",
            error: "MiniMax returned an invalid video task status",
        });
    });

    test("does not echo an unbounded unknown Hailuo task status", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { status: "x".repeat(100_000), base_resp: { status_code: 0 } } });

        await expect(minimaxVideoAdapter.query!({ ...videoRequest("https://api.minimax.io"), taskId: "task-1" })).resolves.toEqual({
            status: "failed",
            error: "MiniMax returned an unsupported video task status",
        });
    });

    test("fails a missing Hailuo task status instead of polling forever", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { base_resp: { status_code: 0 } } });

        await expect(minimaxVideoAdapter.query!({ ...videoRequest("https://api.minimax.io"), taskId: "task-1" })).resolves.toEqual({
            status: "failed",
            error: "MiniMax did not return a video task status",
        });
    });

    test("rejects MiniMax provider errors", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { base_resp: { status_code: 1008, status_msg: "insufficient balance" } } });

        await expect(minimaxMusicAdapter.generate!(musicRequest("https://api.minimaxi.com", "music-2.6"))).rejects.toThrow("insufficient balance");
    });

    test("rejects an empty Hailuo task ID", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { task_id: "", base_resp: { status_code: 0 } } });

        await expect(minimaxVideoAdapter.submit!(videoRequest("https://api.minimaxi.com"))).rejects.toThrow("MiniMax did not return a video task ID");
    });

    test("rejects a completed Hailuo task without a media URL", async () => {
        vi.spyOn(axios, "request")
            .mockResolvedValueOnce({ data: { status: "Success", file_id: "file-1", base_resp: { status_code: 0 } } })
            .mockResolvedValueOnce({ data: { file: {}, base_resp: { status_code: 0 } } });

        await expect(minimaxVideoAdapter.query!({ ...videoRequest("https://api.minimaxi.com"), taskId: "task-1" })).resolves.toEqual({
            status: "failed",
            error: "MiniMax did not return a video download URL",
        });
    });

    test("reports an expired Hailuo media file as failed", async () => {
        vi.spyOn(axios, "request")
            .mockResolvedValueOnce({ data: { status: "Success", file_id: "file-1", base_resp: { status_code: 0 } } })
            .mockResolvedValueOnce({ data: { base_resp: { status_code: 1024, status_msg: "file expired" } } });

        await expect(minimaxVideoAdapter.query!({ ...videoRequest("https://api.minimaxi.com"), taskId: "task-1" })).resolves.toEqual({ status: "failed", error: "file expired" });
    });
});
