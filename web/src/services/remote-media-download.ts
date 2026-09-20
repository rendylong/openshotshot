import type { MainFetchResponse } from "@/lib/agent/pi-agent-types";

function isAutodlResultUrl(value: string) {
    try {
        const url = new URL(value);
        return url.origin === "https://codewithgpu-image-1310972338.cos.ap-beijing.myqcloud.com" && !url.username && !url.password;
    } catch { return false; }
}

/** AutoDL result storage omits CORS headers; desktop downloads use the existing fetch bridge. */
export async function downloadRemoteMediaBlob(url: string, signal: AbortSignal): Promise<Blob> {
    signal.throwIfAborted();
    const bridge = typeof window === "undefined" ? undefined : window.shotshot?.agent;
    if (!bridge?.fetch || !isAutodlResultUrl(url)) {
        const response = await fetch(url, { signal });
        signal.throwIfAborted();
        if (!response.ok) throw new Error(`Failed to download remote media (${response.status})`);
        const blob = await response.blob();
        signal.throwIfAborted();
        return blob;
    }

    const id = crypto.randomUUID();
    let rejectAborted: (reason: unknown) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
    const onAbort = () => {
        rejectAborted(signal.reason || new DOMException("The operation was aborted", "AbortError"));
        void bridge.abortFetch?.(id).catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let response: MainFetchResponse;
    try {
        signal.throwIfAborted();
        const result = await Promise.race([bridge.fetch({ id, url, method: "GET", responseType: "bytes" }), aborted]);
        signal.throwIfAborted();
        if ("error" in result || !result.bytes || !ArrayBuffer.isView(result.bytes)) throw new Error("remote_media_download_failed");
        response = result;
    } catch {
        signal.throwIfAborted();
        throw new Error("Failed to download remote media");
    } finally {
        signal.removeEventListener("abort", onAbort);
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Failed to download remote media (${response.status})`);
    return new Blob([Uint8Array.from(response.bytes!).buffer], { type: response.headers["content-type"] || "application/octet-stream" });
}
