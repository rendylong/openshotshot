import axios from "axios";
import { afterEach, describe, expect, test, vi } from "vitest";

import i18n from "@/i18n";
import { ensureManagedCatalog, resetManagedCatalogForTests } from "@/lib/desktop/managed-catalog-cache";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";

import { requestOpenAISpeech } from "./audio";
import { requestOpenAIImages } from "./image";
import { resetManagedUsageRefreshForTests } from "./model-transport";
import { createOpenAIVideoTask, pollOpenAIVideoTask } from "./video";
import { openAIImageAdapter, openAIVideoAdapter } from "./media-adapters/openai-gemini";

function config(model: string): AiConfig {
    return {
        ...defaultConfig,
        vquality: "768p横", videoSeconds: "5",
        compressReferenceImages: false,
        credentialMode: "shotshot",
        credentialModes: { agent: "shotshot", text: "shotshot", image: "shotshot", video: "shotshot", audio: "shotshot" },
        model,
        baseUrl: "should-not-be-used",
        apiKey: "should-not-be-used",
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetManagedUsageRefreshForTests();
    resetManagedCatalogForTests();
});

describe("managed image canonical spec size", () => {
    function managedBridge(fetch: ReturnType<typeof vi.fn>) {
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(), fetch: fetch as never, abort: vi.fn() } };
        return fetch;
    }

    function capturedBody(fetch: ReturnType<typeof vi.fn>) {
        return JSON.parse(fetch.mock.calls[0]![0].body.value) as Record<string, unknown>;
    }

    test("sends the ratio plus the declared resolution tier instead of a pixel size", async () => {
        const fetch = managedBridge(vi.fn(async (request) => ({
            id: request.id, status: 200, statusText: "OK", headers: { "content-type": "application/json" },
            body: { kind: "text" as const, value: '{"data":[{"b64_json":"aW1hZ2U="}]}' },
        })));
        const imageConfig = { ...config("managed-image"), size: "16:9", quality: "2K" };

        await expect(requestOpenAIImages(imageConfig, "cat", [], 1, undefined, undefined, { resolutions: ["1K", "2K", "4K"] }))
            .resolves.toMatchObject([{ dataUrl: "data:image/png;base64,aW1hZ2U=" }]);

        expect(capturedBody(fetch)).toEqual(expect.objectContaining({ size: "16:9|2K" }));
        expect(capturedBody(fetch).size).not.toMatch(/\d+x\d+/);
        expect(capturedBody(fetch)).not.toHaveProperty("quality");
    });

    test("sends the declared quality token for a quality-axis model", async () => {
        const fetch = managedBridge(vi.fn(async (request) => ({
            id: request.id, status: 200, statusText: "OK", headers: { "content-type": "application/json" },
            body: { kind: "text" as const, value: '{"data":[{"b64_json":"aW1hZ2U="}]}' },
        })));
        const imageConfig = { ...config("managed-image"), size: "4:3", quality: "ultra" };

        await requestOpenAIImages(imageConfig, "cat", [], 1, undefined, undefined, { qualities: ["standard", "fine", "ultra"] });

        expect(capturedBody(fetch)).toEqual(expect.objectContaining({ size: "4:3|ultra" }));
        expect(capturedBody(fetch)).not.toHaveProperty("quality");
    });

    test("emits only the ratio for a model without a second axis", async () => {
        const fetch = managedBridge(vi.fn(async (request) => ({
            id: request.id, status: 200, statusText: "OK", headers: { "content-type": "application/json" },
            body: { kind: "text" as const, value: '{"data":[{"b64_json":"aW1hZ2U="}]}' },
        })));
        // A tier value that is not declared by the ratio-only model must not leak into the key.
        const imageConfig = { ...config("managed-image"), size: "16:9", quality: "2K" };

        await requestOpenAIImages(imageConfig, "cat", [], 1, undefined, undefined, { aspectRatios: ["16:9"] });

        expect(capturedBody(fetch)).toEqual(expect.objectContaining({ size: "16:9" }));
    });

    test("rejects an explicit pixel size before any request is sent", async () => {
        const fetch = managedBridge(vi.fn());
        const imageConfig = { ...config("managed-image"), size: "1024x1024", quality: "2K" };

        await expect(requestOpenAIImages(imageConfig, "cat", [], 1, undefined, undefined, { resolutions: ["1K", "2K"] }))
            .rejects.toThrow(i18n.t("apiErrors.managedImageSpecRequiresRatio", { model: "managed-image", size: "1024x1024" }));
        expect(fetch).not.toHaveBeenCalled();
    });

    test("rejects a non-ratio auto size before any request is sent", async () => {
        const fetch = managedBridge(vi.fn());
        const imageConfig = { ...config("managed-image"), size: "auto", quality: "2K" };

        await expect(requestOpenAIImages(imageConfig, "cat", [], 1, undefined, undefined, { resolutions: ["1K", "2K"] }))
            .rejects.toThrow(i18n.t("apiErrors.managedImageSpecRequiresRatio", { model: "managed-image", size: "auto" }));
        expect(fetch).not.toHaveBeenCalled();
    });

    test("defaults a non-declared second-axis value instead of emitting a bare ratio", async () => {
        const fetch = managedBridge(vi.fn(async (request) => ({
            id: request.id, status: 200, statusText: "OK", headers: { "content-type": "application/json" },
            body: { kind: "text" as const, value: '{"data":[{"b64_json":"aW1hZ2U="}]}' },
        })));
        // A stale tier token on a quality-only model falls back to the first declared, priced value.
        const imageConfig = { ...config("managed-image"), size: "16:9", quality: "2K" };

        await requestOpenAIImages(imageConfig, "cat", [], 1, undefined, undefined, { aspectRatios: ["16:9"], qualities: ["standard", "fine", "ultra"] });

        expect(capturedBody(fetch)).toEqual(expect.objectContaining({ size: "16:9|standard" }));
    });

    test("defaults auto quality when the model declares a second axis (fresh managed generation)", async () => {
        const fetch = managedBridge(vi.fn(async (request) => ({
            id: request.id, status: 200, statusText: "OK", headers: { "content-type": "application/json" },
            body: { kind: "text" as const, value: '{"data":[{"b64_json":"aW1hZ2U="}]}' },
        })));
        // defaultConfig.quality is "auto"; the request boundary selects the first priced tier.
        const imageConfig = { ...config("managed-image"), size: "1:1", quality: "auto" };

        await requestOpenAIImages(imageConfig, "cat", [], 1, undefined, undefined, { aspectRatios: ["1:1"], resolutions: ["1K", "2K", "4K"] });

        expect(capturedBody(fetch)).toEqual(expect.objectContaining({ size: "1:1|1K" }));
    });

    test("emits the panel-written declared tier even when quality defaulted from auto", async () => {
        const fetch = managedBridge(vi.fn(async (request) => ({
            id: request.id, status: 200, statusText: "OK", headers: { "content-type": "application/json" },
            body: { kind: "text" as const, value: '{"data":[{"b64_json":"aW1hZ2U="}]}' },
        })));
        // The panel writes the first declared tier when it sees `auto`; the emitted key must carry it.
        const imageConfig = { ...config("managed-image"), size: "1:1", quality: "1K" };

        await requestOpenAIImages(imageConfig, "cat", [], 1, undefined, undefined, { aspectRatios: ["1:1"], resolutions: ["1K", "2K", "4K"] });

        expect(capturedBody(fetch)).toEqual(expect.objectContaining({ size: "1:1|1K" }));
    });

    test("rejects a ratio outside the model's declared set", async () => {
        const fetch = managedBridge(vi.fn());
        const imageConfig = { ...config("managed-image"), size: "3:2", quality: "1K" };

        await expect(requestOpenAIImages(imageConfig, "cat", [], 1, undefined, undefined, { aspectRatios: ["1:1", "16:9"], resolutions: ["1K"] }))
            .rejects.toThrow(i18n.t("apiErrors.managedImageSpecRatioUnsupported", { model: "managed-image", ratio: "3:2", ratios: "1:1, 16:9" }));
        expect(fetch).not.toHaveBeenCalled();
    });

    test("rejects a ratio outside the fixed subset when no spec is present", async () => {
        const fetch = managedBridge(vi.fn());
        const imageConfig = { ...config("managed-image"), size: "21:9", quality: "1K" };

        await expect(requestOpenAIImages(imageConfig, "cat", [], 1, undefined, undefined, undefined))
            .rejects.toThrow(i18n.t("apiErrors.managedImageSpecRatioUnsupported", { model: "managed-image", ratio: "21:9", ratios: "1:1, 4:3, 3:4, 16:9, 9:16" }));
        expect(fetch).not.toHaveBeenCalled();
    });

    test("managed precondition messages resolve from keys declared in both locales", () => {
        const keys = ["managedImageSpecRequiresRatio", "managedImageSpecRatioUnsupported", "managedImageSpecTwoAxesUnsupported", "managedImageSpecSecondAxisRequired"];
        for (const locale of ["zh-CN", "en-US"] as const) {
            for (const key of keys) {
                // getResource reads the bundle directly, so this fails if either locale lacks the key.
                const template = i18n.getResource(locale, "translation", `apiErrors.${key}`);
                expect(typeof template).toBe("string");
                const message = i18n.t(`apiErrors.${key}`, { lng: locale, model: "m", size: "x", ratio: "x", ratios: "x", quality: "x", expected: "x" });
                expect(message).not.toContain("apiErrors.");
                expect(message).not.toContain("{{");
            }
        }
    });

    test("rejects a model declaring both axes instead of emitting an unpriced 2-segment key", async () => {
        const fetch = managedBridge(vi.fn());
        const imageConfig = { ...config("managed-image"), size: "16:9", quality: "2K" };

        await expect(requestOpenAIImages(imageConfig, "cat", [], 1, undefined, undefined, { resolutions: ["1K", "2K"], qualities: ["standard", "fine", "ultra"] }))
            .rejects.toThrow(i18n.t("apiErrors.managedImageSpecTwoAxesUnsupported", { model: "managed-image", size: "16:9", quality: "2K" }));
        expect(fetch).not.toHaveBeenCalled();
    });

    test("keeps folding the pixel size for BYOK requests", async () => {
        const post = vi.spyOn(axios, "post").mockResolvedValue({ data: { data: [{ b64_json: "aW1hZ2U=" }] } });
        const imageConfig: AiConfig = {
            ...defaultConfig,
            credentialMode: "byok",
            credentialModes: { agent: "byok", text: "byok", image: "byok", video: "byok", audio: "byok" },
            model: "gpt-image-2",
            baseUrl: "https://api.openai.com",
            apiKey: "byok-secret",
            size: "16:9",
            quality: "high",
        };

        await expect(requestOpenAIImages(imageConfig, "cat", [], 1)).resolves.toMatchObject([{ dataUrl: "data:image/png;base64,aW1hZ2U=" }]);

        expect(post.mock.calls[0]![1]).toEqual(expect.objectContaining({ size: "3840x2160", quality: "high" }));
    });

    test("reads the second axis from the resolved catalog descriptor", async () => {
        resetManagedCatalogForTests();
        const fetch = vi.fn(async (request) => ({
            id: request.id, status: 200, statusText: "OK", headers: { "content-type": "application/json" },
            body: { kind: "text" as const, value: '{"data":[{"b64_json":"aW1hZ2U="}]}' },
        }));
        const listModels = vi.fn(async () => [{ id: "managed-image", name: "Managed image", capability: "image" as const, execution: "direct" as const, spec: { aspectRatios: ["16:9"], resolutions: ["1K", "2K", "4K"] } }]);
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels, fetch, abort: vi.fn() } };
        await ensureManagedCatalog();
        const imageConfig = { ...config("managed-image"), size: "16:9", quality: "2K" };

        await openAIImageAdapter.generate!({ config: imageConfig, channelId: "managed", prompt: "cat", images: [], params: {}, signal: undefined });

        expect(capturedBody(fetch)).toEqual(expect.objectContaining({ size: "16:9|2K" }));
    });
});

