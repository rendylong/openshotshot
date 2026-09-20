import { create } from "zustand";
import type { AccountBridge } from "@/lib/desktop/account-bridge";
import type { AccountState } from "@/lib/desktop/auth-types";

type UserStore = {
    account: AccountState;
    initialized: boolean;
    initialize: () => Promise<void>;
    signIn: () => Promise<void>;
    retrySignIn: () => Promise<void>;
    cancelSignIn: () => Promise<void>;
    signOut: () => Promise<void>;
    refresh: () => Promise<void>;
    openAccountPage: () => Promise<void>;
    dispose: () => void;
};

let unsubscribe: (() => void) | null = null;
let initializePromise: Promise<void> | null = null;
let operation: Promise<void> | null = null;
let revision = 0;

function accountBridge(): AccountBridge | null {
    return typeof window === "undefined" ? null : window.shotshot?.account ?? null;
}

async function runOnce(action: (bridge: AccountBridge) => Promise<void>): Promise<void> {
    const bridge = accountBridge();
    if (!bridge) return;
    if (!operation) operation = action(bridge).finally(() => { operation = null; });
    return operation;
}

export const useUserStore = create<UserStore>()((set, get) => ({
    account: { state: "signed-out" },
    initialized: false,
    initialize: async () => {
        if (get().initialized) return;
        if (initializePromise) return initializePromise;
        const initializeRevision = revision;
        initializePromise = (async () => {
            const bridge = accountBridge();
            if (!bridge) {
                set({ account: { state: "signed-out" }, initialized: true });
                return;
            }
            unsubscribe ??= bridge.onChanged((account) => {
                revision += 1;
                set({ account, initialized: true });
            });
            const startedAt = revision;
            const account = await bridge.getState();
            if (startedAt === revision) set({ account, initialized: true });
        })().catch(() => {
            if (initializeRevision === revision) {
                set({ account: { state: "error", code: "account_bridge_failed" }, initialized: true });
            }
        }).finally(() => {
            initializePromise = null;
        });
        return initializePromise;
    },
    signIn: () => runOnce((bridge) => bridge.signIn()),
    retrySignIn: async () => {
        await accountBridge()?.retrySignIn();
    },
    cancelSignIn: async () => {
        await accountBridge()?.cancelSignIn();
    },
    signOut: () => runOnce((bridge) => bridge.signOut()),
    refresh: () => runOnce((bridge) => bridge.refresh()),
    openAccountPage: () => runOnce((bridge) => bridge.openAccountPage()),
    dispose: () => {
        revision += 1;
        unsubscribe?.();
        unsubscribe = null;
        initializePromise = null;
        operation = null;
        set({ account: { state: "signed-out" }, initialized: false });
    },
}));
