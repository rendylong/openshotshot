import { describe, expect, test } from "vitest";
import { resolveModel, resolveProvider } from "./model-resolver";

describe("resolveModel", () => {
    test("recognizes the official OpenRouter host", () => {
        expect(resolveProvider("custom", "https://openrouter.ai/api/v1", "openai")).toBe("openrouter");
    });

    test("routes confirmed OpenRouter text models through the compatible text adapter", () => {
        expect(resolveModel({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiFormat: "openai", model: "vendor/model:free", userCapability: "text" })).toMatchObject({
            provider: "openrouter", model: "vendor/model:free", modality: "text", execution: "stream", adapterId: "openai-compatible.text",
        });
    });

    test("does not route OpenRouter image models through the OpenAI image adapter", () => {
        expect(resolveModel({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiFormat: "openai", model: "vendor/image:model", userCapability: "image" })).toMatchObject({
            provider: "openrouter", modality: "unknown", execution: "unsupported", adapterId: null,
        });
    });

    test("does not infer an unconfirmed OpenRouter model as text", () => {
        expect(resolveModel({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiFormat: "openai", model: "vendor/unknown" })).toMatchObject({
            modality: "unknown", execution: "unsupported", adapterId: null,
        });
    });
    // Catches a wrong provider-domain or execution-mode mapping.
    test.each([
        ["minimax-cn", "https://api.minimaxi.com", "image-01", "image", "direct", "minimax.image"],
        ["minimax-global", "https://api.minimax.io", "MiniMax-Hailuo-2.3", "video", "remote_task", "minimax.video"],
        ["minimax-global", "https://api.minimax.io", "speech-2.8-hd", "speech", "direct", "minimax.speech"],
        ["minimax-global", "https://api.minimax.io", "music-2.6", "music", "direct", "minimax.music"],
        ["minimax-cn", "https://api.minimaxi.com", "MiniMax-H3", "video", "remote_task", "minimax.video"],
        ["minimax-global", "https://api.minimax.io", "MiniMax-H3-Max", "video", "remote_task", "minimax.video"],
        ["zhipu", "https://open.bigmodel.cn/api/paas/v4", "glm-image", "image", "remote_task", "zhipu.image"],
        ["zhipu", "https://open.bigmodel.cn/api/paas/v4", "cogvideox-3", "video", "remote_task", "zhipu.video"],
        ["moonshot", "https://api.moonshot.cn/v1", "kimi-k2.5", "text", "stream", "openai-compatible.text"],
        ["deepseek", "https://api.deepseek.com", "deepseek-v4-flash-vision-exp", "text", "stream", "openai-compatible.text"],
        ["hiapi", "https://api.hiapi.ai", "gpt-image-2/text-to-image", "image", "remote_task", "hiapi.image"],
        ["hiapi", "https://api.hiapi.ai", "veo-3.1/image-to-video", "video", "remote_task", "hiapi.video"],
        ["hiapi", "https://api.hiapi.ai", "qwen-audio-3.0-tts-plus", "speech", "remote_task", "hiapi.speech"],
        ["hiapi", "https://api.hiapi.ai", "minimax-music-2.6", "music", "remote_task", "hiapi.music"],
    ] as const)("resolves %s %s", (provider, baseUrl, model, modality, execution, adapterId) => {
        expect(resolveModel({ provider, baseUrl, apiFormat: "openai", model })).toMatchObject({ provider, modality, execution, adapterId });
    });

    // Catches loose substring matching that misses an official provider URL.
    test("infers a known custom model from official base URL", () => {
        expect(resolveModel({ provider: "custom", baseUrl: "https://open.bigmodel.cn/api/paas/v4/", apiFormat: "openai", model: "cogvideox-3" })).toMatchObject({ provider: "zhipu", modality: "video", execution: "remote_task", confidence: "exact" });
    });

    test("infers HiAPI from its official base URL", () => {
        expect(resolveModel({ provider: "custom", baseUrl: "https://api.hiapi.ai/", apiFormat: "openai", model: "veo-3.1/text-to-video" })).toMatchObject({
            provider: "hiapi",
            modality: "video",
            execution: "remote_task",
            adapterId: "hiapi.video",
            confidence: "exact",
        });
    });

    // Catches treating a multimodal-input model as an image generator.
    test("does not treat vision understanding as image generation", () => {
        expect(resolveModel({ provider: "deepseek", baseUrl: "https://api.deepseek.com", apiFormat: "openai", model: "deepseek-v4-flash-vision-exp" }).modality).toBe("text");
    });

    // Catches unsafe fallback for arbitrary media-looking custom names.
    test("returns unsupported for an unknown custom media-looking model", () => {
        expect(resolveModel({ provider: "custom", baseUrl: "https://example.test", apiFormat: "openai", model: "someone-video-magic" })).toMatchObject({ modality: "unknown", execution: "unsupported", adapterId: null });
    });

    // Catches compatible-text fallback accidentally selecting an unknown media protocol.
    test.each([
        ["deepseek", "https://api.deepseek.com", "openai", "unknown-video"],
        ["openai", "https://api.openai.com", "openai", "unknown-image"],
        ["moonshot", "https://api.moonshot.cn/v1", "openai", "unknown-tts"],
        ["custom", "https://example.test", "gemini", "unknown-music"],
    ] as const)("rejects unmatched explicit media model %s", (provider, baseUrl, apiFormat, model) => {
        expect(resolveModel({ provider, baseUrl, apiFormat, model })).toMatchObject({ modality: "unknown", execution: "unsupported", adapterId: null });
    });

    // Catches loose official-host matching that accepts an attacker-controlled suffix.
    test("does not infer a provider from a spoofed official host", () => {
        expect(resolveModel({ provider: "custom", baseUrl: "https://open.bigmodel.cn.attacker.test", apiFormat: "openai", model: "someone-video-magic" })).toMatchObject({
            provider: "custom",
            modality: "unknown",
            execution: "unsupported",
            adapterId: null,
        });
    });

    // Catches heuristics that route user-stored capability to the wrong adapter.
    test.each([
        // [provider, model, userCapability, expectedModality, expectedAdapterId]
        ["minimax-cn", "future-minimax-model", "video", "video", "minimax.video"],
        ["minimax-cn", "future-minimax-model", "audio", "speech", "minimax.speech"],
        ["minimax-cn", "future-minimax-model", "image", "image", "minimax.image"],
        ["minimax-global", "future-minimax-model", "video", "video", "minimax.video"],
        ["zhipu", "future-zhipu-image", "image", "image", "zhipu.image"],
        ["zhipu", "future-zhipu-video", "video", "video", "zhipu.video"],
        ["openai", "future-openai-video", "video", "video", "openai.video"],
        ["gemini", "future-gemini-text", "text", "text", "gemini.text"],
        ["hiapi", "future-hiapi-image", "image", "image", "hiapi.image"],
        ["hiapi", "future-hiapi-audio", "audio", "speech", "hiapi.speech"],
    ] as const)("heuristically routes %s/%s with user capability %s", (provider, model, userCapability, expectedModality, expectedAdapterId) => {
        const resolved = resolveModel({ provider, baseUrl: "https://example.test", apiFormat: "openai", model, userCapability });
        expect(resolved).toMatchObject({ provider, modality: expectedModality, adapterId: expectedAdapterId, source: "heuristic" });
    });

    test("static rule still wins over user capability when both exist", () => {
        // image-01 is statically registered as image; user-saved "video" should not silently override it.
        const resolved = resolveModel({ provider: "minimax-cn", baseUrl: "https://api.minimaxi.com", apiFormat: "openai", model: "image-01", userCapability: "video" });
        expect(resolved).toMatchObject({ modality: "image", adapterId: "minimax.image", source: "builtin" });
    });

    test("heuristic returns unsupported when user capability is not supported by the provider", () => {
        // deepseek only supports text; user-saved "video" should not get a fabricated adapter.
        const resolved = resolveModel({ provider: "deepseek", baseUrl: "https://api.deepseek.com", apiFormat: "openai", model: "future-deepseek-model", userCapability: "video" });
        expect(resolved).toMatchObject({ modality: "unknown", execution: "unsupported", adapterId: null });
    });
});


