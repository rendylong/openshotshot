import { createHash } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ByokTextModelConfig, ResolvedTextModelConfig } from "@/lib/agent/pi-agent-types";
import { buildModelsFromConfig } from "@/lib/agent/pi-provider-map";
const CHANNEL_PROVIDERS = new Set(["custom", "minimax-cn", "minimax-global", "deepseek", "moonshot", "zhipu", "hiapi", "openrouter"]);
function isPlainObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function parseAgentModelConfig(raw: unknown): ResolvedTextModelConfig {
    if (!isPlainObject(raw)) throw new Error("invalid_agent_model_config");
    if (raw.credentialMode === "shotshot") {
        if (Object.keys(raw).some(key => !["credentialMode", "model", "apiFormat", "agentApiMode"].includes(key)) || typeof raw.model !== "string" || !raw.model.trim() || raw.apiFormat !== "openai" || raw.agentApiMode !== "chat_completions") throw new Error("invalid_agent_model_config");
        return { credentialMode: "shotshot", model: raw.model, apiFormat: "openai", agentApiMode: "chat_completions" };
    }
    if (raw.credentialMode !== undefined && raw.credentialMode !== "byok") throw new Error("invalid_agent_model_config");
    if (raw.source === "chatgpt" || raw.source === "platform") {
        if (Object.keys(raw).some(key => key !== "source" && key !== "model") || typeof raw.model !== "string" || !raw.model.trim()) throw new Error("invalid_agent_model_config");
        return { source: raw.source, model: raw.model };
    }
    if (raw.source !== undefined && raw.source !== "byok") throw new Error("invalid_agent_model_config");
    const byok = parseByokModelConfig(raw);
    if (!byok) throw new Error("invalid_agent_model_config");
    return byok;
}
export async function resolveAgentModel(config: ResolvedTextModelConfig, runtime: ModelRuntime): Promise<Model<any>> {
    if (config.source === "platform") throw new Error("platform_agent_unavailable");
    if (config.source === "chatgpt") {
        const model = runtime.getModel("openai-codex", config.model);
        if (!model || !model.input.includes("text")) throw new Error("chatgpt_model_unavailable");
        if (!(await runtime.getAuth(model))) throw new Error("chatgpt_auth_required");
        return model;
    }
    // Keep active turns bound to their original BYOK destination and auth even
    // when another session selects a different custom API configuration.
    const byok = config as ByokTextModelConfig;
    const fingerprint = createHash("sha256").update(JSON.stringify([byok.model, byok.baseUrl, byok.apiKey, byok.apiFormat, byok.agentApiMode, byok.supportsImageInput, byok.provider])).digest("hex");
    const { models, model } = buildModelsFromConfig(byok, `shotshot-local-${fingerprint}`);
    const registered = runtime.getModel(model.provider, model.id);
    if (registered) return registered;
    const provider = models.getProvider(model.provider);
    if (!provider) throw new Error("invalid_agent_provider");
    runtime.registerNativeProvider(provider);
    return model;
}
export function parseByokModelConfig(raw: unknown): ByokTextModelConfig | null {
    if (!isPlainObject(raw)) return null;
    const { model, baseUrl, apiKey } = raw;
    if (typeof model !== "string" || model.length === 0 || typeof baseUrl !== "string" || baseUrl.length === 0 || typeof apiKey !== "string") return null;
    if (raw.apiFormat !== "openai" && raw.apiFormat !== "gemini") return null;
    if (raw.agentApiMode !== "responses" && raw.agentApiMode !== "chat_completions") return null;
    if (typeof raw.supportsImageInput !== "boolean") return null;
    if (raw.provider !== undefined && (typeof raw.provider !== "string" || !CHANNEL_PROVIDERS.has(raw.provider))) return null;
    return {
        model,
        baseUrl,
        apiKey,
        apiFormat: raw.apiFormat,
        agentApiMode: raw.agentApiMode,
        supportsImageInput: raw.supportsImageInput,
        ...(raw.provider !== undefined ? { provider: raw.provider as ByokTextModelConfig["provider"] } : {}),
    };
}
