import { resolveProvider } from "@/lib/models/model-resolver";
import { providerChatUrl } from "@/services/api/provider-endpoints";
import { type AiConfig, type ChannelProvider } from "@/stores/use-config-store";

type ChatMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

type ChatCompletionPayload = {
    choices?: Array<{ message?: { content?: string | null } }>;
    error?: { message?: string };
    base_resp?: { status_code?: number; status_msg?: string };
};

export type ChatCompletionOptions = {
    /**
     * Merged into the request body when provided (e.g. `{"type":"json_object"}`).
     * Off by default: several OpenAI-compatible endpoints reject response_format,
     * so callers opt in — the structured-output retry path enables it explicitly.
     */
    responseFormat?: Record<string, unknown>;
    /** Confirmed catalog image support; OpenRouter defaults to text-only. */
    supportsImageInput?: boolean;
};

export async function requestChatCompletion(
    config: AiConfig,
    provider: ChannelProvider | undefined,
    messages: ChatMessage[],
    onDelta: (text: string) => void,
    signal?: AbortSignal,
    options?: ChatCompletionOptions,
) {
    const requestMessages = provider === "openrouter" && options?.supportsImageInput !== true
        ? messages.map(message => ({ ...message, content: Array.isArray(message.content) ? message.content.filter(item => item.type !== "image_url") : message.content }))
        : messages;
    const response = await fetch(chatCompletionsUrl(config.baseUrl, provider), {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ model: config.model, messages: requestMessages, stream: true, ...(options?.responseFormat ? { response_format: options.responseFormat } : {}) }),
        signal,
    });
    if (!response.ok) throw new Error(await readChatError(response));
    if (!response.body) {
        const payload = (await response.json()) as ChatCompletionPayload;
        validateChatPayload(payload);
        const text = payload.choices?.[0]?.message?.content || "";
        if (text) onDelta(text);
        return text;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const consume = (block: string) => {
        const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n")
            .trim();
        if (!data || data === "[DONE]") return;
        const payload = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string | null } }>; error?: { message?: string } };
        if (payload.error?.message) throw new Error(payload.error.message);
        const delta = payload.choices?.[0]?.delta?.content || "";
        if (!delta) return;
        text += delta;
        onDelta(text);
    };
    const flushBlocks = (flush = false) => {
        for (;;) {
            const match = buffer.match(/\r?\n\r?\n/);
            if (!match) break;
            const index = match.index || 0;
            consume(buffer.slice(0, index));
            buffer = buffer.slice(index + match[0].length);
        }
        if (flush && buffer.trim()) consume(buffer);
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        flushBlocks();
    }
    buffer += decoder.decode();
    flushBlocks(true);
    return text;
}

function chatCompletionsUrl(baseUrl: string, provider: ChannelProvider | undefined) {
    return providerChatUrl(resolveProvider(provider, baseUrl, "openai"), baseUrl.trim());
}

function validateChatPayload(payload: ChatCompletionPayload) {
    if (payload.error?.message) throw new Error(payload.error.message);
    if (payload.base_resp?.status_code && payload.base_resp.status_code !== 0) throw new Error(payload.base_resp.status_msg || `Chat completion failed (${payload.base_resp.status_code})`);
}

async function readChatError(response: Response) {
    const text = await response.text();
    try {
        const payload = JSON.parse(text) as ChatCompletionPayload;
        return payload.error?.message || payload.base_resp?.status_msg || text || `Chat completion failed (${response.status})`;
    } catch {
        return text || `Chat completion failed (${response.status})`;
    }
}
