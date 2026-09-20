import { afterEach, expect, test, vi } from "vitest";
import { installChatGptAuthFetch } from "./chatgpt-network";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
test("OAuth uses desktop transport with the original form and cancellation signal", async () => {
    globalThis.fetch = vi.fn(async () => new Response("direct network rejected", { status: 403 }));
    const desktop = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.url).toBe("https://auth.openai.com/oauth/token");
        expect(await request.text()).toBe("grant_type=authorization_code&code=sentinel");
        expect(request.signal.aborted).toBe(true);
        return new Response("desktop transport", { status: 200 });
    });
    const restore = installChatGptAuthFetch(desktop);
    const abort = new AbortController(); abort.abort();
    const response = await fetch(new URL("https://auth.openai.com/oauth/token"), { method: "POST", body: "grant_type=authorization_code&code=sentinel", signal: abort.signal });
    expect(await response.text()).toBe("desktop transport");
    restore();
    expect((await fetch("https://auth.openai.com/oauth/token")).status).toBe(403);
});
test("unrelated and lookalike endpoints keep their original transport", async () => {
    globalThis.fetch = vi.fn(async () => new Response("original"));
    installChatGptAuthFetch(async () => new Response("desktop"));
    for (const url of ["https://example.test/v1", "http://127.0.0.1:1234", "https://auth.openai.com.evil.test/oauth/token", "http://auth.openai.com/oauth/token"]) {
        expect(await (await fetch(new Request(url))).text()).toBe("original");
    }
});
test("desktop network errors expose a stable code without request secrets", async () => {
    installChatGptAuthFetch(async () => { throw new Error("net::ERR_PROXY_CONNECTION_FAILED sentinel-token"); });
    await expect(fetch("https://auth.openai.com/oauth/token")).rejects.toThrow("chatgpt_network_failed");
});
