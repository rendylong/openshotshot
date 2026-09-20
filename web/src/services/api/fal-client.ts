import { createFalClient, type FalClient } from "@fal-ai/client";
import type { ModelChannel } from "@/stores/use-config-store";

function networkError() {
    return Object.assign(new Error("fal_network_error"), { code: "ERR_NETWORK" });
}

/** Only SDK queue requests can be mapped to a user's queue base URL. */
export function createFalFetch(baseUrl: string): typeof fetch {
    let base: URL;
    try {
        base = new URL(baseUrl.trim());
        if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error();
    } catch { throw new Error("fal_transport_base_url"); }
    const prefix = base.href.replace(/\/+$/, "");
    return async (input, init) => {
        let source: URL;
        try {
            source = new URL(input instanceof Request ? input.url : String(input));
            if (source.origin !== "https://queue.fal.run" || source.username || source.password || source.hash) throw new Error();
        } catch { throw new Error("fal_transport_target"); }
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        signal?.throwIfAborted();
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        if (method !== "GET" && method !== "POST") throw new Error("fal_transport_method");
        // The queue protocol accepts JSON only. Never forward File/Blob or streams.
        const body = init?.body;
        if ((body !== undefined && body !== null && typeof body !== "string") || (input instanceof Request && input.body && body === undefined)) throw new Error("fal_transport_body");
        const url = `${prefix}${source.pathname}${source.search}`;
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        const bridge = typeof window === "undefined" ? undefined : window.shotshot?.agent;
        if (!bridge?.fetch) {
            try {
                const response = await fetch(url, { ...init, method, headers, body, signal });
                signal?.throwIfAborted();
                return response;
            } catch {
                signal?.throwIfAborted();
                throw networkError();
            }
        }
        const id = crypto.randomUUID();
        let rejectAborted: (reason: unknown) => void = () => {};
        const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
        const onAbort = () => {
            rejectAborted(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
            void bridge.abortFetch?.(id).catch(() => {});
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
            signal?.throwIfAborted();
            const response = await Promise.race([bridge.fetch({ id, url, method, headers: Object.fromEntries(headers), ...(typeof body === "string" ? { body } : {}) }), aborted]);
            signal?.throwIfAborted();
            if ("error" in response) throw networkError();
            return new Response([204, 205, 304].includes(response.status) ? null : response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
        } catch {
            signal?.throwIfAborted();
            throw networkError();
        } finally {
            signal?.removeEventListener("abort", onAbort);
        }
    };
}

/** Credentials belong to this request's channel, never to the SDK singleton. */
export function createFalChannelClient(channel: Pick<ModelChannel, "baseUrl" | "apiKey">): FalClient {
    return createFalClient({
        credentials: channel.apiKey,
        suppressLocalCredentialsWarning: true,
        fetch: createFalFetch(channel.baseUrl),
    });
}
