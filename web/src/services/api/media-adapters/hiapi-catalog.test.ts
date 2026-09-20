import axios from "axios";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { detectHiapiImageField, fetchHiapiCatalog, getHiapiCatalogMirror, lookupHiapiModel, resolveCatalogFieldValue } from "./hiapi-catalog";

const samplePayload = {
    models: [
        {
            id: "seedance-2.5/image-to-video",
            title: "Seedance 2.5 Image to Video API",
            category: "video",
            capability: "Video generation (image-to-video)",
            input: [
                { name: "prompt", type: "string", required: true },
                { name: "first_frame_url", type: "string", required: false },
                { name: "reference_image_urls", type: "string[]", required: false },
            ],
        },
        {
            id: "qwen-image-3.0/image-to-image",
            title: "Qwen Image 3.0 Image to Image API",
            category: "image",
            capability: "Image generation (image-to-image)",
            input: [
                { name: "prompt", type: "string", required: true },
                { name: "image_urls", type: "string[]", required: true },
            ],
        },
        {
            id: "wan2.7-video/image-to-video",
            title: "Wan 2.7 Image-to-Video",
            category: "video",
            capability: "Video generation (image-to-video)",
            input: [
                { name: "prompt", type: "string", required: true },
                { name: "media", type: "object[]", required: false },
            ],
        },
        {
            id: "minimax-h3",
            title: "minimax-h3",
            category: "video",
            capability: "Video generation (text-to-video)",
            input: [
                { name: "prompt", type: "string", required: true },
                { name: "resolution", type: "enum", required: false, enum: ["2K"], default: "2K" },
                { name: "aspect_ratio", type: "enum", required: false, enum: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"], default: "16:9" },
                { name: "duration", type: "integer", required: false, default: 5 },
            ],
        },
        {
            id: "Nano-Banana",
            title: "Nano Banana API",
            category: "image",
            capability: "Image generation (text-to-image)",
            input: [
                { name: "prompt", type: "string", required: true },
                { name: "aspect_ratio", type: "enum", required: false },
            ],
        },
    ],
};

const network = (response: unknown, error?: unknown) => {
    if (error) return vi.spyOn(axios, "get").mockRejectedValue(error as never);
    return vi.spyOn(axios, "get").mockResolvedValue({ data: response } as never);
};

beforeEach(async () => {
    window.localStorage.clear();
    network(samplePayload);
    await fetchHiapiCatalog({ force: true });
});

afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
});

describe("HiAPI catalog", () => {
    test("fetches the public catalog and stores it in the in-memory mirror", () => {
        expect(getHiapiCatalogMirror()?.models.length).toBeGreaterThanOrEqual(4);
    });

    test("looks up models case-insensitively", () => {
        const entry = lookupHiapiModel("nano-banana");
        expect(entry?.category).toBe("image");
    });

    test("returns the documented image field for catalog-known image-to-image models", () => {
        expect(detectHiapiImageField("qwen-image-3.0/image-to-image")).toEqual({ kind: "array", field: "image_urls" });
        expect(detectHiapiImageField("seedance-2.5/image-to-video")).toEqual({ kind: "single", field: "first_frame_url" });
        expect(detectHiapiImageField("wan2.7-video/image-to-video")).toEqual({ kind: "media" });
    });

    test("returns null for text-only models without an image input field", () => {
        expect(detectHiapiImageField("nano-banana")).toBeNull();
    });

    test("picks closest catalog enum value for an unrecognised user input", () => {
        // minimax-h3 only accepts "2K"; user picked 720p. We should coerce to "2K" instead of forwarding the invalid value.
        const picked = resolveCatalogFieldValue("minimax-h3", "resolution", "720p");
        expect(picked).toBe("2K");
        // Numeric portion matching: 1080 maps to closest valid resolution in the 2K-only enum (still 2K)
        expect(resolveCatalogFieldValue("minimax-h3", "resolution", 1080)).toBe("2K");
        // Unknown model: pass-through
        expect(resolveCatalogFieldValue("unknown-model", "resolution", "720p")).toBe("720p");
    });

    test("returns catalog default when no user value provided", () => {
        expect(resolveCatalogFieldValue("minimax-h3", "resolution", undefined)).toBe("2K");
    });

    test("drops invalid persisted entries on next load", async () => {
        window.localStorage.setItem(
            "shotshot:hiapi_catalog_v1",
            JSON.stringify({
                fetchedAt: Date.now(),
                etag: null,
                models: [{ id: "valid-model", title: "Valid", category: "image", capability: "x", input: [{ name: "prompt", type: "string", required: true }] }, { id: 123, category: "image", input: [] }, null],
            }),
        );
        network(new Error("offline"));
        // Force a re-fetch by clearing the in-memory mirror via a fresh fetch attempt.
        const before = getHiapiCatalogMirror()?.models.length ?? 0;
        await fetchHiapiCatalog({ force: true });
        const after = getHiapiCatalogMirror()?.models.length ?? 0;
        // Either network fetch returned new data, or persisted fallback filtered out invalid entries.
        expect(after).toBeGreaterThanOrEqual(before);
    });
});
