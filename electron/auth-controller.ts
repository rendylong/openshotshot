import type { AccountState, DesktopAccountSnapshot } from "../web/src/lib/desktop/auth-types";
import type { DesktopAuthCallback, DesktopAuthCallbackRouter } from "./auth-deep-link";
import { createDesktopAuthSecrets, verifyOAuthState, type DesktopAuthSecrets } from "./auth-pkce";
import { ShotshotCloudClientError, type DesktopAuthStart } from "./shotshot-cloud-client";

export type ShotshotAuthCloud = {
    startDesktopAuth(input: {
        codeChallenge: string;
        state: string;
        deviceName: string;
        platform: string;
    }): Promise<DesktopAuthStart>;
    exchangeDesktopGrant(input: {
        code: string;
        codeVerifier: string;
        state: string;
    }): Promise<{ subjectId: string; deviceId: string }>;
    restoreSession(): Promise<boolean>;
    getAccountSnapshot(): Promise<DesktopAccountSnapshot>;
    logout(): Promise<void>;
};

type ActiveAttempt = DesktopAuthSecrets & {
    requestId: string;
    expiresAt: number;
};

export type AuthControllerDependencies = {
    cloud: ShotshotAuthCloud;
    callbacks: DesktopAuthCallbackRouter;
    openExternal(url: string): Promise<void>;
    device: { name: string; platform: string };
    webOrigin: string;
    now?: () => number;
    createSecrets?: () => DesktopAuthSecrets;
};

function validateAuthorizationUrl(start: DesktopAuthStart, state: string, webOrigin: string): string {
    let url: URL;
    try {
        url = new URL(start.authorizationUrl);
    } catch {
        throw new Error("auth_start_failed");
    }
    const trustedOrigin = new URL(webOrigin);
    const localDevelopmentOrigin = trustedOrigin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "::1"].includes(trustedOrigin.hostname);
    const parameterNames = [...url.searchParams.keys()];
    if (url.origin !== trustedOrigin.origin || (url.protocol !== "https:" && !localDevelopmentOrigin) ||
        url.pathname !== "/auth/desktop" ||
        url.username || url.password || url.hash || parameterNames.length !== 2 ||
        url.searchParams.getAll("request_id").length !== 1 ||
        url.searchParams.get("request_id") !== start.requestId ||
        url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== state) {
        throw new Error("auth_start_failed");
    }
    return url.toString();
}

function errorCode(error: unknown, fallback: string): string {
    if (error instanceof ShotshotCloudClientError) {
        if (error.code === "session_revoked") return "session_revoked";
        if (error.serverCode === "request_expired" || error.serverCode === "grant_expired") return "auth_expired";
    }
    if (error instanceof Error && error.message === "secure_storage_unavailable") {
        return "secure_storage_unavailable";
    }
    return fallback;
}

export class AuthController {
    private readonly now: () => number;
    private readonly createSecrets: () => DesktopAuthSecrets;
    private readonly listeners = new Set<(state: AccountState) => void>();
    private readonly supersededStates = new Set<string>();
    private state: AccountState = { state: "signed-out" };
    private attempt: ActiveAttempt | null = null;
    private signInPromise: Promise<void> | null = null;
    private retryPromise: Promise<void> | null = null;
    private signInRevision = 0;
    private detachCallbacks: (() => void) | null;
    private disposed = false;

    constructor(private readonly dependencies: AuthControllerDependencies) {
        this.now = dependencies.now ?? Date.now;
        this.createSecrets = dependencies.createSecrets ?? createDesktopAuthSecrets;
        this.detachCallbacks = dependencies.callbacks.attach((callback) => {
            void this.acceptCallback(callback);
        });
    }

    getState(): AccountState {
        return this.state;
    }

