export type DesktopPlan = "free" | "standard" | "pro";

export type DesktopAccount = {
    subjectId: string;
    email: string | null;
    displayName: string | null;
    avatarUrl: string | null;
};

export type DesktopAccountSnapshot = {
    account: DesktopAccount;
    subscription: {
        plan: DesktopPlan;
        status: string;
        currentPeriodEndsAt: string | null;
        cancelAtPeriodEnd: boolean;
    };
    usage: {
        balance: number;
        usedUnits: number;
        periodStart: string;
        periodEnd: string;
    };
    entitlements: Array<{
        code: string;
        state: string;
        limitValue: number | null;
        validUntil: string | null;
    }>;
    fetchedAt: string;
    staleSections?: Array<"subscription" | "usage" | "entitlements">;
};

export type DesktopDevice = {
    id: string;
    deviceName: string;
    platform: string;
    lastSeenAt: string | null;
    expiresAt: string;
    revokedAt: string | null;
};

export type AccountState =
    | { state: "signed-out" }
    | { state: "signing-in" }
    | { state: "loading"; previous?: DesktopAccountSnapshot }
    | { state: "ready"; snapshot: DesktopAccountSnapshot }
    | { state: "stale"; snapshot: DesktopAccountSnapshot; code: "account_refresh_failed" }
    | { state: "error"; code: string };

export type AuthStatus = AccountState;
