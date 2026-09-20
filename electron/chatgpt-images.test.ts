import { expect, test, vi } from "vitest";
import { createChatGptImageTool } from "./chatgpt-images";
import { createSessionToolSelection } from "./pi-session-adapter";

const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.test`;
function setup(provider = "openai-codex") {
    const fetch = vi.fn(async () => Response.json({ data: [{ b64_json: "aW1hZ2U=" }] }));
    const readImage = vi.fn(async () => ({ ok: true as const, image: { dataUrl: "data:image/png;base64,cmVm" } }));
    const saveImage = vi.fn(async () => ({ handle: "generated", name: "image.png", kind: "image" as const, mimeType: "image/png", size: 5, sourcePath: "/images/image.png" }));
    const importImage = vi.fn();
    const tool = createChatGptImageTool({ fetch, getProvider: () => provider, getAccessToken: async () => token, readImage, saveImage, importImage });
    return { tool, fetch, readImage, saveImage, importImage };
}
test("subscription generation persists an image then requests canvas import without returning bytes in text", async () => {
    const s = setup();
    const result = await s.tool.execute("call", { prompt: "a red cube" });
    const [url, init] = s.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    expect(JSON.parse(init.body as string)).toEqual({ model: "gpt-image-2", prompt: "a red cube", background: "auto", quality: "auto", size: "auto" });
    expect(new Headers(init.headers).get("chatgpt-account-id")).toBe("account");
    expect(s.saveImage).toHaveBeenCalledWith("aW1hZ2U=");
    expect(s.importImage).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("aW1hZ2U=");
    expect(JSON.stringify(result)).toContain("/images/image.png");
});
test("edits resolve exact canvas node and image IDs and pass cancellation to HTTP", async () => {
    const s = setup(); const controller = new AbortController();
    await s.tool.execute("call", { prompt: "make it blue", references: [{ nodeId: "node", imageId: "second" }] }, controller.signal);
    expect(s.readImage).toHaveBeenCalledWith({ nodeId: "node", imageId: "second" }, controller.signal);
    const [url, init] = s.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/images\/edits$/);
    expect(JSON.parse(init.body as string).images).toEqual([{ image_url: "data:image/png;base64,cmVm" }]);
    expect(init.signal).toBe(controller.signal);
});
test("rejects non-subscription sessions before reading references or sending requests", async () => {
    const s = setup("openai");
    await expect(s.tool.execute("call", { prompt: "cube" })).rejects.toThrow("chatgpt_auth_required");
    expect(s.fetch).not.toHaveBeenCalled();
});
test("quota failures are explicit and never retried or routed to another provider", async () => {
    const s = setup(); s.fetch.mockResolvedValue(new Response("sensitive upstream body", { status: 429 }));
    await expect(s.tool.execute("call", { prompt: "cube" })).rejects.toThrow("chatgpt_image_usage_limit");
    expect(s.fetch).toHaveBeenCalledOnce(); expect(s.saveImage).not.toHaveBeenCalled();
});
test("aborted requests and invalid responses do not import images", async () => {
    const s = setup(); const controller = new AbortController(); controller.abort();
    await expect(s.tool.execute("call", { prompt: "cube" }, controller.signal)).rejects.toThrow();
    expect(s.fetch).not.toHaveBeenCalled();
    s.fetch.mockResolvedValue(Response.json({ data: [] }));
    await expect(s.tool.execute("call", { prompt: "cube" })).rejects.toThrow("chatgpt_image_invalid_response");
    expect(s.importImage).not.toHaveBeenCalled();
});
test("native image tool stays registered but is only active for ChatGPT", () => {
    const tools = [{ name: "generate_chatgpt_image", label: "Image" }, { name: "view_image", label: "View" }];
    expect(createSessionToolSelection(tools, true, "openai-codex").activeNames).toContain("generate_chatgpt_image");
    expect(createSessionToolSelection(tools, true, "openai").activeNames).not.toContain("generate_chatgpt_image");
    expect(createSessionToolSelection(tools, false, "openai").registeredNames).toContain("generate_chatgpt_image");
});
