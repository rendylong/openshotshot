import { afterEach, describe, expect, it, vi } from "vitest";
import { createFalChannelClient, createFalFetch } from "./fal-client";

afterEach(() => { delete window.shotshot; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("controlled fal transport", () => {
    it("isolates simultaneous channel credentials and maps SDK paths and queries", async () => {
        const fetcher = vi.fn<typeof fetch>(async () => Response.json({ request_id: "r1", status: "IN_QUEUE" }));
        vi.stubGlobal("fetch", fetcher);
        await Promise.all([
            createFalChannelClient({ baseUrl: "https://a.example/queue/", apiKey: "key-a" }).queue.submit("fal-ai/flux-2-pro", { input: { prompt: "cup" } }),
            createFalChannelClient({ baseUrl: "https://b.example", apiKey: "key-b" }).queue.status("fal-ai/kling-video/v3/pro/image-to-video", { requestId: "r1", logs: false }),
        ]);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(fetcher.mock.calls.map(([url, init]) => [String(url), new Headers(init?.headers).get("authorization")]).sort()).toEqual([
            ["https://a.example/queue/fal-ai/flux-2-pro", "Key key-a"],
            ["https://b.example/fal-ai/kling-video/requests/r1/status?logs=0", "Key key-b"],
        ]);
    });

    it.each(["https://fal.run/fal-ai/flux-2-pro", "https://rest.alpha.fal.ai/storage/upload/initiate", "https://queue.fal.run.evil.test/x", "https://user:pass@queue.fal.run/x"])("rejects non-queue SDK target %s", async url => {
        const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
        await expect(createFalFetch("https://proxy.example")(url)).rejects.toThrow("fal_transport_target");
        expect(fetcher).not.toHaveBeenCalled();
    });

    it("rebuilds Electron JSON responses with status, text, headers and unique request IDs", async () => {
        const nativeFetch = vi.fn(); vi.stubGlobal("fetch", nativeFetch);
        const bridgeFetch = vi.fn(async ({ id }) => ({ id, status: 422, statusText: "Unprocessable Entity", headers: { "content-type": "application/json", "x-fal-request-id": "r1" }, body: '{"detail":"failed"}' }));
        window.shotshot = { agent: { fetch: bridgeFetch, abortFetch: vi.fn() } } as never;
        const fetcher = createFalFetch("https://proxy.example/queue");
        const responses = await Promise.all([1, 2].map(() => fetcher("https://queue.fal.run/fal-ai/flux-2-pro", { method: "POST", headers: { Authorization: "Key fixture" }, body: '{"prompt":"cup"}' })));
        expect(responses[0].status).toBe(422);
        expect(responses[0].statusText).toBe("Unprocessable Entity");
        expect(responses[0].headers.get("x-fal-request-id")).toBe("r1");
        expect(await responses[0].json()).toEqual({ detail: "failed" });
        expect(bridgeFetch.mock.calls[0][0]).toMatchObject({ url: "https://proxy.example/queue/fal-ai/flux-2-pro", method: "POST", body: '{"prompt":"cup"}' });
        expect(new Set(bridgeFetch.mock.calls.map(([request]) => request.id)).size).toBe(2);
        expect(nativeFetch).not.toHaveBeenCalled();
    });

    it("rejects already aborted signals without issuing a bridge request", async () => {
        const bridgeFetch = vi.fn(); window.shotshot = { agent: { fetch: bridgeFetch } } as never;
        const controller = new AbortController(); controller.abort();
        await expect(createFalFetch("https://queue.fal.run")("https://queue.fal.run/x", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(bridgeFetch).not.toHaveBeenCalled();
    });

    it("aborts an in-flight bridge once and cleans its listener without waiting for IPC", async () => {
        const bridgeFetch = vi.fn((_request: { id: string }) => new Promise<never>(() => {}));
        const abortFetch = vi.fn(async () => {});
        window.shotshot = { agent: { fetch: bridgeFetch, abortFetch } } as never;
        const controller = new AbortController(); const remove = vi.spyOn(controller.signal, "removeEventListener");
        const pending = createFalFetch("https://queue.fal.run")("https://queue.fal.run/x", { signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(abortFetch).toHaveBeenCalledWith(bridgeFetch.mock.calls[0][0].id);
        expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    });

    it("cleans listeners on success and sanitizes bridge failures as runner network errors", async () => {
        const bridgeFetch = vi.fn().mockResolvedValueOnce({ id: "x", status: 200, statusText: "OK", headers: {}, body: "ok" }).mockResolvedValueOnce({ id: "x", error: "Failed to fetch Key fixture-secret" });
        window.shotshot = { agent: { fetch: bridgeFetch } } as never;
        const controller = new AbortController(); const remove = vi.spyOn(controller.signal, "removeEventListener");
        const fetcher = createFalFetch("https://queue.fal.run");
        await fetcher("https://queue.fal.run/x", { signal: controller.signal });
        expect(remove).toHaveBeenCalledOnce();
        await expect(fetcher("https://queue.fal.run/x")).rejects.toMatchObject({ message: "fal_network_error", code: "ERR_NETWORK" });
    });
});
