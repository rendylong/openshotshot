import { describe, expect, it, vi } from "vitest";
import { APP_RELEASE_CHANNELS } from "../web/src/lib/desktop/app-release-bridge";
import { registerAppReleaseIpc } from "./app-release-ipc";
import type { AppReleaseController } from "./app-release-controller";

const STATE = { status: "idle", policy: null, checkedAt: null };

function harness(options: { trusted: boolean } = { trusted: true }) {
    const registered = new Map<string, (event: { sender: unknown }) => unknown>();
    const ipcMain = {
        handle: vi.fn((channel: string, handler: (event: { sender: unknown }) => unknown) => registered.set(channel, handler)),
        removeHandler: vi.fn((channel: string) => registered.delete(channel)),
    };
    const controller: AppReleaseController = {
        getState: vi.fn(() => STATE as never),
        refresh: vi.fn(async () => STATE as never),
        openDownload: vi.fn(async () => undefined),
        subscribe: vi.fn(() => () => undefined),
        start: vi.fn(async () => undefined),
        dispose: vi.fn(),
    };
    const isTrustedSender = vi.fn(() => options.trusted);
    const dispose = registerAppReleaseIpc({
        ipcMain: ipcMain as never,
        controller,
        isTrustedSender,
        recipients: () => [],
    });
    return { registered, controller, isTrustedSender, dispose, ipcMain };
}

describe("registerAppReleaseIpc", () => {
    it("registers all three channels", () => {
        const { registered } = harness();
        expect([...registered.keys()].sort()).toEqual([APP_RELEASE_CHANNELS.getState, APP_RELEASE_CHANNELS.openDownload, APP_RELEASE_CHANNELS.refresh].sort());
    });

    it("rejects untrusted senders", async () => {
        const { registered } = harness({ trusted: false });
        expect(() => registered.get(APP_RELEASE_CHANNELS.getState)?.({ sender: {} })).toThrow("untrusted_ipc_sender");
        await expect(registered.get(APP_RELEASE_CHANNELS.refresh)?.({ sender: {} })).rejects.toThrow("untrusted_ipc_sender");
    });

    it("trusted getState returns controller state", () => {
        const { registered, controller } = harness();
        expect(registered.get(APP_RELEASE_CHANNELS.getState)?.({ sender: {} })).toBe(controller.getState());
    });

    it("dispose removes handlers", () => {
        const { dispose, registered } = harness();
        dispose();
        expect(registered.size).toBe(0);
    });
});
