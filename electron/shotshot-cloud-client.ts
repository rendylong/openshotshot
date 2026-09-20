import { parseManagedVideoSpecs, type ManagedVideoSpec } from "../web/src/lib/desktop/managed-video-spec";
import type {
    DesktopAccount,
    DesktopAccountSnapshot,
    DesktopPlan,
} from "../web/src/lib/desktop/auth-types";
import type { AuthSessionStore, StoredAuthSession } from "./auth-session-store";

const DESKTOP_REDIRECT_URI = "ai.shotshot.desktop:/oauth/callback";
const ACCESS_REFRESH_SKEW_MS = 30_000;
const ACCESS_BACKGROUND_SKEW_MS = 120_000;

type JsonObject = Record<string, unknown>;
type CloudRequestInit = { method?: string; body?: JsonObject | Uint8Array; contentType?: string; signal?: AbortSignal };

type ActiveSession = {
    subjectId: string;
    deviceId: string;
    accessToken: string;
    accessTokenExpiresAt: string;
    refreshTokenExpiresAt: string;
};

export type DesktopAuthStart = {
    requestId: string;
    authorizationUrl: string;
    expiresAt: string;
};

export type ManagedModel = {
    id: string;
    name: string;
    capability: "text" | "image" | "video" | "audio";
    execution: "direct" | "remote_task";
    input_modalities?: Array<"text" | "image">;
    video_specs?: ManagedVideoSpec[];
    spec?: {
        aspectRatios?: string[];
        resolutions?: string[];
        qualities?: string[];
    };
    input_slots?: Array<{
        field: string;
        kind: "image" | "audio" | "video";
        required: boolean;
        accept_types: string[];
    }>;
};

export type GatewayCredential = NonNullable<StoredAuthSession["gateway"]>;

export class ShotshotCloudClientError extends Error {
    constructor(
        public readonly code:
            | "cloud_request_failed"
            | "invalid_cloud_response"
            | "invalid_referral_payload"
            | "signed_out"
            | "session_revoked"
            | "account_refresh_failed",
        public readonly status: number | null = null,
        public readonly serverCode: string | null = null,
    ) {
        super(code);
        this.name = "ShotshotCloudClientError";
    }
}

export type ShotshotCloudClientOptions = {
    baseUrl: string;
    fetch?: typeof globalThis.fetch;
    sessionStore: AuthSessionStore;
    now?: () => Date;
};

function object(value: unknown): JsonObject {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ShotshotCloudClientError("invalid_cloud_response");
    }
    return value as JsonObject;
}

function string(value: unknown): string {
    if (typeof value !== "string" || !value) {
        throw new ShotshotCloudClientError("invalid_cloud_response");
    }
    return value;
}

function nullableString(value: unknown): string | null {
    if (value === null) return null;
    return string(value);
}

function number(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ShotshotCloudClientError("invalid_cloud_response");
    }
    return value;
}

function boolean(value: unknown): boolean {
    if (typeof value !== "boolean") throw new ShotshotCloudClientError("invalid_cloud_response");
    return value;
}

function plan(value: unknown): DesktopPlan {
    if (value !== "free" && value !== "standard" && value !== "pro") {
        throw new ShotshotCloudClientError("invalid_cloud_response");
    }
    return value;
}

function parseSession(value: unknown) {
    const response = object(value);
    const active = {
        subjectId: string(response.subject_id),
        deviceId: string(response.device_id),
        accessToken: string(response.access_token),
        accessTokenExpiresAt: string(response.access_token_expires_at),
        refreshTokenExpiresAt: string(response.refresh_token_expires_at),
    } satisfies ActiveSession;
    if (!Number.isFinite(Date.parse(active.accessTokenExpiresAt)) ||
        !Number.isFinite(Date.parse(active.refreshTokenExpiresAt))) {
        throw new ShotshotCloudClientError("invalid_cloud_response");
    }
    return { active, refreshToken: string(response.refresh_token) };
}

function parseSubscription(value: unknown, subjectId: string): DesktopAccountSnapshot["subscription"] {
    const response = object(value);
    if (string(response.subject_id) !== subjectId) throw new ShotshotCloudClientError("invalid_cloud_response");
    return {
        plan: plan(response.plan_code),
        status: string(response.status),
        currentPeriodEndsAt: nullableString(response.current_period_ends_at),
        cancelAtPeriodEnd: boolean(response.cancel_at_period_end),
    };
}

