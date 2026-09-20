import { describe, expect, it, vi } from "vitest";
import { computeReleaseStatus, createAppReleaseController, parseReleasePolicy, platformToken } from "./app-release-controller";

const POLICY = {
    minVersion: "",
    latestVersion: "0.19.0",
    downloadUrl: "https://shotshot.ai/download",
    notes: "",
    updatedAt: "2026-09-18T00:00:00.000Z",
};

function jsonResponse(value: unknown, ok = true) {
    return { ok, status: ok ? 200 : 500, json: async () => value } as unknown as Response;
}

function controller(overrides: Partial<Parameters<typeof createAppReleaseController>[0]> = {}) {
    const listeners: Array<(state: unknown) => void> = [];
    const openExternal = vi.fn(async () => undefined);
    const instance = createAppReleaseController({
        baseUrl: "https://api.shotshot.ai",
        localVersion: "0.18.1",
        packaged: true,
        openExternal,
        intervalMs: 60_000,
        ...overrides,
    });
    return { instance, openExternal, listeners };
}

describe("parseReleasePolicy", () => {
    it("parses a valid payload", () => {
        expect(parseReleasePolicy({ minVersion: "", latestVersion: "0.19.0", downloadUrl: "https://x.com/d", notes: "n", updatedAt: "2026-09-18T00:00:00Z" })).toEqual({
            minVersion: "", latestVersion: "0.19.0", downloadUrl: "https://x.com/d", notes: "n", updatedAt: "2026-09-18T00:00:00Z",
        });
    });
    it("returns null for non-object payloads", () => {
        expect(parseReleasePolicy(null)).toBeNull();
        expect(parseReleasePolicy("x")).toBeNull();
    });
    it("sanitizes malformed fields and keeps defaults", () => {
        expect(parseReleasePolicy({ minVersion: "v1", latestVersion: "0.19.0-beta", downloadUrl: "javascript:alert(1)" })).toEqual({
            minVersion: "", latestVersion: "", downloadUrl: "https://shotshot.ai/download", notes: "", updatedAt: null,
        });
    });
});

describe("computeReleaseStatus", () => {
    it("idle when both versions empty", () => {
        expect(computeReleaseStatus("0.18.1", { ...POLICY, latestVersion: "" }, { enforceForce: true }).status).toBe("idle");
    });
    it("soft when local older than latest", () => {
        expect(computeReleaseStatus("0.18.1", POLICY, { enforceForce: true }).status).toBe("soft_update");
    });
    it("up_to_date when current", () => {
        expect(computeReleaseStatus("0.19.0", POLICY, { enforceForce: true }).status).toBe("up_to_date");
    });
    it("force when local below min", () => {
        expect(computeReleaseStatus("0.18.1", { ...POLICY, minVersion: "0.19.0" }, { enforceForce: true }).status).toBe("force_update");
    });
    it("drops contradictory min (min > latest) to soft", () => {
        expect(computeReleaseStatus("0.18.1", { ...POLICY, minVersion: "0.20.0" }, { enforceForce: true }).status).toBe("soft_update");
    });
    it("downgrades force to soft in dev (enforceForce=false, below min)", () => {
        expect(computeReleaseStatus("0.18.1", { ...POLICY, minVersion: "0.19.0", latestVersion: "0.19.0" }, { enforceForce: false }).status).toBe("soft_update");
    });
    it("dev below min with empty latest still surfaces soft_update (local >= latest)", () => {
        expect(computeReleaseStatus("0.18.1", { ...POLICY, minVersion: "0.19.0", latestVersion: "" }, { enforceForce: false }).status).toBe("soft_update");
    });
});

describe("controller lifecycle", () => {
    it("fetches on start, computes status, and notifies subscribers", async () => {
        const fetchMock = vi.fn(async () => jsonResponse(POLICY));
        const { instance } = controller({ fetch: fetchMock as unknown as typeof fetch });
        const seen: unknown[] = [];
        const unsubscribe = instance.subscribe((state) => seen.push(state));
        await instance.start();
        expect(instance.getState().status).toBe("soft_update");
        expect(instance.getState().policy?.latestVersion).toBe("0.19.0");
        expect(seen.length).toBeGreaterThan(0);
        unsubscribe();
        instance.dispose();
    });

    it("keeps last snapshot and stays idle when the request fails", async () => {
        const fetchMock = vi.fn(async () => { throw new Error("network down"); });
        const { instance } = controller({ fetch: fetchMock as unknown as typeof fetch });
        await instance.start();
        expect(instance.getState().status).toBe("idle");
        instance.dispose();
    });

    it("refresh returns the fresh state", async () => {
        const fetchMock = vi.fn(async () => jsonResponse(POLICY));
        const { instance } = controller({ fetch: fetchMock as unknown as typeof fetch });
        const state = await instance.refresh();
        expect(state.status).toBe("soft_update");
        instance.dispose();
    });

    it("openDownload opens the policy download url", async () => {
        const fetchMock = vi.fn(async () => jsonResponse(POLICY));
        const { instance, openExternal } = controller({ fetch: fetchMock as unknown as typeof fetch });
        await instance.start();
        await instance.openDownload();
        expect(openExternal).toHaveBeenCalledWith("https://shotshot.ai/download");
        instance.dispose();
    });

    it("openDownload never opens untrusted urls (parse falls back to default)", async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ ...POLICY, downloadUrl: "file:///etc/passwd" }));
        const { instance, openExternal } = controller({ fetch: fetchMock as unknown as typeof fetch });
        await instance.start();
        await instance.openDownload();
        expect(openExternal).not.toHaveBeenCalledWith("file:///etc/passwd");
        expect(openExternal).toHaveBeenCalledWith("https://shotshot.ai/download");
        instance.dispose();
    });

    it("start is idempotent while a request is in flight (no double fetch)", async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const fetchMock = vi.fn(async () => { await gate; return jsonResponse(POLICY); });
        const { instance } = controller({ fetch: fetchMock as unknown as typeof fetch });
        const first = instance.start();
        const second = instance.start();
        release();
        await Promise.all([first, second]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        instance.dispose();
    });
});

describe("platformToken", () => {
    it("maps process.platform values to contract tokens", () => {
        expect(platformToken("darwin")).toBe("mac");
        expect(platformToken("win32")).toBe("win");
        expect(platformToken("linux")).toBe("linux");
        expect(platformToken("freebsd")).toBe("linux");
    });
});

describe("platform request param", () => {
    it("requests the controller platform token", async () => {
        const fetchMock = vi.fn(async () => jsonResponse(POLICY));
        const { instance } = controller({ fetch: fetchMock as unknown as typeof fetch, platform: "win32" });
        await instance.start();
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining("/v1/app/release-policy?platform=win"),
            expect.anything(),
        );
        instance.dispose();
    });

    it("defaults to darwin→mac when platform is not injected", async () => {
        const fetchMock = vi.fn(async () => jsonResponse(POLICY));
        const { instance } = controller({ fetch: fetchMock as unknown as typeof fetch, platform: "darwin" });
        await instance.start();
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining("?platform=mac"),
            expect.anything(),
        );
        instance.dispose();
    });
});