describe("AutoDL routing", () => {
    test.each(["https://autodl.art", "https://www.autodl.art/api/v1/"])("recognizes only official host %s", (baseUrl) => {
        expect(resolveModel({ provider: "custom", baseUrl, apiFormat: "openai", model: "minimax_h3_lightx2v_no_pic" })).toMatchObject({ provider: "autodl", modality: "video", execution: "remote_task", adapterId: "autodl.video", confidence: "exact" });
    });
    test.each(["https://autodl.art.attacker.test", "https://fake-autodl.art", "https://attacker.test/autodl.art"])("rejects lookalike host %s", (baseUrl) => {
        expect(resolveProvider("custom", baseUrl, "openai")).toBe("custom");
    });
    test("honors explicit AutoDL provider on a custom URL", () => {
        expect(resolveModel({ provider: "autodl", baseUrl: "https://proxy.example.test", apiFormat: "gemini", model: "minimax_h3_b99_001" })).toMatchObject({ adapterId: "autodl.video" });
        expect(resolveProvider("hiapi", "https://autodl.art", "openai")).toBe("hiapi");
    });
    test.each([undefined, "text", "video"] as const)("rejects unknown workflows even with %s capability", (userCapability) => {
        expect(resolveModel({ provider: "autodl", baseUrl: "https://autodl.art", apiFormat: "openai", model: "future-workflow", userCapability })).toMatchObject({ modality: "unknown", execution: "unsupported", adapterId: null });
    });
});
