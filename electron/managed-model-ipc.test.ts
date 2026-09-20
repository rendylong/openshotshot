import { describe, expect, test, vi } from "vitest";
import { MANAGED_MODEL_CHANNELS } from "../web/src/lib/desktop/managed-model-types";
import { registerManagedModelIpc } from "./managed-model-ipc";

describe("managed model IPC", () => {
    test("isolates aborts by sender and cleans up handlers", async () => {
        const handlers = new Map<string, (...args: any[]) => unknown>();
        const ipcMain = {
            handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler)),
            removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
        };
        const listeners = new Map<string, () => void>();
        const sender = { id: 1, once: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)), off: vi.fn() };
        const other = { id: 2, once: vi.fn(), off: vi.fn() };
        let observedSignal: AbortSignal | undefined;
        let resolve!: (value: unknown) => void;
        const client = {
            listModels: vi.fn(async () => []),
            request: vi.fn((_request, signal) => { observedSignal = signal; return new Promise((done) => { resolve = done; }); }),
            discardTemporaryFile: vi.fn(async () => undefined),
        };
        const dispose = registerManagedModelIpc({ ipcMain: ipcMain as never, client: client as never, isTrustedSender: (value) => value === sender as unknown });
        const request = { id: "req-1", path: "/v1/responses", method: "POST", timeoutClass: "text" };
        const pending = handlers.get(MANAGED_MODEL_CHANNELS.fetch)?.({ sender }, request);

        await expect(handlers.get(MANAGED_MODEL_CHANNELS.abort)?.({ sender: other }, "req-1")).rejects.toThrow("untrusted_ipc_sender");
        await handlers.get(MANAGED_MODEL_CHANNELS.abort)?.({ sender }, "req-1");
        expect(observedSignal?.aborted).toBe(true);
        resolve({ id: "req-1", status: 200, statusText: "OK", headers: {}, body: { kind: "text", value: "ok" } });
        await pending;

        dispose();
        expect(ipcMain.removeHandler).toHaveBeenCalledTimes(3);
        expect(handlers.size).toBe(0);
    });
});
