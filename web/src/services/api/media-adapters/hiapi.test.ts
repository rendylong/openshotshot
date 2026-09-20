import axios from "axios";
import { afterEach, describe, expect, test, vi } from "vitest";

import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import i18n from "@/i18n";

import { hiapiAudioAdapter, hiapiImageAdapter, hiapiMusicAdapter, hiapiVideoAdapter } from "./hiapi";
import { getMediaAdapter } from "./registry";
import type { MediaGenerateRequest } from "./types";


function request(model: string, overrides: Partial<MediaGenerateRequest> = {}): MediaGenerateRequest {
    const config: AiConfig = {
        ...defaultConfig,
        baseUrl: "https://api.hiapi.ai",
        apiKey: "secret",
        model,
        size: "16:9",
        vquality: "720",
        videoSeconds: "6",
        videoGenerateAudio: "true",
        audioVoice: "longanlingxin",
        audioFormat: "mp3",
    };
    return { config, prompt: "a product shot", images: [], params: {}, ...overrides };
}

afterEach(() => vi.restoreAllMocks());

describe("HiAPI media adapters", () => {
    test("registers all unified async adapters", () => {
        expect([getMediaAdapter("hiapi.image"), getMediaAdapter("hiapi.video"), getMediaAdapter("hiapi.speech"), getMediaAdapter("hiapi.music")]).toEqual([hiapiImageAdapter, hiapiVideoAdapter, hiapiAudioAdapter, hiapiMusicAdapter]);
    });

    test("submits GPT Image 2 to /v1/tasks with normalized input", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { code: 200, data: { taskId: "tk-hiapi-image" } } });

        await expect(hiapiImageAdapter.submit!(request("gpt-image-2/text-to-image", { params: { ratio: "16:9", quality: "high" } }))).resolves.toEqual({ taskId: "tk-hiapi-image" });
        expect(axios.post).toHaveBeenCalledWith(
            "https://api.hiapi.ai/v1/tasks",
            { model: "gpt-image-2/text-to-image", input: { prompt: "a product shot", aspect_ratio: "16:9", resolution: "4K" } },
            { headers: { Authorization: "Bearer secret", "Content-Type": "application/json" }, signal: undefined },
        );
    });

    test("i2i-only 模型零参考图：本地报错不发起请求", async () => {
        const post = vi.spyOn(axios, "post");
        await expect(hiapiImageAdapter.submit!(request("gpt-image-2/image-to-image"))).rejects.toThrow(i18n.t("apiErrors.hiapiImageToImageNeedsReference", { model: "gpt-image-2/image-to-image" }));
        expect(post).not.toHaveBeenCalled();
    });

    test("i2i-only 模型带参考图：正常提交（回归）", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { code: 200, data: { taskId: "tk-i2i" } } });
        await expect(hiapiImageAdapter.submit!(request("gpt-image-2/image-to-image", { images: ["https://example.com/a.png"] }))).resolves.toEqual({ taskId: "tk-i2i" });
    });

    test("switches GPT Image 2 to image-to-image when a reference is provided", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-hiapi-image" } } });

        await hiapiImageAdapter.submit!(request("gpt-image-2/text-to-image", { images: ["https://cdn.example/input.png"] }));

        expect(axios.post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: "gpt-image-2/image-to-image", input: expect.objectContaining({ input_urls: ["https://cdn.example/input.png"] }) }), expect.anything());
    });

    test("submits Qwen Image 3.0 image-to-image with image_urls array", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-hiapi-qwen-i2i" } } });

        await hiapiImageAdapter.submit!(request("qwen-image-3.0/text-to-image", { images: ["https://cdn.example/ref.png"], params: { ratio: "1:1" } }));

        expect(axios.post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: "qwen-image-3.0/image-to-image", input: expect.objectContaining({ image_urls: ["https://cdn.example/ref.png"] }) }), expect.anything());
    });

    test("submits Flux 2 image-to-image with image_urls array", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-hiapi-flux-i2i" } } });

        await hiapiImageAdapter.submit!(request("flux-2/text-to-image", { images: ["https://cdn.example/ref.png"], params: { ratio: "16:9" } }));

        expect(axios.post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: "flux-2/image-to-image", input: expect.objectContaining({ image_urls: ["https://cdn.example/ref.png"] }) }), expect.anything());
    });

    test("submits Grok Imagine 2.0 image-to-image with single image string", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-hiapi-grok-i2i" } } });

        await hiapiImageAdapter.submit!(request("grok-imagine-image-2.0/text-to-image", { images: ["https://cdn.example/ref.png"] }));

        expect(axios.post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: "grok-imagine-image-2.0/image-to-image", input: expect.objectContaining({ image: "https://cdn.example/ref.png" }) }), expect.anything());
    });

    test("submits Grok Imagine quality image-to-image with image_urls array", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-hiapi-grok-q" } } });

        await hiapiImageAdapter.submit!(request("grok-imagine-quality/text-to-image", { images: ["https://cdn.example/ref.png"] }));

        expect(axios.post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: "grok-imagine-quality/image-to-image", input: expect.objectContaining({ image_urls: ["https://cdn.example/ref.png"] }) }), expect.anything());
    });

    test("omits image field for text-only models even when a reference is attached", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-hiapi-t2i" } } });

        // An unknown image-to-image model with an unrecognised field has no plan; request must omit the image field entirely.
        await hiapiImageAdapter.submit!(request("custom-text-to-image", { images: ["https://cdn.example/ref.png"] }));

        const call = vi.mocked(axios.post).mock.calls[0];
        expect(call?.[1]).toEqual(expect.objectContaining({ model: "custom-text-to-image", input: expect.not.objectContaining({ input_urls: true, image_urls: true, image: true }) }));
    });

    test("submits Veo image-to-video with documented image_url input", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-hiapi-video" } } });

        await hiapiVideoAdapter.submit!(request("veo-3.1/image-to-video", { images: ["https://cdn.example/input.png"], params: { seconds: 8, resolution: "1080", generateAudio: false } }));

        expect(axios.post).toHaveBeenCalledWith(
            expect.anything(),
            { model: "veo-3.1/image-to-video", input: { prompt: "a product shot", image_url: "https://cdn.example/input.png", aspect_ratio: "16:9", resolution: "1080p", duration: 8, generate_audio: false } },
            expect.anything(),
        );
    });

    test("submits Seedance 2.5 image-to-video with first_frame_url", async () => {
        vi.spyOn(axios, "get").mockImplementation(async (url) => {
            if (typeof url === "string" && url.includes("/docs/models.json")) {
                return {
                    data: {
                        models: [
                            {
                                id: "seedance-2.5/image-to-video",
                                title: "Seedance 2.5 Image to Video API",
                                category: "video",
                                capability: "Video generation (image-to-video)",
                                input: [
                                    { name: "prompt", type: "string", required: true },
                                    { name: "first_frame_url", type: "string", required: false },
                                    { name: "resolution", type: "enum", required: false, enum: ["720p", "1080p"], default: "720p" },
                                    { name: "aspect_ratio", type: "enum", required: false, enum: ["adaptive"], default: "adaptive" },
                                    { name: "duration", type: "integer", required: false, default: 5 },
                                ],
                            },
                        ],
                    },
                };
            }
            return { data: { data: { taskId: "tk-hiapi-seedance-i2v" } } };
        });
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-hiapi-seedance-i2v" } } } as never);
        const catalogModule = await import("./hiapi-catalog");
        await catalogModule.fetchHiapiCatalog({ force: true });

        await hiapiVideoAdapter.submit!(request("seedance-2.5/image-to-video", { images: ["https://cdn.example/first-frame.jpg"], params: { seconds: 6, size: "1280x720", resolution: "720", generateAudio: true } }));

        expect(axios.post).toHaveBeenCalledWith(
            expect.anything(),
            { model: "seedance-2.5/image-to-video", input: { prompt: "a product shot", first_frame_url: "https://cdn.example/first-frame.jpg", aspect_ratio: "adaptive", resolution: "720p", duration: 6, generate_audio: true } },
            expect.anything(),
        );
    });

    test("submits Seedance 2.5 reference-to-video with reference_image_urls array", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-hiapi-seedance-r2v" } } });

        await hiapiVideoAdapter.submit!(request("seedance-2.5/reference-to-video", { images: ["https://cdn.example/subject.jpg"], params: { seconds: 8 } }));

        expect(axios.post).toHaveBeenCalledWith(
            expect.anything(),
            { model: "seedance-2.5/reference-to-video", input: { prompt: "a product shot", reference_image_urls: ["https://cdn.example/subject.jpg"], aspect_ratio: "16:9", resolution: "720p", duration: 8, generate_audio: true } },
            expect.anything(),
        );
    });

    test("submits Seedance 2.0 mini with first_frame_url when an image is attached", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-hiapi-seedance-mini" } } });

        await hiapiVideoAdapter.submit!(request("seedance-2.0-mini", { images: ["https://cdn.example/first.jpg"], params: { seconds: 6, resolution: "720" } }));

        expect(axios.post).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ model: "seedance-2.0-mini", input: expect.objectContaining({ first_frame_url: "https://cdn.example/first.jpg", duration: 6, resolution: "720p" }) }),
            expect.anything(),
        );
    });

    test("submits Kling 3.0 Turbo image-to-video with image_urls array", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-hiapi-kling" } } });

        await hiapiVideoAdapter.submit!(request("kling-3.0-turbo/image-to-video", { images: ["https://cdn.example/first.jpg"], params: { seconds: 6, resolution: "1080" } }));

        expect(axios.post).toHaveBeenCalledWith(
            expect.anything(),
            { model: "kling-3.0-turbo/image-to-video", input: { prompt: "a product shot", image_urls: ["https://cdn.example/first.jpg"], aspect_ratio: "16:9", resolution: "1080p", duration: 6, generate_audio: true } },
            expect.anything(),
        );
    });

    test("submits HappyHorse 1.1 image-to-video with image_urls array", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-hiapi-hh" } } });

        await hiapiVideoAdapter.submit!(request("happyhorse-1.1/image-to-video", { images: ["https://cdn.example/first.jpg"], params: { seconds: 5 } }));

        expect(axios.post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: "happyhorse-1.1/image-to-video", input: expect.objectContaining({ image_urls: ["https://cdn.example/first.jpg"] }) }), expect.anything());
    });

    test("submits Grok Imagine image-to-video with image_urls array", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-hiapi-grok" } } });

        await hiapiVideoAdapter.submit!(request("grok-imagine/image-to-video", { images: ["https://cdn.example/first.jpg"], params: { seconds: 6 } }));

        expect(axios.post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: "grok-imagine/image-to-video", input: expect.objectContaining({ image_urls: ["https://cdn.example/first.jpg"] }) }), expect.anything());
    });

    test("submits Hailuo 2.3 image-to-video with single image_url", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-hiapi-hailuo" } } });

        await hiapiVideoAdapter.submit!(request("hailuo-2.3/image-to-video", { images: ["https://cdn.example/first.jpg"], params: { seconds: 6 } }));

        expect(axios.post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: "hailuo-2.3/image-to-video", input: expect.objectContaining({ image_url: "https://cdn.example/first.jpg" }) }), expect.anything());
    });

    test("submits Wan 2.7 video image-to-video with media first_frame descriptor", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-hiapi-wan" } } });

        await hiapiVideoAdapter.submit!(request("wan2.7-video/image-to-video", { images: ["https://cdn.example/first.jpg"], params: { seconds: 6 } }));

        expect(axios.post).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ model: "wan2.7-video/image-to-video", input: expect.objectContaining({ media: [{ type: "first_frame", url: "https://cdn.example/first.jpg" }] }) }),
            expect.anything(),
        );
    });

    test("coerces video resolution to the catalog enum (minimax-h3 -> 2K)", async () => {
        vi.spyOn(axios, "get").mockImplementation(async (url) => {
            if (typeof url === "string" && url.includes("/docs/models.json")) {
                return {
                    data: {
                        models: [
                            {
                                id: "minimax-h3",
                                title: "minimax-h3",
                                category: "video",
                                capability: "Video generation (text-to-video)",
                                input: [
                                    { name: "prompt", type: "string", required: true },
                                    { name: "resolution", type: "enum", required: false, enum: ["2K"], default: "2K" },
                                    { name: "aspect_ratio", type: "enum", required: false, enum: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"], default: "16:9" },
                                    { name: "duration", type: "integer", required: false, default: 5 },
                                ],
                            },
                        ],
                    },
                };
            }
            return { data: { data: { status: "queued" } } };
        });
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-h3" } } } as never);
        const catalogModule = await import("./hiapi-catalog");
        await catalogModule.fetchHiapiCatalog({ force: true });

        await hiapiVideoAdapter.submit!(request("minimax-h3", { params: { seconds: 6, resolution: "720" } }));

        expect(axios.post).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                model: "minimax-h3",
                input: expect.objectContaining({ resolution: "2K", aspect_ratio: "16:9", duration: 6 }),
            }),
            expect.anything(),
        );
    });

    test("surfaces HiAPI error message instead of generic HTTP failure", async () => {
        const axiosError = Object.assign(new Error("Request failed with status code 400"), { isAxiosError: true, response: { status: 400, data: { error: { code: "invalid_parameter", message: "first_frame_url is required for image-to-video" } } } });
        vi.spyOn(axios, "post").mockRejectedValue(axiosError);

        await expect(hiapiVideoAdapter.submit!(request("seedance-2.5/image-to-video", { images: ["https://cdn.example/first.jpg"], params: { seconds: 6 } }))).rejects.toThrow("first_frame_url is required for image-to-video");
    });

    test("falls back to default error when HiAPI returns no readable message", async () => {
        const axiosError = Object.assign(new Error("Request failed with status code 500"), { isAxiosError: true, response: { status: 500, data: {} } });
        vi.spyOn(axios, "post").mockRejectedValue(axiosError);

        await expect(hiapiVideoAdapter.submit!(request("veo-3.1/image-to-video"))).rejects.toThrow("Request failed with status code 500");
    });

    test("uses HiAPI catalog to pick first_frame_url for catalog-only image-to-video models", async () => {
        // The default HiAPI regex already covers seedance-2.5, so we use a future family not yet in the regex to prove catalog routing wins.
        vi.spyOn(axios, "get").mockImplementation(async (url) => {
            if (typeof url === "string" && url.includes("/docs/models.json")) {
                return {
                    data: {
                        models: [
                            {
                                id: "future-model/image-to-video",
                                title: "Future Model",
                                category: "video",
                                capability: "Video generation (image-to-video)",
                                input: [
                                    { name: "prompt", type: "string", required: true },
                                    { name: "first_frame_url", type: "string", required: false },
                                ],
                            },
                        ],
                    },
                };
            }
            return { data: { data: { status: "queued" } } };
        });
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-future" } } } as never);
        const catalogModule = await import("./hiapi-catalog");
        await catalogModule.fetchHiapiCatalog({ force: true });

        await hiapiVideoAdapter.submit!(request("future-model/image-to-video", { images: ["https://cdn.example/first.jpg"], params: { seconds: 6 } }));

        expect(axios.post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: "future-model/image-to-video", input: expect.objectContaining({ first_frame_url: "https://cdn.example/first.jpg" }) }), expect.anything());
    });

    test("falls back to built-in regex when catalog is empty for unsupported model", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-fb" } } });

        await hiapiVideoAdapter.submit!(request("seedance-2.5/image-to-video", { images: ["https://cdn.example/first.jpg"], params: { seconds: 6 } }));

        expect(axios.post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: "seedance-2.5/image-to-video", input: expect.objectContaining({ first_frame_url: "https://cdn.example/first.jpg" }) }), expect.anything());
    });

    test("submits Qwen TTS with async text/voice fields", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-hiapi-audio" } } });

        await hiapiAudioAdapter.submit!(request("qwen-audio-3.0-tts-plus", { prompt: "hello", params: { voice: "longanlufeng", format: "wav", speed: 1.2, instructions: "warm" } }));

        expect(axios.post).toHaveBeenCalledWith(expect.anything(), { model: "qwen-audio-3.0-tts-plus", input: { text: "hello", voice: "longanlufeng", format: "wav", rate: 1.2, instruction: "warm" } }, expect.anything());
    });

    test("maps HiAPI task states and filters output by media type", async () => {
        const get = vi.spyOn(axios, "get");
        get.mockResolvedValueOnce({ data: { code: 200, data: { status: "queued" } } });
        await expect(hiapiVideoAdapter.query!({ ...request("veo-3.1/text-to-video"), taskId: "tk-hiapi-video" })).resolves.toEqual({ status: "pending", phase: "queued" });

        get.mockResolvedValueOnce({
            data: {
                code: 200,
                data: {
                    status: "success",
                    output: [
                        { type: "first_frame", url: "https://cdn.example/frame.jpg" },
                        { type: "video", url: "https://cdn.example/video.mp4" },
                    ],
                },
            },
        });
        await expect(hiapiVideoAdapter.query!({ ...request("veo-3.1/text-to-video"), taskId: "tk-hiapi-video" })).resolves.toEqual({ status: "succeeded", result: { kind: "video", source: "https://cdn.example/video.mp4", mimeType: "video/mp4" } });

        get.mockResolvedValueOnce({ data: { code: 200, data: { status: "success", output: [{ type: "audio", url: "https://cdn.example/speech.wav" }] } } });
        const audioRequest = request("qwen-audio-3.0-tts-plus");
        audioRequest.config.audioFormat = "wav";
        await expect(hiapiAudioAdapter.query!({ ...audioRequest, taskId: "tk-hiapi-audio" })).resolves.toEqual({
            status: "succeeded",
            result: { kind: "audio", source: "https://cdn.example/speech.wav", mimeType: "audio/wav" },
        });
    });

    test("maps failures and rejects missing task IDs", async () => {
        vi.spyOn(axios, "post").mockResolvedValue({ data: { code: 200, data: {} } });
        await expect(hiapiMusicAdapter.submit!(request("minimax-music-1.5"))).rejects.toThrow(i18n.t("apiErrors.hiapiTaskId"));

        vi.spyOn(axios, "get").mockResolvedValue({ data: { code: 200, data: { status: "fail", error: { message: "content rejected" } } } });
        await expect(hiapiAudioAdapter.query!({ ...request("qwen-audio-3.0-tts-plus"), taskId: "tk-hiapi-audio" })).resolves.toEqual({ status: "failed", error: "content rejected" });
    });
});

