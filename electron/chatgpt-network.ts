/** Pi's OAuth flow uses global fetch without a transport option. Route only its
 * OpenAI authorization origin through Electron, which honors OS proxy settings.
 * All custom model/media endpoints retain their existing Node transport. */
export function installChatGptAuthFetch(desktopFetch: typeof globalThis.fetch): () => void {
    const originalFetch = globalThis.fetch;
    const routedFetch: typeof globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== "https://auth.openai.com" || url.username || url.password) return originalFetch(input, init);
        try { return await desktopFetch(input, init); }
        catch { throw new Error("chatgpt_network_failed"); }
    };
    globalThis.fetch = routedFetch;
    return () => { if (globalThis.fetch === routedFetch) globalThis.fetch = originalFetch; };
}
