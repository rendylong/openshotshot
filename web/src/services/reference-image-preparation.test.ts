import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { defaultConfig } from "@/stores/use-config-store";
import { encodeReferenceJpeg } from "./reference-image-codec";
import { imageToDataUrl } from "./image-storage";
import { createReferenceImageSession, hasReferenceMask, prepareReferenceImages, prepareReferenceObjects, referenceCompressionEnabled, resetReferenceImageMemoForTests, withReferenceImageSession } from "./reference-image-preparation";

vi.mock("./reference-image-codec", () => ({ encodeReferenceJpeg: vi.fn() }));
vi.mock("./image-storage", () => ({ imageToDataUrl: vi.fn(async (image: { dataUrl?: string; storageKey?: string }) => image.dataUrl || "data:image/png;base64,c3RvcmVk") }));
const png = "data:image/png;base64,b3JpZ2luYWw=";
const jpg = new Blob(["jpg copy"], { type: "image/jpeg" });
beforeEach(() => { resetReferenceImageMemoForTests(); vi.mocked(encodeReferenceJpeg).mockReset().mockResolvedValue(jpg); });
afterEach(() => vi.restoreAllMocks());

describe("reference image preparation", () => {
    test("compresses uploads and shares concurrent content, without changing originals", async () => {
        const config = defaultConfig;
        const original = [png, png];
        const result = await prepareReferenceImages(config, original);
        expect(result[0]).toMatch(/^data:image\/jpeg;base64,/);
        expect(result[0]).toBe(result[1]);
        expect(original).toEqual([png, png]);
        expect(encodeReferenceJpeg).toHaveBeenCalledOnce();
        await prepareReferenceImages(config, result);
        expect(encodeReferenceJpeg).toHaveBeenCalledOnce();
    });
    test("disabled compression and masked edits preserve source bytes without reading them", async () => {
        const read = vi.mocked(imageToDataUrl); read.mockClear();
        expect(await prepareReferenceImages({ ...defaultConfig, compressReferenceImages: false }, [png])).toEqual([png]);
        expect(await prepareReferenceImages(defaultConfig, [png], { preserveOriginal: true })).toEqual([png]);
        expect(hasReferenceMask({ mask: png })).toBe(true);
        expect(hasReferenceMask({ mask_image: png })).toBe(true);
        expect(read).not.toHaveBeenCalled(); expect(encodeReferenceJpeg).not.toHaveBeenCalled();
    });
    test("keeps reference order and updates file metadata without overwriting stored assets", async () => {
        const ref = { id: "a", name: "role.png", type: "image/png", dataUrl: png, storageKey: "image:a" };
        const [result] = await prepareReferenceObjects(defaultConfig, [ref]);
        expect(result).toMatchObject({ id: "a", name: "role.jpg", type: "image/jpeg", storageKey: undefined });
        expect(ref).toMatchObject({ storageKey: "image:a", dataUrl: png, name: "role.png" });
    });
    test("failure never silently uploads the original, and a later attempt can recover", async () => {
        vi.mocked(encodeReferenceJpeg).mockRejectedValueOnce(new Error("decode failed"));
        await expect(prepareReferenceImages(defaultConfig, [png])).rejects.toThrow(/压缩参考图/);
        await expect(prepareReferenceImages(defaultConfig, [png])).resolves.toEqual([expect.stringContaining("image/jpeg")]);
    });
    test("limits decoding to two jobs across simultaneous requests", async () => {
        let active = 0, peak = 0;
        const releases: Array<() => void> = [];
        vi.mocked(encodeReferenceJpeg).mockImplementation(async () => {
            active++; peak = Math.max(peak, active);
            await new Promise<void>(resolve => releases.push(resolve)); active--; return jpg;
        });
        const work = prepareReferenceImages(defaultConfig, ["a", "b", "c", "d"].map(value => `data:image/png;base64,${btoa(value)}`));
        await vi.waitFor(() => expect(releases).toHaveLength(2));
        releases[0](); releases[1]();
        await vi.waitFor(() => expect(releases).toHaveLength(4));
        releases[2](); releases[3](); await work;
        expect(peak).toBe(2);
    });
    test("one cancelled consumer does not cancel a shared compression", async () => {
        let finish!: () => void;
        vi.mocked(encodeReferenceJpeg).mockImplementation(async () => { await new Promise<void>(resolve => { finish = resolve; }); return jpg; });
        const controller = new AbortController();
        const cancelled = prepareReferenceImages(defaultConfig, [png], { signal: controller.signal });
        const rejected = expect(cancelled).rejects.toThrow(/abort/i);
        const surviving = prepareReferenceImages(defaultConfig, [png]);
        await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
        controller.abort(); finish();
        await rejected; await expect(surviving).resolves.toHaveLength(1);
        expect(encodeReferenceJpeg).toHaveBeenCalledOnce();
    });
    test("batch settings survive config spreads, stay frozen and are not persisted", () => {
        const session = createReferenceImageSession(true);
        const config = withReferenceImageSession(defaultConfig, session);
        expect(referenceCompressionEnabled({ ...config, compressReferenceImages: false })).toBe(true);
        expect(JSON.stringify(config)).not.toContain("uploads");
        expect(Object.getOwnPropertySymbols(JSON.parse(JSON.stringify(config)))).toHaveLength(0);
    });
});
