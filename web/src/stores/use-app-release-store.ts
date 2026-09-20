import { create } from "zustand";
import type { AppReleaseBridge, AppReleaseState } from "@/lib/desktop/app-release-bridge";

const SNOOZE_MS = 30 * 60 * 1000;
const IDLE_STATE: AppReleaseState = { status: "idle", policy: null, checkedAt: null };

type AppReleaseStore = {
    state: AppReleaseState;
    snoozedUntil: number | null;
    releaseModalOpen: boolean;
    initialize: () => Promise<void>;
    refresh: () => Promise<boolean>;
    snooze: () => void;
    setReleaseModalOpen: (open: boolean) => void;
};

let unsubscribe: (() => void) | null = null;
let initializePromise: Promise<void> | null = null;

function appReleaseBridge(): AppReleaseBridge | null {
    return typeof window === "undefined" ? null : window.shotshot?.appRelease ?? null;
}

export function appReleaseForceModalVisible(state: AppReleaseState, snoozedUntil: number | null, now: number): boolean {
    if (state.status !== "force_update") return false;
    return snoozedUntil === null || now >= snoozedUntil;
}

export const useAppReleaseStore = create<AppReleaseStore>()((set) => ({
    state: IDLE_STATE,
    snoozedUntil: null,
    releaseModalOpen: false,
    initialize: async () => {
        const bridge = appReleaseBridge();
        if (!bridge) return;
        if (initializePromise) return initializePromise;
        initializePromise = (async () => {
            const state = await bridge.getState().catch(() => IDLE_STATE);
            set({ state });
            unsubscribe = bridge.onChanged((next) => set({ state: next }));
        })();
        return initializePromise;
    },
    refresh: async () => {
        const bridge = appReleaseBridge();
        if (!bridge) return false;
        const next = await bridge.refresh().catch(() => null);
        if (!next) return false;
        set({ state: next });
        return true;
    },
    snooze: () => set({ snoozedUntil: Date.now() + SNOOZE_MS }),
    setReleaseModalOpen: (open) => set({ releaseModalOpen: open }),
}));

export function disposeAppReleaseStoreForTests(): void {
    unsubscribe?.();
    unsubscribe = null;
    initializePromise = null;
}
