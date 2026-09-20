import { afterEach, describe, expect, it, vi } from "vitest";

import { createFetchRequestRegistry, proxyFetch } from "./fetch-proxy";

function jsonResponse(status: number, body: string, headers: Record<string, string> = {}) {
    return {
        status,
        statusText: "OK",
        headers: new Headers(headers),
        text: async () => body,
    };
}

describe("proxyFetch", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("转发请求并返回状态/头/body", async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, '{"ok":true}', { "content-type": "application/json" }));
        vi.stubGlobal("fetch", fetchMock);

        const res = await proxyFetch({ id: "1", url: "https://example.com/api", method: "POST", headers: { "x-foo": "bar" }, body: "hello" });

        expect(res.id).toBe("1");
        expect(res.status).toBe(200);
        expect(res.body).toBe('{"ok":true}');
        expect(res.headers["content-type"]).toBe("application/json");

        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("https://example.com/api");
        expect(init.method).toBe("POST");
        expect(init.headers).toEqual({ "x-foo": "bar" });
        expect(init.body).toBe("hello");
    });

    it("GET 请求不带 body", async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(204, ""));
        vi.stubGlobal("fetch", fetchMock);

        await proxyFetch({ id: "2", url: "https://example.com" });

        const [, init] = fetchMock.mock.calls[0];
        expect(init.body).toBeUndefined();
    });

    it("把 AbortSignal 传给 fetch 以支持超时", async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, ""));
        vi.stubGlobal("fetch", fetchMock);

        await proxyFetch({ id: "3", url: "https://example.com", timeoutMs: 5000 });

        const [, init] = fetchMock.mock.calls[0];
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("rejects non-HTTP protocols and embedded credentials", async () => {
        await expect(proxyFetch({ id: "4", url: "file:///etc/passwd" })).rejects.toThrow("invalid_fetch_url");
        await expect(proxyFetch({ id: "5", url: "https://user:secret@example.com" })).rejects.toThrow("invalid_fetch_url");
    });

    it("strips hop-by-hop headers while preserving provider authorization", async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, ""));
        vi.stubGlobal("fetch", fetchMock);

        await proxyFetch({
            id: "6",
            url: "http://localhost:8080/v1/models",
            headers: { Authorization: "Bearer byok", Connection: "keep-alive", Host: "evil.example", "x-client": "shotshot" },
        });

        expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer byok", "x-client": "shotshot" });
    });
});


describe("binary remote-media fetch", () => {
    const url = "https://codewithgpu-image-1310972338.cos.ap-beijing.myqcloud.com/video.mp4";
    afterEach(() => vi.unstubAllGlobals());

    it("preserves arbitrary binary bytes without text decoding and sends no credentials", async () => {
        const bytes = new Uint8Array([0, 128, 255, 13, 10, 1]);
        const fetchMock = vi.fn().mockResolvedValue(new Response(bytes, { headers: { "content-type": "video/mp4" } }));
        vi.stubGlobal("fetch", fetchMock);
        const result = await proxyFetch({ id: "binary", url, responseType: "bytes" });
        expect(result.bytes).toEqual(bytes);
        expect(result.body).toBe("");
        expect(result.headers["content-type"]).toBe("video/mp4");
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
        expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();
    });

    it.each([
        { url: "https://example.com/video.mp4" },
        { url: "http://codewithgpu-image-1310972338.cos.ap-beijing.myqcloud.com/video.mp4" },
        { url: "https://codewithgpu-image-1310972338.cos.ap-beijing.myqcloud.com.attacker.test/video.mp4" },
        { url: "https://user:secret@codewithgpu-image-1310972338.cos.ap-beijing.myqcloud.com/video.mp4" },
        { url, headers: { authorization: "secret" } },
        { url, method: "POST" as const },
    ])("rejects out-of-scope binary request %j", async request => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        await expect(proxyFetch({ id: "invalid", responseType: "bytes", ...request })).rejects.toThrow();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("forwards caller cancellation to native fetch and rejects pre-aborted requests", async () => {
        const controller = new AbortController();
        const fetchMock = vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })));
        vi.stubGlobal("fetch", fetchMock);
        const pending = proxyFetch({ id: "cancel", url, responseType: "bytes" }, controller.signal);
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
        await expect(proxyFetch({ id: "already-cancelled", url, responseType: "bytes" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("isolates cancellation by renderer owner and cleans up completed request IDs", async () => {
        const fetchMock = vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })));
        vi.stubGlobal("fetch", fetchMock);
        const registry = createFetchRequestRegistry();
        const first = registry.fetch(1, { id: "shared", url, responseType: "bytes" });
        const second = registry.fetch(2, { id: "shared", url, responseType: "bytes" });
        await expect(registry.fetch(1, { id: "shared", url })).rejects.toThrow("duplicate_fetch_request");
        registry.abort(1, "shared");
        await expect(first).rejects.toMatchObject({ name: "AbortError" });
        expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(false);
        registry.abortOwner(2);
        await expect(second).rejects.toMatchObject({ name: "AbortError" });
        fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1])) as never);
        await expect(registry.fetch(1, { id: "shared", url, responseType: "bytes" })).resolves.toMatchObject({ bytes: new Uint8Array([1]) });
        registry.dispose();
    });
});
