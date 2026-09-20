// electron/library-asset-ipc.ts
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";

import { LIBRARY_ASSET_CHANNELS, type LibraryAssetChangedEvent, type LibraryAssetsBridge } from "@/lib/library-assets/library-asset-types";
import type { LibraryAssetStore } from "./library-asset-store";

type LibraryAssetIpcOptions = {
    ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
    store: LibraryAssetStore;
    isTrustedSender(sender: WebContents): boolean;
    recipients(): WebContents[];
};

type LibraryAssetBridgeResponse = { ok: true; value: unknown } | { ok: false; error: string };

const INVALID_INPUT = "无效的素材库参数";
const UNTRUSTED_SENDER_ERROR = "不受信任的渲染进程";

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const parseString = (value: unknown): string => {
    if (!isNonEmptyString(value)) throw new Error(INVALID_INPUT);
    return value;
};
const parseLooseString = (value: unknown): string => {
    if (typeof value !== "string") throw new Error(INVALID_INPUT);
    return value;
};
const parseOptionalString = (value: unknown): string | undefined => {
    if (value !== undefined && typeof value !== "string") throw new Error(INVALID_INPUT);
    return value;
};
const parseBytes = (value: unknown): Uint8Array => {
    if (!(value instanceof Uint8Array)) throw new Error(INVALID_INPUT);
    return value;
};
const parseTags = (value: unknown): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(INVALID_INPUT);
    return value as string[];
};
const parseRef = (value: unknown) => {
    if (!value || typeof value !== "object") throw new Error(INVALID_INPUT);
    const ref = value as Record<string, unknown>;
    if (ref.backend !== "library-file" || !isNonEmptyString(ref.assetId) || !isNonEmptyString(ref.relativePath) || typeof ref.revision !== "number" || !Number.isInteger(ref.revision)) {
        throw new Error(INVALID_INPUT);
    }
    return { backend: "library-file" as const, assetId: ref.assetId, relativePath: ref.relativePath, revision: ref.revision };
};
const parseWriteInput = (value: unknown) => {
    if (!value || typeof value !== "object") throw new Error(INVALID_INPUT);
    const input = value as Record<string, unknown>;
    return {
        name: parseString(input.name),
        mimeType: parseLooseString(input.mimeType),
        bytes: parseBytes(input.bytes),
        title: parseLooseString(input.title),
        tags: parseTags(input.tags),
        source: parseOptionalString(input.source),
        note: parseOptionalString(input.note),
        assetId: parseOptionalString(input.assetId),
        createdAt: parseOptionalString(input.createdAt),
    };
};
const parseImportInput = (value: unknown) => {
    if (!value || typeof value !== "object") throw new Error(INVALID_INPUT);
    const input = value as Record<string, unknown>;
    return {
        sourcePath: parseString(input.sourcePath),
        title: parseLooseString(input.title),
        tags: parseTags(input.tags),
        source: parseOptionalString(input.source),
        note: parseOptionalString(input.note),
    };
};

/** 注册 library-assets:* 通道；注册即 ensure + watch 并向全部窗口广播变更。返回 dispose。 */
export function registerLibraryAssetIpc(options: LibraryAssetIpcOptions): () => void {
    const fail = (error: unknown): LibraryAssetBridgeResponse => ({ ok: false, error: error instanceof Error ? error.message : String(error) });
    const guarded = async (event: IpcMainInvokeEvent, run: () => Promise<unknown>): Promise<LibraryAssetBridgeResponse> => {
        if (!options.isTrustedSender(event.sender)) return fail(new Error(UNTRUSTED_SENDER_ERROR));
        try {
            return { ok: true, value: await run() };
        } catch (error) {
            return fail(error);
        }
    };
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>();
    handlers.set(LIBRARY_ASSET_CHANNELS.list, (event) => guarded(event, () => options.store.list()));
    handlers.set(LIBRARY_ASSET_CHANNELS.write, (event, input) => guarded(event, () => options.store.write(parseWriteInput(input))));
    handlers.set(LIBRARY_ASSET_CHANNELS.importPath, (event, input) => guarded(event, () => options.store.importPath(parseImportInput(input))));
    handlers.set(LIBRARY_ASSET_CHANNELS.read, (event, input) => guarded(event, () => options.store.read({ ref: parseRef((input as { ref?: unknown })?.ref ?? input) })));
    handlers.set(LIBRARY_ASSET_CHANNELS.stat, (event, input) => guarded(event, () => options.store.stat({ ref: parseRef((input as { ref?: unknown })?.ref ?? input) })));
    handlers.set(LIBRARY_ASSET_CHANNELS.remove, (event, assetId) => guarded(event, () => options.store.remove(parseString(assetId)).then(() => true as const)));
    handlers.set(LIBRARY_ASSET_CHANNELS.markLegacyMigrated, (event) => guarded(event, () => options.store.markLegacyMigrated().then(() => true as const)));
    for (const [channel, handler] of handlers) options.ipcMain.handle(channel, handler);

    const unsubscribeWatch = options.store.watch((event) => {
        const payload: LibraryAssetChangedEvent = event.type === "changed" ? { type: "changed", record: event.record } : { type: "missing", ref: event.ref };
        for (const recipient of options.recipients()) {
            if (!recipient.isDestroyed()) recipient.send(LIBRARY_ASSET_CHANNELS.changed, payload);
        }
    }).catch(() => undefined);

    return () => {
        void unsubscribeWatch.then((unsubscribe) => unsubscribe?.()).catch(() => undefined);
        for (const [channel] of handlers) options.ipcMain.removeHandler(channel);
    };
}

// 供 preload/类型对齐参考：桥接方法与通道映射（运行时不使用，仅类型导出消费方可见）。
export type LibraryAssetIpcBridgeContract = LibraryAssetsBridge;
