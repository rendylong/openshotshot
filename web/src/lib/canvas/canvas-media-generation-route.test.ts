import { afterEach, describe, expect, test, vi } from "vitest";

import { ensureManagedCatalog, resetManagedCatalogForTests } from "@/lib/desktop/managed-catalog-cache";
import { planCanvasMediaGeneration } from "./canvas-media-generation-route";
import { createModelChannel, defaultConfig, type AiConfig } from "@/stores/use-config-store";

function config(capability: "image" | "video" | "audio", mode: "remote_task" | "direct"): AiConfig {
    const model = `${capability}-model`;
    return {
        ...defaultConfig,
        model: `channel-1::${model}`,
        channels: [{ id: "channel-1", name: "Provider", baseUrl: "https://example.test", apiKey: "secret", apiFormat: "openai", models: [{ name: model, capability, executionMode: mode, remoteTask: { timeoutMinutes: 5, submitScript: `return '${capability}-id'`, queryScript: `return { capability: '${capability}' }` } }] }],
    };
}

function adapterConfig(): AiConfig {
    return {
        ...defaultConfig,
        model: "channel-1::cogvideox-3",
        channels: [{
            id: "channel-1",
            name: "Zhipu",
            provider: "zhipu",
            baseUrl: "https://open.bigmodel.cn/api/paas/v4",
            apiKey: "secret-key",
            apiFormat: "openai",
            models: [{ name: "cogvideox-3", capability: "video" }],
        }],
    };
}

function minimaxPresetConfig(): AiConfig {
    const channel = createModelChannel({ id: "minimax-1", provider: "minimax-cn", apiKey: "secret-key" });
    return {
        ...defaultConfig,
        model: "minimax-1::MiniMax-Hailuo-2.3",
        channels: [channel],
    };
}

function hiapiPresetConfig(): AiConfig {
    const channel = createModelChannel({ id: "hiapi-1", provider: "hiapi", apiKey: "secret-key" });
    return {
        ...defaultConfig,
        model: "hiapi-1::veo-3.1/text-to-video",
        channels: [channel],
    };
}

describe("canvas media generation routing orchestrator", () => {
    test("plans a known video model as an adapter-backed remote task", () => {
        const plan = planCanvasMediaGeneration({ config: adapterConfig(), capability: "video", phase: "first" });

        expect(plan).toMatchObject({ mode: "remote_task", adapterId: "zhipu.video", adapterVersion: 1, timeoutMinutes: 30 });
        expect(plan).not.toHaveProperty("remote.submitScript");
    });

    test("prefers the MiniMax video adapter over stale scripts in the built-in preset", () => {
        const plan = planCanvasMediaGeneration({ config: minimaxPresetConfig(), capability: "video", phase: "first" });

        expect(plan).toMatchObject({ mode: "remote_task", adapterId: "minimax.video", adapterVersion: 1 });
        expect(plan).not.toHaveProperty("remote");
    });

    test("routes a HiAPI video model through its unified async adapter", () => {
        const plan = planCanvasMediaGeneration({ config: hiapiPresetConfig(), capability: "video", phase: "first" });

        expect(plan).toMatchObject({ mode: "remote_task", adapterId: "hiapi.video", adapterVersion: 1 });
        expect(plan).not.toHaveProperty("remote");
    });

    test.each(["first", "retry"] as const)("routes all three built-in media phases through remote or direct execution (%s)", (phase) => {
        for (const capability of ["image", "video", "audio"] as const) {
            expect(planCanvasMediaGeneration({ config: config(capability, "remote_task"), capability, phase })).toMatchObject({
                mode: "remote_task",
                capability,
                phase,
                remote: { submitScript: `return '${capability}-id'`, queryScript: `return { capability: '${capability}' }` },
            });
            expect(planCanvasMediaGeneration({ config: config(capability, "direct"), capability, phase })).toEqual({ mode: "direct", capability, phase });
        }
    });

    test("keeps text and plugin-host calls direct", () => {
        expect(planCanvasMediaGeneration({ config: config("image", "remote_task"), capability: "text", phase: "first" })).toEqual({ mode: "direct", capability: "text", phase: "first" });
        expect(planCanvasMediaGeneration({ config: config("image", "remote_task"), capability: "image", phase: "retry", pluginHost: true })).toEqual({ mode: "direct", capability: "image", phase: "retry" });
    });

    test("plans a managed remote task without requiring a stored video preference", () => {
        const config = { ...defaultConfig, credentialModes: { ...defaultConfig.credentialModes, video: "shotshot" as const }, managedModels: { text: "", image: "", video: "", audio: "" } };
        expect(planCanvasMediaGeneration({ config, capability: "video", phase: "first" })).toMatchObject({ mode: "remote_task", adapterId: "openai.video", timeoutMinutes: 30 });
    });

    describe("managed image execution split by catalog execution", () => {
        function managedImageConfig(execution: "direct" | "remote_task"): AiConfig {
            window.shotshot = {
                agent: {} as never,
                skills: {} as never,
                platform: "darwin",
                managedModels: {
                    listModels: vi.fn(async () => [{ id: "gpt-image-2", name: "GPT Image 2", capability: "image" as const, execution }]),
                    fetch: vi.fn(),
                    abort: vi.fn(),
                },
            };
            return {
                ...defaultConfig,
                credentialModes: { ...defaultConfig.credentialModes, image: "shotshot" as const },
                managedModels: { text: "", image: "gpt-image-2", video: "", audio: "" },
            };
        }

        afterEach(() => {
            delete window.shotshot;
            resetManagedCatalogForTests();
        });

        test("plans a remote_task managed image model as the managed image adapter task", async () => {
            const config = managedImageConfig("remote_task");
            await ensureManagedCatalog();

            expect(planCanvasMediaGeneration({ config, capability: "image", phase: "first" })).toMatchObject({
                mode: "remote_task",
                capability: "image",
                adapterId: "shotshot.managed-image",
                adapterVersion: 1,
            });
        });

        test("keeps a direct managed image model on the synchronous path", async () => {
            const config = managedImageConfig("direct");
            await ensureManagedCatalog();

            expect(planCanvasMediaGeneration({ config, capability: "image", phase: "first" })).toEqual({ mode: "direct", capability: "image", phase: "first" });
        });
    });
});
