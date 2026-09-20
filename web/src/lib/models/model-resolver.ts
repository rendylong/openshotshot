import type { ProviderId, ResolveModelInput, ResolvedModel } from "./model-adapter-types";
import { MODEL_RULES, providerFromOfficialBaseUrl } from "./model-registry";

export type { ProviderId, ModelExecution, ModelMatchConfidence, ModelModality, ResolveModelInput, ResolvedModel } from "./model-adapter-types";

export function resolveProvider(provider: ProviderId | undefined, baseUrl: string, apiFormat: ResolveModelInput["apiFormat"]): ProviderId {
    if (!provider || provider === "custom") return providerFromOfficialBaseUrl(baseUrl) ?? (apiFormat === "gemini" ? "gemini" : "custom");
    return provider;
}

export function isAutodlChannel(channel: { provider?: ProviderId; baseUrl: string; apiFormat?: ResolveModelInput["apiFormat"] }): boolean {
    return resolveProvider(channel.provider, channel.baseUrl, channel.apiFormat ?? "openai") === "autodl";
}

export function resolveModel(input: ResolveModelInput): ResolvedModel {
    const provider = resolveProvider(input.provider, input.baseUrl, input.apiFormat);
    const directMatch = findModelRule(provider, input.model);
    const compatibleOpenAIMatch = provider === "custom" && input.apiFormat === "openai" ? findModelRule("openai", input.model) : undefined;
    const matched = directMatch ?? compatibleOpenAIMatch;

    if (matched) {
        return {
            provider,
            model: input.model,
            ...matched.rule.result,
            adapterVersion: 1,
            confidence: matched.confidence,
            source: "builtin",
        };
    }

    if (provider === "fal" || provider === "autodl" || (provider === "openrouter" && !input.userCapability)) return unsupportedResult(provider, input.model);

    if (input.userCapability) {
        const heuristic = heuristicResolve(provider, input.userCapability, input.apiFormat);
        if (heuristic) {
            return {
                provider,
                model: input.model,
                ...heuristic,
                adapterVersion: 1,
                confidence: "unknown",
                source: "heuristic",
            };
        }
        // User explicitly asked for a capability the provider cannot deliver. Surface this instead of silently routing to a default adapter.
        return unsupportedResult(provider, input.model);
    }

    if (hasExplicitMediaFamilyToken(input.model)) return unsupportedResult(provider, input.model);
    if (provider !== "custom" || input.apiFormat === "gemini") return compatibleTextResult(provider, input.model, input.apiFormat);
    return unsupportedResult(provider, input.model);
}

type HeuristicResult = Pick<ResolvedModel, "modality" | "execution" | "adapterId">;

function heuristicResolve(provider: ProviderId, capability: "image" | "video" | "text" | "audio", apiFormat: ResolveModelInput["apiFormat"]): HeuristicResult | undefined {
    const isGemini = apiFormat === "gemini";
    switch (provider) {
        case "minimax-cn":
        case "minimax-global":
            if (capability === "image") return { modality: "image", execution: "direct", adapterId: "minimax.image" };
            if (capability === "video") return { modality: "video", execution: "remote_task", adapterId: "minimax.video" };
            if (capability === "audio") return { modality: "speech", execution: "direct", adapterId: "minimax.speech" };
            if (capability === "text") return { modality: "text", execution: "stream", adapterId: isGemini ? "gemini.text" : "openai-compatible.text" };
            return undefined;
        case "zhipu":
            if (capability === "image") return { modality: "image", execution: "remote_task", adapterId: "zhipu.image" };
            if (capability === "video") return { modality: "video", execution: "remote_task", adapterId: "zhipu.video" };
            return undefined;
        case "openai":
            if (capability === "image") return { modality: "image", execution: "direct", adapterId: "openai.image" };
            if (capability === "video") return { modality: "video", execution: "remote_task", adapterId: "openai.video" };
            if (capability === "audio") return { modality: "speech", execution: "direct", adapterId: "openai.speech" };
            return undefined;
        case "gemini":
            if (capability === "image") return { modality: "image", execution: "direct", adapterId: "gemini.image" };
            if (capability === "video") return { modality: "video", execution: "remote_task", adapterId: "gemini.video" };
            if (capability === "audio") return { modality: "speech", execution: "direct", adapterId: "gemini.speech" };
            if (capability === "text") return { modality: "text", execution: "stream", adapterId: "gemini.text" };
            return undefined;
        case "hiapi":
            if (capability === "image") return { modality: "image", execution: "remote_task", adapterId: "hiapi.image" };
            if (capability === "video") return { modality: "video", execution: "remote_task", adapterId: "hiapi.video" };
            if (capability === "audio") return { modality: "speech", execution: "remote_task", adapterId: "hiapi.speech" };
            if (capability === "text") return { modality: "text", execution: "stream", adapterId: "openai-compatible.text" };
            return undefined;
        case "deepseek":
        case "moonshot":
        case "custom":
            if (capability === "text") return { modality: "text", execution: "stream", adapterId: isGemini ? "gemini.text" : "openai-compatible.text" };
            return undefined;
        case "openrouter":
            if (capability === "text") return { modality: "text", execution: "stream", adapterId: "openai-compatible.text" };
            return undefined;
        default:
            return undefined;
    }
}

function findModelRule(provider: ProviderId, model: string) {
    const normalizedModel = (provider === "fal" || provider === "autodl") ? model : model.toLowerCase();
    const exact = MODEL_RULES.find((rule) => rule.provider === provider && rule.models?.includes(normalizedModel));
    if (exact) return { rule: exact, confidence: "exact" as const };
    const family = MODEL_RULES.find((rule) => rule.provider === provider && rule.pattern?.test(model));
    return family ? { rule: family, confidence: "family" as const } : undefined;
}

function hasExplicitMediaFamilyToken(model: string) {
    return /(?:^|[-_.])(?:image|video|audio|speech|tts|music|hailuo|cogvideo(?:x)?)(?:$|[-_.])/i.test(model);
}

function compatibleTextResult(provider: ProviderId, model: string, apiFormat: ResolveModelInput["apiFormat"]): ResolvedModel {
    return {
        provider,
        model,
        modality: "text",
        execution: "stream",
        adapterId: apiFormat === "gemini" ? "gemini.text" : "openai-compatible.text",
        adapterVersion: 1,
        confidence: "compatible",
        source: "builtin",
    };
}

function unsupportedResult(provider: ProviderId, model: string): ResolvedModel {
    return {
        provider,
        model,
        modality: "unknown",
        execution: "unsupported",
        adapterId: null,
        adapterVersion: 1,
        confidence: "unknown",
        source: "builtin",
    };
}
