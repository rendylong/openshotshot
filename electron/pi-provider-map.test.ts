import { describe, expect, it, test } from "vitest";

import { buildModelsFromConfig } from "@/lib/agent/pi-provider-map";

const baseConfig = {
    source: "byok" as const,
    model: "gpt-5.5",
    baseUrl: "https://api.openai.com",
    apiKey: "secret",
    apiFormat: "openai" as const,
    agentApiMode: "responses" as const,
    supportsImageInput: false,
};

describe("Agent provider protocol", () => {
    test("uses the Responses API for OpenAI-format Agent models by default", () => {
        const { model } = buildModelsFromConfig({ ...baseConfig, agentApiMode: "responses" });

        expect(model.api).toBe("openai-responses");
        expect(model.baseUrl).toBe("https://api.openai.com/v1");
    });

    test("keeps Chat Completions as an explicit compatibility mode", () => {
        const { model } = buildModelsFromConfig({ ...baseConfig, agentApiMode: "chat_completions" });

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

    test("maps declared image-input support onto the Pi model", () => {
        const { model } = buildModelsFromConfig({ ...baseConfig, supportsImageInput: true });

        expect(model.input).toEqual(["text", "image"]);
    });
});

it.each(["https://openrouter.ai/api/v1", "https://proxy.example/router"])("uses OpenRouter Chat Completions at %s without mutating preferences", (baseUrl) => {
    const config = { source: "byok" as const, provider: "openrouter" as const,
        model: "a/model:free", apiKey: "fixture-key", baseUrl,
        apiFormat: "openai" as const, agentApiMode: "responses" as const, supportsImageInput: true };
    const { model } = buildModelsFromConfig(config);
    expect(model.api).toBe("openai-completions");
    expect(model.id).toBe("a/model:free");
    expect(model.baseUrl).toBe(baseUrl);
    expect(model.input).toEqual(["text", "image"]);
    expect(config.agentApiMode).toBe("responses");
});
