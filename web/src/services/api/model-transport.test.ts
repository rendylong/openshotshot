import { afterEach, describe, expect, test, vi } from "vitest";

import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { invalidateManagedCatalog, resetManagedCatalogForTests } from "@/lib/desktop/managed-catalog-cache";
import { useUserStore } from "@/stores/use-user-store";

import {
    ManagedModelUnavailableError,
    managedErrorStatus,
    requestModel,
    resetManagedUsageRefreshForTests,
    resolveManagedModelForCapability,
} from "./model-transport";

function managedConfig(overrides: Partial<AiConfig> = {}): AiConfig {
    return {
        ...defaultConfig,
        credentialMode: "shotshot",
        credentialModes: { agent: "shotshot", text: "shotshot", image: "shotshot", video: "shotshot", audio: "shotshot" },
        managedModels: { ...defaultConfig.managedModels, image: "managed-image" },
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    resetManagedUsageRefreshForTests();
    resetManagedCatalogForTests();
    useUserStore.setState({ account: { state: "signed-out" }, initialized: false });
});

describe("credential-aware model transport", () => {
    test("keeps the existing BYOK request path byte-for-byte owned by its caller", async () => {
        const byok = vi.fn(async () => ({ data: { ok: true } }));
        const managedFetch = vi.fn();
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(), fetch: managedFetch, abort: vi.fn() } };

        await expect(requestModel({ config: defaultConfig, timeoutClass: "image", path: "/v1/images/generations", body: { model: "gpt-image-2" }, responseType: "json", byok })).resolves.toEqual({ ok: true });

        expect(byok).toHaveBeenCalledOnce();
        expect(managedFetch).not.toHaveBeenCalled();
    });

    test("attaches the gateway HTTP status to non-2xx failures", async () => {
        const fetch = vi.fn(async (request) => ({ id: request.id, status: 503, statusText: "Service Unavailable", headers: { "content-type": "application/json" }, body: { kind: "text" as const, value: '{"error":"media_unavailable"}' } }));
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(), fetch, abort: vi.fn() } };

        const outcome = requestModel({ config: managedConfig(), timeoutClass: "image", path: "/v1/media/tasks/task-1", method: "GET", responseType: "json", byok: vi.fn() });
        await expect(outcome).rejects.toThrow("media_unavailable");
        const error = await outcome.catch((value: unknown) => value);
        expect(managedErrorStatus(error)).toBe(503);
        expect(managedErrorStatus(new Error("plain"))).toBeUndefined();
    });

    test("never reads BYOK credentials in Shotshot mode and sends only a relative managed request", async () => {
        const fetch = vi.fn(async (request) => ({ id: request.id, status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: { kind: "text" as const, value: '{"data":[]}' } }));
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(), fetch, abort: vi.fn() } };
        const config = new Proxy(managedConfig(), {
            get(target, property, receiver) {
                if (property === "apiKey" || property === "baseUrl" || property === "channels") throw new Error(`credential read: ${String(property)}`);
                return Reflect.get(target, property, receiver);
            },
        });

        await expect(requestModel({ config, timeoutClass: "image", path: "/v1/images/generations", body: { model: "managed-image", prompt: "cat" }, responseType: "json", byok: vi.fn() })).resolves.toEqual({ data: [] });

        expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ path: "/v1/images/generations", method: "POST", timeoutClass: "image" }));
        expect(JSON.parse(fetch.mock.calls[0]![0].body.value)).toMatchObject({ model: "managed-image", prompt: "cat" });
    });

    test("fails before network access when Shotshot mode runs outside desktop", async () => {
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "web" };
        const byok = vi.fn();
        await expect(requestModel({ config: managedConfig(), timeoutClass: "text", path: "/v1/responses", body: { model: "managed-text" }, responseType: "json", byok })).rejects.toThrow("managed_desktop_required");
        expect(byok).not.toHaveBeenCalled();
    });

    test("accepts only a selected model from the signed-in catalog", async () => {
        const listModels = vi.fn(async () => [
            { id: "managed-image", name: "Image", capability: "image" as const, execution: "direct" as const },
            { id: "managed-text", name: "Text", capability: "text" as const, execution: "direct" as const },
        ]);
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels, fetch: vi.fn(), abort: vi.fn() } };

        await expect(resolveManagedModelForCapability(managedConfig(), "image")).resolves.toMatchObject({ id: "managed-image" });
        await expect(resolveManagedModelForCapability(managedConfig({ managedModels: { ...defaultConfig.managedModels, image: "not-in-catalog" } }), "image")).resolves.toMatchObject({ id: "managed-image" });
    });

    test("falls back to the first catalog model when the stored preference is stale", async () => {
        const listModels = vi.fn(async () => [
            { id: "managed-image", name: "Image", capability: "image" as const, execution: "direct" as const },
        ]);
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels, fetch: vi.fn(), abort: vi.fn() } };

        await expect(resolveManagedModelForCapability(managedConfig({ managedModels: { ...defaultConfig.managedModels, image: "not-in-catalog" } }), "image")).resolves.toMatchObject({ id: "managed-image" });
        await expect(resolveManagedModelForCapability(managedConfig({ managedModels: defaultConfig.managedModels }), "image")).resolves.toMatchObject({ id: "managed-image" });
    });

    test("throws a typed capability error when the catalog has no such model", async () => {
        const listModels = vi.fn(async () => [{ id: "managed-image", name: "Image", capability: "image" as const, execution: "direct" as const }]);
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels, fetch: vi.fn(), abort: vi.fn() } };

        const error = await resolveManagedModelForCapability(managedConfig(), "video").catch((value: unknown) => value);
        expect(error).toBeInstanceOf(ManagedModelUnavailableError);
        expect((error as ManagedModelUnavailableError).capability).toBe("video");
    });

    test("serves the stale snapshot when refresh fails but cached models exist", async () => {
        const listModels = vi.fn()
            .mockResolvedValueOnce([{ id: "managed-image", name: "Image", capability: "image" as const, execution: "direct" as const }])
            .mockRejectedValueOnce(new Error("network down"));
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels, fetch: vi.fn(), abort: vi.fn() } };

        await resolveManagedModelForCapability(managedConfig(), "image");
        invalidateManagedCatalog();
        await expect(resolveManagedModelForCapability(managedConfig(), "image")).resolves.toMatchObject({ id: "managed-image" });
    });

    test("propagates abort and throttles account refresh to once per minute", async () => {
        let finish: ((value: unknown) => void) | undefined;
        const fetch = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
        const abort = vi.fn(async () => undefined);
        const refresh = vi.fn(async () => undefined);
        useUserStore.setState({ refresh });
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(), fetch: fetch as never, abort } };
        const controller = new AbortController();
        const pending = requestModel({ config: managedConfig(), timeoutClass: "image", path: "/v1/images/generations", body: { model: "managed-image" }, responseType: "json", signal: controller.signal, byok: vi.fn() });
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
        controller.abort();
        expect(abort).toHaveBeenCalledOnce();
        finish?.({ id: "request", status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: { kind: "text", value: "{}" } });
        await pending;

        fetch.mockResolvedValueOnce({ id: "request-2", status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: { kind: "text", value: "{}" } });
        await requestModel({ config: managedConfig(), timeoutClass: "image", path: "/v1/images/generations", body: { model: "managed-image" }, responseType: "json", byok: vi.fn() });
        expect(refresh).toHaveBeenCalledOnce();
    });
});
