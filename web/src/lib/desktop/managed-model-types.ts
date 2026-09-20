import type { ManagedVideoSpec } from "./managed-video-spec";
export type ManagedModelDescriptor = {
    id: string;
    name: string;
    capability: "text" | "image" | "video" | "audio";
    execution: "direct" | "remote_task";
    input_modalities?: Array<"text" | "image">;
    video_specs?: ManagedVideoSpec[];
    spec?: {
        aspectRatios?: string[];
        resolutions?: string[];
        qualities?: string[];
    };
    input_slots?: Array<{
        field: string;
        kind: "image" | "audio" | "video";
        required: boolean;
        accept_types: string[];
    }>;
};

export type ManagedMultipartField =
    | { name: string; kind: "text"; value: string }
    | { name: string; kind: "bytes"; value: Uint8Array; filename: string; contentType: string };

export type ManagedRequestBody =
    | { kind: "json"; value: string }
    | { kind: "text"; value: string }
    | { kind: "bytes"; value: Uint8Array; contentType: string }
    | { kind: "multipart"; fields: ManagedMultipartField[] };

export type ManagedModelRequest = {
    id: string;
    path: string;
    method: "GET" | "POST" | "DELETE";
    headers?: Record<string, string>;
    body?: ManagedRequestBody;
    timeoutClass: "text" | "image" | "audio" | "video";
};

export type ManagedModelResponse = {
    id: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body:
        | { kind: "text"; value: string }
        | { kind: "bytes"; value: Uint8Array; contentType: string }
        | { kind: "temporary-file"; id: string; size: number; contentType: string };
};

export type ManagedModelsBridge = {
    listModels(): Promise<ManagedModelDescriptor[]>;
    fetch(request: ManagedModelRequest): Promise<ManagedModelResponse>;
    abort(requestId: string): Promise<void>;
};

type RendererIpc = {
    invoke(channel: string, value?: unknown): Promise<unknown>;
};

export const MANAGED_MODEL_CHANNELS = {
    listModels: "managed-models:list",
    fetch: "managed-models:fetch",
    abort: "managed-models:abort",
} as const;

const FORBIDDEN_RESPONSE_KEY = /(?:token|secret|credential|authorization|api.?key)/i;

// 渲染进程边界同样只接受两个规范数组；目录真值在云端，这里只做 fail-closed 校验。
function isCanonicalInputModalities(value: unknown): value is Array<"text" | "image"> {
    return Array.isArray(value) && (
        (value.length === 1 && value[0] === "text") ||
        (value.length === 2 && value[0] === "text" && value[1] === "image"));
}

function assertCanonicalInputModalities(models: unknown[]): void {
    for (const model of models) {
        if (!model || typeof model !== "object") throw new Error("invalid_managed_models_payload");
        const descriptor = model as ManagedModelDescriptor;
        if (descriptor.input_modalities !== undefined &&
            (descriptor.capability !== "text" || !isCanonicalInputModalities(descriptor.input_modalities))) {
            throw new Error("invalid_managed_models_payload");
        }
    }
}

function assertCredentialFree(value: unknown): void {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_RESPONSE_KEY.test(key)) throw new Error("credential_shaped_managed_payload");
        assertCredentialFree(child);
    }
}

export function createManagedModelsBridge(ipc: RendererIpc): ManagedModelsBridge {
    return {
        async listModels() {
            const result = await ipc.invoke(MANAGED_MODEL_CHANNELS.listModels);
            assertCredentialFree(result);
            if (!Array.isArray(result)) throw new Error("invalid_managed_models_payload");
            assertCanonicalInputModalities(result);
            return result as ManagedModelDescriptor[];
        },
        async fetch(request) {
            const result = await ipc.invoke(MANAGED_MODEL_CHANNELS.fetch, request);
            assertCredentialFree(result);
            if (!result || typeof result !== "object") throw new Error("invalid_managed_response_payload");
            return result as ManagedModelResponse;
        },
        abort: (requestId) => ipc.invoke(MANAGED_MODEL_CHANNELS.abort, requestId).then(() => undefined),
    };
}
