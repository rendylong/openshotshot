import { describe, expect, it, test } from "vitest";

import { buildModelsFromConfig } from "@/lib/agent/pi-provider-map";
import type { ByokTextModelConfig } from "@/lib/agent/pi-agent-types";

function config(supportsImageInput: boolean): ByokTextModelConfig {
    return {
        model: "agent-model",
        baseUrl: "https://api.example.com",
        apiKey: "test-key",
        apiFormat: "openai",
        agentApiMode: "responses",
        supportsImageInput,
    };
}

describe("buildModelsFromConfig image input", () => {
    test("declares image input when the configured Agent model supports it", () => {
        expect(buildModelsFromConfig(config(true)).model.input).toEqual(["text", "image"]);
    });

    test("keeps a text-only Agent model from receiving image blocks", () => {
        expect(buildModelsFromConfig(config(false)).model.input).toEqual(["text"]);
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
