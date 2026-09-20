export type ProviderId = "custom" | "fal" | "openrouter" | "openai" | "gemini" | "minimax-cn" | "minimax-global" | "deepseek" | "moonshot" | "zhipu" | "hiapi" | "autodl";
export type ModelModality = "text" | "image" | "video" | "speech" | "music" | "unknown";
export type ModelExecution = "stream" | "direct" | "remote_task" | "unsupported";
export type ModelMatchConfidence = "exact" | "family" | "compatible" | "unknown";

export type ResolveModelInput = {
    provider?: ProviderId;
    baseUrl: string;
    apiFormat: "openai" | "gemini";
    model: string;
    /** Capability the user explicitly stored for this model (overrides automatic detection when no static rule matches). */
    userCapability?: "image" | "video" | "text" | "audio";
};

export type ResolvedModel = {
    provider: ProviderId;
    model: string;
    modality: ModelModality;
    execution: ModelExecution;
    adapterId: string | null;
    adapterVersion: 1;
    confidence: ModelMatchConfidence;
    source: "builtin" | "provider_models" | "catalog" | "heuristic";
};

export type ModelRule = {
    provider: ProviderId;
    models?: readonly string[];
    pattern?: RegExp;
    result: Pick<ResolvedModel, "modality" | "execution" | "adapterId">;
};
