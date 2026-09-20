import { createFalClient } from "@fal-ai/client";
import { describe, expect, it, vi } from "vitest";

function clientWith(fetcher: typeof fetch) {
    return createFalClient({ credentials: "fixture-key", fetch: fetcher, suppressLocalCredentialsWarning: true });
}

const endpoint = "fal-ai/kling-video/v3/pro/image-to-video";

describe("fal SDK admission contract", () => {
    it.each(["submit", "status", "result"] as const)("does not resend %s after HTTP 503", async (operation) => {
        const fetcher = vi.fn<typeof fetch>(async () => new Response("unavailable", { status: 503 }));
        const client = clientWith(fetcher);
        const request = operation === "submit"
            ? client.queue.submit("fal-ai/flux-2-pro", { input: { prompt: "a cup" } })
            : client.queue[operation](endpoint, { requestId: "r1" });
        await expect(request).rejects.toThrow();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("does not resend a paid submit after an uncertain network failure", async () => {
        const failure = new TypeError("Failed to fetch");
        const fetcher = vi.fn<typeof fetch>(async () => { throw failure; });
        await expect(clientWith(fetcher).queue.submit("fal-ai/flux-2-pro", { input: { prompt: "a cup" } })).rejects.toBe(failure);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it.each(["status", "result"] as const)("uses the queue root for %s without the model subpath", async (operation) => {
        const fetcher = vi.fn<typeof fetch>(async () => Response.json({ status: "IN_PROGRESS", request_id: "r1" }));
        await clientWith(fetcher).queue[operation](endpoint, { requestId: "r1" });
        expect(fetcher).toHaveBeenCalledTimes(1);
        const url = new URL(String(fetcher.mock.calls[0][0]));
        expect(url.origin).toBe("https://queue.fal.run");
        expect(url.pathname).toBe(`/fal-ai/kling-video/requests/r1${operation === "status" ? "/status" : ""}`);
    });

    it.each(["submit", "status", "result"] as const)("passes abortSignal to %s transport", async (operation) => {
        const controller = new AbortController();
        const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
            expect(init?.signal).toBe(controller.signal);
            controller.abort();
            init?.signal?.throwIfAborted();
            throw new Error("expected abort");
        });
        const client = clientWith(fetcher);
        const request = operation === "submit"
            ? client.queue.submit(endpoint, { input: { prompt: "a cup" }, abortSignal: controller.signal })
            : client.queue[operation](endpoint, { requestId: "r1", abortSignal: controller.signal });
        await expect(request).rejects.toMatchObject({ name: "AbortError" });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});
