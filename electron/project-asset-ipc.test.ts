import { describe, expect, it, vi } from "vitest";

import { PROJECT_ASSET_CHANNELS, type ProjectAssetRecord, type ProjectFileAssetRef } from "@/lib/project-assets/project-asset-types";
import { registerProjectAssetIpc } from "./project-asset-ipc";
import type { ProjectAssetStatResult, ProjectAssetWatchListener } from "./project-asset-store";

const trustedSender = { id: 1 };
const untrustedSender = { id: 2 };
const trustedEvent = { sender: trustedSender };
const untrustedEvent = { sender: untrustedSender };

const validRef: ProjectFileAssetRef = {
    backend: "project-file",
    assetId: "a-1",
    projectId: "p",
    relativePath: "assets/imported/a--00000000.png",
    revision: 1,
};
const record: ProjectAssetRecord = {
    ...validRef,
    originalName: "a.png",
    kind: "image",
    mimeType: "image/png",
    bytes: 3,
    sha256: "hash",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "canvas-import" },
};
const result = { record, ref: validRef };
const validRead = { workspacePath: "/ws", ref: validRef };
const validBytes = new Uint8Array([1, 2, 3]);
const validRestore = {
    projectId: "p",
    workspacePath: "/ws",
    assetId: "a-1",
    relativePath: "assets/imported/a--00000000.png",
    revision: 1,
    originalName: "a.png",
    kind: "image",
    mimeType: "image/png",
    bytes: validBytes,
    source: { type: "webdav-restore" },
};

function makeHarness() {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
        handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
            handlers.set(channel, handler);
        }),
        removeHandler: vi.fn((channel: string) => {
            handlers.delete(channel);
        }),
    };
    let watchListener: ProjectAssetWatchListener | undefined;
    const detachWatch = vi.fn();
    const store = {
        writeBytes: vi.fn(async () => result),
        importPath: vi.fn(async () => result),
        read: vi.fn(async () => ({ bytes: validBytes, record })),
        stat: vi.fn(async (): Promise<ProjectAssetStatResult> => ({ status: "ready", record })),
        restore: vi.fn(async () => result),
        watch: vi.fn(async (_projectId: string, _workspacePath: string, listener: ProjectAssetWatchListener) => {
            watchListener = listener;
            return detachWatch;
        }),
        unwatch: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
    };
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const recipient = {
        isDestroyed: () => false,
        send: vi.fn((channel: string, payload: unknown) => {
            sent.push({ channel, payload });
        }),
    };
    const dispose = registerProjectAssetIpc({
        ipcMain: ipcMain as never,
        store: store as never,
        isTrustedSender: (sender) => sender === (trustedSender as never),
        recipients: () => [recipient as never],
    });
    return { handlers, ipcMain, store, sent, detachWatch, dispose, watchListener: () => watchListener };
}

describe("project asset IPC", () => {
    it("registers exactly the seven invoke channels and keeps project-assets:changed send-only", () => {
        const { handlers, ipcMain } = makeHarness();
        expect([...handlers.keys()].sort()).toEqual([
            "project-assets:import-path",
            "project-assets:read",
            "project-assets:restore",
            "project-assets:stat",
            "project-assets:unwatch",
            "project-assets:watch",
            "project-assets:write",
        ]);
        expect(ipcMain.handle).toHaveBeenCalledTimes(7);
        expect(handlers.has(PROJECT_ASSET_CHANNELS.changed)).toBe(false);
    });

    it("rejects malformed byte writes before calling the store", async () => {
        const { handlers, store } = makeHarness();
        const handler = handlers.get("project-assets:write")!;
        await expect(handler(trustedEvent, { projectId: "p", bytes: "base64" })).resolves.toMatchObject({ ok: false });
        expect(store.writeBytes).not.toHaveBeenCalled();
    });

    it("rejects an untrusted renderer", async () => {
        const { handlers } = makeHarness();
        const handler = handlers.get("project-assets:read")!;
        await expect(handler(untrustedEvent, validRead)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("不受信任") });
    });

    it("rejects malformed watch, unwatch, and restore inputs before calling the store", async () => {
        const { handlers, store } = makeHarness();
        await expect(handlers.get(PROJECT_ASSET_CHANNELS.watch)!(trustedEvent, "", "/ws")).resolves.toMatchObject({ ok: false });
        await expect(handlers.get(PROJECT_ASSET_CHANNELS.unwatch)!(trustedEvent, 42)).resolves.toMatchObject({ ok: false });
        await expect(handlers.get(PROJECT_ASSET_CHANNELS.restore)!(trustedEvent, { ...validRestore, bytes: [1, 2, 3] })).resolves.toMatchObject({ ok: false });
        expect(store.watch).not.toHaveBeenCalled();
        expect(store.unwatch).not.toHaveBeenCalled();
        expect(store.restore).not.toHaveBeenCalled();
    });

    it("returns ok bridge results for write, a missing stat, and a failed read", async () => {
        const { handlers, store } = makeHarness();
        const writeInput = {
            projectId: "p",
            workspacePath: "/ws",
            name: "a.png",
            mimeType: "image/png",
            bytes: validBytes,
            source: { type: "canvas-import" },
        };
        await expect(handlers.get(PROJECT_ASSET_CHANNELS.write)!(trustedEvent, writeInput)).resolves.toEqual({ ok: true, value: result });
        expect(store.writeBytes).toHaveBeenCalledWith(writeInput);

        vi.mocked(store.stat).mockResolvedValue({ status: "missing" });
        await expect(handlers.get(PROJECT_ASSET_CHANNELS.stat)!(trustedEvent, validRead)).resolves.toEqual({ ok: true, value: { status: "missing" } });

        vi.mocked(store.read).mockRejectedValue(new Error("资产不在索引中：a-1"));
        await expect(handlers.get(PROJECT_ASSET_CHANNELS.read)!(trustedEvent, validRead)).resolves.toEqual({ ok: false, error: "资产不在索引中：a-1" });
    });

    it("forwards store watch events to recipients as the changed/missing union", async () => {
        const { handlers, store, sent, watchListener } = makeHarness();
        await handlers.get(PROJECT_ASSET_CHANNELS.watch)!(trustedEvent, "p", "/ws");
        expect(store.watch).toHaveBeenCalledWith("p", "/ws", expect.any(Function));

        watchListener()!(record);
        expect(sent).toEqual([{ channel: "project-assets:changed", payload: { type: "changed", record } }]);

        watchListener()!({ type: "missing", ref: validRef });
        expect(sent[1]?.payload).toEqual({ type: "missing", ref: validRef });
    });

    it("resolves unwatch and cleans up handlers and listeners on dispose", async () => {
        const { handlers, store, ipcMain, detachWatch, dispose } = makeHarness();
        await handlers.get(PROJECT_ASSET_CHANNELS.watch)!(trustedEvent, "p", "/ws");
        await expect(handlers.get(PROJECT_ASSET_CHANNELS.unwatch)!(trustedEvent, "p")).resolves.toEqual({ ok: true, value: true });
        expect(store.unwatch).toHaveBeenCalledWith("p");

        dispose();
        expect(ipcMain.removeHandler).toHaveBeenCalledTimes(7);
        expect(handlers.size).toBe(0);
        expect(detachWatch).toHaveBeenCalled();
    });
});
