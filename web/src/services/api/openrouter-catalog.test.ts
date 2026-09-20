import { afterEach, describe, expect, it, vi } from "vitest";

import { createModelChannel } from "@/stores/use-config-store";
import { fetchOpenRouterCatalog, parseOpenRouterCatalog } from "./openrouter-catalog";

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("OpenRouter model catalog", () => {
    it("uses output modality and preserves unknown tool support", () => {
        const rows = parseOpenRouterCatalog({ data: [
            {
                id: "a/vision",
                name: "Vision",
                architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
                supported_parameters: ["tools"],
                ignored: "raw provider data",
            },
            { id: "b/paint", architecture: { input_modalities: ["text"], output_modalities: ["image"] } },
            { id: "c/text", architecture: { output_modalities: ["text"] } },
            { id: "d/unknown" },
        ] });

        expect(rows.map((entry) => entry.id)).toEqual(["a/vision", "c/text"]);
        expect(rows[0]).toEqual({
            id: "a/vision",
            displayName: "Vision",
            provider: "openrouter",
            category: "text",
            metadata: {
                version: 1,
                source: "provider_models",
                inputModalities: ["text", "image"],
                outputModalities: ["text"],
                supportsTools: true,
                providerStatus: "unknown",
            },
            availability: "ready",
        });
        expect(rows[1].displayName).toBe("c/text");
        expect(rows[1].metadata.inputModalities).toBeUndefined();
        expect(rows[1].metadata.supportsTools).toBeUndefined();
        expect(rows[1].metadata.providerStatus).toBe("unknown");
        expect(rows[0]).not.toHaveProperty("ignored");
    });

    it("requests the provider models endpoint with a bearer token and abort signal", async () => {
        const channel = createModelChannel({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1/", apiKey: "sk-secret" });
        const signal = new AbortController().signal;
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({ data: [{ id: "vendor/model", architecture: { output_modalities: ["text"] } }] }),
        } as Response));
        vi.stubGlobal("fetch", fetchMock);

        await expect(fetchOpenRouterCatalog(channel, signal)).resolves.toMatchObject([{ id: "vendor/model" }]);
        expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models?output_modalities=text", {
            headers: { Authorization: "Bearer sk-secret" },
            signal,
        });
    });

    it.each([401, 429])("reports HTTP %s without exposing response or credential data", async (status) => {
        const channel = createModelChannel({ provider: "openrouter", apiKey: "sk-private" });
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status, json: async () => ({ error: "private upstream body" }) } as Response)));

        const error = await fetchOpenRouterCatalog(channel).catch((caught: unknown) => caught);

        expect(error).toEqual(new Error(`catalog_http_${status}`));
        expect(String(error)).not.toContain("sk-private");
        expect(String(error)).not.toContain("private upstream body");
    });
});
