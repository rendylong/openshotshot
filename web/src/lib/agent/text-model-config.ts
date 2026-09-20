import { canUseAsAgent } from "@/lib/models/channel-model-metadata";
import type { ResolvedTextModelConfig } from "@/lib/agent/pi-agent-types";
import { useAiSourceStore } from "@/stores/use-ai-source-store";
import { useChatGptStore } from "@/stores/use-chatgpt-store";
import { modelProviderOf, resolveModelChannel, resolveModelExecution, resolveModelForCapability, resolveModelRequestConfig, useConfigStore } from "@/stores/use-config-store";

export function resolvePiModelConfig(config: ReturnType<typeof useConfigStore.getState>["config"]): ResolvedTextModelConfig | null {
    const sources = useAiSourceStore.getState();
    if (sources.status !== "ready" || sources.applying || sources.error) return null;
    const selection = sources.preferences.selections.agent;
    if (selection) {
        const connection = useChatGptStore.getState();
        if (selection.source !== "chatgpt" || connection.status.state !== "signed-in" || !connection.models.some(model => model.id === selection.modelId)) return null;
        return { source: "chatgpt", model: selection.modelId };
    }
    const agentModel = resolveModelForCapability(config, config.agentModel, "text");
    if (!agentModel) return null;
    const channel = resolveModelChannel(config, agentModel);
    const model = resolveModelExecution(config, agentModel);
    if (channel.provider === "openrouter" && (!model || !canUseAsAgent(channel, model))) return null;
    const request = resolveModelRequestConfig(config, agentModel);
    if (!request.model.trim() || !request.baseUrl.trim() || !request.apiKey.trim()) return null;
    return {
        source: "byok",
        model: request.model,
        baseUrl: request.baseUrl,
        apiKey: request.apiKey,
        apiFormat: request.apiFormat,
        agentApiMode: config.agentApiMode,
        supportsImageInput: channel.provider === "openrouter" ? model?.catalog?.version === 1 && model.catalog.inputModalities?.includes("image") === true : Boolean(model?.supportsImageInput),
        supportsReasoning: Boolean(model?.supportsReasoning),
        provider: modelProviderOf(config, agentModel),
    };
}

export async function resolvePiModelConfigForBridge(): Promise<ResolvedTextModelConfig | null> {
    return resolvePiModelConfig(useConfigStore.getState().config);
}
