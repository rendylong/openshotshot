import type { AiConfig, ModelCapability } from "@/stores/use-config-store";

type ModelResponseType = "json" | "text" | "blob";

export type ModelTransportRequest<T> = {
    config: AiConfig;
    capability?: ModelCapability;
    timeoutClass: "text" | "image" | "video" | "audio";
    path: string;
    method?: string;
    headers?: Record<string, string>;
    body?: Record<string, unknown> | FormData | string | Uint8Array;
    responseType: ModelResponseType;
    signal?: AbortSignal;
    byok: () => Promise<{ data: T }>;
};

export async function requestModel<T>(request: ModelTransportRequest<T>): Promise<T> {
    return (await request.byok()).data;
}
