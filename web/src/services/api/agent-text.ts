import { resolvePiModelConfigForBridge } from "@/lib/agent/text-model-config";
import { requestImageQuestion, type AiTextMessage } from "@/services/api/image";
import { requestModel } from "@/services/api/model-transport";
import { useConfigStore } from "@/stores/use-config-store";

export class AgentTitleUnsupportedSourceError extends Error {
    constructor(public readonly source: string) {
        super(`agent_title_source_unsupported_${source}`);
    }
}

// 画布自动命名的一次性文本补全：与 Agent 同源解析（byok 渠道 / shotshot 托管网关）。
// ChatGPT/platform 源渲染层无执行器，抛错由调用方回退提问截断（spec §11 D14）。
export async function requestAgentTextCompletion(messages: AiTextMessage[], options?: { signal?: AbortSignal }): Promise<string> {
    const resolved = await resolvePiModelConfigForBridge();
    if (!resolved) throw new AgentTitleUnsupportedSourceError("unresolved");
    const config = useConfigStore.getState().config;
    if (resolved.credentialMode === "byok") {
        return requestImageQuestion({ ...config, model: resolved.model }, messages, () => undefined, { signal: options?.signal });
    }
    if (resolved.credentialMode === "shotshot") {
        const forced = { ...config, credentialMode: "shotshot" as const, credentialModes: { ...config.credentialModes, text: "shotshot" as const } };
        const payload = await requestModel<{ choices?: Array<{ message?: { content?: unknown } }> }>({
            config: forced,
            capability: "text",
            timeoutClass: "text",
            path: "/v1/chat/completions",
            method: "POST",
            body: { model: resolved.model, messages, stream: false },
            responseType: "json",
            signal: options?.signal,
            byok: async () => {
                throw new Error("unreachable");
            },
        });
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            const text = content.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : "")).join("");
            if (text.trim()) return text;
        }
        throw new Error("agent_text_empty_response");
    }
    throw new AgentTitleUnsupportedSourceError(resolved.source ?? resolved.credentialMode ?? "unresolved");
}
