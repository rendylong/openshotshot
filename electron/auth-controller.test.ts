import { describe, expect, test, vi } from "vitest";
import type { DesktopAccountSnapshot } from "../web/src/lib/desktop/auth-types";
import { AuthController, type ShotshotAuthCloud } from "./auth-controller";
import { DesktopAuthCallbackRouter } from "./auth-deep-link";

const NOW = Date.parse("2026-09-05T02:00:00.000Z");
const STATE = "desktop_state_with_sufficient_entropy_123";
const REQUEST_ID = "00000000-0000-4000-8000-000000000123";

function snapshot(overrides: Partial<DesktopAccountSnapshot> = {}): DesktopAccountSnapshot {
    return {
        account: { subjectId: "subject-1", email: "user@example.com", displayName: "User", avatarUrl: null },
        subscription: { plan: "pro", status: "active", currentPeriodEndsAt: null, cancelAtPeriodEnd: false },
        usage: { balance: 900, usedUnits: 100, periodStart: "2026-09-01", periodEnd: "2026-10-01" },
        entitlements: [{ code: "managed-models", state: "active", limitValue: 1000, validUntil: null }],
        fetchedAt: "2026-09-05T02:00:00.000Z",
        ...overrides,
    };
}

function harness(
    now: () => number = () => NOW,
    createSecrets: () => { codeVerifier: string; codeChallenge: string; state: string; nonce: string } = () => ({
        codeVerifier: "verifier",
        codeChallenge: "challenge",
        state: STATE,
        nonce: "nonce",
    }),
) {
    const callbacks = new DesktopAuthCallbackRouter();
    let requestSequence = 0;
    const cloud: ShotshotAuthCloud = {
        startDesktopAuth: vi.fn(async ({ state }) => {
            requestSequence += 1;
            const requestId = requestSequence === 1 ? REQUEST_ID : "00000000-0000-4000-8000-000000000124";
            return {
                requestId,
                authorizationUrl: `https://shotshot.ai/auth/desktop?request_id=${requestId}&state=${state}`,
                expiresAt: "2026-09-05T02:05:00.000Z",
            };
        }),
        exchangeDesktopGrant: vi.fn(async () => ({ subjectId: "subject-1", deviceId: "device-1" })),
        restoreSession: vi.fn(async () => false),
        getAccountSnapshot: vi.fn(async () => snapshot()),
        logout: vi.fn(async () => undefined),
    };
    const openExternal = vi.fn(async () => undefined);
    const controller = new AuthController({
        cloud,
        callbacks,
        openExternal,
        device: { name: "Studio Mac", platform: "darwin" },
        webOrigin: "https://shotshot.ai",
        now,
        createSecrets,
    });
    return { controller, callbacks, cloud, openExternal };
}

