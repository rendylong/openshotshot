import type { ProviderId } from "@/lib/models/model-resolver";

export function providerModelsUrl(provider: ProviderId, baseUrl: string) {
    const base = baseUrl.replace(/\/+$/, "");
    if (provider === "deepseek") return `${base.replace(/\/v1$/i, "")}/models`;
    if (provider === "zhipu" || provider === "moonshot" || provider === "openrouter") return `${base}/models`;
    return buildVersionedUrl(base, "/models");
}

export function providerChatUrl(provider: ProviderId, baseUrl: string) {
    const base = baseUrl.replace(/\/+$/, "");
    if (provider === "deepseek") return `${base.replace(/\/v1$/i, "")}/chat/completions`;
    if (provider === "zhipu" || provider === "moonshot" || provider === "openrouter") return `${base}/chat/completions`;
    return buildVersionedUrl(base, "/chat/completions");
}

function buildVersionedUrl(baseUrl: string, path: string) {
    return `${/\/v1$/i.test(baseUrl) ? baseUrl : `${baseUrl}/v1`}${path}`;
}
