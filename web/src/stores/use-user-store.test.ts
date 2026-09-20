import { afterEach, describe, expect, test, vi } from "vitest";
import type { AccountBridge } from "@/lib/desktop/account-bridge";
import type { AccountState } from "@/lib/desktop/auth-types";
import { useUserStore } from "./use-user-store";

function installBridge(overrides: Partial<AccountBridge> = {}) {
    let changed: ((state: AccountState) => void) | null = null;
    const bridge: AccountBridge = {
        getState: vi.fn(async (): Promise<AccountState> => ({ state: "signed-out" })),
        signIn: vi.fn(async () => undefined),
        retrySignIn: vi.fn(async () => undefined),
        cancelSignIn: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
        refresh: vi.fn(async () => undefined),
        openAccountPage: vi.fn(async () => undefined),
        getReferralInfo: vi.fn(async (): Promise<never> => { throw new Error("getReferralInfo is not exercised in this test"); }),
        onChanged: vi.fn((listener) => { changed = listener; return vi.fn(() => { changed = null; }); }),
        ...overrides,
    };
    window.shotshot = { account: bridge, agent: {} as never, skills: {} as never, platform: "darwin" };
    return { bridge, emit: (state: AccountState) => changed?.(state) };
}

afterEach(() => {
    useUserStore.getState().dispose();
    delete window.shotshot;
});

describe("user account store", () => {
    test("stays signed out in a browser-only build", async () => {
        await useUserStore.getState().initialize();
        expect(useUserStore.getState()).toMatchObject({ initialized: true, account: { state: "signed-out" } });
    });

    test("hydrates once and subscribes before reading state", async () => {
        const value = installBridge();
        await Promise.all([useUserStore.getState().initialize(), useUserStore.getState().initialize()]);
        expect(value.bridge.getState).toHaveBeenCalledOnce();
        expect(value.bridge.onChanged).toHaveBeenCalledOnce();
    });

    test("does not let a late hydration overwrite a newer event", async () => {
        let resolveState!: (value: AccountState) => void;
        const value = installBridge({ getState: vi.fn(() => new Promise<AccountState>((resolve) => { resolveState = resolve; })) });
        const pending = useUserStore.getState().initialize();
        value.emit({ state: "signing-in" });
        resolveState({ state: "signed-out" });
        await pending;
        expect(useUserStore.getState().account).toEqual({ state: "signing-in" });
    });

    test("deduplicates rapid account operations", async () => {
        let resolve!: () => void;
        const signIn = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
        installBridge({ signIn });
        const first = useUserStore.getState().signIn();
        const second = useUserStore.getState().signIn();
        expect(signIn).toHaveBeenCalledOnce();
        resolve();
        await Promise.all([first, second]);
    });

    test("forwards retry and cancel even while the original sign-in operation is pending", async () => {
        let resolveSignIn!: () => void;
        const signIn = vi.fn(() => new Promise<void>((resolve) => { resolveSignIn = resolve; }));
        const retrySignIn = vi.fn(async () => undefined);
        const cancelSignIn = vi.fn(async () => undefined);
        installBridge({ signIn, retrySignIn, cancelSignIn });

        const pending = useUserStore.getState().signIn();
        const actions = useUserStore.getState();
        await actions.retrySignIn();
        await actions.cancelSignIn();

        expect(retrySignIn).toHaveBeenCalledOnce();
        expect(cancelSignIn).toHaveBeenCalledOnce();
        resolveSignIn();
        await pending;
    });
});
