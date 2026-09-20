import { describe, expect, test, vi } from "vitest";

import type { AuthSessionStore, StoredAuthSession } from "./auth-session-store";
import { ShotshotCloudClient, ShotshotCloudClientError } from "./shotshot-cloud-client";

const API_URL = "https://api.shotshot.ai";
const NOW = new Date("2026-09-05T02:00:00.000Z");

function json(value: unknown, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function memoryStore(initial: StoredAuthSession | null = null) {
    let value = initial;
    const store: AuthSessionStore = {
        load: vi.fn(async () => value),
        save: vi.fn(async (next) => { value = next; }),
        clear: vi.fn(async () => { value = null; }),
    };
    return store;
}

function exchangeResponse(overrides: Record<string, unknown> = {}) {
    return {
        subject_id: "subject-1",
        device_id: "device-1",
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        access_token_expires_at: "2026-09-05T03:00:00.000Z",
        refresh_token_expires_at: "2026-10-05T03:00:00.000Z",
        ...overrides,
    };
}

function createClient(fetch: typeof globalThis.fetch, store: AuthSessionStore, now: () => Date = () => NOW) {
    return new ShotshotCloudClient({
        baseUrl: API_URL,
        fetch,
        sessionStore: store,
        now,
    });
}

describe("Shotshot cloud desktop client", () => {
    test("uploads asset metadata and bytes to Cloud with desktop auth and hides signed URLs", async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            expect(url.origin).toBe(API_URL);
            if (url.pathname === "/v1/auth/desktop/exchange") return json(exchangeResponse());
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-secret");
            expect(init?.redirect).toBe("error");
            if (url.pathname.endsWith("/content")) {
                expect(new Headers(init?.headers).get("content-type")).toBe("image/png");
                expect([...init?.body as Uint8Array]).toEqual([137, 80, 78, 71]);
            }
            return json({ asset_id: "asset-1", upload_url: "https://storage.example/upload?token=secret" });
        });
        const client = createClient(fetchMock, memoryStore());
        await client.exchangeDesktopGrant({ code: "code", codeVerifier: "verifier", state: "state" });
        expect(await client.requestManagedAsset("/v1/assets/upload", { mime_type: "image/png", byte_size: 4 })).toEqual({ asset_id: "asset-1" });
        expect(await client.requestManagedAsset("/v1/assets/asset-1/content", new Uint8Array([137, 80, 78, 71]), "image/png")).toEqual({ asset_id: "asset-1" });
        expect(await client.requestManagedAsset("/v1/assets/asset-1/complete", { byte_size: 4 })).toEqual({ asset_id: "asset-1" });
        await expect(client.requestManagedAsset("https://other.example/v1/assets/upload", {})).rejects.toThrow();
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    test("refreshes desktop auth on an asset 401 and replays the same binary body", async () => {
        let attempts = 0;
        const bytes = new Uint8Array([1, 2, 3]);
        const controller = new AbortController();
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            if (path.endsWith("/exchange")) return json(exchangeResponse());
            if (path.endsWith("/refresh")) return json(exchangeResponse({ access_token: "refreshed-access" }));
            expect([...init?.body as Uint8Array]).toEqual([...bytes]);
            expect(init?.signal).toBe(controller.signal);
            attempts++;
            if (attempts === 1) return json({ error: "unauthorized" }, 401);
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer refreshed-access");
            return json({ asset_id: "asset-1", status: "uploaded" });
        });
        const client = createClient(fetchMock, memoryStore());
        await client.exchangeDesktopGrant({ code: "code", codeVerifier: "verifier", state: "state" });
        await client.requestManagedAsset("/v1/assets/asset-1/content", bytes, "image/png", controller.signal);
        expect(attempts).toBe(2);
    });

    test("starts browser authorization and exchanges a one-time grant", async () => {
        const store = memoryStore();
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith("/v1/auth/desktop/start")) {
                expect(JSON.parse(String(init?.body))).toEqual({
                    code_challenge: "challenge",
                    state: "state",
                    redirect_uri: "ai.shotshot.desktop:/oauth/callback",
                    device_name: "Studio Mac",
                    platform: "darwin",
                });
                return json({
                    request_id: "request-1",
                    authorization_url: "https://shotshot.ai/auth/desktop?request_id=request-1",
                    expires_at: "2026-09-05T02:35:00.000Z",
                });
            }
            expect(url).toBe(`${API_URL}/v1/auth/desktop/exchange`);
            expect(JSON.parse(String(init?.body))).toEqual({
                code: "grant-code",
                code_verifier: "verifier",
                state: "state",
            });
            return json(exchangeResponse());
        });
        const client = createClient(fetchMock as typeof globalThis.fetch, store);

        await expect(client.startDesktopAuth({
            codeChallenge: "challenge",
            state: "state",
            deviceName: "Studio Mac",
            platform: "darwin",
        })).resolves.toMatchObject({ requestId: "request-1" });
        await expect(client.exchangeDesktopGrant({ code: "grant-code", codeVerifier: "verifier", state: "state" }))
            .resolves.toMatchObject({ subjectId: "subject-1", deviceId: "device-1" });

        expect(store.save).toHaveBeenCalledWith({ refreshToken: "refresh-secret", deviceId: "device-1" });
    });

    test("restores a session by rotating the persisted refresh token", async () => {
        const store = memoryStore({ refreshToken: "old-refresh", deviceId: "device-1" });
        const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
            expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: "old-refresh" });
            return json(exchangeResponse({ refresh_token: "rotated-refresh" }));
        });
        const client = createClient(fetchMock as typeof globalThis.fetch, store);

        await expect(client.restoreSession()).resolves.toBe(true);
        expect(store.save).toHaveBeenCalledWith({ refreshToken: "rotated-refresh", deviceId: "device-1" });
    });

    test("clears a revoked session instead of leaving stale credentials", async () => {
        const store = memoryStore({ refreshToken: "revoked-refresh", deviceId: "device-1" });
        const client = createClient(
            vi.fn(async () => json({ error: "invalid_refresh_token", leaked: "server-secret" }, 400)) as typeof globalThis.fetch,
            store,
        );

        await expect(client.restoreSession()).resolves.toBe(false);
        expect(store.clear).toHaveBeenCalledOnce();
        expect(client.hasSession()).toBe(false);
    });

    test("preserves the encrypted refresh credential on a transient restore failure", async () => {
        const store = memoryStore({ refreshToken: "offline-refresh", deviceId: "device-1" });
        const client = createClient(
            vi.fn(async () => { throw new Error("network unavailable"); }) as typeof globalThis.fetch,
            store,
        );

        await expect(client.restoreSession()).rejects.toMatchObject({ code: "cloud_request_failed" });
        expect(store.clear).not.toHaveBeenCalled();
        await expect(store.load()).resolves.toEqual({
            refreshToken: "offline-refresh",
            deviceId: "device-1",
        });
    });

    test("returns a token-free account, plan, credits, usage, and entitlement snapshot", async () => {
        const store = memoryStore();
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v1/auth/desktop/exchange") return json(exchangeResponse());
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-secret");
            if (path === "/v1/me") return json({
                subject_id: "subject-1",
                email: "creator@example.com",
                display_name: "Creator",
                avatar_url: "https://example.com/avatar.png",
                status: "active",
            });
            if (path === "/v1/subscription") return json({
                subject_id: "subject-1",
                plan_code: "standard",
                status: "active",
                current_period_ends_at: "2026-10-05T00:00:00.000Z",
                cancel_at_period_end: false,
            });
            if (path === "/v1/usage/summary") return json({
                subject_id: "subject-1",
                balance: 1800,
                used_units: 200,
                period_start: "2026-09-01T00:00:00.000Z",
                period_end: "2026-10-01T00:00:00.000Z",
            });
            return json({
                subject_id: "subject-1",
                entitlements: [{ code: "managed-models", state: "active", limit_value: 2000, valid_until: null }],
            });
        });
        const client = createClient(fetchMock as typeof globalThis.fetch, store);
        await client.exchangeDesktopGrant({ code: "code", codeVerifier: "verifier", state: "state" });

        const snapshot = await client.getAccountSnapshot();

        expect(snapshot).toMatchObject({
            account: { subjectId: "subject-1" },
            subscription: { plan: "standard", status: "active" },
            usage: { balance: 1800, usedUnits: 200 },
            entitlements: [{ code: "managed-models", state: "active" }],
        });
        expect(JSON.stringify(snapshot)).not.toMatch(/token|secret|verifier/i);
    });

    test("keeps the last verified section when one account endpoint is transiently unavailable", async () => {
        const store = memoryStore();
        let usageCalls = 0;
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v1/auth/desktop/exchange") return json(exchangeResponse());
            if (path === "/v1/me") return json({
                subject_id: "subject-1",
                email: "creator@example.com",
                display_name: "Creator",
                avatar_url: null,
            });
            if (path === "/v1/subscription") return json({
                subject_id: "subject-1",
                plan_code: "pro",
                status: "active",
                current_period_ends_at: null,
                cancel_at_period_end: false,
            });
            if (path === "/v1/usage/summary") {
                usageCalls += 1;
                return usageCalls === 1
                    ? json({
                        subject_id: "subject-1",
                        balance: 900,
                        used_units: 100,
                        period_start: "2026-09-01T00:00:00.000Z",
                        period_end: "2026-10-01T00:00:00.000Z",
                    })
                    : json({ error: "service_unavailable" }, 503);
            }
            return json({ subject_id: "subject-1", entitlements: [] });
        });
        const client = createClient(fetchMock as typeof globalThis.fetch, store);
        await client.exchangeDesktopGrant({ code: "code", codeVerifier: "verifier", state: "state" });
        await client.getAccountSnapshot();

        await expect(client.getAccountSnapshot()).resolves.toMatchObject({
            usage: { balance: 900, usedUnits: 100 },
            staleSections: ["usage"],
        });
    });

    test("refreshes once after an authenticated 401 and retries with the rotated access token", async () => {
        const store = memoryStore();
        const modelAuthorization: Array<string | null> = [];
        let modelCalls = 0;
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v1/auth/desktop/exchange") return json(exchangeResponse());
            if (path === "/v1/auth/desktop/refresh") {
                return json(exchangeResponse({
                    access_token: "rotated-access",
                    refresh_token: "rotated-refresh",
                }));
            }
            modelCalls += 1;
            modelAuthorization.push(new Headers(init?.headers).get("authorization"));
            if (modelCalls === 1) return json({ error: "unauthorized" }, 401);
            return json({
                subject_id: "subject-1",
                models: [{
                    id: "managed-video",
                    name: "Managed video",
                    capability: "video",
                    execution: "remote_task",
                    input_slots: [{ field: "first_frame", kind: "image", required: true, accept_types: ["image/png"] }],
                    video_specs: [{ resolution: "768p横", orientation: "landscape", quality: "768p", duration: { min: 1, max: 10, default: 5, integer: true } }],
                }],
            });
        });
        const client = createClient(fetchMock as typeof globalThis.fetch, store);
        await client.exchangeDesktopGrant({ code: "code", codeVerifier: "verifier", state: "state" });

        await expect(client.getManagedModels()).resolves.toMatchObject([{ input_slots: [{ field: "first_frame", kind: "image" }], video_specs: [{ resolution: "768p横", duration: { max: 10 } }] }]);
        expect(modelAuthorization).toEqual(["Bearer access-secret", "Bearer rotated-access"]);
        expect(store.save).toHaveBeenLastCalledWith({
            refreshToken: "rotated-refresh",
            deviceId: "device-1",
        });
    });

    test("proceeds with the current token while a background access token refresh is kicked off", async () => {
        const store = memoryStore();
        const modelAuthorization: Array<string | null> = [];
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v1/auth/desktop/exchange") return json(exchangeResponse({
                access_token: "stale-access",
                access_token_expires_at: "2026-09-05T02:01:30.000Z",
            }));
            if (path === "/v1/auth/desktop/refresh") {
                return json(exchangeResponse({
                    access_token: "new-access",
                    refresh_token: "rotated-refresh",
                }));
            }
            modelAuthorization.push(new Headers(init?.headers).get("authorization"));
            return json({ subject_id: "subject-1", models: [] });
        });
        const client = createClient(fetchMock as typeof globalThis.fetch, store);
        await client.exchangeDesktopGrant({ code: "code", codeVerifier: "verifier", state: "state" });

        await expect(client.getManagedModels()).resolves.toEqual([]);
        expect(modelAuthorization).toEqual(["Bearer stale-access"]);
        await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/v1/auth/desktop/refresh"))).toBe(true));
    });

    test("awaits the access token refresh inside the synchronous skew and uses the new token", async () => {
        const store = memoryStore();
        const modelAuthorization: Array<string | null> = [];
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v1/auth/desktop/exchange") return json(exchangeResponse({
                access_token: "stale-access",
                access_token_expires_at: "2026-09-05T02:00:10.000Z",
            }));
            if (path === "/v1/auth/desktop/refresh") {
                return json(exchangeResponse({
                    access_token: "new-access",
                    refresh_token: "rotated-refresh",
                }));
            }
            modelAuthorization.push(new Headers(init?.headers).get("authorization"));
            return json({ subject_id: "subject-1", models: [] });
        });
        const client = createClient(fetchMock as typeof globalThis.fetch, store);
        await client.exchangeDesktopGrant({ code: "code", codeVerifier: "verifier", state: "state" });

        await expect(client.getManagedModels()).resolves.toEqual([]);
        expect(modelAuthorization).toEqual(["Bearer new-access"]);
    });

    test("does not refresh while the access token is well inside its validity", async () => {
        const store = memoryStore();
        const modelAuthorization: Array<string | null> = [];
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v1/auth/desktop/exchange") return json(exchangeResponse({
                access_token: "stale-access",
                access_token_expires_at: "2026-09-05T02:30:00.000Z",
            }));
            modelAuthorization.push(new Headers(init?.headers).get("authorization"));
            return json({ subject_id: "subject-1", models: [] });
        });
        const client = createClient(fetchMock as typeof globalThis.fetch, store);
        await client.exchangeDesktopGrant({ code: "code", codeVerifier: "verifier", state: "state" });

        await expect(client.getManagedModels()).resolves.toEqual([]);
        expect(modelAuthorization).toEqual(["Bearer stale-access"]);
        expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/v1/auth/desktop/refresh"))).toBe(false);
    });

    test("rejects with a typed session revocation when a 401 races a revoked background refresh", async () => {
        const store = memoryStore();
        let refreshFailed: (() => void) | null = null;
        const refreshFailedPromise = new Promise<void>((resolve) => {
            refreshFailed = resolve;
        });
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v1/auth/desktop/exchange") return json(exchangeResponse({
                access_token: "stale-access",
                access_token_expires_at: "2026-09-05T02:01:30.000Z",
            }));
            if (path === "/v1/auth/desktop/refresh") {
                const response = json({ error: "invalid_refresh_token" }, 400);
                queueMicrotask(() => refreshFailed?.());
                return response;
            }
            await refreshFailedPromise;
            return json({ error: "unauthorized" }, 401);
        });
        const client = createClient(fetchMock as typeof globalThis.fetch, store);
        await client.exchangeDesktopGrant({ code: "code", codeVerifier: "verifier", state: "state" });

        await expect(client.getManagedModels()).rejects.toMatchObject({
            name: "ShotshotCloudClientError",
            code: "session_revoked",
            status: 401,
        });
        expect(store.clear).toHaveBeenCalledOnce();
    });

    test("copies managed model spec axes through the strict field-by-field parser", async () => {
        const store = memoryStore();
        const spec = { aspectRatios: ["16:9"], resolutions: ["1K", "2K"], qualities: [] };
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v1/auth/desktop/exchange") return json(exchangeResponse());
            return json({
                subject_id: "subject-1",
                models: [
                    { id: "managed-image", name: "Managed image", capability: "image", execution: "direct", spec },
                    { id: "managed-text", name: "Managed text", capability: "text", execution: "direct" },
                ],
            });
        });
        const client = createClient(fetchMock as typeof globalThis.fetch, store);
        await client.exchangeDesktopGrant({ code: "code", codeVerifier: "verifier", state: "state" });

        await expect(client.getManagedModels()).resolves.toEqual([
            { id: "managed-image", name: "Managed image", capability: "image", execution: "direct", spec },
            { id: "managed-text", name: "Managed text", capability: "text", execution: "direct" },
        ]);
    });

    test("retains canonical input modalities on text models", async () => {
        const store = memoryStore();
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v1/auth/desktop/exchange") return json(exchangeResponse());
            return json({
                subject_id: "subject-1",
                models: [
                    { id: "minimax-m3", name: "MiniMax M3", capability: "text", execution: "direct", input_modalities: ["text", "image"] },
                    { id: "text-only", name: "Text only", capability: "text", execution: "direct" },
                ],
            });
        });
        const client = createClient(fetchMock as typeof globalThis.fetch, store);
        await client.exchangeDesktopGrant({ code: "code", codeVerifier: "verifier", state: "state" });

        await expect(client.getManagedModels()).resolves.toEqual([
            { id: "minimax-m3", name: "MiniMax M3", capability: "text", execution: "direct", input_modalities: ["text", "image"] },
            { id: "text-only", name: "Text only", capability: "text", execution: "direct" },
        ]);
    });

    test.each([
        [[]],
        [["image"]],
        [["image", "text"]],
        [["text", "text"]],
        [["text", "audio"]],
        [["text", "image", "text"]],
    ])("rejects non-canonical input modalities %j", async (modalities) => {
        const store = memoryStore();
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v1/auth/desktop/exchange") return json(exchangeResponse());
            return json({
                subject_id: "subject-1",
                models: [{ id: "minimax-m3", name: "MiniMax M3", capability: "text", execution: "direct", input_modalities: modalities }],
            });
        });
        const client = createClient(fetchMock as typeof globalThis.fetch, store);
        await client.exchangeDesktopGrant({ code: "code", codeVerifier: "verifier", state: "state" });

        await expect(client.getManagedModels()).rejects.toMatchObject({ message: "invalid_cloud_response" });
    });

    test("rejects input modalities on non-text models", async () => {
        const store = memoryStore();
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v1/auth/desktop/exchange") return json(exchangeResponse());
            return json({
                subject_id: "subject-1",
                models: [{ id: "managed-image", name: "Managed image", capability: "image", execution: "direct", input_modalities: ["text"] }],
            });
        });
        const client = createClient(fetchMock as typeof globalThis.fetch, store);
        await client.exchangeDesktopGrant({ code: "code", codeVerifier: "verifier", state: "state" });

        await expect(client.getManagedModels()).rejects.toMatchObject({ message: "invalid_cloud_response" });
    });

    test("rejects malformed managed model spec axes", async () => {
        const store = memoryStore();
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v1/auth/desktop/exchange") return json(exchangeResponse());
            return json({
                subject_id: "subject-1",
                models: [{ id: "managed-image", name: "Managed image", capability: "image", execution: "direct", spec: { resolutions: "2K" } }],
            });
        });
        const client = createClient(fetchMock as typeof globalThis.fetch, store);
        await client.exchangeDesktopGrant({ code: "code", codeVerifier: "verifier", state: "state" });

        await expect(client.getManagedModels()).rejects.toMatchObject({ message: "invalid_cloud_response" });
    });

    test("parses the cloud referral payload into camelCase desktop fields", async () => {
        const store = memoryStore();
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v1/auth/desktop/exchange") return json(exchangeResponse());
            expect(path).toBe("/v1/me/referral");
            return json({
                enabled: true,
                code: "SHOT-1234",
                referrer_reward_credits: 500,
                referee_bonus_credits: 200,
                invited_count: 3,
                revoked_count: 1,
                earned_credits_total: 1300,
            });
        });
        const client = createClient(fetchMock as typeof globalThis.fetch, store);
        await client.exchangeDesktopGrant({ code: "code", codeVerifier: "verifier", state: "state" });

        await expect(client.getReferralInfo()).resolves.toEqual({
            enabled: true,
            code: "SHOT-1234",
            referrerRewardCredits: 500,
            refereeBonusCredits: 200,
            invitedCount: 3,
            revokedCount: 1,
            earnedCreditsTotal: 1300,
        });
    });

    test("rejects a referral payload missing required keys", async () => {
        const store = memoryStore();
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v1/auth/desktop/exchange") return json(exchangeResponse());
            return json({ enabled: true, code: "SHOT-1234", invited_count: 3 });
        });
        const client = createClient(fetchMock as typeof globalThis.fetch, store);
        await client.exchangeDesktopGrant({ code: "code", codeVerifier: "verifier", state: "state" });

        await expect(client.getReferralInfo()).rejects.toMatchObject({
            name: "ShotshotCloudClientError",
            message: "invalid_referral_payload",
        });
    });

    test("issues and rotates a gateway credential without sending client-selected models", async () => {
        const store = memoryStore();
        const bodies: unknown[] = [];
        let gatewayCalls = 0;
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            if (path === "/v1/auth/desktop/exchange") return json(exchangeResponse());
            bodies.push(JSON.parse(String(init?.body)));
            gatewayCalls += 1;
            return json({
                token_id: `gateway-token-${gatewayCalls}`,
                secret: `gateway-secret-${gatewayCalls}`,
                expires_at: "2026-09-05T03:00:00.000Z",
            });
        });
        const client = createClient(fetchMock as typeof globalThis.fetch, store);
        await client.exchangeDesktopGrant({ code: "code", codeVerifier: "verifier", state: "state" });

        await client.issueGatewayCredential(["gpt-5-mini"]);
        await client.rotateGatewayCredential(["gpt-5-mini"]);

        expect(bodies).toEqual([{ device_id: "device-1" }, {}]);
        await expect(client.getStoredGatewayCredential()).resolves.toEqual({
            tokenId: "gateway-token-2",
            secret: "gateway-secret-2",
            expiresAt: "2026-09-05T03:00:00.000Z",
            modelIds: ["gpt-5-mini"],
        });
    });

    test("sanitizes cloud failures and clears local state on logout", async () => {
        const store = memoryStore();
        const fetchMock = vi.fn(async () => json({ error: "boom", secret: "response-secret" }, 500));
        const client = createClient(fetchMock as typeof globalThis.fetch, store);

        const request = client.exchangeDesktopGrant({ code: "grant-secret", codeVerifier: "verifier-secret", state: "state" });
        await expect(request).rejects.toEqual(expect.objectContaining<Partial<ShotshotCloudClientError>>({
                name: "ShotshotCloudClientError",
                status: 500,
                message: "cloud_request_failed",
            }));
        await client.logout();
        expect(store.clear).toHaveBeenCalledOnce();
        await expect(request.catch((error) => String(error))).resolves.not.toMatch(/grant-secret|verifier-secret|response-secret/);
    });
});
