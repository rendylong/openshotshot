import axios from "axios";
import { afterEach, describe, expect, it, test, vi } from "vitest";

import i18n from "@/i18n";
import { resolveProvider } from "@/lib/models/model-resolver";
import { requestAudioGeneration } from "@/services/api/audio";
import { fetchChannelModels, requestEdit, requestGeneration, requestImageQuestion } from "@/services/api/image";
import { minimaxVideoAdapter } from "@/services/api/media-adapters/minimax";
import {
    geminiImageAdapter,
    geminiSpeechAdapter,
    geminiVideoAdapter,
    openAIImageAdapter,
    openAISpeechAdapter,
    openAIVideoAdapter,
} from "@/services/api/media-adapters/openai-gemini";
import { getMediaAdapter } from "@/services/api/media-adapters/registry";
import { providerChatUrl, providerModelsUrl } from "@/services/api/provider-endpoints";
import { createModelChannel, defaultConfig, encodeChannelModel, modelOptionsFromChannels, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

function minimaxConfig(capability: ModelCapability, model: string): AiConfig {
    const channel = createModelChannel({ id: "minimax-cn", provider: "minimax-cn", apiKey: "secret" });
    const selected = encodeChannelModel(channel.id, model);
    return {
        ...defaultConfig,
        compressReferenceImages: false,
        channels: [channel],
        models: modelOptionsFromChannels([channel]),
        model: selected,
        imageModel: capability === "image" ? selected : "",
        videoModel: capability === "video" ? selected : "",
        audioModel: capability === "audio" ? selected : "",
        textModel: capability === "text" ? selected : "",
        agentModel: capability === "text" ? selected : "",
        size: "16:9",
        count: "1",
    };
}

function officialMediaRequest(baseUrl: string, model: string, apiFormat: "openai" | "gemini" = "openai") {
    return {
        config: {
            ...defaultConfig,
        compressReferenceImages: false,
            baseUrl,
            apiKey: "secret",
            apiFormat,
            model,
            size: "16:9",
            count: "1",
            audioVoice: "Kore",
            audioFormat: "wav",
            audioSpeed: "1",
            videoSeconds: "6",
            vquality: "720",
        },
        prompt: "create media",
        images: [] as string[],
        params: {} as Record<string, unknown>,
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("official provider text protocols", () => {
    test.each([
        ["moonshot", "https://api.moonshot.cn/v1", "https://api.moonshot.cn/v1/chat/completions", "https://api.moonshot.cn/v1/models"],
        ["zhipu", "https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/paas/v4/chat/completions", "https://open.bigmodel.cn/api/paas/v4/models"],
        ["deepseek", "https://api.deepseek.com", "https://api.deepseek.com/chat/completions", "https://api.deepseek.com/models"],
        ["hiapi", "https://api.hiapi.ai", "https://api.hiapi.ai/v1/chat/completions", "https://api.hiapi.ai/v1/models"],
    ] as const)("builds %s endpoints without duplicate version segments", (provider, baseUrl, chatUrl, modelsUrl) => {
        expect(providerChatUrl(provider, baseUrl)).toBe(chatUrl);
        expect(providerModelsUrl(provider, baseUrl)).toBe(modelsUrl);
    });

    test("preserves exact upstream model IDs when refreshing an official channel", async () => {
        const channel = createModelChannel({ provider: "moonshot", apiKey: "secret" });
        vi.spyOn(axios, "get").mockResolvedValue({ data: { data: [{ id: "kimi-k2.5" }, { id: "glm-image" }, { id: "cogvideox-3" }] } } as never);

        await expect(fetchChannelModels(channel)).resolves.toEqual(["cogvideox-3", "glm-image", "kimi-k2.5"]);
        expect(axios.get).toHaveBeenCalledWith("https://api.moonshot.cn/v1/models", { headers: { Authorization: "Bearer secret" } });
    });

    test.each([
        ["minimax-cn", undefined, "MiniMax-M2.7", "https://api.minimaxi.com/v1/chat/completions"],
        ["deepseek", undefined, "deepseek-v4-flash", "https://api.deepseek.com/chat/completions"],
        ["moonshot", undefined, "kimi-k2.5", "https://api.moonshot.cn/v1/chat/completions"],
        ["zhipu", undefined, "glm-5.2", "https://open.bigmodel.cn/api/paas/v4/chat/completions"],
        ["custom", "https://api.moonshot.cn/v1", "kimi-k2.5", "https://api.moonshot.cn/v1/chat/completions"],
    ] as const)("streams %s text through Chat Completions", async (provider, baseUrl, model, endpoint) => {
        const channel = createModelChannel({ id: provider, provider, baseUrl, apiKey: "secret", models: [{ name: model, capability: "text" }] });
        const selected = encodeChannelModel(channel.id, model);
        const config = { ...defaultConfig,
        compressReferenceImages: false, channels: [channel], models: modelOptionsFromChannels([channel]), model: selected, textModel: selected, agentModel: selected };
        const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
            expect(url).toBe(endpoint);
            expect(JSON.parse(String(init?.body))).toMatchObject({ model, stream: true, messages: [{ role: "user", content: "hello" }] });
            return { ok: true, body: null, json: async () => ({ choices: [{ message: { content: "world" } }] }) } as Response;
        });
        vi.stubGlobal("fetch", fetchMock);
        const onDelta = vi.fn();

        const answer = await requestImageQuestion(config, [{ role: "user", content: "hello" }], onDelta);

        expect(answer).toBe("world");
        expect(onDelta).toHaveBeenLastCalledWith("world");
    });

    test("does not infer a Chat Completions provider from a spoofed host", () => {
        expect(resolveProvider("custom", "https://api.moonshot.cn.attacker.test/v1", "openai")).toBe("custom");
    });
});

describe("MiniMax official image protocol", () => {
    test("generates images through /v1/image_generation and decodes base64 results", async () => {
        const post = vi.spyOn(axios, "post").mockImplementation(async (url, body) => {
            if (url !== "https://api.minimaxi.com/v1/image_generation") throw new Error(`wrong MiniMax image endpoint: ${url}`);
            expect(body).toMatchObject({ model: "image-01", prompt: "draw a cat", response_format: "base64", n: 1, aspect_ratio: "16:9" });
            return { data: { data: { image_base64: ["aW1hZ2U="] }, base_resp: { status_code: 0, status_msg: "success" } } } as never;
        });

        const result = await requestGeneration(minimaxConfig("image", "image-01"), "draw a cat");

        expect(result.map((image) => image.dataUrl)).toEqual(["data:image/jpeg;base64,aW1hZ2U="]);
        expect(post).toHaveBeenCalledOnce();
    });

    test("sends reference images as subject_reference instead of OpenAI multipart edits", async () => {
        vi.spyOn(axios, "post").mockImplementation(async (url, body) => {
            if (url !== "https://api.minimaxi.com/v1/image_generation") throw new Error(`wrong MiniMax image endpoint: ${url}`);
            expect(body).toMatchObject({
                model: "image-01",
                subject_reference: [{ type: "character", image_file: "data:image/png;base64,cmVm" }],
                response_format: "base64",
            });
            return { data: { data: { image_base64: ["ZWRpdA=="] }, base_resp: { status_code: 0, status_msg: "success" } } } as never;
        });

        const result = await requestEdit(minimaxConfig("image", "image-01"), "keep the subject", [{ id: "ref", name: "ref", type: "image/png", dataUrl: "data:image/png;base64,cmVm" }]);

        expect(result.map((image) => image.dataUrl)).toEqual(["data:image/jpeg;base64,ZWRpdA=="]);
    });
});

describe("MiniMax official TTS protocol", () => {
    test("uses /v1/t2a_v2 and converts the returned hex audio to a playable Blob", async () => {
        vi.spyOn(axios, "post").mockImplementation(async (url, body) => {
            if (url !== "https://api.minimaxi.com/v1/t2a_v2") throw new Error(`wrong MiniMax TTS endpoint: ${url}`);
            expect(body).toMatchObject({
                model: "speech-2.8-hd",
                text: "你好",
                stream: false,
                output_format: "hex",
                voice_setting: { voice_id: "male-qn-qingse", speed: 1 },
                audio_setting: { format: "mp3" },
            });
            return { data: { data: { audio: "4869", status: 2 }, base_resp: { status_code: 0, status_msg: "success" } } } as never;
        });

        const blob = await requestAudioGeneration(minimaxConfig("audio", "speech-2.8-hd"), "你好");

        expect(blob.type).toBe("audio/mpeg");
        expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([72, 105]);
    });
});

describe("MiniMax Hailuo durable video protocol", () => {
    test("submits, queries, and retrieves Hailuo video through typed official V1 task endpoints", async () => {
        const config = minimaxConfig("video", "MiniMax-Hailuo-2.3");
        const request = vi.spyOn(axios, "request")
            .mockResolvedValueOnce({ data: { task_id: "h3-task", base_resp: { status_code: 0, status_msg: "success" } } })
            .mockResolvedValueOnce({ data: { task_id: "h3-task", status: "Success", file_id: "video-file", base_resp: { status_code: 0, status_msg: "success" } } })
            .mockResolvedValueOnce({ data: { file: { file_id: "video-file", download_url: "https://cdn.example.com/hailuo.mp4" }, base_resp: { status_code: 0, status_msg: "success" } } });

        const adapterRequest = {
            config: { ...config, model: "MiniMax-Hailuo-2.3", baseUrl: "https://api.minimaxi.com", apiKey: "secret" },
            prompt: "camera moves forward",
            images: ["data:image/png;base64,Zmlyc3Q="],
            params: { seconds: "6", resolution: "720", ratio: "16:9" },
        };
        const submitted = await minimaxVideoAdapter.submit!(adapterRequest);
        const queried = await minimaxVideoAdapter.query!({ ...adapterRequest, taskId: submitted.taskId });

        expect(submitted).toEqual({ taskId: "h3-task" });
        expect(queried).toEqual({ status: "succeeded", result: { kind: "video", source: "https://cdn.example.com/hailuo.mp4", mimeType: "video/mp4" } });
        expect(request.mock.calls[0][0]).toMatchObject({
            method: "post",
            url: "https://api.minimaxi.com/v1/video_generation",
            data: {
                model: "MiniMax-Hailuo-2.3",
                prompt: "camera moves forward",
                first_frame_image: "data:image/png;base64,Zmlyc3Q=",
                resolution: "768P",
                duration: 6,
            },
        });
        expect(request.mock.calls[1][0]).toMatchObject({ method: "get", url: "https://api.minimaxi.com/v1/query/video_generation", params: { task_id: "h3-task" } });
        expect(request.mock.calls[2][0]).toMatchObject({ method: "get", url: "https://api.minimaxi.com/v1/files/retrieve", params: { file_id: "video-file" } });
    });
});

describe("OpenAI official media adapters", () => {
    test("registers image, speech, and persistent video adapters", () => {
        expect([
            getMediaAdapter("openai.image"),
            getMediaAdapter("openai.speech"),
            getMediaAdapter("openai.video"),
        ]).toEqual([openAIImageAdapter, openAISpeechAdapter, openAIVideoAdapter]);
    });

    test("retains the existing OpenAI image and TTS HTTP contracts and normalizers", async () => {
        const imageRequest = officialMediaRequest("https://api.openai.com", "gpt-image-2");
        const speechRequest = officialMediaRequest("https://api.openai.com", "gpt-4o-mini-tts");
        const audio = new Blob([new Uint8Array([72, 105])], { type: "audio/mpeg" });
        const post = vi.spyOn(axios, "post")
            .mockImplementationOnce(async (_url, body) => {
                expect(body).toMatchObject({ model: "gpt-image-2", prompt: "create media", n: 1, size: "1024x1024", response_format: "b64_json" });
                return { data: { data: [{ b64_json: "aW1hZ2U=" }] } } as never;
            })
            .mockResolvedValueOnce({ data: audio });

        await expect(openAIImageAdapter.generate!({ ...imageRequest, params: { count: 1, size: "1024x1024" } })).resolves.toEqual({
            kind: "image",
            sources: ["data:image/png;base64,aW1hZ2U="],
        });
        await expect(openAISpeechAdapter.generate!({ ...speechRequest, params: { voice: "alloy", format: "mp3", speed: 1 } })).resolves.toEqual({
            kind: "audio",
            source: audio,
            mimeType: "audio/mpeg",
        });
        expect(post.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/images/generations");
        expect(post.mock.calls[1]?.[0]).toBe("https://api.openai.com/v1/audio/speech");
    });

    test("submits and queries OpenAI video through the existing task HTTP boundaries", async () => {
        const request = officialMediaRequest("https://api.openai.com", "sora-2");
        const video = new Blob([new Uint8Array([1, 2, 3])], { type: "video/mp4" });
        const post = vi.spyOn(axios, "post").mockResolvedValue({ data: { id: "video-1", status: "queued" } });
        const get = vi.spyOn(axios, "get")
            .mockResolvedValueOnce({ data: { id: "video-1", status: "completed", video_url: "https://cdn.example/video.mp4" } })
            .mockResolvedValueOnce({ data: video });

        const submitted = await openAIVideoAdapter.submit!({ ...request, images: ["data:image/png;base64,cmVm"] });
        const queried = await openAIVideoAdapter.query!({ ...request, taskId: submitted.taskId });

        expect(submitted).toEqual({ taskId: "video-1" });
        expect(queried).toEqual({ status: "succeeded", result: { kind: "video", source: video, mimeType: "video/mp4" } });
        expect(post.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/videos");
        expect(get.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/videos/video-1");
    });

    test.each([
        ["", "secret", /Base URL/i],
        ["https://api.openai.com", "", /API Key/i],
    ])("rejects incomplete OpenAI video adapter configuration before submission", async (baseUrl, apiKey, expected) => {
        const post = vi.spyOn(axios, "post");
        const request = officialMediaRequest(baseUrl, "sora-2");
        request.config.apiKey = apiKey;

        await expect(openAIVideoAdapter.submit!(request)).rejects.toThrow(expected);
        expect(post).not.toHaveBeenCalled();
    });
});

describe("Gemini official media adapters", () => {
    test("registers image, speech, and persistent Veo adapters", () => {
        expect([
            getMediaAdapter("gemini.image"),
            getMediaAdapter("gemini.speech"),
            getMediaAdapter("gemini.video"),
        ]).toEqual([geminiImageAdapter, geminiSpeechAdapter, geminiVideoAdapter]);
    });

    test("retains Gemini image result normalization at the generateContent boundary", async () => {
        const request = officialMediaRequest("https://generativelanguage.googleapis.com", "gemini-3-pro-image", "gemini");
        const post = vi.spyOn(axios, "post").mockImplementation(async (url, body) => {
            expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent");
            expect(body).toMatchObject({ generationConfig: { responseModalities: ["TEXT", "IMAGE"] } });
            return { data: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }] } }] } } as never;
        });

        await expect(geminiImageAdapter.generate!(request)).resolves.toEqual({
            kind: "image",
            sources: ["data:image/png;base64,aW1hZ2U="],
        });
        expect(post).toHaveBeenCalledOnce();
    });

    test("requests Gemini speech with the AUDIO response modality and normalizes inline audio", async () => {
        const request = officialMediaRequest("https://generativelanguage.googleapis.com", "gemini-2.5-flash-preview-tts", "gemini");
        const post = vi.spyOn(axios, "post").mockImplementation(async (url, body) => {
            expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent");
            expect(body).toMatchObject({
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
                },
            });
            return { data: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16", data: "AAECAw==" } }] } }] } } as never;
        });

        const result = await geminiSpeechAdapter.generate!({ ...request, params: { voice: "Kore" } });
        const source = result.kind === "audio" && result.source instanceof Blob ? result.source : undefined;
        const bytes = new Uint8Array(await source!.arrayBuffer());
        const view = new DataView(bytes.buffer);

        expect(result).toMatchObject({ kind: "audio", mimeType: "audio/wav" });
        expect(source?.type).toBe("audio/wav");
        expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
        expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe("WAVE");
        expect(view.getUint32(24, true)).toBe(24000);
        expect(view.getUint16(34, true)).toBe(16);
        expect(view.getUint32(40, true)).toBe(4);
        expect(post).toHaveBeenCalledOnce();
    });

    test("persists the Veo operation name and later normalizes its completed video URI", async () => {
        const request = officialMediaRequest("https://generativelanguage.googleapis.com", "veo-3.1-generate-preview", "gemini");
        const post = vi.spyOn(axios, "post").mockImplementation(async (url, body) => {
            expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning");
            expect(body).toMatchObject({ instances: [{ prompt: "create media" }], parameters: { aspectRatio: "16:9" } });
            return { data: { name: "operations/veo-1" } } as never;
        });
        const get = vi.spyOn(axios, "get").mockImplementation(async (url) => {
            expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/operations/veo-1");
            return {
                data: {
                    name: "operations/veo-1",
                    done: true,
                    response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://cdn.example/veo.mp4" } }] } },
                },
            } as never;
        });

        const submitted = await geminiVideoAdapter.submit!(request);
        const queried = await geminiVideoAdapter.query!({ ...request, taskId: submitted.taskId });

        expect(submitted).toEqual({ taskId: "operations/veo-1" });
        expect(queried).toEqual({
            status: "succeeded",
            result: { kind: "video", source: "https://cdn.example/veo.mp4?key=secret", mimeType: "video/mp4" },
        });
        expect(post).toHaveBeenCalledOnce();
        expect(get).toHaveBeenCalledOnce();
    });

    test("localizes invalid, missing, and failed Veo operation errors", async () => {
        const previousLanguage = i18n.language;
        await i18n.changeLanguage("zh-CN");
        try {
            const request = officialMediaRequest("https://generativelanguage.googleapis.com", "veo-3.1-generate-preview", "gemini");
            const post = vi.spyOn(axios, "post").mockResolvedValue({ data: {} });
            const get = vi.spyOn(axios, "get").mockResolvedValue({ data: { done: true, error: {} } });

            await expect(geminiVideoAdapter.submit!(request)).rejects.toThrow("Gemini 接口没有返回视频任务名称");
            post.mockResolvedValue({ data: { name: "operations/veo-1" } });
            await expect(geminiVideoAdapter.query!({ ...request, taskId: "../secret" })).rejects.toThrow("Gemini 返回了无效的视频任务名称");
            await expect(geminiVideoAdapter.query!({ ...request, taskId: "operations/veo-1" })).resolves.toEqual({
                status: "failed",
                error: "Gemini 视频生成失败",
            });

            expect(get).toHaveBeenCalledOnce();
        } finally {
            await i18n.changeLanguage(previousLanguage);
        }
    });
});

