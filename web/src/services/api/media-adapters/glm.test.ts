import axios from "axios";
import { afterEach, describe, expect, test, vi } from "vitest";

import { defaultConfig, type AiConfig } from "@/stores/use-config-store";

import { zhipuImageAdapter, zhipuVideoAdapter } from "./glm";
import { getMediaAdapter } from "./registry";
import type { MediaGenerateRequest } from "./types";

function glmRequest(model: string, overrides: Partial<MediaGenerateRequest> = {}): MediaGenerateRequest {
    const config: AiConfig = {
        ...defaultConfig,
        baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
        apiKey: "secret",
        model,
        size: "1280x1280",
        vquality: "1920x1080",
        videoGenerateAudio: "true",
    };
    return { config, prompt: "draw a cat", images: [], params: {}, ...overrides };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("Zhipu GLM media adapters", () => {
    test("registers the image and video adapters by their resolved IDs", () => {
        expect([getMediaAdapter("zhipu.image"), getMediaAdapter("zhipu.video")]).toEqual([zhipuImageAdapter, zhipuVideoAdapter]);
    });

    test("submits GLM-Image to the official async endpoint", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { id: "image-task", task_status: "PROCESSING" } });

        await expect(zhipuImageAdapter.submit!(glmRequest("glm-image", { params: { size: "1:1", resolution: "720" } }))).resolves.toEqual({ taskId: "image-task" });
        expect(axios.post).toHaveBeenCalledWith(
            "https://open.bigmodel.cn/api/paas/v4/async/images/generations",
            { model: "glm-image", prompt: "draw a cat", size: "1280x1280" },
            { headers: { Authorization: "Bearer secret", "Content-Type": "application/json" }, signal: undefined },
        );
    });

    test.each([
        ["1:1", "1280x1280"],
        ["3:2", "1568x1056"],
        ["2:3", "1056x1568"],
        ["4:3", "1472x1088"],
        ["3:4", "1088x1472"],
        ["16:9", "1728x960"],
        ["9:16", "960x1728"],
        ["2048x1024", "2048x1024"],
        ["auto", "1280x1280"],
        ["", "1280x1280"],
    ] as const)("normalizes GLM-Image canvas size %s to %s", async (size, expectedSize) => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { id: "image-task", task_status: "PROCESSING" } });

        await zhipuImageAdapter.submit!(glmRequest("glm-image", { params: { size } }));

        expect(axios.post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ size: expectedSize }), expect.anything());
    });

    test("rejects a malformed GLM-Image size before making a request", async () => {
        const post = vi.spyOn(axios, "post").mockResolvedValue({ data: { id: "image-task", task_status: "PROCESSING" } });

        await expect(zhipuImageAdapter.submit!(glmRequest("glm-image", { params: { size: "large" } }))).rejects.toThrow(
            "Zhipu image size must be WIDTHxHEIGHT or a supported aspect ratio",
        );
        expect(post).not.toHaveBeenCalled();
    });

    test("does not send reference images to the text-only GLM-Image endpoint", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { id: "image-task", task_status: "PROCESSING" } });

        await zhipuImageAdapter.submit!(glmRequest("glm-image", { images: ["data:image/png;base64,aW1hZ2U="] }));

        expect(axios.post).toHaveBeenCalledWith(expect.anything(), expect.not.objectContaining({ image_url: expect.anything() }), expect.anything());
    });

    test("submits CogVideoX with its supported first frame, audio, and resolution fields", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { id: "video-task", task_status: "PROCESSING" } });

        await expect(
            zhipuVideoAdapter.submit!(
                glmRequest("cogvideox-3", {
                    prompt: "camera moves forward",
                    images: ["data:image/png;base64,Zmlyc3Q="],
                    params: { generateAudio: false, size: "1280x720", resolution: "720" },
                }),
            ),
        ).resolves.toEqual({ taskId: "video-task" });
        expect(axios.post).toHaveBeenCalledWith(
            "https://open.bigmodel.cn/api/paas/v4/videos/generations",
            {
                model: "cogvideox-3",
                prompt: "camera moves forward",
                image_url: "data:image/png;base64,Zmlyc3Q=",
                with_audio: false,
                size: "1280x720",
            },
            { headers: { Authorization: "Bearer secret", "Content-Type": "application/json" }, signal: undefined },
        );
    });

    test.each([
        ["16:9", "1280x720"],
        ["3:2", "1280x720"],
        ["4:3", "1280x720"],
        ["9:16", "720x1280"],
        ["2:3", "720x1280"],
        ["3:4", "720x1280"],
        ["1:1", "1024x1024"],
    ] as const)("maps CogVideoX canvas ratio %s to %s", async (size, expectedSize) => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { id: "video-task", task_status: "PROCESSING" } });

        await zhipuVideoAdapter.submit!(glmRequest("cogvideox-3", { params: { size, resolution: "720" } }));

        expect(axios.post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ size: expectedSize }), expect.anything());
    });

    test.each(["", "auto"])("omits CogVideoX size for provider-default value %j", async (size) => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { id: "video-task", task_status: "PROCESSING" } });

        await zhipuVideoAdapter.submit!(glmRequest("cogvideox-3", { params: { size, resolution: "720" } }));

        expect(axios.post).toHaveBeenCalledWith(expect.anything(), expect.not.objectContaining({ size: expect.anything() }), expect.anything());
    });

    test("rejects a malformed CogVideoX size before making a request", async () => {
        const post = vi.spyOn(axios, "post").mockResolvedValue({ data: { id: "video-task", task_status: "PROCESSING" } });

        await expect(zhipuVideoAdapter.submit!(glmRequest("cogvideox-3", { params: { size: "720p", resolution: "720" } }))).rejects.toThrow(
            "Zhipu video size must be WIDTHxHEIGHT, auto, or a supported aspect ratio",
        );
        expect(post).not.toHaveBeenCalled();
    });

    test("queries only the documented Zhipu async-result endpoint", async () => {
        vi.spyOn(axios, "get").mockResolvedValue({ data: { task_status: "PROCESSING", result_url: "https://attacker.example/result" } });

        await expect(zhipuVideoAdapter.query!({ ...glmRequest("cogvideox-3"), taskId: "video/task" })).resolves.toEqual({ status: "pending", phase: "running" });
        expect(axios.get).toHaveBeenCalledWith("https://open.bigmodel.cn/api/paas/v4/async-result/video%2Ftask", {
            headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
            signal: undefined,
        });
    });

    test("maps a completed GLM-Image task to image URLs", async () => {
        vi.spyOn(axios, "get").mockResolvedValue({
            data: { task_status: "SUCCESS", image_result: [{ url: "https://cdn.example/one.png" }, { url: "https://cdn.example/two.png" }] },
        });

        await expect(zhipuImageAdapter.query!({ ...glmRequest("glm-image"), taskId: "image-task" })).resolves.toEqual({
            status: "succeeded",
            result: { kind: "image", sources: ["https://cdn.example/one.png", "https://cdn.example/two.png"] },
        });
    });

    test("maps a completed CogVideoX task to a video URL", async () => {
        vi.spyOn(axios, "get").mockResolvedValue({ data: { task_status: "SUCCESS", video_result: [{ url: "https://cdn.example/cog.mp4" }] } });

        await expect(zhipuVideoAdapter.query!({ ...glmRequest("cogvideox-3"), taskId: "video-task" })).resolves.toEqual({
            status: "succeeded",
            result: { kind: "video", source: "https://cdn.example/cog.mp4", mimeType: "video/mp4" },
        });
    });

    test.each([zhipuImageAdapter, zhipuVideoAdapter])("maps PROCESSING to a running task for $id", async (adapter) => {
        vi.spyOn(axios, "get").mockResolvedValue({ data: { task_status: "PROCESSING" } });

        await expect(adapter.query!({ ...glmRequest(adapter.modality === "image" ? "glm-image" : "cogvideox-3"), taskId: "task" })).resolves.toEqual({
            status: "pending",
            phase: "running",
        });
    });

    test.each(["FAIL", "FAILED"])("maps %s to the provider failure message", async (taskStatus) => {
        vi.spyOn(axios, "get").mockResolvedValue({ data: { task_status: taskStatus, error: { message: "content rejected" } } });

        await expect(zhipuVideoAdapter.query!({ ...glmRequest("cogvideox-3"), taskId: "video-task" })).resolves.toEqual({
            status: "failed",
            error: "content rejected",
        });
    });

    test("uses a fixed diagnostic when a failed task has no provider message", async () => {
        vi.spyOn(axios, "get").mockResolvedValue({ data: { task_status: "FAIL" } });

        await expect(zhipuImageAdapter.query!({ ...glmRequest("glm-image"), taskId: "image-task" })).resolves.toEqual({
            status: "failed",
            error: "Zhipu image task failed",
        });
    });

    test.each([
        [null, "Zhipu returned an invalid media task payload"],
        [{}, "Zhipu did not return a media task status"],
        [{ task_status: 42 }, "Zhipu returned an invalid media task status"],
        [{ task_status: "EXPIRED" }, "Zhipu returned an unsupported media task status"],
    ] as const)("fails a malformed or unknown task state without indefinite polling", async (data, error) => {
        vi.spyOn(axios, "get").mockResolvedValue({ data });

        await expect(zhipuVideoAdapter.query!({ ...glmRequest("cogvideox-3"), taskId: "video-task" })).resolves.toEqual({ status: "failed", error });
    });

    test("does not echo an unbounded unknown task status", async () => {
        vi.spyOn(axios, "get").mockResolvedValue({ data: { task_status: "x".repeat(100_000) } });

        await expect(zhipuVideoAdapter.query!({ ...glmRequest("cogvideox-3"), taskId: "video-task" })).resolves.toEqual({
            status: "failed",
            error: "Zhipu returned an unsupported media task status",
        });
    });

    test.each([
        [zhipuImageAdapter, "glm-image", "Zhipu did not return an image task ID"],
        [zhipuVideoAdapter, "cogvideox-3", "Zhipu did not return a video task ID"],
    ] as const)("rejects a missing task ID from $id", async (adapter, model, error) => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { id: "", task_status: "PROCESSING" } });

        await expect(adapter.submit!(glmRequest(model))).rejects.toThrow(error);
    });

    test("rejects a completed GLM-Image task without an image result", async () => {
        vi.spyOn(axios, "get").mockResolvedValue({ data: { task_status: "SUCCESS", image_result: [] } });

        await expect(zhipuImageAdapter.query!({ ...glmRequest("glm-image"), taskId: "image-task" })).rejects.toThrow("Zhipu did not return an image result URL");
    });

    test("rejects a completed CogVideoX task without a video result", async () => {
        vi.spyOn(axios, "get").mockResolvedValue({ data: { task_status: "SUCCESS", video_result: [{}] } });

        await expect(zhipuVideoAdapter.query!({ ...glmRequest("cogvideox-3"), taskId: "video-task" })).rejects.toThrow("Zhipu did not return a video result URL");
    });

    test("rejects a submit provider error without exposing the API key", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { error: { code: "1214", message: "model unavailable" } } });

        await expect(zhipuImageAdapter.submit!(glmRequest("glm-image"))).rejects.toThrow("model unavailable");
    });

    test("maps a query provider error to a failed task", async () => {
        vi.spyOn(axios, "get").mockResolvedValue({ data: { error: { code: "1214", message: "task rejected" } } });

        await expect(zhipuVideoAdapter.query!({ ...glmRequest("cogvideox-3"), taskId: "video-task" })).resolves.toEqual({ status: "failed", error: "task rejected" });
    });

    test("leaves transport failures throwable for runner retries", async () => {
        vi.spyOn(axios, "get").mockRejectedValue(new Error("network unavailable"));

        await expect(zhipuVideoAdapter.query!({ ...glmRequest("cogvideox-3"), taskId: "video-task" })).rejects.toThrow("network unavailable");
    });
});
