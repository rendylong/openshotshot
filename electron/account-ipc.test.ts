import { describe, expect, test, vi } from "vitest";
import { ACCOUNT_CHANNELS } from "../web/src/lib/desktop/account-bridge";
import { registerAccountIpc } from "./account-ipc";

describe("account IPC", () => {
    test("validates each sender, publishes state, and unregisters all handlers", async () => {
        const handlers = new Map<string, (event: { sender: unknown }) => unknown>();
        const ipcMain = {
            handle: vi.fn((channel: string, handler: (event: { sender: unknown }) => unknown) => handlers.set(channel, handler)),
            removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
        };
        let publish!: (state: { state: "signing-in" }) => void;
        const unsubscribe = vi.fn();
        const controller = {
            getState: vi.fn(() => ({ state: "signed-out" })),
            signIn: vi.fn(async () => undefined),
            retrySignIn: vi.fn(async () => undefined),
            cancelSignIn: vi.fn(async () => undefined),
            signOut: vi.fn(async () => undefined),
            refresh: vi.fn(async () => undefined),
            openAccountPage: vi.fn(async () => undefined),
            subscribe: vi.fn((listener) => { publish = listener; return unsubscribe; }),
        };
        const trusted = { id: 1 };
        const recipient = { isDestroyed: () => false, send: vi.fn() };
        const referralPayload = {
            enabled: true,
            code: "SHOT-1234",
            referrerRewardCredits: 500,
            refereeBonusCredits: 200,
            invitedCount: 3,
            revokedCount: 1,
            earnedCreditsTotal: 1300,
            shareUrl: "https://shotshot.ai/i/SHOT-1234",
        };
        const referralInfo = vi.fn(async () => referralPayload);
        const dispose = registerAccountIpc({
            ipcMain: ipcMain as never,
            controller: controller as never,
            isTrustedSender: (sender) => sender === trusted,
            recipients: () => [recipient as never],
            referralInfo,
        });

        await expect(handlers.get(ACCOUNT_CHANNELS.signIn)?.({ sender: {} })).rejects.toThrow("untrusted_ipc_sender");
        await expect(handlers.get(ACCOUNT_CHANNELS.getReferralInfo)?.({ sender: {} })).rejects.toThrow("untrusted_ipc_sender");
        await handlers.get(ACCOUNT_CHANNELS.signIn)?.({ sender: trusted });
        expect(controller.signIn).toHaveBeenCalledOnce();
        await expect(handlers.get(ACCOUNT_CHANNELS.getReferralInfo)?.({ sender: trusted })).resolves.toEqual(referralPayload);
        expect(referralInfo).toHaveBeenCalledOnce();
        await handlers.get("account:retry-sign-in")?.({ sender: trusted });
        await handlers.get("account:cancel-sign-in")?.({ sender: trusted });
        expect(controller.retrySignIn).toHaveBeenCalledOnce();
        expect(controller.cancelSignIn).toHaveBeenCalledOnce();
        publish({ state: "signing-in" });
        expect(recipient.send).toHaveBeenCalledWith(ACCOUNT_CHANNELS.changed, { state: "signing-in" });

        dispose();
        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(ipcMain.removeHandler).toHaveBeenCalledTimes(Object.keys(ACCOUNT_CHANNELS).length - 1);
        expect(handlers.size).toBe(0);
    });
});