describe("OpenRouter text and vision protocol", () => {
    it.each(["https://openrouter.ai/api/v1/", "https://proxy.example/router/"])("preserves base path %s", baseUrl => {
        expect(providerChatUrl("openrouter", baseUrl)).toBe(`${baseUrl}chat/completions`);
        expect(providerModelsUrl("openrouter", baseUrl)).toBe(`${baseUrl}models`);
    });
    it.each([undefined, ["text"], ["text", "image"]].map(inputModalities => ({ inputModalities })))("streams split SSE and sends only confirmed vision (%j)", async ({ inputModalities }) => {
        const model = "vendor/vision/model:free";
        const channel = createModelChannel({ provider: "openrouter", apiKey: "fixture-key", models: [{ name: model, capability: "text", catalog: { version: 1, source: "provider_models", providerStatus: "active", supportsTools: true, inputModalities } }] });
        expect(channel.models[0].supportsImageInput).toBe(true); // Catalog confirmation wins over generic name inference.
        const value = encodeChannelModel(channel.id, model);
        const config = { ...defaultConfig,
        compressReferenceImages: false, channels: [channel], model: value };
        const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "describe" }, { type: "image_url" as const, image_url: { url: "data:image/png;base64,aW1hZ2U=" } }] }];
        const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
            expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
            expect(init?.headers).toMatchObject({ Authorization: "Bearer fixture-key" });
            expect(JSON.parse(String(init?.body))).toEqual({ model, stream: true, messages: [{ role: "user", content: inputModalities?.includes("image") ? messages[0].content : [messages[0].content[0]] }] });
            return new Response(new ReadableStream({ start(controller) {
                for (const chunk of ['data: {"choices":[{"delta":{"con', 'tent":"hello"}}]}\r\n', '\r\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DO', 'NE]\n\n']) controller.enqueue(new TextEncoder().encode(chunk));
                controller.close();
            } }));
        });
        vi.stubGlobal("fetch", fetchMock);
        const onDelta = vi.fn();
        await expect(requestImageQuestion(config, messages, onDelta)).resolves.toBe("hello world");
        expect(onDelta.mock.calls).toEqual([["hello"], ["hello world"]]);
        expect(messages[0].content).toHaveLength(2);
    });
    it("surfaces a stream error after partial content", async () => {
        const channel = createModelChannel({ provider: "openrouter", apiKey: "fixture-key", models: [{ name: "a/model:free", capability: "text" }] });
        vi.stubGlobal("fetch", vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"error":{"message":"upstream failed"}}\n\n')));
        const onDelta = vi.fn();
        await expect(requestImageQuestion({ ...defaultConfig,
        compressReferenceImages: false, channels: [channel], model: encodeChannelModel(channel.id, "a/model:free") }, [{ role: "user", content: "hello" }], onDelta)).rejects.toThrow("upstream failed");
        expect(onDelta).toHaveBeenCalledWith("partial");
    });
});
