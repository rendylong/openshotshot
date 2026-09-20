import { afterEach, describe, expect, test, vi } from "vitest";

const { saveAs } = vi.hoisted(() => ({ saveAs: vi.fn() }));

vi.mock("file-saver", () => ({ saveAs }));

import { exportAppConfig, importAppConfig } from "@/services/config-file";
import { CONFIG_STORE_KEY, modelOptionLabel, createModelChannel, defaultConfig, defaultWebdavSyncConfig, encodeChannelModel, normalizeAiConfig, normalizeChannelModels, resolveModelExecution, useConfigStore, type AiConfig } from "@/stores/use-config-store";

const initialState = useConfigStore.getState();

afterEach(() => {
    saveAs.mockReset();
    localStorage.removeItem(CONFIG_STORE_KEY);
    useConfigStore.setState(initialState, true);
});

describe("model execution configuration", () => {
    test("drops legacy credentialMode keys from persisted config without throwing", () => {
        const legacy = { ...defaultConfig, credentialMode: "shotshot", credentialModes: { agent: "shotshot" }, managedModels: { image: "x" }, managedAgentModel: "managed-text" } as Partial<AiConfig>;
        const normalized = normalizeAiConfig(legacy);
        expect("credentialMode" in normalized).toBe(false);
        expect("credentialModes" in normalized).toBe(false);
        expect("managedModels" in normalized).toBe(false);
        expect("managedAgentModel" in normalized).toBe(false);
    });

    test("keeps script-free models free of generated execution configuration", () => {
        const model = normalizeChannelModels([{ name: "image-x", capability: "image" }])[0];
        expect(model).toEqual({ name: "image-x", capability: "image" });
    });

    test("preserves imported legacy scripts and remote task configuration byte-for-byte", () => {
        const legacy = {
            name: "private-video",
            capability: "audio" as const,
            executionMode: "remote_task" as const,
            script: "\n return 'direct legacy'; \n",
            remoteTask: {
                timeoutMinutes: 9,
                submitScript: "\nreturn 'remote-id';\n",
                queryScript: "\nreturn { status: 'pending' };\n",
            },
        };

        expect(normalizeChannelModels([legacy])[0]).toEqual(legacy);
    });

    test("resolves encoded models to the correct channel when names repeat", () => {
        const config = {
            ...defaultConfig,
            channels: [
                { ...defaultConfig.channels[0], id: "first", models: normalizeChannelModels([{ name: "shared", capability: "video" }]) },
                { ...defaultConfig.channels[0], id: "second", models: normalizeChannelModels([{ name: "shared", capability: "audio", executionMode: "remote_task", remoteTask: { timeoutMinutes: 9, submitScript: "submit", queryScript: "query" } }]) },
            ],
        };
        const execution = resolveModelExecution(config, encodeChannelModel("second", "shared"));
        expect(execution?.executionMode).toBe("remote_task");
        expect(execution?.remoteTask).toEqual({ timeoutMinutes: 9, submitScript: "submit", queryScript: "query" });
    });

    test("returns undefined for an unresolved model value", () => {
        expect(resolveModelExecution(defaultConfig, encodeChannelModel("missing", "model"))).toBeUndefined();
    });
});

