import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

/** Native Codex models/auth with Electron HTTP streaming, so inference honors
 * the same OS proxy as authorization. The SDK's default WebSocket/Node path
 * does not consume an injected HTTP fetch implementation. */
export function createDesktopChatGptProvider(desktopFetch: typeof globalThis.fetch): ReturnType<typeof openaiCodexProvider> {
    const provider = openaiCodexProvider();
    return {
        ...provider,
        stream: (...[model, context, options]: Parameters<typeof provider.stream>) =>
            provider.stream(model, context, { ...options, transport: "sse", fetch: desktopFetch }),
        streamSimple: (...[model, context, options]: Parameters<typeof provider.streamSimple>) =>
            provider.streamSimple(model, context, { ...options, transport: "sse", fetch: desktopFetch }),
    } satisfies typeof provider;
}
