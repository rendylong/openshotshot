import type { AccountState } from "./auth-types";

export const ACCOUNT_CHANNELS = {
    getState: "account:get-state",
    signIn: "account:sign-in",
    retrySignIn: "account:retry-sign-in",
    cancelSignIn: "account:cancel-sign-in",
    signOut: "account:sign-out",
    refresh: "account:refresh",
    openAccountPage: "account:open-page",
    getReferralInfo: "account:referral-info",
    changed: "account:changed",
} as const;

export type AccountBridge = {
    getState(): Promise<AccountState>;
    signIn(): Promise<void>;
    retrySignIn(): Promise<void>;
    cancelSignIn(): Promise<void>;
    signOut(): Promise<void>;
    refresh(): Promise<void>;
    openAccountPage(): Promise<void>;
    getReferralInfo(): Promise<ReferralInfo>;
    onChanged(listener: (state: AccountState) => void): () => void;
};

type RendererIpc = {
    invoke(channel: string): Promise<unknown>;
    on(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
    removeListener(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
};

const FORBIDDEN_KEY = /(?:token|secret|credential|authorization|api.?key)/i;
const ACCOUNT_STATES = new Set(["signed-out", "signing-in", "loading", "ready", "stale", "error"]);

export type ReferralInfo = {
    enabled: boolean;
    code: string;
    referrerRewardCredits: number;
    refereeBonusCredits: number;
    invitedCount: number;
    revokedCount: number;
    earnedCreditsTotal: number;
    shareUrl: string;
};

const REFERRAL_INFO_KEYS = [
    "code", "earnedCreditsTotal", "enabled", "invitedCount",
    "refereeBonusCredits", "referrerRewardCredits", "revokedCount", "shareUrl",
] as const;

export function assertReferralInfo(value: unknown): asserts value is ReferralInfo {
    const candidate = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
    if (!candidate) throw new Error("invalid_referral_payload");
    for (const key of Object.keys(candidate)) {
        if (FORBIDDEN_KEY.test(key)) throw new Error("credential_shaped_referral_payload");
        if (!(REFERRAL_INFO_KEYS as readonly string[]).includes(key)) throw new Error("invalid_referral_payload");
    }
    if (typeof candidate.enabled !== "boolean" || typeof candidate.code !== "string" || typeof candidate.shareUrl !== "string") {
        throw new Error("invalid_referral_payload");
    }
    for (const key of ["referrerRewardCredits", "refereeBonusCredits", "invitedCount", "revokedCount", "earnedCreditsTotal"] as const) {
        if (typeof candidate[key] !== "number" || !Number.isFinite(candidate[key])) throw new Error("invalid_referral_payload");
    }
}

export function assertTokenFreeAccountState(value: unknown): asserts value is AccountState {
    const seen = new Set<object>();
    const visit = (candidate: unknown): void => {
        if (!candidate || typeof candidate !== "object") return;
        if (seen.has(candidate as object)) return;
        seen.add(candidate as object);
        for (const [key, child] of Object.entries(candidate)) {
            if (FORBIDDEN_KEY.test(key)) throw new Error("credential_shaped_account_payload");
            visit(child);
        }
    };
    visit(value);
    if (!value || typeof value !== "object" || !ACCOUNT_STATES.has((value as { state?: unknown }).state as string)) {
        throw new Error("invalid_account_payload");
    }
}

export function createAccountBridge(ipc: RendererIpc): AccountBridge {
    return {
        async getState() {
            const value = await ipc.invoke(ACCOUNT_CHANNELS.getState);
            assertTokenFreeAccountState(value);
            return value;
        },
        signIn: () => ipc.invoke(ACCOUNT_CHANNELS.signIn).then(() => undefined),
        retrySignIn: () => ipc.invoke(ACCOUNT_CHANNELS.retrySignIn).then(() => undefined),
        cancelSignIn: () => ipc.invoke(ACCOUNT_CHANNELS.cancelSignIn).then(() => undefined),
        signOut: () => ipc.invoke(ACCOUNT_CHANNELS.signOut).then(() => undefined),
        refresh: () => ipc.invoke(ACCOUNT_CHANNELS.refresh).then(() => undefined),
        openAccountPage: () => ipc.invoke(ACCOUNT_CHANNELS.openAccountPage).then(() => undefined),
        async getReferralInfo() {
            const value = await ipc.invoke(ACCOUNT_CHANNELS.getReferralInfo);
            assertReferralInfo(value);
            return value;
        },
        onChanged(listener) {
            const ipcListener = (_event: unknown, value: unknown) => {
                assertTokenFreeAccountState(value);
                listener(value);
            };
            ipc.on(ACCOUNT_CHANNELS.changed, ipcListener);
            return () => { ipc.removeListener(ACCOUNT_CHANNELS.changed, ipcListener); };
        },
    };
}