function parseUsage(value: unknown, subjectId: string): DesktopAccountSnapshot["usage"] {
    const response = object(value);
    if (string(response.subject_id) !== subjectId) throw new ShotshotCloudClientError("invalid_cloud_response");
    return {
        balance: number(response.balance),
        usedUnits: number(response.used_units),
        periodStart: string(response.period_start),
        periodEnd: string(response.period_end),
    };
}

function parseEntitlements(value: unknown, subjectId: string): DesktopAccountSnapshot["entitlements"] {
    const response = object(value);
    if (string(response.subject_id) !== subjectId || !Array.isArray(response.entitlements)) {
        throw new ShotshotCloudClientError("invalid_cloud_response");
    }
    return response.entitlements.map((entry) => {
        const entitlement = object(entry);
        return {
            code: string(entitlement.code),
            state: string(entitlement.state),
            limitValue: entitlement.limit_value === null ? null : number(entitlement.limit_value),
            validUntil: nullableString(entitlement.valid_until),
        };
    });
}

const MANAGED_SPEC_KEYS = ["aspectRatios", "resolutions", "qualities"] as const;

// 目录可执行侧的权威字段：只接受 ["text"] 与 ["text", "image"] 两个规范数组。
function parseManagedInputModalities(value: unknown): Array<"text" | "image"> {
    if (Array.isArray(value) && value.length === 1 && value[0] === "text") return ["text"];
    if (Array.isArray(value) && value.length === 2 && value[0] === "text" && value[1] === "image") return ["text", "image"];
    throw new ShotshotCloudClientError("invalid_cloud_response");
}

function parseManagedModelSpec(value: unknown): NonNullable<ManagedModel["spec"]> {
    const source = object(value);
    if (Object.keys(source).some((key) => !(MANAGED_SPEC_KEYS as readonly string[]).includes(key))) {
        throw new ShotshotCloudClientError("invalid_cloud_response");
    }
    const spec: NonNullable<ManagedModel["spec"]> = {};
    for (const key of MANAGED_SPEC_KEYS) {
        const axis = source[key];
        if (axis === undefined) continue;
        if (!Array.isArray(axis) || axis.length > 32) throw new ShotshotCloudClientError("invalid_cloud_response");
        spec[key] = axis.map((entry) => {
            const token = string(entry);
            if (token.length > 128) throw new ShotshotCloudClientError("invalid_cloud_response");
            return token;
        });
    }
    return spec;
}

function parseManagedModels(value: unknown, subjectId: string): ManagedModel[] {
    const response = object(value);
    if (string(response.subject_id) !== subjectId || !Array.isArray(response.models)) {
        throw new ShotshotCloudClientError("invalid_cloud_response");
    }
    const ids = new Set<string>();
    return response.models.map((entry) => {
        const model = object(entry);
        const id = string(model.id);
        if (ids.has(id)) throw new ShotshotCloudClientError("invalid_cloud_response");
        ids.add(id);
        const capability = string(model.capability);
        const execution = string(model.execution);
        if (!["text", "image", "video", "audio"].includes(capability) ||
            !["direct", "remote_task"].includes(execution)) {
            throw new ShotshotCloudClientError("invalid_cloud_response");
        }
        const managed: ManagedModel = {
            id,
            name: string(model.name),
            capability: capability as ManagedModel["capability"],
            execution: execution as ManagedModel["execution"],
        };
        if ("input_modalities" in model) {
            // 可执行目录属性：非文本模型带该字段、或数组非规范时整个目录响应失败（fail closed）。
            if (capability !== "text") throw new ShotshotCloudClientError("invalid_cloud_response");
            managed.input_modalities = parseManagedInputModalities(model.input_modalities);
        }
        if ("video_specs" in model) {
            const specs = parseManagedVideoSpecs(model.video_specs);
            if (!specs) throw new ShotshotCloudClientError("invalid_cloud_response");
            managed.video_specs = specs;
        }
        if ("spec" in model) {
            managed.spec = parseManagedModelSpec(model.spec);
        }
        if ("input_slots" in model) {
            if (!Array.isArray(model.input_slots) || model.input_slots.length > 32) throw new ShotshotCloudClientError("invalid_cloud_response");
            const fields = new Set<string>();
            managed.input_slots = model.input_slots.map((entry) => {
                const slot = object(entry);
                if (Object.keys(slot).sort().join(",") !== "accept_types,field,kind,required") throw new ShotshotCloudClientError("invalid_cloud_response");
                const field = string(slot.field);
                const kind = string(slot.kind);
                const required = boolean(slot.required);
                if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field) || fields.has(field) || !["image", "audio", "video"].includes(kind) || !Array.isArray(slot.accept_types) || slot.accept_types.length < 1 || slot.accept_types.length > 8) {
                    throw new ShotshotCloudClientError("invalid_cloud_response");
                }
                const accept_types = slot.accept_types.map((type) => {
                    const value = string(type);
                    if (!/^[-A-Za-z0-9_.+]+\/[-A-Za-z0-9_.+]+$/.test(value) || value.length > 128) throw new ShotshotCloudClientError("invalid_cloud_response");
                    return value;
                });
                fields.add(field);
                return { field, kind: kind as "image" | "audio" | "video", required, accept_types };
            });
        }
        return managed;
    });
}

