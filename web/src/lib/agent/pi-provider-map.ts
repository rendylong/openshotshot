import { createModels, createProvider, type ApiKeyAuth, type Model, type Models, type ProviderAuth } from "@earendil-works/pi-ai";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

import type { ByokTextModelConfig, ShotshotTextModelConfig } from "./pi-agent-types";

// 渲染进程配置里的自定义 channel → pi 的 provider + model。
// 内置的 openaiProvider()/googleProvider() 走环境变量与硬编码 baseUrl，
// 无法满足用户在配置面板里填的自定义 baseUrl / apiKey，因此这里用 createProvider
// 组装一个固定 key 的 provider，api 实现走深路径导入的懒加载构造器。
const PI_PROVIDER_ID = "shotshot-local";
const PI_MANAGED_PROVIDER_ID = "shotshot-cloud";

export type ManagedProviderAccess = {
    baseUrl: string;
    resolveApiKey(model: string): Promise<string>;
    // 主进程目录描述符：input_modalities 只来自可执行目录，渲染进程不可自授。
    resolveTextModelDescriptor(model: string): Promise<{
        inputModalities: Array<'text' | 'image'>;
    }>;
};

export type ResolvedManagedProviderAccess = Omit<
    ManagedProviderAccess,
    'resolveTextModelDescriptor'
> & {
    inputModalities: Array<'text' | 'image'>;
};

function buildApiKeyAuth(apiKey: string): ApiKeyAuth {
    return {
        name: "Canvas model API key",
        resolve: async () => (apiKey ? { auth: { apiKey } } : undefined),
    };
}

// OpenAI SDK 用 baseURL 原样拼 /chat/completions，不会自动补 /v1。
// 配置里通常存裸 host（如 https://api.openai.com），这里为常规 OpenAI
// 格式补上 /v1；DeepSeek、OpenRouter 与 Gemini 基址保持原样。
function normalizeOpenAIBaseUrl(baseUrl: string, provider?: import("@/stores/use-config-store").ChannelProvider): string {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    if (provider === "deepseek" || provider === "openrouter") return trimmed;
    return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export function buildModelsFromConfig(config: ByokTextModelConfig | ShotshotTextModelConfig, accessOrProviderId?: ResolvedManagedProviderAccess | string): { models: Models; model: Model<any> } {
    const managedAccess = typeof accessOrProviderId === "object" ? accessOrProviderId : undefined;
    const providerId = typeof accessOrProviderId === "string" ? accessOrProviderId : PI_PROVIDER_ID;
    if (config.credentialMode === "shotshot") {
        if (!managedAccess) throw new Error("managed_provider_unavailable");
        const useResponses = config.agentApiMode !== "chat_completions";
        const baseUrl = normalizeOpenAIBaseUrl(managedAccess.baseUrl);
        const model: Model<any> = {
            id: config.model,
            name: config.model,
            api: useResponses ? "openai-responses" : "openai-completions",
            provider: PI_MANAGED_PROVIDER_ID,
            baseUrl,
            reasoning: false,
            input: managedAccess.inputModalities.includes('image')
                ? ['text', 'image']
                : ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 512_000,
            maxTokens: 30_000,
        };
        const provider = createProvider({
            id: PI_MANAGED_PROVIDER_ID,
            name: "Shotshot Cloud",
            baseUrl,
            auth: {
                apiKey: {
                    name: "Shotshot managed gateway credential",
                    resolve: async () => ({ auth: { apiKey: await managedAccess.resolveApiKey(config.model) } }),
                },
            } satisfies ProviderAuth,
            models: [model],
            api: useResponses ? openAIResponsesApi() : openAICompletionsApi(),
        });
        const models = createModels();
        models.setProvider(provider);
        return { models, model };
    }
    const isGemini = config.apiFormat === "gemini";
    const useResponses = !isGemini && config.provider !== "openrouter" && config.agentApiMode !== "chat_completions";
    const api = isGemini ? "google-generative-ai" : useResponses ? "openai-responses" : "openai-completions";
    const baseUrl = isGemini ? config.baseUrl : normalizeOpenAIBaseUrl(config.baseUrl, config.provider);

    const model: Model<any> = {
        id: config.model,
        name: config.model,
        api,
        provider: providerId,
        baseUrl,
        // 推理参数只在 responses 模式下启用：pi 会话默认 thinkingLevel=medium，
        // 打开后请求携带 reasoning:{effort}，端点以 reasoning 输出项返回思考
        //（如 MiniMax /v1/responses）；completions 模式由端点自行返回推理字段。
        reasoning: useResponses && config.supportsReasoning === true,
        input: config.supportsImageInput ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 512_000,
        maxTokens: 30_000,
    };

    const provider = createProvider({
        id: providerId,
        name: "Shotshot local model",
        baseUrl,
        auth: { apiKey: buildApiKeyAuth(config.apiKey) } satisfies ProviderAuth,
        models: [model],
        api: isGemini ? googleGenerativeAIApi() : useResponses ? openAIResponsesApi() : openAICompletionsApi(),
    });

    const models = createModels();
    models.setProvider(provider);

    return { models, model };
}
