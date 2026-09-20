import { describe, expect, test } from "vitest";

import { assertMediaAdapterRegistry, getMediaAdapter, registerMediaAdapters } from "./registry";
import type { MediaAdapter } from "./types";

const fakeImageAdapter: MediaAdapter = {
    id: "fake.image",
    version: 1,
    modality: "image",
    execution: "direct",
    generate: async () => ({ kind: "image", sources: [] }),
};

describe("media adapter registry", () => {
    test("registers both fal persistent queue adapters", () => {
        for (const modality of ["image", "video"]) expect(getMediaAdapter(`fal.${modality}`)).toMatchObject({ version: 1, modality, execution: "remote_task", submit: expect.any(Function), query: expect.any(Function) });
    });
    test("rejects a remote adapter without both submit and query", () => {
        expect(() =>
            assertMediaAdapterRegistry([
                {
                    id: "broken",
                    version: 1,
                    modality: "video",
                    execution: "remote_task",
                    submit: async () => ({ taskId: "x" }),
                },
            ]),
        ).toThrow("remote_task adapter broken must implement submit and query");
    });

    test("rejects duplicate adapter IDs", () => {
        expect(() => assertMediaAdapterRegistry([fakeImageAdapter, fakeImageAdapter])).toThrow("duplicate media adapter: fake.image");
    });

    test("returns a registered adapter by the resolved adapter ID", () => {
        registerMediaAdapters([fakeImageAdapter]);
        expect(getMediaAdapter("fake.image")).toBe(fakeImageAdapter);
    });

    test("returns undefined for null and unknown adapter IDs", () => {
        registerMediaAdapters([fakeImageAdapter]);
        expect(getMediaAdapter(null)).toBeUndefined();
        expect(getMediaAdapter("missing")).toBeUndefined();
    });
});
