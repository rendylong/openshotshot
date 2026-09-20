import { describe, expect, test } from "vitest";
import { getFalProfile } from "./fal/profiles";
import { patchProviderParams, readProviderParams, validateProviderOptions } from "./provider-options";
const profile = getFalProfile("fal-ai/flux-2-pro")!;
describe("provider options", () => {
    test("scopes immutable values to the exact channel and endpoint", () => {
        const stored = patchProviderParams(undefined, "one::fal-ai/flux-2-pro", profile, { seed: 7 });
        const next = patchProviderParams(stored, "two::fal-ai/flux-2-pro", profile, { seed: 8 });
        expect(readProviderParams(stored, "one::fal-ai/flux-2-pro")).toEqual({ seed: 7 });
        expect(readProviderParams(stored, "two::fal-ai/flux-2-pro")).toEqual({});
        expect(readProviderParams(next, "two::fal-ai/flux-2-pro")).toEqual({ seed: 8 });
        const params = readProviderParams(stored, "one::fal-ai/flux-2-pro"); params.seed = 10;
        expect(readProviderParams(stored, "one::fal-ai/flux-2-pro").seed).toBe(7);
    });
    test("refuses unknown wrapper/profile versions without modifying original", () => {
        const stored = patchProviderParams(undefined, "one::fal-ai/flux-2-pro", profile, { seed: 7 });
        const unknown = { ...stored, version: 8 };
        expect(() => readProviderParams(unknown, "one::fal-ai/flux-2-pro")).toThrow();
        expect(() => patchProviderParams(unknown, "one::fal-ai/flux-2-pro", profile, {})).toThrow();
        expect(unknown.version).toBe(8);
        stored.models["one::fal-ai/flux-2-pro"].profileVersion = 8;
        expect(() => readProviderParams(stored, "one::fal-ai/flux-2-pro")).toThrow();
    });
    test.each(["prompt", "size", "image_size", "image_urls", "num_images", "apiKey", "baseUrl", "unknown", "__proto__"])("rejects injected %s", key => {
        expect(() => patchProviderParams(undefined, "one::fal-ai/flux-2-pro", profile, { [key]: "secret" })).toThrow();
    });
    test.each([NaN, Infinity, undefined, new Date(), () => 1])("rejects non JSON %s", seed => {
        expect(() => patchProviderParams(undefined, "one::fal-ai/flux-2-pro", profile, { seed } as never)).toThrow();
    });
    test("rejects profile/endpoint mismatch and unscoped model keys", () => {
        expect(() => patchProviderParams(undefined, "one::fal-ai/nano-banana", profile, {})).toThrow();
        expect(() => patchProviderParams(undefined, profile.id, profile, {})).toThrow();
    });
});


test("validates all entries of a tool write and returns an isolated copy", () => {
    const options = patchProviderParams(undefined, "one::fal-ai/flux-2-pro", profile, { seed: 7 });
    const result = validateProviderOptions(options);
    result.models["one::fal-ai/flux-2-pro"].params.seed = 8;
    expect(options.models["one::fal-ai/flux-2-pro"].params.seed).toBe(7);
    const inactive = { ...options, models: { ...options.models, "other::fal-ai/flux-2-pro": { ...options.models["one::fal-ai/flux-2-pro"], profileVersion: 99 } } };
    expect(() => validateProviderOptions(inactive)).toThrow("fal_options_profile");
});


test.each([undefined, null, "1", 99])("rejects malformed saved profileVersion %s without defaulting to the latest profile", profileVersion => {
    const model = "one::fal-ai/flux-2-pro";
    const stored = { version: 1, models: { [model]: { provider: "fal", profileId: profile.id, ...(profileVersion === undefined ? {} : { profileVersion }), params: { seed: 7 } } } };
    const before = structuredClone(stored);
    expect(() => readProviderParams(stored as never, model)).toThrow("fal_options_profile");
    expect(() => validateProviderOptions(stored)).toThrow("fal_options_profile");
    expect(() => patchProviderParams(stored as never, model, profile, { seed: 8 })).toThrow("fal_options_profile");
    expect(stored).toEqual(before);
    expect(getFalProfile(profile.id)).toBe(profile);
});