    subscribe(listener: (state: AccountState) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async restore(): Promise<void> {
        this.ensureActive();
        this.publish({ state: "loading" });
        try {
            const restored = await this.dependencies.cloud.restoreSession();
            if (!restored) {
                this.publish({ state: "signed-out" });
                return;
            }
            await this.refresh();
        } catch (error) {
            this.publish({ state: "error", code: errorCode(error, "account_refresh_failed") });
        }
    }

    async signIn(): Promise<void> {
        this.ensureActive();
        if (this.attempt && this.attempt.expiresAt > this.now()) return;
        if (this.signInPromise) return this.signInPromise;
        this.attempt = null;
        const revision = ++this.signInRevision;
        return this.trackSignIn(this.startSignIn(revision));
    }

    async retrySignIn(): Promise<void> {
        this.ensureActive();
        if (this.state.state !== "signing-in") return;
        if (this.retryPromise) return this.retryPromise;
        const previous = this.signInPromise;
        const revision = ++this.signInRevision;
        this.invalidateAttempt();
        const task = (async () => {
            await previous;
            if (this.disposed || revision !== this.signInRevision) return;
            await this.startSignIn(revision);
        })();
        const tracked = this.trackSignIn(task);
        this.retryPromise = tracked;
        await tracked;
    }

    async cancelSignIn(): Promise<void> {
        this.ensureActive();
        if (this.state.state !== "signing-in") return;
        this.signInRevision += 1;
        this.signInPromise = null;
        this.retryPromise = null;
        this.invalidateAttempt();
        this.publish({ state: "signed-out" });
    }

    async acceptCallback(callback: DesktopAuthCallback): Promise<void> {
        this.ensureActive();
        if (this.supersededStates.delete(callback.state)) return;
        const attempt = this.attempt;
        this.attempt = null;
        // OSes can redeliver the same deep link. Once an attempt has been consumed,
        // ignore the duplicate so a successful account state cannot be overwritten.
        if (!attempt) return;
        if (!verifyOAuthState(attempt.state, callback.state)) {
            this.publish({ state: "error", code: "auth_callback_invalid" });
            return;
        }
        if (attempt.expiresAt <= this.now()) {
            this.publish({ state: "error", code: "auth_expired" });
            return;
        }
        this.publish({ state: "loading" });
        try {
            await this.dependencies.cloud.exchangeDesktopGrant({
                code: callback.code,
                codeVerifier: attempt.codeVerifier,
                state: attempt.state,
            });
            await this.refresh();
        } catch (error) {
            this.publish({ state: "error", code: errorCode(error, "auth_callback_invalid") });
        }
    }

    async refresh(): Promise<void> {
        this.ensureActive();
        const previous = this.currentSnapshot();
        this.publish({ state: "loading", ...(previous ? { previous } : {}) });
        try {
            const snapshot = await this.dependencies.cloud.getAccountSnapshot();
            this.publish(snapshot.staleSections?.length
                ? { state: "stale", snapshot, code: "account_refresh_failed" }
                : { state: "ready", snapshot });
        } catch (error) {
            if (errorCode(error, "account_refresh_failed") === "session_revoked") {
                this.publish({ state: "signed-out" });
            } else if (previous) {
                this.publish({ state: "stale", snapshot: previous, code: "account_refresh_failed" });
            } else {
                this.publish({ state: "error", code: errorCode(error, "account_refresh_failed") });
            }
        }
    }

    async signOut(): Promise<void> {
        this.ensureActive();
        this.signInRevision += 1;
        this.signInPromise = null;
        this.retryPromise = null;
        this.invalidateAttempt();
        await this.dependencies.cloud.logout().catch(() => undefined);
        this.publish({ state: "signed-out" });
    }

    async openAccountPage(): Promise<void> {
        this.ensureActive();
        await this.dependencies.openExternal(new URL("/account", this.dependencies.webOrigin).toString());
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.signInRevision += 1;
        this.signInPromise = null;
        this.retryPromise = null;
        this.invalidateAttempt();
        this.supersededStates.clear();
        this.listeners.clear();
        this.detachCallbacks?.();
        this.detachCallbacks = null;
    }

    private async startSignIn(revision: number): Promise<void> {
        if (revision !== this.signInRevision) return;
        this.publish({ state: "signing-in" });
        const secrets = this.createSecrets();
        try {
            const start = await this.dependencies.cloud.startDesktopAuth({
                codeChallenge: secrets.codeChallenge,
                state: secrets.state,
                deviceName: this.dependencies.device.name,
                platform: this.dependencies.device.platform,
            });
            if (revision !== this.signInRevision) return;
            const expiresAt = Date.parse(start.expiresAt);
            if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) throw new Error("auth_start_failed");
            const authorizationUrl = validateAuthorizationUrl(start, secrets.state, this.dependencies.webOrigin);
            this.attempt = { ...secrets, requestId: start.requestId, expiresAt };
            await this.dependencies.openExternal(authorizationUrl);
        } catch (error) {
            if (revision !== this.signInRevision) return;
            this.attempt = null;
            this.publish({ state: "error", code: errorCode(error, "auth_start_failed") });
        }
    }

    private trackSignIn(task: Promise<void>): Promise<void> {
        const tracked = task.finally(() => {
            if (this.signInPromise === tracked) this.signInPromise = null;
            if (this.retryPromise === tracked) this.retryPromise = null;
        });
        this.signInPromise = tracked;
        return tracked;
    }

    private currentSnapshot(): DesktopAccountSnapshot | null {
        if (this.state.state === "ready" || this.state.state === "stale") return this.state.snapshot;
        if (this.state.state === "loading") return this.state.previous ?? null;
        return null;
    }

    private invalidateAttempt(): void {
        if (this.attempt) this.supersededStates.add(this.attempt.state);
        this.attempt = null;
    }

    private publish(state: AccountState): void {
        if (this.disposed) return;
        this.state = state;
        for (const listener of this.listeners) listener(state);
    }

    private ensureActive(): void {
        if (this.disposed) throw new Error("auth_controller_disposed");
    }
}
