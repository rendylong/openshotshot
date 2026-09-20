import { describe, expect, it } from "vitest";
import cases from "./fixtures/contract-cases.json";
import { compileFalInput, parseFalOutput } from "./input";
import { getFalProfile } from "./profiles";

const first = "https://example.test/first.png";
const last = "https://example.test/last.png";

describe.each(cases.map(c => [c.endpointId, c] as const))("%s", (_endpointId, c) => {
    it("compiles the independently authored request and parses the independent output", () => {
        const profile = getFalProfile(c.endpointId)!;
        expect(compileFalInput(profile, c.request)).toEqual(c.expectedInput);
        expect(parseFalOutput(profile, c.providerOutput)).toEqual(c.expectedResult);
    });
    it("rejects wrong prompt types, undeclared fields and unsupported media", () => {
        const profile = getFalProfile(c.endpointId)!;
        expect(() => compileFalInput(profile, { ...c.request, prompt: 42 as unknown as string })).toThrow("fal_input_invalid");
        expect(() => compileFalInput(profile, { ...c.request, params: { imaginary: true } })).toThrow("fal_unsupported_parameter");
        expect(() => compileFalInput(profile, { ...c.request, audios: [first] })).toThrow("fal_unsupported_media");
        expect(() => compileFalInput(profile, { ...c.request, videos: [first] })).toThrow("fal_unsupported_media");
    });
    it("rejects advanced injection of prompt, media and internal controls", () => {
        const profile = getFalProfile(c.endpointId)!;
        for (const key of ["prompt", "image_urls", "num_images", "sync_mode", "unknown", "apiKey"]) {
            expect(() => compileFalInput(profile, { ...c.request, params: { providerParams: { [key]: "secret" } } })).toThrow("fal_unsupported_parameter");
        }
        for (const field of profile.fields.filter((field) => field.common)) {
            expect(() => compileFalInput(profile, { ...c.request, params: { providerParams: { [field.name]: "secret" } } })).toThrow("fal_unsupported_parameter");
            expect(() => compileFalInput(profile, { ...c.request, params: { [field.common!]: {} } })).toThrow();
        }
    });
    it("rejects missing required and extra references without silently dropping images", () => {
        const profile = getFalProfile(c.endpointId)!;
        if (c.request.images.length) expect(() => compileFalInput(profile, { ...c.request, images: [] })).toThrow("fal_missing_reference");
        if (!profile.media.some((slot) => slot.mode === "many")) {
            expect(() => compileFalInput(profile, { ...c.request, images: Array(profile.media.length + 1).fill(first) })).toThrow("fal_extra_references");
        }
        if (profile.media.length) {
            for (const uri of ["javascript:bad", "http://example.test/image.png"]) {
                expect(() => compileFalInput(profile, { ...c.request, images: [uri, ...c.request.images.slice(1)] })).toThrow("fal_input_invalid");
            }
        }
    });
    it("rejects invalid enum values and scalar types on declared controls", () => {
        const profile = getFalProfile(c.endpointId)!;
        for (const field of profile.fields) {
            const params = field.common ? { [field.common]: "not-an-option" } : { providerParams: { [field.name]: {} } };
            if (field.kind === "enum" || !field.common) expect(() => compileFalInput(profile, { ...c.request, params })).toThrow();
        }
    });
    it("rejects absent results, wrong output kind and unsafe URLs", () => {
        const profile = getFalProfile(c.endpointId)!;
        for (const output of [null, {}, { images: [] }, { video: "https://example.test/result.mp4" }]) expect(() => parseFalOutput(profile, output)).toThrow("fal_output_invalid");
        for (const url of ["javascript:alert(1)", "file:///tmp/result", "data:image/png;base64,eA==", "//example.test/x", "https://user:secret@example.test/x", "https://example.test/x\n", "https://example.test/a b"]) {
            expect(() => parseFalOutput(profile, profile.modality === "image" ? { images: [{ url }] } : { video: { url } })).toThrow("fal_output_invalid");
        }
        expect(() => parseFalOutput(profile, profile.modality === "image" ? { images: [{ url: first, content_type: "video/mp4" }] } : { video: { url: first, content_type: "image/png" } })).toThrow("fal_output_invalid");
    });
});

