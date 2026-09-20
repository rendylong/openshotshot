import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentFileDescriptor } from "./agent-files";

type ImageReference = { nodeId: string; imageId?: string };
type ImageToolContext = {
    fetch: typeof globalThis.fetch;
    getProvider: () => string | undefined;
    getAccessToken: () => Promise<string | undefined>;
    readImage: (reference: ImageReference, signal?: AbortSignal) => Promise<{ ok: true; image: { dataUrl: string } } | { ok: false; error: string }>;
    saveImage: (base64: string) => Promise<AgentFileDescriptor>;
    importImage: (file: AgentFileDescriptor, dataUrl: string) => void;
};

// Matches Codex's native ImagesClient JSON protocol. Subscription credentials
// must only reach this fixed first-party endpoint, never a configured API URL.
export function createChatGptImageTool(ctx: ImageToolContext) {
    const parameters = Type.Object({
        prompt: Type.String({ minLength: 1, description: "Complete image generation or editing instructions." }),
        references: Type.Optional(Type.Array(Type.Object({
            nodeId: Type.String({ minLength: 1, description: "Exact canvas image node ID." }),
            imageId: Type.Optional(Type.String({ minLength: 1, description: "Exact image ID within a multi-image node; omitted means the primary image." })),
        }))),
    });
    return {
        name: "generate_chatgpt_image",
        label: "GPT Image 2",
        description: "Generate or edit images with GPT Image 2 using the user's ChatGPT/Codex subscription. Saves original images locally and requests import into this canvas. For editing, provide exact canvas node/image IDs. Use this tool for subscription image generation instead of canvas_generate, which uses separately configured services.",
        promptSnippet: "Generate/edit images with GPT Image 2 using ChatGPT subscription; reference exact canvas image IDs. Results are saved locally and sent to this canvas.",
        parameters,
        async execute(_id: string, raw: unknown, signal?: AbortSignal) {
            const params = raw as { prompt: string; references?: ImageReference[] };
            signal?.throwIfAborted();
            if (ctx.getProvider() !== "openai-codex") throw new Error("chatgpt_auth_required");
            const images = [];
            for (const reference of params.references ?? []) {
                const result = await ctx.readImage(reference, signal);
                if (!result.ok) throw new Error(result.error);
                images.push({ image_url: result.image.dataUrl });
            }
            const accessToken = await ctx.getAccessToken();
            signal?.throwIfAborted();
            if (!accessToken || ctx.getProvider() !== "openai-codex") throw new Error("chatgpt_auth_required");
            let accountId: unknown;
            try {
                accountId = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"))["https://api.openai.com/auth"]?.chatgpt_account_id;
            } catch { throw new Error("chatgpt_auth_required"); }
            if (typeof accountId !== "string" || !accountId) throw new Error("chatgpt_auth_required");
            let response: Response;
            try {
                response = await ctx.fetch(`https://chatgpt.com/backend-api/codex/images/${images.length ? "edits" : "generations"}`, {
                    method: "POST", signal,
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, "chatgpt-account-id": accountId },
                    body: JSON.stringify({ model: "gpt-image-2", prompt: params.prompt, background: "auto", quality: "auto", size: "auto", ...(images.length ? { images } : {}) }),
                });
            } catch {
                signal?.throwIfAborted();
                throw new Error("chatgpt_network_failed");
            }
            if (!response.ok) {
                // Do not return raw upstream bodies: they can echo prompts or credentials.
                await response.body?.cancel();
                if (response.status === 401) throw new Error("chatgpt_auth_required");
                if (response.status === 429) throw new Error("chatgpt_image_usage_limit");
                throw new Error(`chatgpt_image_request_failed (HTTP ${response.status})`);
            }
            let body: { data?: Array<{ b64_json?: unknown }> };
            try { body = await response.json() as typeof body; } catch { signal?.throwIfAborted(); throw new Error("chatgpt_image_invalid_response"); }
            if (!Array.isArray(body?.data) || !body.data.length || body.data.some(item => typeof item?.b64_json !== "string" || !item.b64_json)) {
                throw new Error("chatgpt_image_invalid_response");
            }
            const files = [];
            for (const item of body.data) {
                signal?.throwIfAborted();
                const file = await ctx.saveImage(item.b64_json as string);
                files.push(file);
                signal?.throwIfAborted();
                ctx.importImage(file, `data:image/png;base64,${item.b64_json}`);
            }
            return {
                content: [{ type: "text" as const, text: JSON.stringify({ model: "gpt-image-2", source: "chatgpt", files, canvasImport: "requested" }) }],
                details: { files, source: "chatgpt" },
            };
        },
    } satisfies AgentTool<typeof parameters> & { promptSnippet: string };
}