export type DesktopReferralInfo = {
    enabled: boolean;
    code: string;
    referrerRewardCredits: number;
    refereeBonusCredits: number;
    invitedCount: number;
    revokedCount: number;
    earnedCreditsTotal: number;
};

function parseReferralInfo(value: unknown): DesktopReferralInfo {
    const payload = object(value);
    const num = (key: string): number => {
        const raw = payload[key];
        if (typeof raw !== "number" || !Number.isFinite(raw)) throw new ShotshotCloudClientError("invalid_referral_payload");
        return raw;
    };
    if (typeof payload.enabled !== "boolean" || typeof payload.code !== "string") {
        throw new ShotshotCloudClientError("invalid_referral_payload");
    }
    return {
        enabled: payload.enabled,
        code: payload.code,
        referrerRewardCredits: num("referrer_reward_credits"),
        refereeBonusCredits: num("referee_bonus_credits"),
        invitedCount: num("invited_count"),
        revokedCount: num("revoked_count"),
        earnedCreditsTotal: num("earned_credits_total"),
    };
}

function isAuthoritativeRefreshFailure(error: unknown): boolean {
    return error instanceof ShotshotCloudClientError &&
        (error.status === 400 || error.status === 401);
}

export class ShotshotCloudClient {
    private readonly baseUrl: string;
    private readonly fetch: typeof globalThis.fetch;
    private readonly sessionStore: AuthSessionStore;
    private readonly now: () => Date;
    private session: ActiveSession | null = null;
    private lastSnapshot: DesktopAccountSnapshot | null = null;
    private refreshPromise: Promise<void> | null = null;

    constructor(options: ShotshotCloudClientOptions) {
        this.baseUrl = options.baseUrl.replace(/\/$/, "");
        this.fetch = options.fetch ?? globalThis.fetch;
        this.sessionStore = options.sessionStore;
        this.now = options.now ?? (() => new Date());
    }

    hasSession(): boolean {
        return this.session !== null;
    }

    async startDesktopAuth(input: {
        codeChallenge: string;
        state: string;
        deviceName: string;
        platform: string;
    }): Promise<DesktopAuthStart> {
        const response = object(await this.request("/v1/auth/desktop/start", {
            method: "POST",
            body: {
                code_challenge: input.codeChallenge,
                state: input.state,
                redirect_uri: DESKTOP_REDIRECT_URI,
                device_name: input.deviceName,
                platform: input.platform,
            },
        }));
        return {
            requestId: string(response.request_id),
            authorizationUrl: string(response.authorization_url),
            expiresAt: string(response.expires_at),
        };
    }

    async exchangeDesktopGrant(input: {
        code: string;
        codeVerifier: string;
        state: string;
    }): Promise<{ subjectId: string; deviceId: string }> {
        const response = await this.request("/v1/auth/desktop/exchange", {
            method: "POST",
            body: {
                code: input.code,
                code_verifier: input.codeVerifier,
                state: input.state,
            },
        });
        const parsed = parseSession(response);
        await this.sessionStore.save({
            refreshToken: parsed.refreshToken,
            deviceId: parsed.active.deviceId,
        });
        this.session = parsed.active;
        return { subjectId: parsed.active.subjectId, deviceId: parsed.active.deviceId };
    }

    async restoreSession(): Promise<boolean> {
        const stored = await this.sessionStore.load();
        if (!stored) return false;
        try {
            await this.refreshFromStored(stored);
            return true;
        } catch (error) {
            this.session = null;
            if (isAuthoritativeRefreshFailure(error)) {
                await this.sessionStore.clear();
                return false;
            }
            throw error;
        }
    }

