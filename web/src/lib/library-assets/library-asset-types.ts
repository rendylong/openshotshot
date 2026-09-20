// 素材库桥接类型：通道、桥接口与变更事件；记录类型从主进程 store 仅类型引用（运行时零依赖）。
import type {
    LibraryAssetImportInput,
    LibraryAssetReadInput,
    LibraryAssetRecord,
    LibraryAssetRef,
    LibraryAssetResult,
    LibraryAssetWriteInput,
} from "../../../../electron/library-asset-store";

export type { LibraryAssetImportInput, LibraryAssetReadInput, LibraryAssetRecord, LibraryAssetRef, LibraryAssetResult, LibraryAssetWriteInput };

export const LIBRARY_ASSET_CHANNELS = {
    list: "library-assets:list",
    write: "library-assets:write",
    importPath: "library-assets:import-path",
    read: "library-assets:read",
    stat: "library-assets:stat",
    remove: "library-assets:remove",
    markLegacyMigrated: "library-assets:mark-legacy-migrated",
    changed: "library-assets:changed",
} as const;

export type LibraryAssetBridgeResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type LibraryAssetChangedEvent = { type: "changed"; record: LibraryAssetRecord } | { type: "missing"; ref: LibraryAssetRef };

export type LibraryAssetsBridge = {
    list(): Promise<LibraryAssetBridgeResult<{ assets: LibraryAssetRecord[]; legacyMigratedAt?: string }>>;
    write(input: LibraryAssetWriteInput): Promise<LibraryAssetBridgeResult<LibraryAssetResult>>;
    importPath(input: LibraryAssetImportInput): Promise<LibraryAssetBridgeResult<LibraryAssetResult>>;
    read(input: LibraryAssetReadInput): Promise<LibraryAssetBridgeResult<{ bytes: Uint8Array; record: LibraryAssetRecord }>>;
    stat(input: LibraryAssetReadInput): Promise<LibraryAssetBridgeResult<{ status: "ready"; record: LibraryAssetRecord } | { status: "missing" }>>;
    remove(assetId: string): Promise<LibraryAssetBridgeResult<true>>;
    markLegacyMigrated(): Promise<LibraryAssetBridgeResult<true>>;
    onChanged(listener: (event: LibraryAssetChangedEvent) => void): () => void;
};
