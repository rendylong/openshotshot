import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createModelChannel, defaultConfig } from "@/stores/use-config-store";
import { compileFalInput } from "@/lib/models/fal/input";
import { getFalProfile } from "@/lib/models/fal/profiles";
import { patchProviderParams } from "@/lib/models/provider-options";
import { buildNodeGenerationContext, buildSourceImageReferences, type NodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { planCanvasMediaGeneration } from "./canvas-media-generation-route";
import { assertFalGenerationOperationSupported, prepareFalGenerationRequest } from "./fal-generation-input";
const { imageToDataUrl } = vi.hoisted(() => ({ imageToDataUrl: vi.fn() }));
vi.mock("@/services/image-storage", () => ({ imageToDataUrl }));
function config(model = "fal-ai/veo3.1/first-last-frame-to-video") {
    return { ...defaultConfig, compressReferenceImages: false, model: `one::${model}`, size: "", quality: "", videoSeconds: "", vquality: "", videoGenerateAudio: "", channels: [createModelChannel({ id: "one", provider: "fal", apiKey: "fixture-key", models: [{ name: model, capability: model.includes("flux") ? "image" : "video" }] })] };
}
function context(): NodeGenerationContext {
    return { prompt: "rotate", referenceImages: ["b", "a"].map(id => ({ id, name: "same name", type: "image/png", dataUrl: "blob:stale", storageKey: id })), referenceAudios: [], referenceVideos: [], textCount: 0, imageCount: 2, audioCount: 0, videoCount: 0 };
}
beforeEach(() => { vi.restoreAllMocks(); imageToDataUrl.mockReset().mockImplementation(async ({ storageKey }) => `data:image/png;base64,${storageKey === "a" ? "YQ==" : "Yg=="}`); });
afterEach(() => vi.unstubAllGlobals());
describe("fal generation preflight", () => {
    test("resolves exact storage keys in first/last order without mutating refs", async () => {
        const input = context(); const request = await prepareFalGenerationRequest(config(), input, undefined);
        expect(imageToDataUrl.mock.calls.map(([ref]) => ref)).toEqual([{ storageKey: "b", dataUrl: "" }, { storageKey: "a", dataUrl: "" }]);
        const body = compileFalInput(getFalProfile("fal-ai/veo3.1/first-last-frame-to-video")!, request);
        expect(body.first_frame_url).toBe("data:image/png;base64,Yg==");
        expect(body.last_frame_url).toBe("data:image/png;base64,YQ==");
        expect(input.referenceImages[0].dataUrl).toBe("blob:stale");
        expect(request.channelId).toBe("one");
    });
    test("rejects missing local storage without falling back to stale URL", async () => {
        imageToDataUrl.mockResolvedValue("");
        await expect(prepareFalGenerationRequest(config(), context(), undefined)).rejects.toThrow();
    });
    test("keeps public HTTPS and advanced separate from common controls", async () => {
        const cfg = config("fal-ai/flux-2-pro/edit");
        const input = context(); input.referenceImages = [{ id: "exact", name: "x", type: "image/png", dataUrl: "https://example.com/image.png" }];
        const options = patchProviderParams(undefined, cfg.model, getFalProfile("fal-ai/flux-2-pro/edit")!, { seed: 7 });
        const request = await prepareFalGenerationRequest(cfg, input, options);
        expect(request.images).toEqual(["https://example.com/image.png"]);
        expect(request.params).toEqual({ providerParams: { seed: 7 } });
        expect(imageToDataUrl).not.toHaveBeenCalled();
    });
    test("rejects unsupported media before any read", async () => {
        const input = context(); input.referenceAudios = [{ id: "audio", name: "audio", type: "audio/wav", url: "https://example.com/a.wav" }];
        await expect(prepareFalGenerationRequest(config(), input, undefined)).rejects.toThrow();
        expect(imageToDataUrl).not.toHaveBeenCalled();
    });
    test("honors abort before reading images", async () => {
        const controller = new AbortController(); controller.abort();
        await expect(prepareFalGenerationRequest(config(), context(), undefined, controller.signal)).rejects.toThrow();
        expect(imageToDataUrl).not.toHaveBeenCalled();
    });
});

describe("exact endpoint material constraints", () => {
    function oneImage() { const input = context(); input.referenceImages = [{ id: "actual", name: "image", type: "image/png", dataUrl: "https://example.com/image.png" }]; return input; }
    function actualImage(width: number, height: number, mime = "image/png", bytes = 100) {
        const blob = new Blob([new Uint8Array(bytes)], { type: mime });
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, blob: async () => blob } as Response);
        vi.stubGlobal("Image", class { naturalWidth = width; naturalHeight = height; onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_value: string) { queueMicrotask(() => this.onload?.()); } });
        return fetchMock;
    }
    test.each(["fal-ai/kling-video/v3/pro/image-to-video", "fal-ai/kling-video/v3/standard/image-to-video"])("checks actual Kling bytes/dimensions/ratio for %s", async model => {
        actualImage(300, 750, "image/png", 10485760);
        await expect(prepareFalGenerationRequest(config(model), oneImage(), undefined)).resolves.toBeDefined();
        actualImage(300, 750, "image/png", 10485761);
        await expect(prepareFalGenerationRequest(config(model), oneImage(), undefined)).rejects.toThrow("fal_media_bytes");
        actualImage(299, 750);
        await expect(prepareFalGenerationRequest(config(model), oneImage(), undefined)).rejects.toThrow("fal_media_dimensions");
        actualImage(300, 751);
        await expect(prepareFalGenerationRequest(config(model), oneImage(), undefined)).rejects.toThrow("fal_media_ratio");
    });
    test.each(["bytedance/seedance-2.0/image-to-video", "bytedance/seedance-2.0/fast/image-to-video"])("uses decimal 30 MB and documented MIME formats for %s", async model => {
        actualImage(10, 10, "image/webp", 30000000);
        await expect(prepareFalGenerationRequest(config(model), oneImage(), undefined)).resolves.toBeDefined();
        actualImage(10, 10, "image/webp", 30000001);
        await expect(prepareFalGenerationRequest(config(model), oneImage(), undefined)).rejects.toThrow("fal_media_bytes");
        actualImage(10, 10, "image/gif");
        await expect(prepareFalGenerationRequest(config(model), oneImage(), undefined)).rejects.toThrow("fal_media_type");
    });
    test.each([[240, 7680, true], [239, 7680, false], [240, 7681, false]])("checks WAN actual dimensions %s x %s", async (width, height, valid) => {
        actualImage(width as number, height as number);
        const request = prepareFalGenerationRequest(config("wan/v2.6/image-to-video"), oneImage(), undefined);
        if (valid) await expect(request).resolves.toBeDefined(); else await expect(request).rejects.toThrow("fal_media_dimensions");
    });
    test("checks optional Kling end frame separately", async () => {
        const fetchMock = actualImage(512, 512);
        fetchMock.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["start"], { type: "image/png" }) } as Response)
            .mockResolvedValueOnce({ ok: true, blob: async () => new Blob([new Uint8Array(10485761)], { type: "image/png" }) } as Response);
        const input = oneImage(); input.referenceImages.push({ ...input.referenceImages[0], id: "end", dataUrl: "https://example.com/end.png" });
        await expect(prepareFalGenerationRequest(config("fal-ai/kling-video/v3/pro/image-to-video"), input, undefined)).rejects.toThrow("fal_media_bytes");
    });
    test("applies LTX fast MIME list only to documented start slot and admits HEIF", async () => {
        const fetchMock = actualImage(1, 1, "image/heif");
        const input = oneImage(); input.referenceImages.push({ ...input.referenceImages[0], id: "end", dataUrl: "https://example.com/end.png" });
        await expect(prepareFalGenerationRequest(config("fal-ai/ltx-2.3/image-to-video/fast"), input, undefined)).resolves.toBeDefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        actualImage(1, 1, "image/gif");
        await expect(prepareFalGenerationRequest(config("fal-ai/ltx-2.3/image-to-video/fast"), input, undefined)).rejects.toThrow("fal_media_type");
    });
    test("does not impose Veo recommended size or fetch unconstrained HTTPS", async () => {
        const fetchMock = actualImage(1, 1);
        await expect(prepareFalGenerationRequest(config("fal-ai/veo3.1/image-to-video"), oneImage(), undefined)).resolves.toBeDefined();
        expect(fetchMock).not.toHaveBeenCalled();
    });
    test("rejects unreadable constrained HTTPS without fallback or submit", async () => {
        vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
        const submit = vi.fn();
        await expect(prepareFalGenerationRequest(config("wan/v2.6/image-to-video"), oneImage(), undefined).then(submit)).rejects.toThrow();
        expect(submit).not.toHaveBeenCalled();
    });
});