    async getAccountSnapshot(): Promise<DesktopAccountSnapshot> {
        const me = object(await this.authorizedRequest("/v1/me"));
        const subjectId = string(me.subject_id);
        const account: DesktopAccount = {
            subjectId,
            email: nullableString(me.email),
            displayName: nullableString(me.display_name),
            avatarUrl: nullableString(me.avatar_url),
        };
        const sections = await Promise.allSettled([
            this.authorizedRequest("/v1/subscription").then((value) => parseSubscription(value, subjectId)),
            this.authorizedRequest("/v1/usage/summary").then((value) => parseUsage(value, subjectId)),
            this.authorizedRequest("/v1/entitlements").then((value) => parseEntitlements(value, subjectId)),
        ]);
        const staleSections: NonNullable<DesktopAccountSnapshot["staleSections"]> = [];
        const previous = this.lastSnapshot;
        const subscription = sections[0].status === "fulfilled"
            ? sections[0].value
            : (staleSections.push("subscription"), previous?.subscription);
        const usage = sections[1].status === "fulfilled"
            ? sections[1].value
            : (staleSections.push("usage"), previous?.usage);
        const entitlements = sections[2].status === "fulfilled"
            ? sections[2].value
            : (staleSections.push("entitlements"), previous?.entitlements);
        if (!subscription || !usage || !entitlements) {
            throw new ShotshotCloudClientError("account_refresh_failed");
        }
        const snapshot: DesktopAccountSnapshot = {
            account,
            subscription,
            usage,
            entitlements,
            fetchedAt: this.now().toISOString(),
            ...(staleSections.length > 0 ? { staleSections } : {}),
        };
        this.lastSnapshot = snapshot;
        return snapshot;
    }

    async getManagedModels(): Promise<ManagedModel[]> {
        if (!this.session) throw new ShotshotCloudClientError("signed_out");
        return parseManagedModels(await this.authorizedRequest("/v1/models"), this.session.subjectId);
    }

    async getReferralInfo(): Promise<DesktopReferralInfo> {
        return parseReferralInfo(await this.authorizedRequest("/v1/me/referral"));
    }

    /** Asset bytes use the desktop session and Cloud origin, never a gateway credential. */
    async requestManagedAsset(path: string, body: JsonObject | Uint8Array, contentType?: string, signal?: AbortSignal): Promise<{ asset_id: string }> {
        const content = /^\/v1\/assets\/[A-Za-z0-9-]+\/content$/.test(path);
        if (path !== "/v1/assets/upload" && !content && !/^\/v1\/assets\/[A-Za-z0-9-]+\/complete$/.test(path)) {
            throw new ShotshotCloudClientError("cloud_request_failed");
        }
        if (content !== (body instanceof Uint8Array)) throw new ShotshotCloudClientError("cloud_request_failed");
        const response = object(await this.authorizedRequest(path, { method: "POST", body, contentType, signal }));
        // Signed upload URLs stay in main. The renderer uploads through the fixed content route.
        return { asset_id: string(response.asset_id) };
    }

    async getStoredGatewayCredential(): Promise<GatewayCredential | null> {
        return (await this.sessionStore.load())?.gateway ?? null;
    }

    async issueGatewayCredential(modelIds: string[]): Promise<GatewayCredential> {
        const stored = await this.requireStoredSession();
        return this.persistGatewayCredential(stored, modelIds, await this.authorizedRequest(
            "/v1/gateway/devices",
            { method: "POST", body: { device_id: stored.deviceId } },
        ));
    }

    async rotateGatewayCredential(modelIds: string[]): Promise<GatewayCredential> {
        const stored = await this.requireStoredSession();
        return this.persistGatewayCredential(stored, modelIds, await this.authorizedRequest(
            `/v1/gateway/devices/${encodeURIComponent(stored.deviceId)}/rotate`,
            { method: "POST", body: {} },
        ));
    }

    async clearGatewayCredential(): Promise<void> {
        const stored = await this.sessionStore.load();
        if (!stored?.gateway) return;
        await this.sessionStore.save({ refreshToken: stored.refreshToken, deviceId: stored.deviceId });
    }

    async logout(): Promise<void> {
        const session = this.session;
        try {
            if (session) {
                await this.authorizedRequest(
                    `/v1/devices/${encodeURIComponent(session.deviceId)}`,
                    { method: "DELETE" },
                );
            }
        } catch {
            // Local credential removal is authoritative for signing out this installation.
        } finally {
            this.session = null;
            this.lastSnapshot = null;
            await this.sessionStore.clear();
        }
    }

