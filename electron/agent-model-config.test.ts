import { expect, it, test, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ResolvedTextModelConfig } from "@/lib/agent/pi-agent-types";
import { parseAgentModelConfig, resolveAgentModel } from "./agent-model-config";
test.each([{ source: "chatgpt", model: "gpt", apiKey: "sentinel" }, { source: "chatgpt", model: "gpt", baseUrl: "https://evil.test" }, { source: "unknown", model: "gpt" }])("rejects provider and credential injection", config => expect(() => parseAgentModelConfig(config)).toThrow());
test("platform never falls back to API channels", async () => {
    const registerNativeProvider = vi.fn(); await expect(resolveAgentModel({ source: "platform", model: "gpt" }, { registerNativeProvider } as unknown as ModelRuntime)).rejects.toThrow("platform_agent_unavailable"); expect(registerNativeProvider).not.toHaveBeenCalled();
});
test("ChatGPT requires native model and resolved auth", async () => {
    const runtime = { getModel: vi.fn(() => ({ id: "gpt", provider: "openai-codex", input: ["text", "image"] })), getAuth: vi.fn(async () => undefined) };
    await expect(resolveAgentModel({ source: "chatgpt", model: "gpt" }, runtime as unknown as ModelRuntime)).rejects.toThrow("chatgpt_auth_required");
    expect(runtime.getModel).toHaveBeenCalledWith("openai-codex", "gpt");
});

test("BYOK configuration changes cannot overwrite another active provider's credentials", async () => {
    const providers = new Map<string, unknown>();
    const runtime = { getModel: vi.fn(() => undefined), registerNativeProvider: vi.fn((provider: {id: string}) => { providers.set(provider.id, provider); }) };
    const config = { model: "test", apiKey: "sentinel-first", baseUrl: "https://example.test", apiFormat: "openai" as const, agentApiMode: "responses" as const, supportsImageInput: false };
    const first = await resolveAgentModel(config, runtime as unknown as ModelRuntime);
    const second = await resolveAgentModel({ ...config, apiKey: "sentinel-second" }, runtime as unknown as ModelRuntime);
    expect(first.provider).not.toBe(second.provider);
    expect(providers.size).toBe(2);
    expect(first.provider).not.toContain("sentinel");
});

it("accepts OpenRouter and binds every destination and protocol field in the provider fingerprint", async () => {
    const config = { provider: "openrouter" as const, model: "a/model:free", apiKey: "fixture-key", baseUrl: "https://openrouter.ai/api/v1", apiFormat: "openai" as const, agentApiMode: "responses" as const, supportsImageInput: false };
    expect(parseAgentModelConfig(config)).toEqual(config);
    const runtime = { getModel: vi.fn(() => undefined), registerNativeProvider: vi.fn() } as unknown as ModelRuntime;
    const variants = [config, { ...config, model: "a/other" }, { ...config, apiKey: "fixture-other" }, { ...config, baseUrl: "https://proxy.example/router" }, { ...config, supportsImageInput: true }, { ...config, agentApiMode: "chat_completions" as const }, { ...config, provider: "custom" as const }];
    const models = await Promise.all(variants.map(value => resolveAgentModel(value, runtime)));
    expect(new Set(models.map(model => model.provider)).size).toBe(variants.length);
    expect(models[0].api).toBe("openai-completions");
});

test("managed configs reject renderer capability flags", () => {
    expect(() => parseAgentModelConfig({ credentialMode: "shotshot", model: "minimax-m3", apiFormat: "openai", agentApiMode: "chat_completions", supportsImageInput: true })).toThrow("invalid_agent_model_config");
    expect(() => parseAgentModelConfig({ credentialMode: "shotshot", model: "minimax-m3", apiFormat: "openai", agentApiMode: "chat_completions", inputModalities: ["text", "image"] })).toThrow("invalid_agent_model_config");
});

test("managed modalities re-resolve per idle call and replace the same stable provider when the catalog flips", async () => {
    const registeredModels = new Map<string, Model<any>>();
    const registeredProviderIds: string[] = [];
    const runtime = {
        getModel: (_provider: string, id: string) => registeredModels.get(id),
        registerNativeProvider: vi.fn((provider: { id: string; getModels: () => Model<any>[] }) => {
            registeredProviderIds.push(provider.id);
            const model = provider.getModels()[0]!;
            registeredModels.set(model.id, model);
        }),
    } as unknown as ModelRuntime;
    let inputModalities: Array<"text" | "image"> = ["text"];
    const managedAccess = {
        baseUrl: "https://gateway.example",
        resolveApiKey: async () => "managed-secret",
        resolveTextModelDescriptor: async () => ({ inputModalities }),
    };
    const config: ResolvedTextModelConfig = { credentialMode: "shotshot", model: "minimax-m3", apiFormat: "openai", agentApiMode: "chat_completions" };

    const textOnly = await resolveAgentModel(config, runtime, managedAccess);
    expect(textOnly.input).toEqual(["text"]);

    inputModalities = ["text", "image"];
    const multimodal = await resolveAgentModel(config, runtime, managedAccess);
    expect(multimodal.input).toEqual(["text", "image"]);
    expect(multimodal.provider).toBe(textOnly.provider);

    inputModalities = ["text"];
    const backToText = await resolveAgentModel(config, runtime, managedAccess);
    expect(backToText.input).toEqual(["text"]);

    // 同一稳定 provider id 原地替换三次，绝不派生自能力的临时 id。
    expect(registeredProviderIds).toEqual(["shotshot-cloud", "shotshot-cloud", "shotshot-cloud"]);
});