describe("desktop auth controller", () => {
    test("restores a valid session into a ready account snapshot", async () => {
        const value = harness();
        vi.mocked(value.cloud.restoreSession).mockResolvedValueOnce(true);

        await value.controller.restore();

        expect(value.controller.getState()).toMatchObject({ state: "ready", snapshot: { account: { subjectId: "subject-1" } } });
    });

    test("keeps a missing or authoritatively revoked restore signed out", async () => {
        const value = harness();
        await value.controller.restore();
        expect(value.controller.getState()).toEqual({ state: "signed-out" });
    });

    test("opens one exact Web authorization URL for concurrent sign-in commands", async () => {
        const value = harness();

        await Promise.all([value.controller.signIn(), value.controller.signIn(), value.controller.signIn()]);

        expect(value.cloud.startDesktopAuth).toHaveBeenCalledTimes(1);
        expect(value.openExternal).toHaveBeenCalledOnce();
        await value.controller.signIn();
        expect(value.openExternal).toHaveBeenCalledOnce();
    });

    test("retries browser sign-in with fresh PKCE state and ignores the superseded callback", async () => {
        const retryState = `${STATE}_retry`;
        const secrets = [
            { codeVerifier: "verifier-1", codeChallenge: "challenge-1", state: STATE, nonce: "nonce-1" },
            { codeVerifier: "verifier-2", codeChallenge: "challenge-2", state: retryState, nonce: "nonce-2" },
        ];
        const value = harness(() => NOW, () => secrets.shift()!);

        await value.controller.signIn();
        await value.controller.retrySignIn();

        expect(value.cloud.startDesktopAuth).toHaveBeenCalledTimes(2);
        expect(value.openExternal).toHaveBeenCalledTimes(2);
        expect(value.openExternal).toHaveBeenLastCalledWith(expect.stringContaining(`state=${retryState}`));

        await value.controller.acceptCallback({ code: "superseded-grant", state: STATE });
        expect(value.cloud.exchangeDesktopGrant).not.toHaveBeenCalled();
        expect(value.controller.getState()).toEqual({ state: "signing-in" });

        await value.controller.acceptCallback({ code: "fresh-grant", state: retryState });
        expect(value.cloud.exchangeDesktopGrant).toHaveBeenCalledWith({
            code: "fresh-grant",
            codeVerifier: "verifier-2",
            state: retryState,
        });
        expect(value.controller.getState()).toMatchObject({ state: "ready" });
    });

    test("coalesces rapid retry commands into one fresh browser attempt", async () => {
        const value = harness();
        await value.controller.signIn();

        await Promise.all([value.controller.retrySignIn(), value.controller.retrySignIn()]);

        expect(value.cloud.startDesktopAuth).toHaveBeenCalledTimes(2);
        expect(value.openExternal).toHaveBeenCalledTimes(2);
    });

    test("cancels browser sign-in locally and ignores its late callback", async () => {
        const value = harness();
        await value.controller.signIn();

        await value.controller.cancelSignIn();
        await value.controller.acceptCallback({ code: "late-grant", state: STATE });

        expect(value.cloud.exchangeDesktopGrant).not.toHaveBeenCalled();
        expect(value.controller.getState()).toEqual({ state: "signed-out" });
    });

    test("canceling a pending browser start prevents it from opening later", async () => {
        let resolveStart!: (value: {
            requestId: string;
            authorizationUrl: string;
            expiresAt: string;
        }) => void;
        const value = harness();
        vi.mocked(value.cloud.startDesktopAuth).mockReturnValueOnce(new Promise((resolve) => { resolveStart = resolve; }));

        const pending = value.controller.signIn();
        await value.controller.cancelSignIn();
        resolveStart({
            requestId: REQUEST_ID,
            authorizationUrl: `https://shotshot.ai/auth/desktop?request_id=${REQUEST_ID}&state=${STATE}`,
            expiresAt: "2026-09-05T02:05:00.000Z",
        });
        await pending;

        expect(value.openExternal).not.toHaveBeenCalled();
        expect(value.controller.getState()).toEqual({ state: "signed-out" });
    });

    test("does not retry browser sign-in from a ready account", async () => {
        const value = harness();
        await value.controller.signIn();
        await value.controller.acceptCallback({ code: "grant-code", state: STATE });

        await value.controller.retrySignIn();

        expect(value.cloud.startDesktopAuth).toHaveBeenCalledOnce();
        expect(value.controller.getState()).toMatchObject({ state: "ready" });
    });

    test("does not cancel a ready account session", async () => {
        const value = harness();
        await value.controller.signIn();
        await value.controller.acceptCallback({ code: "grant-code", state: STATE });

        await value.controller.cancelSignIn();

        expect(value.controller.getState()).toMatchObject({ state: "ready" });
    });

    test("rejects an authorization URL outside the trusted Web origin", async () => {
        const value = harness();
        vi.mocked(value.cloud.startDesktopAuth).mockResolvedValueOnce({
            requestId: REQUEST_ID,
            authorizationUrl: `https://evil.example/auth/desktop?request_id=${REQUEST_ID}&state=${STATE}`,
            expiresAt: "2026-09-05T02:05:00.000Z",
        });

        await value.controller.signIn();

        expect(value.openExternal).not.toHaveBeenCalled();
        expect(value.controller.getState()).toEqual({ state: "error", code: "auth_start_failed" });
    });

    test("exchanges a matching callback once and publishes the account", async () => {
        const value = harness();
        await value.controller.signIn();

        await value.controller.acceptCallback({ code: "grant-code", state: STATE });
        await value.controller.acceptCallback({ code: "grant-code", state: STATE });

        expect(value.cloud.exchangeDesktopGrant).toHaveBeenCalledOnce();
        expect(value.controller.getState()).toMatchObject({ state: "ready" });
    });

    test("accepts an exact localhost authorization URL in development", async () => {
        const value = harness();
        value.controller.dispose();
        const callbacks = new DesktopAuthCallbackRouter();
        const controller = new AuthController({
            cloud: {
                ...value.cloud,
                startDesktopAuth: vi.fn(async () => ({
                    requestId: REQUEST_ID,
                    authorizationUrl: `http://localhost:4321/auth/desktop?request_id=${REQUEST_ID}&state=${STATE}`,
                    expiresAt: "2026-09-05T02:05:00.000Z",
                })),
            },
            callbacks,
            openExternal: value.openExternal,
            device: { name: "Studio Mac", platform: "darwin" },
            webOrigin: "http://localhost:4321",
            now: () => NOW,
            createSecrets: () => ({ codeVerifier: "verifier", codeChallenge: "challenge", state: STATE, nonce: "nonce" }),
        });

        await controller.signIn();

        expect(value.openExternal).toHaveBeenCalledOnce();
    });

    test("rejects a wrong-state callback before exchange", async () => {
        const value = harness();
        await value.controller.signIn();

        await value.controller.acceptCallback({ code: "grant-code", state: `${STATE}x` });

        expect(value.cloud.exchangeDesktopGrant).not.toHaveBeenCalled();
        expect(value.controller.getState()).toEqual({ state: "error", code: "auth_callback_invalid" });
    });

    test("rejects an expired attempt before exchange", async () => {
        let currentTime = NOW;
        const value = harness(() => currentTime);
        vi.mocked(value.cloud.startDesktopAuth).mockResolvedValueOnce({
            requestId: REQUEST_ID,
            authorizationUrl: `https://shotshot.ai/auth/desktop?request_id=${REQUEST_ID}&state=${STATE}`,
            expiresAt: "2026-09-05T02:00:01.000Z",
        });
        await value.controller.signIn();
        currentTime += 2_000;

        await value.controller.acceptCallback({ code: "grant-code", state: STATE });

        expect(value.cloud.exchangeDesktopGrant).not.toHaveBeenCalled();
        expect(value.controller.getState()).toEqual({ state: "error", code: "auth_expired" });
    });

    test("marks a partial account snapshot stale", async () => {
        const value = harness();
        vi.mocked(value.cloud.restoreSession).mockResolvedValueOnce(true);
        vi.mocked(value.cloud.getAccountSnapshot).mockResolvedValueOnce(snapshot({ staleSections: ["usage"] }));

        await value.controller.restore();

        expect(value.controller.getState()).toMatchObject({ state: "stale", code: "account_refresh_failed" });
    });

    test("signs out locally even when remote logout fails", async () => {
        const value = harness();
        vi.mocked(value.cloud.logout).mockRejectedValueOnce(new Error("offline"));

        await value.controller.signOut();

        expect(value.controller.getState()).toEqual({ state: "signed-out" });
    });

    test("detaches from deep links on dispose", async () => {
        const value = harness();
        await value.controller.signIn();
        value.controller.dispose();

        value.callbacks.handleUrl(`ai.shotshot.desktop:/oauth/callback?code=grant-code&state=${STATE}`);
        await Promise.resolve();

        expect(value.cloud.exchangeDesktopGrant).not.toHaveBeenCalled();
    });
});