    private async persistGatewayCredential(
        stored: StoredAuthSession,
        modelIds: string[],
        value: unknown,
    ): Promise<GatewayCredential> {
        const response = object(value);
        const credential: GatewayCredential = {
            tokenId: string(response.token_id),
            secret: string(response.secret),
            expiresAt: string(response.expires_at),
            modelIds: [...modelIds],
        };
        if (!Number.isFinite(Date.parse(credential.expiresAt)) || credential.modelIds.length === 0) {
            throw new ShotshotCloudClientError("invalid_cloud_response");
        }
        await this.sessionStore.save({ ...stored, gateway: credential });
        return credential;
    }

    private async requireStoredSession(): Promise<StoredAuthSession> {
        if (!this.session) throw new ShotshotCloudClientError("signed_out");
        const stored = await this.sessionStore.load();
        if (!stored || stored.deviceId !== this.session.deviceId) {
            throw new ShotshotCloudClientError("signed_out");
        }
        return stored;
    }

    private async authorizedRequest(
        path: string,
        init: CloudRequestInit = {},
    ): Promise<unknown> {
        if (!this.session) throw new ShotshotCloudClientError("signed_out");
        const remainingMs = Date.parse(this.session.accessTokenExpiresAt) - this.now().getTime();
        if (remainingMs <= ACCESS_REFRESH_SKEW_MS) {
            await this.refreshAccessSession();
        } else if (remainingMs <= ACCESS_BACKGROUND_SKEW_MS) {
            void this.refreshAccessSession().catch(() => undefined);
        }
        const attemptedAccessToken = this.session.accessToken;
        try {
            return await this.request(path, {
                ...init,
                authorization: `Bearer ${attemptedAccessToken}`,
            });
        } catch (error) {
            if (!(error instanceof ShotshotCloudClientError) || error.status !== 401) throw error;
            if (this.session?.accessToken === attemptedAccessToken) {
                await this.refreshAccessSession();
            }
            if (!this.session) throw new ShotshotCloudClientError("session_revoked", 401);
            return this.request(path, {
                ...init,
                authorization: `Bearer ${this.session.accessToken}`,
            });
        }
    }

    private async refreshAccessSession(): Promise<void> {
        if (this.refreshPromise) return this.refreshPromise;
        this.refreshPromise = (async () => {
            const stored = await this.sessionStore.load();
            if (!stored) throw new ShotshotCloudClientError("signed_out");
            try {
                await this.refreshFromStored(stored);
            } catch (error) {
                if (isAuthoritativeRefreshFailure(error)) {
                    this.session = null;
                    this.lastSnapshot = null;
                    await this.sessionStore.clear();
                    throw new ShotshotCloudClientError("session_revoked", 401);
                }
                throw error;
            }
        })().finally(() => {
            this.refreshPromise = null;
        });
        return this.refreshPromise;
    }

    private async refreshFromStored(stored: StoredAuthSession): Promise<void> {
        const response = await this.request("/v1/auth/desktop/refresh", {
            method: "POST",
            body: { refresh_token: stored.refreshToken },
        });
        const parsed = parseSession(response);
        if (parsed.active.deviceId !== stored.deviceId) {
            throw new ShotshotCloudClientError("invalid_cloud_response");
        }
        await this.sessionStore.save({
            ...stored,
            refreshToken: parsed.refreshToken,
            deviceId: parsed.active.deviceId,
        });
        this.session = parsed.active;
    }

    private async request(
        path: string,
        options: CloudRequestInit & { authorization?: string },
    ): Promise<unknown> {
        let response: Response;
        try {
            response = await this.fetch(`${this.baseUrl}${path}`, {
                method: options.method ?? "GET",
                headers: {
                    accept: "application/json",
                    ...(options.body ? { "content-type": options.body instanceof Uint8Array ? options.contentType || "application/octet-stream" : "application/json" } : {}),
                    ...(options.authorization ? { authorization: options.authorization } : {}),
                },
                ...(options.body ? { body: options.body instanceof Uint8Array ? Buffer.from(options.body) : JSON.stringify(options.body) } : {}),
                signal: options.signal,
                ...(path.startsWith("/v1/assets/") ? { redirect: "error" as const } : {}),
            });
        } catch {
            throw new ShotshotCloudClientError("cloud_request_failed");
        }
        if (!response.ok) {
            let serverCode: string | null = null;
            try {
                const error = object(await response.json()).error;
                if (typeof error === "string" && /^[a-z0-9_]{1,128}$/.test(error)) serverCode = error;
            } catch {
                // Error payloads are deliberately ignored and never included in diagnostics.
            }
            throw new ShotshotCloudClientError("cloud_request_failed", response.status, serverCode);
        }
        try {
            return await response.json();
        } catch {
            throw new ShotshotCloudClientError("invalid_cloud_response", response.status);
        }
    }
}