describe("HiAPI idempotent submission", () => {
    test("sends the Idempotency-Key header when the request carries one", async () => {
        const post = vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-key" } } });
        await hiapiImageAdapter.submit!(request("gpt-image-2/text-to-image", { idempotencyKey: "key-1" }));
        expect(post.mock.calls[0]![2]).toMatchObject({ headers: { "Idempotency-Key": "key-1" } });
    });

    test("omits the header when no key is present", async () => {
        const post = vi.spyOn(axios, "post").mockResolvedValue({ data: { data: { taskId: "tk-plain" } } });
        await hiapiImageAdapter.submit!(request("gpt-image-2/text-to-image"));
        expect(post.mock.calls[0]![2]).not.toHaveProperty(["headers", "Idempotency-Key"]);
    });

    test("maps 409 + Retry-After to an idempotency-pending error with a clamped wait", async () => {
        const conflict = Object.assign(new Error("conflict"), { isAxiosError: true, response: { status: 409, headers: { "retry-after": "3" } } });
        vi.spyOn(axios, "post").mockRejectedValue(conflict);
        await expect(hiapiImageAdapter.submit!(request("gpt-image-2/text-to-image", { idempotencyKey: "key-2" }))).rejects.toMatchObject({ idempotencyPending: true, retryAfterMs: 3_000 });
    });

    test("uses the default wait when Retry-After is missing or invalid", async () => {
        const conflict = Object.assign(new Error("conflict"), { isAxiosError: true, response: { status: 409, headers: {} } });
        vi.spyOn(axios, "post").mockRejectedValue(conflict);
        await expect(hiapiImageAdapter.submit!(request("gpt-image-2/text-to-image", { idempotencyKey: "key-2" }))).rejects.toMatchObject({ idempotencyPending: true, retryAfterMs: 2_000 });
    });

    test("treats a 409 without a key as a plain provider error", async () => {
        const conflict = Object.assign(new Error("conflict"), { isAxiosError: true, response: { status: 409, headers: {}, data: { error: { message: "conflict" } } } });
        vi.spyOn(axios, "post").mockRejectedValue(conflict);
        await expect(hiapiImageAdapter.submit!(request("gpt-image-2/text-to-image"))).rejects.toThrow("conflict");
    });

    test("surfaces 422 key-mismatch messages without retry", async () => {
        const mismatch = Object.assign(new Error("mismatch"), { isAxiosError: true, response: { status: 422, headers: {}, data: { error: { message: "IDEMPOTENCY_KEY_MISMATCH" } } } });
        vi.spyOn(axios, "post").mockRejectedValue(mismatch);
        await expect(hiapiImageAdapter.submit!(request("gpt-image-2/text-to-image", { idempotencyKey: "key-3" }))).rejects.toThrow("IDEMPOTENCY_KEY_MISMATCH");
    });
});