describe("official channel presets", () => {
    test("creates an empty OpenRouter preset at the official API base", () => {
        expect(createModelChannel({ provider: "openrouter" })).toMatchObject({
            name: "OpenRouter",
            provider: "openrouter",
            baseUrl: "https://openrouter.ai/api/v1",
            apiFormat: "openai",
            models: [],
        });
    });

    test("encodes identical model names independently for different channels", () => {
        expect(encodeChannelModel("openrouter", "vendor/model:free")).not.toBe(encodeChannelModel("custom", "vendor/model:free"));
    });

    test("creates MiniMax China with the official host and current multimodal models", () => {
        const channel = createModelChannel({ provider: "minimax-cn" } as never);

        expect(channel).toMatchObject({ provider: "minimax-cn", baseUrl: "https://api.minimaxi.com", apiFormat: "openai" });
        expect(channel.models.map(({ name, capability }) => [name, capability])).toEqual([
            ["MiniMax-M2.7", "text"],
            ["MiniMax-M2.7-highspeed", "text"],
            ["image-01", "image"],
            ["image-01-live", "image"],
            ["MiniMax-Hailuo-2.3", "video"],
            ["MiniMax-Hailuo-2.3-Fast", "video"],
            ["MiniMax-H3", "video"],
            ["MiniMax-H3-Max", "video"],
            ["speech-2.8-hd", "audio"],
            ["speech-2.8-turbo", "audio"],
        ]);
    });

    test("uses the international MiniMax host without changing model contracts", () => {
        const channel = createModelChannel({ provider: "minimax-global" } as never);

        expect(channel).toMatchObject({ provider: "minimax-global", baseUrl: "https://api.minimax.io" });
        expect(channel.models.map((model) => model.name)).toContain("MiniMax-Hailuo-2.3");
    });

    test("does not materialize scripts for new MiniMax presets", () => {
        const channel = createModelChannel({ provider: "minimax-global" });
        const video = channel.models.find((item) => item.name === "MiniMax-Hailuo-2.3");

        expect(video).toEqual({ name: "MiniMax-Hailuo-2.3", capability: "video" });
        expect(video).not.toHaveProperty("script");
        expect(video).not.toHaveProperty("remoteTask");
    });

    test("creates DeepSeek as a text-only official channel", () => {
        const channel = createModelChannel({ provider: "deepseek" } as never);

        expect(channel).toMatchObject({ provider: "deepseek", baseUrl: "https://api.deepseek.com", apiFormat: "openai" });
        expect(channel.models.map(({ name, capability }) => [name, capability])).toEqual([
            ["deepseek-v4-flash", "text"],
            ["deepseek-v4-pro", "text"],
            ["deepseek-v4-flash-vision-exp", "text"],
        ]);
    });

    test.each([
        ["moonshot", "https://api.moonshot.cn/v1", "kimi-k2.5"],
        ["zhipu", "https://open.bigmodel.cn/api/paas/v4", "glm-5.2"],
    ] as const)("creates the %s official preset", (provider, baseUrl, model) => {
        const channel = createModelChannel({ provider });

        expect(channel.baseUrl).toBe(baseUrl);
        expect(channel.models.some((item) => item.name === model)).toBe(true);
    });

    test("creates HiAPI with the unified async endpoint and media catalog", () => {
        const channel = createModelChannel({ provider: "hiapi" });

        expect(channel).toMatchObject({ provider: "hiapi", baseUrl: "https://api.hiapi.ai", apiFormat: "openai" });
        expect(channel.models.map(({ name, capability }) => [name, capability])).toEqual(expect.arrayContaining([
            ["gpt-image-2/text-to-image", "image"],
            ["gpt-image-2/image-to-image", "image"],
            ["veo-3.1/text-to-video", "video"],
            ["veo-3.1/image-to-video", "video"],
            ["qwen-audio-3.0-tts-plus", "audio"],
            ["qwen-audio-3.0-tts-flash", "audio"],
            ["elevenlabs/text-to-dialogue", "audio"],
            ["minimax-music-1.5", "audio"],
            ["minimax-music-2.6", "audio"],
        ]));
    });

    test("keeps a selected persisted model when a refreshed channel omits it", () => {
        const channel = createModelChannel({
            id: "moonshot",
            provider: "moonshot",
            models: [{ name: "kimi-k2.5", capability: "text" }],
        });
        const selected = encodeChannelModel(channel.id, "kimi-k2.5");

        const config = normalizeAiConfig({
            ...defaultConfig,
            channels: [{ ...channel, models: [{ name: "other-model", capability: "text" }] }],
            model: selected,
            textModel: selected,
            agentModel: selected,
        });

        expect(config.channels[0].models.map((model) => model.name)).toContain("kimi-k2.5");
        expect(config.model).toBe(selected);
        expect(config.textModel).toBe(selected);
        expect(config.agentModel).toBe(selected);
    });
});

