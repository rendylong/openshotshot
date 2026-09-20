import { resolvePiModelConfigForBridge } from "@/lib/agent/text-model-config";
import { requestImageQuestion, type AiTextMessage } from "@/services/api/image";
import { useConfigStore } from "@/stores/use-config-store";

export class AgentTitleUnsupportedSourceError extends Error {
    constructor(public readonly source: string) {
        super(`agent_title_source_unsupported_${source}`);
    }
}

// 画布自动命名的一次性文本补全，仅支持 BYOK 渠道；
// ChatGPT/未配置源渲染层无执行器，抛错由调用方回退提问截断。
export async function requestAgentTextCompletion(messages: AiTextMessage[], options?: { signal?: AbortSignal }): Promise<string> {
    const resolved = await resolvePiModelConfigForBridge();
    if (!resolved) throw new AgentTitleUnsupportedSourceError("unresolved");
    if (resolved.source !== "byok") throw new AgentTitleUnsupportedSourceError(resolved.source);
    const config = useConfigStore.getState().config;
    return requestImageQuestion({ ...config, model: resolved.model }, messages, () => undefined, { signal: options?.signal });
}
