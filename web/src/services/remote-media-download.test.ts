import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadRemoteMediaBlob } from "./remote-media-download";

const url = "https://codewithgpu-image-1310972338.cos.ap-beijing.myqcloud.com/video.mp4";
function installBridge(fetch: ReturnType<typeof vi.fn>, abortFetch = vi.fn().mockResolvedValue(undefined)) {
    window.shotshot = { agent: { fetch, abortFetch } } as never;
    return abortFetch;
}
function readBlob(blob: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(blob);
    });
}

afterEach(() => { delete window.shotshot; vi.unstubAllGlobals(); });

describe("remote-media download", () => {
    it("downloads the exact AutoDL result CDN as bytes through Electron without credentials", async () => {
        const bytes = new Uint8Array([0, 255, 128, 7]);
        const bridgeFetch = vi.fn().mockResolvedValue({ id: "result", status: 200, body: "", headers: { "content-type": "video/mp4" }, bytes });
        installBridge(bridgeFetch);
        const nativeFetch = vi.fn();
        vi.stubGlobal("fetch", nativeFetch);
        const blob = await downloadRemoteMediaBlob(url, new AbortController().signal);
        expect(new Uint8Array(await readBlob(blob))).toEqual(bytes);
        expect(blob.type).toBe("video/mp4");
        expect(bridgeFetch).toHaveBeenCalledWith({ id: expect.any(String), url, method: "GET", responseType: "bytes" });
        expect(nativeFetch).not.toHaveBeenCalled();
    });

    it.each(["https://example.test/video.mp4", "http://codewithgpu-image-1310972338.cos.ap-beijing.myqcloud.com/video.mp4", "https://codewithgpu-image-1310972338.cos.ap-beijing.myqcloud.com.attacker.test/video.mp4", "https://user:secret@codewithgpu-image-1310972338.cos.ap-beijing.myqcloud.com/video.mp4"])("preserves native fetch for nonmatching URL %s", async input => {
        const bridgeFetch = vi.fn();
        installBridge(bridgeFetch);
        const blob = new Blob(["video"]);
        const nativeFetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });
        vi.stubGlobal("fetch", nativeFetch);
        const controller = new AbortController();
        expect(await downloadRemoteMediaBlob(input, controller.signal)).toBe(blob);
        expect(nativeFetch).toHaveBeenCalledWith(input, { signal: controller.signal });
        expect(bridgeFetch).not.toHaveBeenCalled();
    });

    it("retains the browser-native fallback when Electron is unavailable", async () => {
        const blob = new Blob(["video"]);
        const nativeFetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });
        vi.stubGlobal("fetch", nativeFetch);
        expect(await downloadRemoteMediaBlob(url, new AbortController().signal)).toBe(blob);
    });

    it("rejects immediately on cancellation and forwards the same request ID", async () => {
        const bridgeFetch = vi.fn((_request: { id: string }) => new Promise(() => {}));
        const abortFetch = installBridge(bridgeFetch);
        const controller = new AbortController();
        const pending = downloadRemoteMediaBlob(url, controller.signal);
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(abortFetch).toHaveBeenCalledWith(bridgeFetch.mock.calls[0][0].id);
    });

    it("does not submit already-aborted downloads", async () => {
        const bridgeFetch = vi.fn();
        installBridge(bridgeFetch);
        const controller = new AbortController();
        controller.abort();
        await expect(downloadRemoteMediaBlob(url, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
        expect(bridgeFetch).not.toHaveBeenCalled();
    });

    it("reports only HTTP status and never response body or bridge error details", async () => {
        const bridgeFetch = vi.fn().mockResolvedValue({ id: "result", status: 403, body: "secret signed URL", headers: {}, bytes: new Uint8Array() });
        installBridge(bridgeFetch);
        await expect(downloadRemoteMediaBlob(url, new AbortController().signal)).rejects.toThrow("Failed to download remote media (403)");
        bridgeFetch.mockResolvedValueOnce({ id: "result", error: "secret signed URL" });
        await expect(downloadRemoteMediaBlob(url, new AbortController().signal)).rejects.toThrow(/^Failed to download remote media$/);
    });
});

it.each(["image/png", "video/mp4"])("downloads public fal %s without channel headers or privileged byte access", async mime => {
    const bridgeFetch = vi.fn(); installBridge(bridgeFetch);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": mime } }));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    const blob = await downloadRemoteMediaBlob("https://v3b.fal.media/files/result", signal);
    expect(blob.type).toBe(mime);
    expect(fetcher).toHaveBeenCalledWith("https://v3b.fal.media/files/result", { signal });
    expect(bridgeFetch).not.toHaveBeenCalled();
});

it("rejects a fal download aborted while its body is being read", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => { controller.abort(); return new Blob(["late"]); } }));
    await expect(downloadRemoteMediaBlob("https://fal.media/result.png", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});
