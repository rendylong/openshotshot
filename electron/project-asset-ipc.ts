// electron/project-asset-ipc.ts
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";

import {
    PROJECT_ASSET_CHANNELS,
    type ProjectAssetChangedEvent,
    type ProjectAssetSource,
    type ProjectFileAssetRef,
} from "@/lib/project-assets/project-asset-types";
import type {
    ProjectAssetImportPathInput,
    ProjectAssetReadInput,
    ProjectAssetRestoreInput,
    ProjectAssetStore,
    ProjectAssetWatchEvent,
    ProjectAssetWriteInput,
} from "./project-asset-store";

type ProjectAssetIpcOptions = {
    ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
    store: ProjectAssetStore;
    isTrustedSender(sender: WebContents): boolean;
    recipients(): WebContents[];
};

type ProjectAssetBridgeResponse = { ok: true; value: unknown } | { ok: false; error: string };

const PROJECT_ASSET_SOURCE_TYPES = new Set<string>(["agent-attachment", "canvas-import", "generated", "derived", "legacy-migration", "webdav-restore"]);
const PROJECT_ASSET_SOURCE_ROLES = new Set<string>(["entity-reference", "storyboard", "video", "dialogue", "sfx"]);
const PROJECT_ASSET_KINDS = new Set<string>(["image", "video", "audio", "pdf", "presentation", "spreadsheet", "model3d", "text", "other"]);

const INVALID_INPUT = "无效的项目资产参数";

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

const parseInt32 = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(INVALID_INPUT);
    return value;
};

const parseBytes = (value: unknown): Uint8Array => {
    if (!(value instanceof Uint8Array)) throw new Error(INVALID_INPUT);
    return value;
};

const parseSource = (value: unknown): ProjectAssetSource => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(INVALID_INPUT);
    const source = value as ProjectAssetSource;
    if (!PROJECT_ASSET_SOURCE_TYPES.has(source.type)) throw new Error(INVALID_INPUT);
    for (const field of [source.canvasId, source.nodeId, source.scriptNodeId, source.shotId]) {
        if (field !== undefined && typeof field !== "string") throw new Error(INVALID_INPUT);
    }
    if (source.role !== undefined && !PROJECT_ASSET_SOURCE_ROLES.has(source.role)) throw new Error(INVALID_INPUT);
    if (source.version !== undefined && (typeof source.version !== "number" || !Number.isInteger(source.version))) throw new Error(INVALID_INPUT);
    return source;
};

const parseRef = (value: unknown): ProjectFileAssetRef => {
    if (!value || typeof value !== "object") throw new Error(INVALID_INPUT);
    const ref = value as ProjectFileAssetRef;
    if (
        ref.backend !== "project-file" ||
        !isNonEmptyString(ref.assetId) ||
        !isNonEmptyString(ref.projectId) ||
        !isNonEmptyString(ref.relativePath) ||
        typeof ref.revision !== "number" ||
        !Number.isInteger(ref.revision)
    ) throw new Error(INVALID_INPUT);
    return ref;
};

const parseReadInput = (value: unknown): ProjectAssetReadInput => {
    if (!value || typeof value !== "object") throw new Error(INVALID_INPUT);
    const input = value as ProjectAssetReadInput;
    return { workspacePath: parseString(input.workspacePath), ref: parseRef(input.ref) };
};

const parseWriteInput = (value: unknown): ProjectAssetWriteInput => {
    if (!value || typeof value !== "object") throw new Error(INVALID_INPUT);
    const input = value as ProjectAssetWriteInput;
    return {
        projectId: parseString(input.projectId),
        workspacePath: parseString(input.workspacePath),
        name: parseString(input.name),
        mimeType: parseLooseString(input.mimeType),
        bytes: parseBytes(input.bytes),
        source: parseSource(input.source),
    };
};

const parseImportPathInput = (value: unknown): ProjectAssetImportPathInput => {
    if (!value || typeof value !== "object") throw new Error(INVALID_INPUT);
    const input = value as ProjectAssetImportPathInput;
    return {
        projectId: parseString(input.projectId),
        workspacePath: parseString(input.workspacePath),
        name: parseString(input.name),
        mimeType: parseLooseString(input.mimeType),
        sourcePath: parseString(input.sourcePath),
        source: parseSource(input.source),
    };
};

const parseRestoreInput = (value: unknown): ProjectAssetRestoreInput => {
    if (!value || typeof value !== "object") throw new Error(INVALID_INPUT);
    const input = value as ProjectAssetRestoreInput;
    if (input.kind === undefined || !PROJECT_ASSET_KINDS.has(input.kind)) throw new Error(INVALID_INPUT);
    return {
        projectId: parseString(input.projectId),
        workspacePath: parseString(input.workspacePath),
        assetId: parseString(input.assetId),
        relativePath: parseString(input.relativePath),
        revision: parseInt32(input.revision),
        originalName: parseString(input.originalName),
        kind: input.kind,
        mimeType: parseLooseString(input.mimeType),
        bytes: parseBytes(input.bytes),
        sha256: parseOptionalString(input.sha256),
        createdAt: parseOptionalString(input.createdAt),
        source: parseSource(input.source),
    };
};

export function registerProjectAssetIpc(options: ProjectAssetIpcOptions): () => void {
    const unsubscribers = new Set<() => void>();
    const fail = (error: unknown): ProjectAssetBridgeResponse => ({ ok: false, error: error instanceof Error ? error.message : String(error) });
    const guarded = async (event: IpcMainInvokeEvent, run: () => Promise<unknown>): Promise<ProjectAssetBridgeResponse> => {
        if (!options.isTrustedSender(event.sender)) return fail(new Error("不受信任的渲染进程"));
        try {
            return { ok: true, value: await run() };
        } catch (error) {
            return fail(error);
        }
    };
    const forward = (event: ProjectAssetWatchEvent): void => {
        const payload: ProjectAssetChangedEvent = "type" in event ? { type: "missing", ref: event.ref } : { type: "changed", record: event };
        for (const recipient of options.recipients()) {
            if (!recipient.isDestroyed()) recipient.send(PROJECT_ASSET_CHANNELS.changed, payload);
        }
    };
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>();
    handlers.set(PROJECT_ASSET_CHANNELS.write, (event, input) => guarded(event, () => options.store.writeBytes(parseWriteInput(input))));
    handlers.set(PROJECT_ASSET_CHANNELS.importPath, (event, input) => guarded(event, () => options.store.importPath(parseImportPathInput(input))));
    handlers.set(PROJECT_ASSET_CHANNELS.read, (event, input) => guarded(event, () => options.store.read(parseReadInput(input))));
    handlers.set(PROJECT_ASSET_CHANNELS.stat, (event, input) => guarded(event, () => options.store.stat(parseReadInput(input))));
    handlers.set(PROJECT_ASSET_CHANNELS.restore, (event, input) => guarded(event, () => options.store.restore(parseRestoreInput(input))));
    handlers.set(PROJECT_ASSET_CHANNELS.watch, (event, projectId, workspacePath) => guarded(event, async () => {
        const unsubscribe = await options.store.watch(parseString(projectId), parseString(workspacePath), forward);
        unsubscribers.add(unsubscribe);
        return true;
    }));
    handlers.set(PROJECT_ASSET_CHANNELS.unwatch, (event, projectId) => guarded(event, () => options.store.unwatch(parseString(projectId)).then(() => true)));
    for (const [channel, handler] of handlers) options.ipcMain.handle(channel, handler);
    return () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
        unsubscribers.clear();
        for (const [channel] of handlers) options.ipcMain.removeHandler(channel);
    };
}