test.each(["mask", "plugin-self"] as const)("rejects unsupported fal %s before submit", operation => {
    const submit = vi.fn();
    expect(() => { assertFalGenerationOperationSupported(config("fal-ai/flux-2-pro/edit"), operation); submit(); }).toThrow(operation === "mask" ? "fal_mask_unsupported" : "fal_target_unsupported");
    expect(submit).not.toHaveBeenCalled();
    expect(() => assertFalGenerationOperationSupported(defaultConfig, operation)).not.toThrow();
});


test.each(["first", "retry"] as const)("routes fal generation from a 3D/plugin source into an ordinary image child through the persistent adapter (%s)", async phase => {
    const cfg = config("fal-ai/flux-2-pro/edit");
    const input = context();
    const prepared = await prepareFalGenerationRequest(cfg, input, undefined);
    const plan = planCanvasMediaGeneration({ config: cfg, capability: "image", phase, pluginHost: false });
    expect(plan).toMatchObject({ mode: "remote_task", adapterId: "fal.image", timeoutMinutes: 5 });
    expect(prepared.images).toEqual(["data:image/png;base64,Yg==", "data:image/png;base64,YQ=="]);
});


describe("project source image plus composer reference composition", () => {
    test.each([1, 2])("keeps %s implicit source images primary and labels the upstream reference at its submitted index", async count => {
        const source: CanvasNodeData = { id: "source-a", type: CanvasNodeType.Image, title: "Source", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: {
            content: "blob:stale-source", composerContent: "Use @[node:upstream-b] twice: @[node:upstream-b]. Literal image1 remains literal.",
            images: Array.from({ length: count }, (_, index) => ({ id: `a${index + 1}`, storageKey: `a${index + 1}`, content: "", mimeType: "image/png", status: "success", naturalWidth: 200, naturalHeight: 200, bytes: 1 })),
        } };
        const upstream: CanvasNodeData = { id: "upstream-b", type: CanvasNodeType.Image, title: "Same name", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { content: "blob:stale-upstream", storageKey: "b", mimeType: "image/png" } };
        const context = buildNodeGenerationContext(source.id, [source, upstream], [{ id: "connection", fromNodeId: upstream.id, toNodeId: source.id }], source.metadata!.composerContent!, { strictReferences: true, sourceImages: buildSourceImageReferences(source) });
        const expectedPrompt = `Use ${imageReferenceLabel(count)} twice: ${imageReferenceLabel(count)}. Literal image1 remains literal.`;
        expect(context.prompt).toBe(expectedPrompt);
        expect(context.referenceImages.map(ref => ref.storageKey)).toEqual([...Array.from({ length: count }, (_, index) => `a${index + 1}`), "b"]);
        imageToDataUrl.mockImplementation(async ({ storageKey }) => `data:image/png;base64,${btoa(storageKey)}`);
        const request = await prepareFalGenerationRequest(config("fal-ai/flux-2-pro/edit"), context, undefined);
        const body = compileFalInput(getFalProfile("fal-ai/flux-2-pro/edit")!, request);
        expect(body.prompt).toBe(expectedPrompt);
        expect(body.image_urls).toEqual([...Array.from({ length: count }, (_, index) => `data:image/png;base64,${btoa(`a${index + 1}`)}`), "data:image/png;base64,Yg=="]);
        expect(context.imageCount).toBe(count + 1);
        expect(source.metadata!.composerContent).toContain("@[node:upstream-b]");
    });
});
