import { afterEach, expect, test, vi } from "vitest";
import { encodeReferenceJpeg } from "./reference-image-codec";
afterEach(() => vi.unstubAllGlobals());
function harness(width: number, height: number) {
    const bitmap = { width, height, close: vi.fn() };
    const context = { fillStyle: "", fillRect: vi.fn(), imageSmoothingEnabled: false, imageSmoothingQuality: "", drawImage: vi.fn() };
    const convertToBlob = vi.fn(async () => new Blob(["encoded"], { type: "image/jpeg" }));
    const sizes: number[][] = [];
    const getContext = vi.fn(() => context);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
    vi.stubGlobal("OffscreenCanvas", class { convertToBlob = convertToBlob; getContext = getContext; constructor(w: number, h: number) { sizes.push([w, h]); } });
    return { bitmap, context, convertToBlob, sizes, getContext };
}
test("fits large images within 3072px, preserves ratio and composites white in sRGB", async () => {
    const h = harness(6000, 4000);
    const blob = new Blob(["png"], { type: "image/png" });
    expect((await encodeReferenceJpeg(blob)).type).toBe("image/jpeg");
    expect(h.sizes).toEqual([[3072, 2048]]);
    expect(h.context.fillStyle).toBe("#ffffff");
    expect(h.context.fillRect).toHaveBeenCalledWith(0, 0, 3072, 2048);
    expect(h.getContext).toHaveBeenCalledWith("2d", { colorSpace: "srgb" });
    expect(h.convertToBlob).toHaveBeenCalledWith({ type: "image/jpeg", quality: 0.94 });
    expect(createImageBitmap).toHaveBeenCalledWith(blob, { imageOrientation: "from-image" });
    expect(h.bitmap.close).toHaveBeenCalledOnce();
});
test("never upscales a small PNG", async () => { const h = harness(400, 800); await encodeReferenceJpeg(new Blob(["png"], { type: "image/png" })); expect(h.sizes).toEqual([[400, 800]]); });
test("retains small JPEG bytes without another lossy encode", async () => { const h = harness(2048, 1024); const original = new Blob(["jpeg"], { type: "image/jpeg" }); expect(await encodeReferenceJpeg(original)).toBe(original); expect(h.convertToBlob).not.toHaveBeenCalled(); expect(h.bitmap.close).toHaveBeenCalledOnce(); });
test("rejects encoders that silently fall back to PNG", async () => { const h = harness(500, 500); h.convertToBlob.mockResolvedValue(new Blob(["fallback"], { type: "image/png" })); await expect(encodeReferenceJpeg(new Blob(["png"], { type: "image/png" }))).rejects.toThrow("reference_image_encoding_failed"); expect(h.bitmap.close).toHaveBeenCalledOnce(); });