describe("managed OpenAI-compatible media requests", () => {
    test("routes image generation through the credential-free desktop bridge", async () => {
        const post = vi.spyOn(axios, "post");
        const fetch = vi.fn(async (request) => ({
            id: request.id,
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
            body: { kind: "text" as const, value: '{"data":[{"b64_json":"aW1hZ2U="}]}' },
        }));
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(), fetch, abort: vi.fn() } };

        await expect(requestOpenAIImages(config("managed-image"), "cat", [], 1)).resolves.toMatchObject([{ dataUrl: "data:image/png;base64,aW1hZ2U=" }]);
        expect(post).not.toHaveBeenCalled();
        expect(fetch.mock.calls[0]![0]).toMatchObject({ path: "/v1/images/generations", timeoutClass: "image" });
    });

    test("returns managed speech bytes as a playable Blob", async () => {
        const fetch = vi.fn(async (request) => ({
            id: request.id,
            status: 200,
            statusText: "OK",
            headers: { "content-type": "audio/mpeg" },
            body: { kind: "bytes" as const, value: new Uint8Array([0x49, 0x44, 0x33]), contentType: "audio/mpeg" },
        }));
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(), fetch, abort: vi.fn() } };

        const result = await requestOpenAISpeech(config("managed-speech"), "hello", "alloy", "mp3", 1, "");
        expect(result).toBeInstanceOf(Blob);
        expect(result.type).toBe("audio/mpeg");
        expect(fetch.mock.calls[0]![0]).toMatchObject({ path: "/v1/audio/speech", timeoutClass: "audio" });
    });

    test("creates and polls a managed video task without a renderer credential", async () => {
        const fetch = vi.fn()
            .mockImplementationOnce(async (request) => ({ id: request.id, status: 202, statusText: "Accepted", headers: { "content-type": "application/json" }, body: { kind: "text", value: '{"id":"video-1","state":"reserving"}' } }))
            .mockImplementationOnce(async (request) => ({ id: request.id, status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: { kind: "text", value: '{"id":"video-1","state":"submitted"}' } }));
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(async () => [{ id: "minimax_h3_lightx2v_v5", name: "Managed video", capability: "video" as const, execution: "remote_task" as const, video_specs: [{ resolution: "768p横", orientation: "landscape" as const, quality: "768p", duration: { min: 1, max: 10, default: 5, integer: true } }], input_slots: [] }]), fetch, abort: vi.fn() } };

        const task = await createOpenAIVideoTask(config("minimax_h3_lightx2v_v5"), "minimax_h3_lightx2v_v5", "move", []);
        await expect(pollOpenAIVideoTask(config("minimax_h3_lightx2v_v5"), task)).resolves.toMatchObject({ status: "pending" });
        expect(fetch.mock.calls.map(([request]) => [request.method, request.path])).toEqual([
            ["POST", "/v1/media/tasks"],
            ["GET", "/v1/media/tasks/video-1"],
        ]);
    });

    test("uploads managed image references before creating the task", async () => {
        const fetch = vi.fn()
            .mockImplementationOnce(async (request) => ({ id: request.id, status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: { kind: "text", value: '{"asset_id":"asset-1"}' } }))
            .mockImplementationOnce(async (request) => ({ id: request.id, status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: { kind: "text", value: '{"status":"uploaded"}' } }))
            .mockImplementationOnce(async (request) => ({ id: request.id, status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: { kind: "text", value: '{"status":"ready"}' } }))
            .mockImplementationOnce(async (request) => ({ id: request.id, status: 202, statusText: "Accepted", headers: { "content-type": "application/json" }, body: { kind: "text", value: '{"id":"video-2","state":"reserving"}' } }));
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(async () => [{ id: "minimax_h3_lightx2v_v5", name: "Managed video", capability: "video" as const, execution: "remote_task" as const, video_specs: [{ resolution: "768p横", orientation: "landscape" as const, quality: "768p", duration: { min: 1, max: 10, default: 5, integer: true } }], input_slots: [{ field: "first_frame", kind: "image" as const, required: true, accept_types: ["image/png"] }] }]), fetch, abort: vi.fn() } };
        const reference = { id: "ref-1", name: "frame.png", type: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" };
        await expect(createOpenAIVideoTask(config("minimax_h3_lightx2v_v5"), "minimax_h3_lightx2v_v5", "move", [reference])).resolves.toMatchObject({ id: "video-2", provider: "shotshot" });
        expect(fetch.mock.calls.map(([request]) => [request.method, request.path])).toEqual([
            ["POST", "/v1/assets/upload"], ["POST", "/v1/assets/asset-1/content"], ["POST", "/v1/assets/asset-1/complete"], ["POST", "/v1/media/tasks"],
        ]);
    });

    test("uploads managed audio and video references into declared public slots", async () => {
        let uploadCount = 0;
        const fetch = vi.fn().mockImplementation(async (request) => {
            const isUpload = request.path === "/v1/assets/upload";
            const value = isUpload ? JSON.stringify({ asset_id: `asset-${++uploadCount}` }) : request.path === "/v1/media/tasks" ? '{"id":"video-media","state":"reserving"}' : '{"status":"ready"}';
            return { id: request.id, status: request.path === "/v1/media/tasks" ? 202 : 200, statusText: "OK", headers: { "content-type": "application/json" }, body: { kind: "text", value } };
        });
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(async () => [{ id: "minimax_h3_lightx2v_v5", name: "Managed video", capability: "video" as const, execution: "remote_task" as const, video_specs: [{ resolution: "768p横", orientation: "landscape" as const, quality: "768p", duration: { min: 1, max: 10, default: 5, integer: true } }], input_slots: [{ field: "ref_audio_0", kind: "audio" as const, required: true, accept_types: ["audio/mpeg"] }, { field: "ref_video_0", kind: "video" as const, required: false, accept_types: ["video/mp4"] }] }]), fetch, abort: vi.fn() } };
        await expect(createOpenAIVideoTask(config("minimax_h3_lightx2v_v5"), "minimax_h3_lightx2v_v5", "lip sync", [], undefined, {
            audioReferences: [{ id: "a", name: "voice.mp3", type: "audio/mpeg", url: "data:audio/mpeg;base64,SUQz" }],
            videoReferences: [{ id: "v", name: "motion.mp4", type: "video/mp4", url: "data:video/mp4;base64,AAAA" }],
        })).resolves.toMatchObject({ id: "video-media", provider: "shotshot" });
        expect(fetch.mock.calls.map(([request]) => [request.method, request.path])).toEqual([
            ["POST", "/v1/assets/upload"], ["POST", "/v1/assets/asset-1/content"], ["POST", "/v1/assets/asset-1/complete"],
            ["POST", "/v1/assets/upload"], ["POST", "/v1/assets/asset-2/content"], ["POST", "/v1/assets/asset-2/complete"], ["POST", "/v1/media/tasks"],
        ]);
        expect(JSON.parse(fetch.mock.calls.at(-1)![0].body.value).assets).toEqual({ ref_audio_0: "asset-1", ref_video_0: "asset-2" });
    });

    test("uses the managed task query path from the canvas adapter", async () => {
        const fetch = vi.fn()
            .mockImplementationOnce(async (request) => ({ id: request.id, status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: { kind: "text", value: '{"id":"video-3","state":"succeeded","result_asset_id":"asset-3"}' } }))
            .mockImplementationOnce(async (request) => ({ id: request.id, status: 200, statusText: "OK", headers: { "content-type": "video/mp4" }, body: { kind: "bytes", value: new Uint8Array([0, 1, 2]), contentType: "video/mp4" } }));
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(), fetch, abort: vi.fn() } };
        const configValue = config("minimax_h3_lightx2v_v5");
        const state = await openAIVideoAdapter.query!({ config: configValue, prompt: "move", images: [], params: {}, taskId: "video-3" });
        expect(state.status).toBe("succeeded");
        expect(fetch.mock.calls.map(([request]) => [request.method, request.path])).toEqual([
            ["GET", "/v1/media/tasks/video-3"], ["GET", "/v1/media/tasks/video-3/content"],
        ]);
    });
});
