import { describe, expect, test, vi } from "vitest";
import { ACCOUNT_CHANNELS, assertTokenFreeAccountState, createAccountBridge } from "./account-bridge";

describe("account bridge", () => {
    test("rejects credential-shaped keys at any depth", () => {
        expect(() => assertTokenFreeAccountState({ state: "ready", snapshot: { account: { refreshToken: "nope" } } })).toThrow("credential_shaped_account_payload");
        expect(() => assertTokenFreeAccountState({ state: "ready", snapshot: { account: { nested: [{ api_key: "nope" }] } } })).toThrow("credential_shaped_account_payload");
    });

    test("validates getState and removes exactly its event listener", async () => {
        const listeners = new Map<string, (event: unknown, value: unknown) => void>();
        const ipc = {
            invoke: vi.fn(async () => ({ state: "signed-out" })),
            on: vi.fn((channel: string, listener: (event: unknown, value: unknown) => void) => listeners.set(channel, listener)),
            removeListener: vi.fn((channel: string, listener: (event: unknown, value: unknown) => void) => {
                if (listeners.get(channel) === listener) listeners.delete(channel);
            }),
        };
        const bridge = createAccountBridge(ipc);
        expect(await bridge.getState()).toEqual({ state: "signed-out" });
        const changed = vi.fn();
        const unsubscribe = bridge.onChanged(changed);

        listeners.get(ACCOUNT_CHANNELS.changed)?.({}, { state: "signing-in" });
        expect(changed).toHaveBeenCalledWith({ state: "signing-in" });
        unsubscribe();

        expect(ipc.removeListener).toHaveBeenCalledOnce();
        expect(listeners.has(ACCOUNT_CHANNELS.changed)).toBe(false);
    });

    test("exposes explicit retry and cancel actions for browser sign-in", async () => {
        const ipc = {
            invoke: vi.fn(async () => undefined),
            on: vi.fn(),
            removeListener: vi.fn(),
        };
        const bridge = createAccountBridge(ipc);

        await bridge.retrySignIn();
        await bridge.cancelSignIn();

        expect(ipc.invoke).toHaveBeenNthCalledWith(1, "account:retry-sign-in");
        expect(ipc.invoke).toHaveBeenNthCalledWith(2, "account:cancel-sign-in");
    });
});
