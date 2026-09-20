import type { MainFetchRequest, MainFetchResponse } from "@/lib/agent/pi-agent-types";

const HOP_BY_HOP_HEADERS = new Set([
    "connection", "content-length", "host", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);

function safeHttpUrl(rawUrl: string): string {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error("invalid_fetch_url");
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
        throw new Error("invalid_fetch_url");
    }
    return url.toString();
}

function safeHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!headers) return undefined;
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) result[name] = value;
    }
    return result;
}

/**
 * 渲染进程 → 主进程的 fetch 代理。主进程用 Node 原生 fetch 直接请求自定义 baseUrl，
 * 规避浏览器 CORS，也让 apiKey 只在主进程侧使用。刻意不 import electron，便于单测。
 */
export async function proxyFetch(req: MainFetchRequest, signal?: AbortSignal): Promise<MainFetchResponse> {
    const { id, url, method = "GET", headers, body, timeoutMs } = req;
    const safeUrl = safeHttpUrl(url);
    const binary = req.responseType === "bytes";
    if (binary && (new URL(safeUrl).origin !== "https://codewithgpu-image-1310972338.cos.ap-beijing.myqcloud.com" || method !== "GET" || body !== undefined || Object.keys(headers || {}).length)) {
        throw new Error("invalid_binary_fetch_request");
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
        controller.signal.throwIfAborted();
        const response = await fetch(safeUrl, {
            method,
            headers: safeHeaders(headers),
            body: method === "GET" || method === "HEAD" ? undefined : body,
            signal: controller.signal,
            ...(binary ? { credentials: "omit" as const, redirect: "error" as const } : {}),
        });
        const bytes = binary ? new Uint8Array(await response.arrayBuffer()) : undefined;
        const text = binary ? "" : await response.text();
        controller.signal.throwIfAborted();
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
            responseHeaders[key] = value;
        });
        return { id, status: response.status, statusText: response.statusText, headers: responseHeaders, body: text, ...(bytes ? { bytes } : {}) };
    } finally {
        signal?.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
    }
}


/** Request ownership prevents one renderer from cancelling another renderer's fetch. */
export function createFetchRequestRegistry() {
    const owners = new Map<number, Map<string, AbortController>>();
    return {
        async fetch(ownerId: number, req: MainFetchRequest) {
            if (!req || typeof req.id !== "string" || !req.id) throw new Error("invalid_fetch_request");
            const requests = owners.get(ownerId) || new Map<string, AbortController>();
            if (requests.has(req.id)) throw new Error("duplicate_fetch_request");
            const controller = new AbortController();
            requests.set(req.id, controller);
            owners.set(ownerId, requests);
            try { return await proxyFetch(req, controller.signal); }
            finally {
                requests.delete(req.id);
                if (!requests.size && owners.get(ownerId) === requests) owners.delete(ownerId);
            }
        },
        abort(ownerId: number, id: string) { owners.get(ownerId)?.get(id)?.abort(); },
        abortOwner(ownerId: number) {
            for (const controller of owners.get(ownerId)?.values() || []) controller.abort();
            owners.delete(ownerId);
        },
        dispose() {
            for (const requests of owners.values()) for (const controller of requests.values()) controller.abort();
            owners.clear();
        },
    };
}
