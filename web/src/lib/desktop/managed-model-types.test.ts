import { describe, expect, test, vi } from "vitest";
import { createManagedModelsBridge, MANAGED_MODEL_CHANNELS } from "./managed-model-types";

describe("managed models preload bridge", () => {
    test("never accepts credential-shaped main-process payloads", async () => {
        const bridge = createManagedModelsBridge({ invoke: vi.fn(async () => ({ status: 200, gatewayToken: "nope" })) });
        await expect(bridge.fetch({ id: "1", path: "/v1/responses", method: "POST", timeoutClass: "text" })).rejects.toThrow("credential_shaped_managed_payload");
    });

    test("forwards only narrow list, request, and abort commands", async () => {
        const invoke = vi.fn(async (channel: string) => channel === MANAGED_MODEL_CHANNELS.listModels ? [] : undefined);
        const bridge = createManagedModelsBridge({ invoke });
        await bridge.listModels();
        await bridge.abort("request-1");
        expect(invoke.mock.calls.map((call) => call[0])).toEqual([MANAGED_MODEL_CHANNELS.listModels, MANAGED_MODEL_CHANNELS.abort]);
    });

    test("carries the managed model spec axes through the list bridge", async () => {
        const spec = { aspectRatios: ["16:9"], resolutions: ["1K", "2K"], qualities: [] };
        const invoke = vi.fn(async () => [{ id: "managed-image", name: "Managed Image", capability: "image", execution: "direct", spec }]);
        const bridge = createManagedModelsBridge({ invoke });

        await expect(bridge.listModels()).resolves.toEqual([{ id: "managed-image", name: "Managed Image", capability: "image", execution: "direct", spec }]);
    });

    test("accepts a descriptor whose model declares no spec", async () => {
        const invoke = vi.fn(async () => [{ id: "managed-image", name: "Managed Image", capability: "image", execution: "direct" }]);
        const bridge = createManagedModelsBridge({ invoke });

        const models = await bridge.listModels();
        expect(models[0]).not.toHaveProperty("spec");
    });

    test("carries canonical image input modalities through the list bridge", async () => {
        const invoke = vi.fn(async () => [{ id: "minimax-m3", name: "MiniMax M3", capability: "text", execution: "direct", input_modalities: ["text", "image"] }]);
        const bridge = createManagedModelsBridge({ invoke });

        await expect(bridge.listModels()).resolves.toEqual([
            { id: "minimax-m3", name: "MiniMax M3", capability: "text", execution: "direct", input_modalities: ["text", "image"] },
        ]);
    });

    test("rejects descriptors carrying non-canonical or misplaced input modalities", async () => {
        for (const payload of [
            [{ id: "minimax-m3", name: "MiniMax M3", capability: "text", execution: "direct", input_modalities: ["image"] }],
            [{ id: "minimax-m3", name: "MiniMax M3", capability: "text", execution: "direct", input_modalities: ["text", "image", "text"] }],
            [{ id: "managed-image", name: "Managed Image", capability: "image", execution: "direct", input_modalities: ["text"] }],
        ]) {
            const bridge = createManagedModelsBridge({ invoke: vi.fn(async () => payload) });
            await expect(bridge.listModels()).rejects.toThrow("invalid_managed_models_payload");
        }
    });
});
