import { describe, expect, it } from "vitest";

import { createModelChannel, normalizeAiConfig } from "@/stores/use-config-store";
import type { CatalogEntry } from "./model-catalog-types";
import { canUseAsAgent, mergeCatalogSelection } from "./channel-model-metadata";

const entry = (values: Partial<CatalogEntry> & Pick<CatalogEntry, "id" | "category">): CatalogEntry => ({
    displayName: values.id,
    provider: "openrouter",
    metadata: {
        version: 1,
        source: "provider_models",
        providerStatus: "active",
        supportsTools: true,
        ...values.metadata,
    },
    availability: "ready",
    ...values,
});

describe("channel catalog metadata", () => {
    it("keeps unknown catalog versions and existing scripts during selection", () => {
        const channel = createModelChannel({ provider: "openrouter", models: [{
            name: "vendor/model:free", capability: "text", script: "return 1;",
            catalog: { version: 9, source: "provider_models", providerStatus: "unknown" },
        }] });
        const models = mergeCatalogSelection(channel, ["vendor/model:free"], []);
        expect(models[0]).toMatchObject({ script: "return 1;", catalog: { version: 9 } });
        expect(canUseAsAgent(channel, models[0])).toBe(false);
        expect(normalizeAiConfig({ channels: [{ ...channel, models }] }).channels[0].models).toEqual(models);
    });

    it("updates known metadata while retaining user configuration", () => {
        const channel = createModelChannel({ provider: "openrouter", models: [{
            name: "vendor/model", capability: "text", script: "return 1;", supportsImageInput: false,
            catalog: { version: 1, source: "provider_models", providerStatus: "unknown" },
        }] });
        const models = mergeCatalogSelection(channel, ["vendor/model"], [entry({
            id: "vendor/model",
            category: "text",
            metadata: { version: 1, source: "provider_models", providerStatus: "active", supportsTools: true, inputModalities: ["text", "image"] },
        })]);

        expect(models[0]).toMatchObject({ name: "vendor/model", capability: "text", script: "return 1;", supportsImageInput: true, catalog: { version: 1, supportsTools: true } });
        expect(canUseAsAgent(channel, models[0])).toBe(true);
    });

    it("derives new model capability and does not turn missing metadata into false", () => {
        const channel = createModelChannel({ provider: "openrouter", models: [] });
        const [image, text] = mergeCatalogSelection(channel, ["vendor/image", "vendor/text"], [
            entry({ id: "vendor/image", category: "image-to-image", metadata: { version: 1, source: "provider_models", providerStatus: "active", inputModalities: ["text", "image"] } }),
            entry({ id: "vendor/text", category: "text", metadata: { version: 1, source: "provider_models", providerStatus: "active" } }),
        ]);

        expect(image).toMatchObject({ name: "vendor/image", capability: "image", supportsImageInput: true });
        expect(text).not.toHaveProperty("supportsImageInput");
        expect(text.catalog).not.toHaveProperty("supportsTools");
    });

    it("keeps model ids with slashes and colons unchanged", () => {
        const channel = createModelChannel({ provider: "openrouter", models: [] });
        expect(mergeCatalogSelection(channel, ["vendor/model:free"], [entry({ id: "vendor/model:free", category: "text" })])[0].name).toBe("vendor/model:free");
    });

    it("preserves unknown metadata on a newly selected model without enabling Agent use", () => {
        const channel = createModelChannel({ provider: "openrouter", models: [] });
        const [model] = mergeCatalogSelection(channel, ["vendor/future"], [entry({
            id: "vendor/future",
            category: "text",
            metadata: { version: 9, source: "provider_models", providerStatus: "unknown", supportsTools: true },
        })]);

        expect(model).toMatchObject({ name: "vendor/future", catalog: { version: 9, supportsTools: true } });
        expect(canUseAsAgent(channel, model)).toBe(false);
    });

    it("keeps an explicit text-only input list from becoming image-capable during normalization", () => {
        const channel = createModelChannel({ provider: "openrouter", models: [] });
        const models = mergeCatalogSelection(channel, ["vendor/vision-model"], [entry({
            id: "vendor/vision-model",
            category: "text",
            metadata: { version: 1, source: "provider_models", providerStatus: "active", inputModalities: ["text"] },
        })]);

        expect(models[0].supportsImageInput).toBe(false);
        expect(normalizeAiConfig({ channels: [{ ...channel, models }] }).channels[0].models[0].supportsImageInput).toBe(false);
    });
});

it("retains fal schema assessment and parameters when catalog refresh omits schema", () => {
    const catalog = { version: 1, source: "provider_models" as const, providerStatus: "active" as const, falSchema: { profileId: "fal-ai/flux-2-pro", profileVersion: 1 as const, status: "incompatible" as const, diagnostics: ["input.prompt: type changed"] } };
    const channel = createModelChannel({ provider: "fal", models: [{ name: "fal-ai/flux-2-pro", capability: "image", script: "keep-me", catalog }] });
    const [model] = mergeCatalogSelection(channel, ["fal-ai/flux-2-pro"], [{ id: "fal-ai/flux-2-pro", displayName: "FLUX", provider: "fal", category: "text-to-image", metadata: { version: 1, source: "provider_models", providerStatus: "active" }, availability: "ready" }]);
    expect(model).toMatchObject({ capability: "image", script: "keep-me", catalog: { falSchema: catalog.falSchema } });
    expect(canUseAsAgent(channel, { ...model, capability: "text" })).toBe(false);
});