it("converts common seconds only according to the selected contract", () => {
    const request = { prompt: "a red cup", images: [], params: { seconds: "6" } };
    expect(compileFalInput(getFalProfile("fal-ai/veo3.1")!, request).duration).toBe("6s");
    expect(compileFalInput(getFalProfile("fal-ai/ltx-2.3/text-to-video")!, request).duration).toBe(6);
    expect(compileFalInput(getFalProfile("fal-ai/kling-video/v3/pro/text-to-video")!, request).duration).toBe("6");
    for (const seconds of ["", " ", "NaN", "Infinity", Infinity, 5.5, "6s"]) {
        expect(() => compileFalInput(getFalProfile("fal-ai/veo3.1")!, { ...request, params: { seconds } })).toThrow();
    }
});
it("preserves Seedance auto duration and explicit audio selection", () => {
    const profile = getFalProfile("bytedance/seedance-2.0/text-to-video")!;
    expect(compileFalInput(profile, { prompt: "a red cup", images: [], params: { seconds: "auto", generateAudio: true } })).toMatchObject({ duration: "auto", generate_audio: true });
});
it("maps exact image presets and rejects unsupported custom dimensions", () => {
    const profile = getFalProfile("fal-ai/flux-2-pro")!;
    expect(compileFalInput(profile, { prompt: "a cup", images: [], params: { size: "16:9" } }).image_size).toBe("landscape_16_9");
    expect(() => compileFalInput(profile, { prompt: "a cup", images: [], params: { size: { width: 1024, height: 1024 } } })).toThrow();
    expect(() => compileFalInput(profile, { prompt: "a cup", images: [], params: { size: "2:1" } })).toThrow();
});
it("honors optional end frames without reversing first/last", () => {
    for (const endpoint of ["fal-ai/kling-video/v3/pro/image-to-video", "bytedance/seedance-2.0/image-to-video", "fal-ai/ltx-2.3/image-to-video"]) {
        const result = compileFalInput(getFalProfile(endpoint)!, { prompt: "a cup", images: [first, last], params: {} });
        expect(result.end_image_url).toBe(last);
        expect(result.start_image_url ?? result.image_url).toBe(first);
    }
});
it("enforces documented reference caps and LTX fast combinations", () => {
    for (const [endpoint, count] of [["openai/gpt-image-2/edit", 17], ["bytedance/seedream/v5/pro/edit", 11]] as const) {
        expect(() => compileFalInput(getFalProfile(endpoint)!, { prompt: "a cup", images: Array(count).fill(first), params: {} })).toThrow("fal_input_invalid");
    }
    const profile = getFalProfile("fal-ai/ltx-2.3/text-to-video/fast")!;
    const request = { prompt: "a cup", images: [], params: { seconds: 12 } };
    expect(compileFalInput(profile, request).duration).toBe(12);
    expect(() => compileFalInput(profile, { ...request, params: { seconds: 12, resolution: "1440p" } })).toThrow("fal_input_invalid");
    expect(() => compileFalInput(profile, { ...request, params: { seconds: 12, providerParams: { fps: 24 } } })).toThrow("fal_input_invalid");
});
it("does not mutate requests or preserve shared nested parameter objects", () => {
    const request = { prompt: "a cup", images: [first, last], params: { providerParams: { seed: 3 } } };
    const original = structuredClone(request);
    const result = compileFalInput(getFalProfile("fal-ai/nano-banana/edit")!, request);
    (result.image_urls as string[]).push("https://example.test/third.png");
    expect(request).toEqual(original);
});