describe("configuration import and export", () => {
    test("round-trips automatic and legacy models without generated JavaScript or resolver secrets", async () => {
        const secret = "round-trip-secret-key";
        const automatic = { name: "MiniMax-Hailuo-2.3", capability: "video" as const };
        const legacy = {
            name: "private-video",
            capability: "video" as const,
            executionMode: "remote_task" as const,
            remoteTask: {
                timeoutMinutes: 7,
                submitScript: "\nreturn 'task-7';\n",
                queryScript: "\nreturn { status: 'pending' };\n",
            },
        };
        const channel = createModelChannel({
            id: "round-trip",
            provider: "minimax-global",
            apiKey: secret,
            models: [automatic, legacy],
        });
        const selected = encodeChannelModel(channel.id, automatic.name);
        useConfigStore.setState({
            config: normalizeAiConfig({
                ...defaultConfig,
                channels: [channel],
                model: selected,
                videoModel: selected,
            }),
            webdav: defaultWebdavSyncConfig,
        });

        await exportAppConfig();
        const exportedBlob = saveAs.mock.calls[0]?.[0] as Blob;
        const exportedText = await exportedBlob.text();
        useConfigStore.setState({ config: defaultConfig, webdav: defaultWebdavSyncConfig });
        await importAppConfig({ text: async () => exportedText } as File);

        const imported = useConfigStore.getState().config.channels[0];
        expect(imported.models[0]).toEqual(automatic);
        expect(JSON.stringify(imported.models[0])).not.toContain("return");
        expect(JSON.stringify(imported.models)).not.toContain(secret);
        expect(imported.models[1]).toEqual(legacy);
        expect(imported.apiKey).toBe(secret);
    });
});

describe("Agent model settings", () => {
    test("defaults the Agent to its own model and the Responses API", () => {
        expect(defaultConfig).toMatchObject({ agentModel: "default::gpt-5.5", agentApiMode: "responses" });
    });

    test("migrates a persisted text model into the independent Agent model", async () => {
        const legacyConfig = {
            ...defaultConfig,
            channels: [{ ...defaultConfig.channels[0], id: "legacy", models: [{ name: "legacy-text", capability: "text" }] }],
            textModel: "legacy::legacy-text",
        };
        delete (legacyConfig as Record<string, unknown>).agentModel;
        delete (legacyConfig as Record<string, unknown>).agentApiMode;
        localStorage.setItem(CONFIG_STORE_KEY, JSON.stringify({ state: { config: legacyConfig }, version: 0 }));

        await useConfigStore.persist.rehydrate();

        expect(useConfigStore.getState().config).toMatchObject({ agentModel: "legacy::legacy-text", agentApiMode: "responses" });
    });

    test("infers image input for the bundled Agent model while keeping unknown custom models text-only", () => {
        expect(normalizeChannelModels([{ name: "gpt-5.5", capability: "text" }])[0]).toMatchObject({ supportsImageInput: true });
        expect(normalizeChannelModels([{ name: "MiniMax-M3", capability: "text" }], {
            provider: "minimax-cn",
            baseUrl: "https://api.minimaxi.com/v1",
            apiFormat: "openai",
        })[0]).toMatchObject({ supportsImageInput: true });
        expect(normalizeChannelModels([{ name: "private-text", capability: "text" }])[0]).not.toHaveProperty("supportsImageInput");
    });

    test("preserves an explicit image-input override instead of re-inferring it", () => {
        expect(normalizeChannelModels([{ name: "gpt-5.5", capability: "text", supportsImageInput: false }])[0]).toMatchObject({ supportsImageInput: false });
        expect(normalizeChannelModels([{ name: "private-text", capability: "text", supportsImageInput: true }])[0]).toMatchObject({ supportsImageInput: true });
    });
});


describe("AutoDL channel configuration", () => {
    test("creates eleven video workflows with empty credentials", () => {
        const channel = createModelChannel({ provider: "autodl" });
        expect(channel).toMatchObject({ provider: "autodl", baseUrl: "https://autodl.art", apiKey: "" });
        expect(channel.models).toHaveLength(11);
        expect(channel.models.every(({ capability }) => capability === "video")).toBe(true);
    });
    test("preserves explicit provider and credentials through config save/restore", () => {
        const channel = createModelChannel({ id: "autodl-test", provider: "autodl", baseUrl: "https://proxy.example.test", apiKey: "test-placeholder" });
        const videoModel = encodeChannelModel(channel.id, channel.models[0].name);
        const restored = normalizeAiConfig(JSON.parse(JSON.stringify({ ...defaultConfig, channels: [channel], videoModel })));
        expect(restored.channels).toEqual([channel]);
        expect(restored.videoModel).toBe(videoModel);
        expect(modelOptionLabel(restored, videoModel)).toContain("H3");
        expect(modelOptionLabel(restored, videoModel)).toContain(channel.models[0].name);
    });
});


test("reference compression defaults on for existing configs and preserves an explicit off switch", () => {
    expect(normalizeAiConfig({}).compressReferenceImages).toBe(true);
    expect(normalizeAiConfig({ compressReferenceImages: false }).compressReferenceImages).toBe(false);
});
