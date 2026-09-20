import axios from "axios";
import { afterEach, describe, expect, test, vi } from "vitest";

import { planCanvasMediaGeneration } from "@/lib/canvas/canvas-media-generation-route";
import { resolveModel } from "@/lib/models/model-resolver";
import { createModelChannel, defaultConfig, encodeChannelModel, modelOptionsFromChannels, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

import { requestEdit, requestGeneration } from "./image";
import { generateResolvedMedia } from "./media-dispatcher";
import { requestAudioGeneration } from "./audio";
import { requestVideoGeneration } from "./video";

function mediaConfig(baseUrl: string, model: string, capability: ModelCapability, options: { provider?: "fal" | "custom" | "minimax-cn" | "minimax-global" | "zhipu"; apiFormat?: "openai" | "gemini"; apiKey?: string; script?: string } = {}): AiConfig {
    const channel = createModelChannel({
        id: "channel",
        provider: options.provider ?? "custom",
        baseUrl,
        apiKey: options.apiKey ?? "secret",
        apiFormat: options.apiFormat ?? "openai",
        models: [{ name: model, capability, ...(options.script ? { script: options.script } : {}) }],
    });
    channel.baseUrl = baseUrl;
    const selected = encodeChannelModel(channel.id, model);
    return {
        ...defaultConfig,
        channels: [channel],
        models: modelOptionsFromChannels([channel]),
        model: selected,
        imageModel: capability === "image" ? selected : "",
        videoModel: capability === "video" ? selected : "",
        audioModel: capability === "audio" ? selected : "",
        size: "16:9",
        count: "1",
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("resolved media dispatcher", () => {
    test.each([["fal-ai/flux-2-pro", "image"], ["fal-ai/kling-video/v3/pro/text-to-video", "video"]] as const)("plans %s as a persistent task without direct generation", async (model, modality) => {
        const config = mediaConfig("https://queue.fal.run", model, modality, { provider: "fal" });
        const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
        expect(planCanvasMediaGeneration({ config, capability: modality, phase: "first" })).toMatchObject({ mode: "remote_task", adapterId: `fal.${modality}`, adapterVersion: 1 });
        await expect(generateResolvedMedia({ config, modality, prompt: "cup" })).rejects.toThrow(/requires a persistent remote task|需要通过持久化远端任务运行/);
        expect(fetcher).not.toHaveBeenCalled();
    });
    test.each([
        ["https://api.openai.com", "openai", "gpt-image-2", "image", "direct", "openai.image"],
        ["https://api.openai.com", "openai", "gpt-4o-mini-tts", "speech", "direct", "openai.speech"],
        ["https://api.openai.com", "openai", "sora-2", "video", "remote_task", "openai.video"],
        ["https://generativelanguage.googleapis.com", "gemini", "gemini-3-pro-image", "image", "direct", "gemini.image"],
        ["https://generativelanguage.googleapis.com", "gemini", "gemini-2.5-flash-preview-tts", "speech", "direct", "gemini.speech"],
        ["https://generativelanguage.googleapis.com", "gemini", "veo-3.1-generate-preview", "video", "remote_task", "gemini.video"],
    ] as const)("resolves the anchored %s family for %s", (baseUrl, provider, model, modality, execution, adapterId) => {
        expect(resolveModel({ provider: "custom", baseUrl, apiFormat: provider === "gemini" ? "gemini" : "openai", model })).toMatchObject({ provider, modality, execution, adapterId, confidence: "family" });
    });

    test.each([
        ["gpt-image-2", "image", "direct", "openai.image"],
        ["gpt-4o-mini-tts", "speech", "direct", "openai.speech"],
        ["sora-2", "video", "remote_task", "openai.video"],
    ] as const)("resolves the anchored custom OpenAI-format family %s without reclassifying its provider", (model, modality, execution, adapterId) => {
        expect(resolveModel({ provider: "custom", baseUrl: "https://gateway.example/v1", apiFormat: "openai", model })).toMatchObject({
            provider: "custom",
            modality,
            execution,
            adapterId,
            confidence: "family",
        });
    });

    test("dispatches an anchored image family through a custom OpenAI-format HTTP boundary", async () => {
        const post = vi.spyOn(axios, "post").mockResolvedValue({ data: { data: [{ b64_json: "aW1hZ2U=" }] } });

        await expect(requestGeneration(mediaConfig("https://gateway.example/v1", "gpt-image-2", "image"), "cat")).resolves.toMatchObject([{ dataUrl: "data:image/png;base64,aW1hZ2U=" }]);

        expect(post.mock.calls[0]?.[0]).toBe("https://gateway.example/v1/images/generations");
    });

    test("dispatches a custom MiniMax model inferred from its official URL", async () => {
        const post = vi.spyOn(axios, "post").mockResolvedValue({
            data: { data: { audio: "4869" }, base_resp: { status_code: 0, status_msg: "success" } },
        });

        const result = await generateResolvedMedia({
            config: mediaConfig("https://api.minimax.io", "music-2.6", "audio"),
            modality: "music",
            prompt: "ambient instrumental",
        });

        expect(result).toMatchObject({ kind: "audio", mimeType: "audio/mpeg" });
        expect(post.mock.calls[0]?.[0]).toBe("https://api.minimax.io/v1/music_generation");
    });

    test("routes MiniMax image and speech through registered typed adapters", async () => {
        const post = vi
            .spyOn(axios, "post")
            .mockResolvedValueOnce({ data: { data: { image_base64: ["aW1hZ2U="] }, base_resp: { status_code: 0 } } })
            .mockResolvedValueOnce({ data: { data: { audio: "4869", status: 2 }, base_resp: { status_code: 0 } } });

        await expect(
            generateResolvedMedia({
                config: mediaConfig("https://api.minimaxi.com", "image-01", "image"),
                modality: "image",
                prompt: "cat",
            }),
        ).resolves.toEqual({ kind: "image", sources: ["data:image/jpeg;base64,aW1hZ2U="] });
        await expect(
            generateResolvedMedia({
                config: mediaConfig("https://api.minimaxi.com", "speech-2.8-hd", "audio"),
                modality: "speech",
                prompt: "hello",
            }),
        ).resolves.toMatchObject({ kind: "audio", mimeType: "audio/mpeg" });

        expect(post.mock.calls.map(([url]) => url)).toEqual(["https://api.minimaxi.com/v1/image_generation", "https://api.minimaxi.com/v1/t2a_v2"]);
    });

    test("preserves the configured system prompt for MiniMax images on the dispatcher path", async () => {
        const config = { ...mediaConfig("https://api.minimaxi.com", "image-01", "image"), systemPrompt: "Use the approved visual language" };
        const post = vi.spyOn(axios, "post").mockImplementation(async (_url, body) => {
            expect(body).toMatchObject({ prompt: "Use the approved visual language\n\ncat" });
            return { data: { data: { image_base64: ["aW1hZ2U="] }, base_resp: { status_code: 0 } } } as never;
        });

        await requestGeneration(config, "cat");

        expect(post).toHaveBeenCalledOnce();
    });

    test("preserves the MiniMax mask rejection before network access", async () => {
        const post = vi.spyOn(axios, "post");
        const config = mediaConfig("https://api.minimaxi.com", "image-01", "image");

        await expect(
            generateResolvedMedia({
                config,
                modality: "image",
                prompt: "edit",
                images: ["data:image/png;base64,cmVm"],
                params: { mask: "data:image/png;base64,bWFzaw==" },
            }),
        ).rejects.toThrow(/mask|蒙版/i);
        expect(post).not.toHaveBeenCalled();
    });

    test("rejects an unknown custom video before network access", async () => {
        const request = vi.spyOn(axios, "request");
        const post = vi.spyOn(axios, "post");
        const get = vi.spyOn(axios, "get");

        await expect(
            generateResolvedMedia({
                config: mediaConfig("https://example.test", "someone-video-magic", "video"),
                modality: "video",
                prompt: "move",
            }),
        ).rejects.toThrow(/No automatic adapter|暂无自动调用适配器/);
        expect(request).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
        expect(get).not.toHaveBeenCalled();
    });

    test("does not classify a media lookalike or Gemini API-format flag by itself", async () => {
        const request = vi.spyOn(axios, "request");
        const post = vi.spyOn(axios, "post");

        // Without user-stored capability, a model whose name contains a media token must not auto-classify.
        expect(resolveModel({ provider: "custom", baseUrl: "https://api.openai.com", apiFormat: "openai", model: "prefix-gpt-image-2" })).toMatchObject({ modality: "unknown", execution: "unsupported", adapterId: null });

        // No capability stored at all (e.g. legacy config without the field) -> heuristic must not silently route.
        const config = mediaConfig("https://example.test", "someone-image-magic", "image", { apiFormat: "gemini" });
        config.channels[0]!.models[0]!.capability = "text";
        await expect(
            generateResolvedMedia({
                config,
                modality: "image",
                prompt: "cat",
            }),
        ).rejects.toThrow(/No automatic adapter|暂无自动调用适配器/);
        expect(request).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    test("rejects GLM remote planning from the direct dispatcher without submitting", async () => {
        const config = mediaConfig("https://open.bigmodel.cn/api/paas/v4", "glm-image", "image");
        const request = vi.spyOn(axios, "request");
        const post = vi.spyOn(axios, "post");

        expect(planCanvasMediaGeneration({ config, capability: "image", phase: "first" })).toMatchObject({
            mode: "remote_task",
            adapterId: "zhipu.image",
            adapterVersion: 1,
        });
        await expect(generateResolvedMedia({ config, modality: "image", prompt: "cat" })).rejects.toThrow(/requires a persistent remote task|需要通过持久化远端任务运行/);
        expect(request).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    test("uses a persisted legacy direct script before automatic resolution", async () => {
        const request = vi.spyOn(axios, "request");
        const config = mediaConfig("https://api.openai.com", "gpt-image-2", "image", {
            script: 'return ["data:image/png;base64,bGVnYWN5"];',
        });

        const result = await requestGeneration(config, "cat");

        expect(result.map((image) => image.dataUrl)).toEqual(["data:image/png;base64,bGVnYWN5"]);
        expect(request).not.toHaveBeenCalled();
    });

    test("normalizes auto quality to undefined for persisted legacy image scripts", async () => {
        const config = {
            ...mediaConfig("https://legacy.example", "legacy-image", "image", {
                script: 'if (params.quality !== undefined) throw new Error("quality was not normalized"); return ["data:image/png;base64,bGVnYWN5"];',
            }),
            quality: "auto",
        };

        await expect(requestGeneration(config, "cat")).resolves.toMatchObject([{ dataUrl: "data:image/png;base64,bGVnYWN5" }]);
    });

    test("does not add mask to the persisted legacy image-edit script parameter contract", async () => {
        const request = vi.spyOn(axios, "request");
        const config = {
            ...mediaConfig("https://legacy.example", "legacy-image", "image", {
                script: 'if (Object.prototype.hasOwnProperty.call(params, "mask")) throw new Error("unexpected mask"); if (params.quality !== undefined) throw new Error("quality was not normalized"); return ["data:image/png;base64,bGVnYWN5"];',
            }),
            quality: "auto",
            compressReferenceImages: false,
        };
        const reference = { id: "reference", name: "reference.png", type: "image/png", dataUrl: "data:image/png;base64,cmVm" };
        const mask = { id: "mask", name: "mask.png", type: "image/png", dataUrl: "data:image/png;base64,bWFzaw==" };

        const result = await requestEdit(config, "edit", [reference], mask);

        expect(result.map((image) => image.dataUrl)).toEqual(["data:image/png;base64,bGVnYWN5"]);
        expect(request).not.toHaveBeenCalled();
    });

    test("preserves normalized parameters for a persisted legacy audio script", async () => {
        const config = {
            ...mediaConfig("https://legacy.example", "legacy-audio", "audio", {
                script: 'if (params.voice !== "alloy") throw new Error("voice was not normalized"); return new Blob(["legacy"], { type: "audio/mpeg" });',
            }),
            audioVoice: "Kore",
        };

        const result = await requestAudioGeneration(config, "hello");

        expect(result).toBeInstanceOf(Blob);
        expect(result.type).toBe("audio/mpeg");
    });

    test("maps the default OpenAI voice to Kore and returns playable WAV through the public Gemini speech path", async () => {
        const config = mediaConfig("https://generativelanguage.googleapis.com", "gemini-2.5-flash-preview-tts", "audio", { apiFormat: "gemini" });
        expect(config.audioVoice).toBe("alloy");
        const post = vi.spyOn(axios, "post").mockImplementation(async (_url, body) => {
            expect(body).toMatchObject({
                generationConfig: { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } },
            });
            return { data: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=16000", data: "AAECAw==" } }] } }] } } as never;
        });

        const result = await requestAudioGeneration(config, "hello");
        const bytes = new Uint8Array(await result.arrayBuffer());

        expect(result.type).toBe("audio/wav");
        expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
        expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(16000);
        expect(post).toHaveBeenCalledOnce();
    });

    test.each([
        ["", "secret", /Base URL/i],
        ["https://legacy.example", "", /API Key/i],
    ])("rejects incomplete legacy video configuration before script or network", async (baseUrl, apiKey, expected) => {
        const request = vi.spyOn(axios, "request");
        const post = vi.spyOn(axios, "post");
        const config = mediaConfig(baseUrl, "legacy-video", "video", {
            apiKey,
            script: 'throw new Error("legacy video script executed");',
        });

        await expect(requestVideoGeneration(config, "move")).rejects.toThrow(expected);
        expect(request).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    test("routes the public image entry through safe automatic resolution", async () => {
        const request = vi.spyOn(axios, "request");
        const post = vi.spyOn(axios, "post");

        await expect(requestGeneration(mediaConfig("https://example.test", "someone-image-magic", "image"), "cat")).rejects.toThrow(/No automatic adapter|暂无自动调用适配器/);
        expect(request).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    test("routes music from the public audio entry to MiniMax music instead of TTS", async () => {
        const post = vi.spyOn(axios, "post").mockImplementation(async (url) => {
            if (url !== "https://api.minimax.io/v1/music_generation") throw new Error(`wrong MiniMax audio endpoint: ${url}`);
            return { data: { data: { audio: "4869" }, base_resp: { status_code: 0 } } } as never;
        });

        const result = await requestAudioGeneration(mediaConfig("https://api.minimax.io", "music-2.6", "audio"), "ambient instrumental");

        expect(result).toBeInstanceOf(Blob);
        expect(post).toHaveBeenCalledOnce();
    });

    test("rejects public direct video generation for a persistent Sora task before submission", async () => {
        const request = vi.spyOn(axios, "request");
        const post = vi.spyOn(axios, "post");

        await expect(requestVideoGeneration(mediaConfig("https://api.openai.com", "sora-2", "video"), "move")).rejects.toThrow(/requires a persistent remote task|需要通过持久化远端任务运行/);
        expect(request).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });
});