it("requires both distinct first/last slots and preserves their ordering", () => {
    for (const endpointId of ["fal-ai/veo3.1/first-last-frame-to-video", "fal-ai/veo3.1/fast/first-last-frame-to-video"]) {
        const profile = getFalProfile(endpointId)!;
        expect(() => compileFalInput(profile, { prompt: "a cup", images: [first], params: {} })).toThrow("fal_missing_reference:last_frame_url");
        expect(compileFalInput(profile, { prompt: "a cup", images: [first, last], params: {} })).toMatchObject({ first_frame_url: first, last_frame_url: last });
    }
});
it("rejects range errors, nullable-control types and scalar coercion in advanced parameters", () => {
    const profile = getFalProfile("fal-ai/kling-video/v3/pro/text-to-video")!;
    for (const cfg_scale of [-0.1, 1.1, "0.5", null, NaN]) {
        expect(() => compileFalInput(profile, { prompt: "a cup", images: [], params: { providerParams: { cfg_scale } } })).toThrow("fal_input_invalid");
    }
    expect(compileFalInput(profile, { prompt: "a cup", images: [], params: { providerParams: { cfg_scale: 0 } } }).cfg_scale).toBe(0);
    const nano = getFalProfile("fal-ai/nano-banana-2")!;
    expect(() => compileFalInput(nano, { prompt: "a cup", images: [], params: { providerParams: { seed: "3" } } })).toThrow("fal_input_invalid");
    expect(() => compileFalInput(nano, { prompt: "a cup", images: [], params: { providerParams: null } })).toThrow("fal_input_invalid");
});
it("does not enable fixed audio switches or infer Hailuo Pro duration", () => {
    for (const endpointId of ["wan/v2.6/text-to-video", "wan/v2.6/image-to-video", "fal-ai/minimax/hailuo-2.3/pro/text-to-video", "fal-ai/minimax/hailuo-2.3/pro/image-to-video"]) {
        const c = cases.find((item) => item.endpointId === endpointId)!;
        expect(() => compileFalInput(getFalProfile(endpointId)!, { ...c.request, params: { generateAudio: false } })).toThrow("fal_unsupported_parameter");
    }
    expect(() => compileFalInput(getFalProfile("fal-ai/minimax/hailuo-2.3/pro/text-to-video")!, { prompt: "a cup", images: [], params: { seconds: 6 } })).toThrow("fal_unsupported_parameter");
});
it("enforces WAN prompt constraints described in its exact captured schemas", () => {
    for (const endpointId of ["wan/v2.6/text-to-video", "wan/v2.6/image-to-video"]) {
        const c = cases.find((item) => item.endpointId === endpointId)!;
        expect(() => compileFalInput(getFalProfile(endpointId)!, { ...c.request, prompt: "x".repeat(1501) })).toThrow("fal_input_invalid");
        expect(() => compileFalInput(getFalProfile(endpointId)!, { ...c.request, params: { providerParams: { negative_prompt: "x".repeat(501) } } })).toThrow("fal_input_invalid");
    }
});
it("accepts valid remote image results and optional video MIME without changing URLs", () => {
    expect(parseFalOutput(getFalProfile("fal-ai/flux-2-pro")!, { images: [{ url: first }, { url: last }] })).toEqual({ kind: "image", sources: [first, last] });
    const source = "https://example.test/result.mp4?signature=provider-signed";
    expect(parseFalOutput(getFalProfile("fal-ai/veo3.1")!, { video: { url: source } })).toEqual({ kind: "video", source });
});

it("treats null image MIME as omitted", () => {
    expect(parseFalOutput(getFalProfile("fal-ai/flux-2-pro")!, { images: [{ url: first, content_type: null }] })).toEqual({ kind: "image", sources: [first] });
});
it("treats null video MIME as omitted", () => {
    const source = "https://example.test/result.mp4";
    expect(parseFalOutput(getFalProfile("fal-ai/veo3.1")!, { video: { url: source, content_type: null } })).toEqual({ kind: "video", source });
});
