import { expect, it, test, vi } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseAgentModelConfig, resolveAgentModel } from "./agent-model-config";
test.each([{ source: "chatgpt", model: "gpt", apiKey: "sentinel" }, { source: "chatgpt", model: "gpt", baseUrl: "https://evil.test" }, { source: "unknown", model: "gpt" }])("rejects provider and credential injection", config => expect(() => parseAgentModelConfig(config)).toThrow());
test("ChatGPT requires native model and resolved auth", async () => {
    const runtime = { getModel: vi.fn(() => ({ id: "gpt", provider: "openai-codex", input: ["text", "image"] })), getAuth: vi.fn(async () => undefined) };
    await expect(resolveAgentModel({ source: "chatgpt", model: "gpt" }, runtime as unknown as ModelRuntime)).rejects.toThrow("chatgpt_auth_required");
    expect(runtime.getModel).toHaveBeenCalledWith("openai-codex", "gpt");
});

test("BYOK configuration changes cannot overwrite another active provider's credentials", async () => {
    const providers = new Map<string, unknown>();
    const runtime = { getModel: vi.fn(() => undefined), registerNativeProvider: vi.fn((provider: {id: string}) => { providers.set(provider.id, provider); }) };
    const config = { source: "byok" as const, model: "test", apiKey: "sentinel-first", baseUrl: "https://example.test", apiFormat: "openai" as const, agentApiMode: "responses" as const, supportsImageInput: false };
    const first = await resolveAgentModel(config, runtime as unknown as ModelRuntime);
    const second = await resolveAgentModel({ ...config, apiKey: "sentinel-second" }, runtime as unknown as ModelRuntime);
    expect(first.provider).not.toBe(second.provider);
    expect(providers.size).toBe(2);
    expect(first.provider).not.toContain("sentinel");
});

it("accepts OpenRouter and binds every destination and protocol field in the provider fingerprint", async () => {
    const config = { source: "byok" as const, provider: "openrouter" as const, model: "a/model:free", apiKey: "fixture-key", baseUrl: "https://openrouter.ai/api/v1", apiFormat: "openai" as const, agentApiMode: "responses" as const, supportsImageInput: false };
    expect(parseAgentModelConfig(config)).toEqual(config);
    const runtime = { getModel: vi.fn(() => undefined), registerNativeProvider: vi.fn() } as unknown as ModelRuntime;
    const variants = [config, { ...config, model: "a/other" }, { ...config, apiKey: "fixture-other" }, { ...config, baseUrl: "https://proxy.example/router" }, { ...config, supportsImageInput: true }, { ...config, agentApiMode: "chat_completions" as const }, { ...config, provider: "custom" as const }];
    const models = await Promise.all(variants.map(value => resolveAgentModel(value, runtime)));
    expect(new Set(models.map(model => model.provider)).size).toBe(variants.length);
    expect(models[0].api).toBe("openai-completions");
});

test("byok configs reject stale credential modes and unknown sources", () => {
    expect(() => parseAgentModelConfig({ credentialMode: "shotshot", model: "minimax-m3", apiFormat: "openai", agentApiMode: "chat_completions", supportsImageInput: true })).toThrow("invalid_agent_model_config");
    expect(() => parseAgentModelConfig({ source: "platform", model: "gpt" })).toThrow("invalid_agent_model_config");
});
