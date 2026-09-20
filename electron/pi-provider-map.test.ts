import { describe, expect, it, test, vi } from "vitest";

import { buildModelsFromConfig } from "@/lib/agent/pi-provider-map";

const baseConfig = {
    credentialMode: "byok" as const,
    model: "gpt-5.5",
    baseUrl: "https://api.openai.com",
    apiKey: "secret",
    apiFormat: "openai" as const,
    supportsImageInput: false,
};

describe("Agent provider protocol", () => {
    test("uses the Responses API for OpenAI-format Agent models by default", () => {
        const { model } = buildModelsFromConfig({ ...baseConfig, agentApiMode: "responses" } as never);

        expect(model.api).toBe("openai-responses");
        expect(model.baseUrl).toBe("https://api.openai.com/v1");
    });

    test("keeps Chat Completions as an explicit compatibility mode", () => {
        const { model } = buildModelsFromConfig({ ...baseConfig, agentApiMode: "chat_completions" } as never);

        expect(model.api).toBe("openai-completions");
    });

    test("enables reasoning params only for Responses models marked as reasoning-capable", () => {
        const responses = { ...baseConfig, agentApiMode: "responses" as const };
        expect(buildModelsFromConfig(responses).model.reasoning).toBe(false);
        expect(buildModelsFromConfig({ ...responses, supportsReasoning: true }).model.reasoning).toBe(true);
        expect(buildModelsFromConfig({ ...responses, supportsReasoning: true, agentApiMode: "chat_completions" }).model.reasoning).toBe(false);
    });

    test("keeps DeepSeek's official base URL when using the Responses API", () => {
        const { model } = buildModelsFromConfig({ ...baseConfig, baseUrl: "https://api.deepseek.com", provider: "deepseek", agentApiMode: "responses" });

        expect(model.api).toBe("openai-responses");
        expect(model.baseUrl).toBe("https://api.deepseek.com");
    });

    test("builds a managed provider with main-owned async authentication", async () => {
        const resolveApiKey = vi.fn(async () => "managed-secret");
        const { models, model } = buildModelsFromConfig(
            { credentialMode: "shotshot", model: "managed-text", apiFormat: "openai", agentApiMode: "chat_completions" },
            { baseUrl: "https://gateway.example", resolveApiKey, inputModalities: ["text"] },
        );
        const provider = models.getProvider(model.provider)!;

        expect(model).toMatchObject({ provider: "shotshot-cloud", baseUrl: "https://gateway.example/v1", api: "openai-completions" });
        expect(model.input).toEqual(["text"]);
        await expect(provider.auth?.apiKey?.resolve({} as never)).resolves.toEqual({ auth: { apiKey: "managed-secret" } });
        expect(resolveApiKey).toHaveBeenCalledWith("managed-text");
    });

    test("maps a resolved managed descriptor with image input onto the Pi model", () => {
        const { model } = buildModelsFromConfig(
            { credentialMode: "shotshot", model: "minimax-m3", apiFormat: "openai", agentApiMode: "chat_completions" },
            { baseUrl: "https://gateway.example", resolveApiKey: async () => "managed-secret", inputModalities: ["text", "image"] },
        );

        expect(model.input).toEqual(["text", "image"]);
    });

    test("refuses to construct a managed provider without main-process access", () => {
        expect(() => buildModelsFromConfig({ credentialMode: "shotshot", model: "managed-text", apiFormat: "openai", agentApiMode: "chat_completions" })).toThrow("managed_provider_unavailable");
    });
});

it.each(["https://openrouter.ai/api/v1", "https://proxy.example/router"])("uses OpenRouter Chat Completions at %s without mutating preferences", (baseUrl) => {
    const config = { credentialMode: "byok" as const, provider: "openrouter" as const,
        model: "a/model:free", apiKey: "fixture-key", baseUrl,
        apiFormat: "openai" as const, agentApiMode: "responses" as const, supportsImageInput: true };
    const { model } = buildModelsFromConfig(config);
    expect(model.api).toBe("openai-completions");
    expect(model.id).toBe("a/model:free");
    expect(model.baseUrl).toBe(baseUrl);
    expect(model.input).toEqual(["text", "image"]);
    expect(config.agentApiMode).toBe("responses");
});
