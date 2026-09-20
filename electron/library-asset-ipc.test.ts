import { describe, expect, it, vi } from "vitest";

import { LIBRARY_ASSET_CHANNELS, type LibraryAssetRecord } from "@/lib/library-assets/library-asset-types";
import { registerLibraryAssetIpc } from "./library-asset-ipc";
import type { LibraryAssetStore } from "./library-asset-store";

const trustedSender = { id: 1 } as never;
const untrustedSender = { id: 2 } as never;

function makeHarness(store: Partial<LibraryAssetStore>) {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const fullStore = { watch: vi.fn().mockResolvedValue(() => undefined), close: vi.fn().mockResolvedValue(undefined), ...store } as LibraryAssetStore;
    const dispose = registerLibraryAssetIpc({
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler as never), removeHandler: (channel) => handlers.delete(channel) },
        store: fullStore,
        isTrustedSender: (sender) => sender === trustedSender,
        recipients: () => [{ isDestroyed: () => false, send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } as never],
    });
    const invoke = (channel: string, sender: unknown, ...args: unknown[]) => handlers.get(channel)?.({ sender }, ...args) as Promise<unknown>;
    return { dispose, invoke, handlers, sent };
}

describe("library asset ipc", () => {
    it("未注册 dispose 后 handler 清空", async () => {
        const harness = makeHarness({});
        expect(harness.handlers.size).toBeGreaterThan(0);
        harness.dispose();
        expect(harness.handlers.size).toBe(0);
    });

    it("不受信任的 sender 一律拒绝", async () => {
        const harness = makeHarness({ list: async () => ({ assets: [] }) });
        const result = (await harness.invoke(LIBRARY_ASSET_CHANNELS.list, untrustedSender)) as { ok: boolean; error: string };
        expect(result.ok).toBe(false);
        expect(result.error).toContain("不受信任");
    });

    it("list/write 透传 store，write 校验输入类型", async () => {
        const record = { assetId: "a1", revision: 1 } as LibraryAssetRecord;
        const write = vi.fn().mockResolvedValue({ record, ref: { backend: "library-file" } });
        const harness = makeHarness({ list: async () => ({ assets: [record] }), write: write as never });
        const listed = (await harness.invoke(LIBRARY_ASSET_CHANNELS.list, trustedSender)) as { ok: boolean };
        expect(listed.ok).toBe(true);
        const badInput = { name: "a.png", mimeType: "image/png", bytes: "not-bytes", title: "a" };
        const invalid = (await harness.invoke(LIBRARY_ASSET_CHANNELS.write, trustedSender, badInput)) as { ok: boolean; error: string };
        expect(invalid.ok).toBe(false);
        expect(write).not.toHaveBeenCalled();
        const bytes = new Uint8Array([1]);
        const valid = (await harness.invoke(LIBRARY_ASSET_CHANNELS.write, trustedSender, { name: "a.png", mimeType: "image/png", bytes, title: "a", tags: ["t"], source: "Agent" })) as { ok: boolean };
        expect(valid.ok).toBe(true);
        expect(write).toHaveBeenCalledWith(expect.objectContaining({ name: "a.png", bytes }));
    });

    it("write 成功后 store watch 监听器的 changed 事件经 changed 通道广播", async () => {
        const record = { assetId: "a1", revision: 1 } as LibraryAssetRecord;
        const write = vi.fn().mockResolvedValue({ record, ref: { backend: "library-file" } });
        let listener: ((event: unknown) => void) | undefined;
        const harness = makeHarness({
            list: async () => ({ assets: [record] }),
            write: write as never,
            watch: vi.fn(async (captured: (event: unknown) => void) => {
                listener = captured;
                return () => undefined;
            }) as never,
        });
        const valid = (await harness.invoke(LIBRARY_ASSET_CHANNELS.write, trustedSender, { name: "a.png", mimeType: "image/png", bytes: new Uint8Array([1]), title: "a" })) as { ok: boolean };
        expect(valid.ok).toBe(true);
        expect(listener).toBeTruthy();
        const event = { type: "changed", record } as const;
        listener?.(event);
        expect(harness.sent).toContainEqual({ channel: LIBRARY_ASSET_CHANNELS.changed, payload: event });
    });

    it("store 抛错转为 { ok:false, error }", async () => {
        const harness = makeHarness({ remove: async () => { throw new Error("素材不在索引中：x"); } });
        const result = (await harness.invoke(LIBRARY_ASSET_CHANNELS.remove, trustedSender, "x")) as { ok: boolean; error: string };
        expect(result.ok).toBe(false);
        expect(result.error).toContain("素材不在索引");
    });

    it("markLegacyMigrated 透传 store，错误转 { ok:false }", async () => {
        const markLegacyMigrated = vi.fn().mockResolvedValue(undefined);
        const harness = makeHarness({ markLegacyMigrated: markLegacyMigrated as never });
        const ok = (await harness.invoke(LIBRARY_ASSET_CHANNELS.markLegacyMigrated, trustedSender)) as { ok: boolean };
        expect(harness.handlers.has(LIBRARY_ASSET_CHANNELS.markLegacyMigrated)).toBe(true);
        expect(ok.ok).toBe(true);
        expect(markLegacyMigrated).toHaveBeenCalledTimes(1);
        const failing = makeHarness({ markLegacyMigrated: async () => { throw new Error("manifest 写入失败"); } });
        const bad = (await failing.invoke(LIBRARY_ASSET_CHANNELS.markLegacyMigrated, trustedSender)) as { ok: boolean; error: string };
        expect(bad.ok).toBe(false);
        expect(bad.error).toContain("manifest");
    });

    it("read 收到 { ref } 时解包内层 ref（与 preload 透传契约一致）", async () => {
        const read = vi.fn().mockResolvedValue({ bytes: new Uint8Array(), record: { assetId: "a1" } });
        const harness = makeHarness({ read: read as never });
        const ref = { backend: "library-file", assetId: "a1", relativePath: "a.png", revision: 1 };
        await harness.invoke(LIBRARY_ASSET_CHANNELS.read, trustedSender, { ref });
        expect(read).toHaveBeenCalledWith({ ref });
    });
});
