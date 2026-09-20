import { canUseAsAgent } from "@/lib/models/channel-model-metadata";
import { ensureManagedCatalog, managedCatalogSnapshot } from "@/lib/desktop/managed-catalog-cache";
import type { ResolvedTextModelConfig } from "@/lib/agent/pi-agent-types";
import { useAiSourceStore } from "@/stores/use-ai-source-store";
import { useChatGptStore } from "@/stores/use-chatgpt-store";
import { credentialModeFor, modelProviderOf, resolveModelChannel, resolveModelExecution, resolveModelForCapability, resolveModelRequestConfig, useConfigStore } from "@/stores/use-config-store";

export function resolvePiModelConfig(config: ReturnType<typeof useConfigStore.getState>["config"]): ResolvedTextModelConfig | null {
    const sources = useAiSourceStore.getState();
    if (sources.status !== "ready" || sources.applying || sources.error) return null;
    const selection = sources.preferences.selections.agent;
    if (selection) {
        const connection = useChatGptStore.getState();
        if (selection.source !== "chatgpt" || connection.status.state !== "signed-in" || !connection.models.some(model => model.id === selection.modelId)) return null;
        return { source: "chatgpt", model: selection.modelId };
    }
    if (credentialModeFor(config, "agent") === "shotshot") {
        const textModels = managedCatalogSnapshot()?.models.filter((item) => item.capability === "text") ?? [];
        // 优先用用户在设置里选的套餐模型；该 id 已不在目录（下架/换目录）时回退第一个 text 模型。
        const model = textModels.find((item) => item.id === config.managedAgentModel)?.id || textModels[0]?.id;
        if (!model) return null;
        return { credentialMode: "shotshot", model, apiFormat: "openai", agentApiMode: "chat_completions" };
    }
    const agentModel = resolveModelForCapability(config, config.agentModel, "text");
    if (!agentModel) return null;
    const channel = resolveModelChannel(config, agentModel);
    const model = resolveModelExecution(config, agentModel);
    if (channel.provider === "openrouter" && (!model || !canUseAsAgent(channel, model))) return null;
    const request = resolveModelRequestConfig(config, agentModel);
    if (!request.model.trim() || !request.baseUrl.trim() || !request.apiKey.trim()) return null;
    return {
        credentialMode: "byok",
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

// shotshot 模式下解析依赖目录快照；仅冷启动（无快照）等待注水（60s TTL，失败保留旧快照），
// stale 但可用的快照立即供给发送、由 ensure（inFlight 去重）在后台刷新。
export async function resolvePiModelConfigForBridge(): Promise<ResolvedTextModelConfig | null> {
    const config = useConfigStore.getState().config;
    if (credentialModeFor(config, "agent") === "shotshot") {
        const snapshot = managedCatalogSnapshot();
        if (!snapshot) await ensureManagedCatalog().catch(() => undefined); // 仅冷启动等待
        else if (snapshot.status === "ready") void ensureManagedCatalog().catch(() => undefined); // ready 且 stale 时后台刷新,错误快照不重试(由重试按钮/下轮触发)
    }
    return resolvePiModelConfig(config);
}
