// 桥接输入/结果类型与主进程 store 共用同一份定义（仅类型引用，运行时零依赖）。
import type {
    ProjectAssetImportPathInput,
    ProjectAssetResult,
    ProjectAssetRestoreInput,
    ProjectAssetWriteInput,
} from "../../../../electron/project-asset-store";

export type ProjectAssetKind = "image" | "video" | "audio" | "pdf" | "presentation" | "spreadsheet" | "model3d" | "text" | "other";

export type ProjectAssetSource = {
    type: "agent-attachment" | "canvas-import" | "generated" | "derived" | "legacy-migration" | "webdav-restore";
    canvasId?: string;
    nodeId?: string;
    scriptNodeId?: string;
    shotId?: string;
    role?: "entity-reference" | "storyboard" | "video" | "dialogue" | "sfx";
    version?: number;
};

export type ProjectFileAssetRef = {
    backend: "project-file";
    assetId: string;
    projectId: string;
    relativePath: string;
    revision: number;
};

export type IndexedDbAssetRef = { backend: "indexeddb"; storageKey: string };
export type CanvasAssetRef = ProjectFileAssetRef | IndexedDbAssetRef;

/** 结构判断：数据中的匿名对象是否为可携带的 project-file assetRef（不含本机绝对路径字段）。 */
export function isProjectFileAssetRef(value: unknown): value is ProjectFileAssetRef {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return (
        candidate.backend === "project-file" &&
        typeof candidate.assetId === "string" &&
        typeof candidate.projectId === "string" &&
        typeof candidate.relativePath === "string" &&
        typeof candidate.revision === "number"
    );
}

/** 深度收集数据中的 project-file assetRef；同一 projectId+assetId 去重，先出现者优先。 */
export function collectProjectAssetRefs(value: unknown, refs = new Map<string, ProjectFileAssetRef>()): ProjectFileAssetRef[] {
    if (!value || typeof value !== "object") return [...refs.values()];
    if (isProjectFileAssetRef(value)) {
        const key = `${value.projectId}:${value.assetId}`;
        if (!refs.has(key)) refs.set(key, value);
        return [...refs.values()];
    }
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectProjectAssetRefs(child, refs)) : collectProjectAssetRefs(item, refs)));
    return [...refs.values()];
}

/** 深度不可变改写：match 命中的 project-file ref 替换为 replace 结果，其余结构与对象原样保留（无命中返回原引用）。 */
export function rewriteProjectAssetRefs<T>(value: T, match: (ref: ProjectFileAssetRef) => boolean, replace: (ref: ProjectFileAssetRef) => CanvasAssetRef): T {
    if (Array.isArray(value)) {
        let changed = false;
        const next = value.map((item) => {
            const rewritten = rewriteProjectAssetRefs(item, match, replace);
            if (rewritten !== item) changed = true;
            return rewritten;
        });
        return (changed ? next : value) as T;
    }
    if (!value || typeof value !== "object") return value;
    if (isProjectFileAssetRef(value)) return (match(value) ? replace(value) : value) as T;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        const rewritten = rewriteProjectAssetRefs(item, match, replace);
        next[key] = rewritten;
        if (rewritten !== item) changed = true;
    }
    return (changed ? next : value) as T;
}

export type ProjectAssetRecord = ProjectFileAssetRef & {
    originalName: string;
    kind: ProjectAssetKind;
    mimeType: string;
    bytes: number;
    sha256: string;
    createdAt: string;
    updatedAt: string;
    source: ProjectAssetSource;
};

export type ProjectAssetManifest = {
    app: "shotshot";
    version: 1;
    projectId: string;
    assets: ProjectAssetRecord[];
};

export const PROJECT_ASSET_CHANNELS = {
    write: "project-assets:write",
    importPath: "project-assets:import-path",
    read: "project-assets:read",
    stat: "project-assets:stat",
    restore: "project-assets:restore",
    watch: "project-assets:watch",
    unwatch: "project-assets:unwatch",
    changed: "project-assets:changed",
    /** 与 project:ensure-workspace 同族，由 electron/project-workspace.ts 注册处理。 */
    relocateWorkspace: "project:relocate-workspace",
} as const;

export type ProjectAssetBridgeResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** `project-assets:changed` 事件：manifest 已知资产变更携带完整 record，文件丢失只携带 ref。 */
export type ProjectAssetChangedEvent = { type: "changed"; record: ProjectAssetRecord } | { type: "missing"; ref: ProjectFileAssetRef };

/** 工作区迁移入参：复制 sourcePath 全部项目文件到 targetPath，校验 manifest 完整后才返回可绑定路径。 */
export type ProjectWorkspaceRelocationInput = { projectId: string; sourcePath: string; targetPath: string };

export type ProjectWorkspaceRelocationResult = { ok: true; path: string } | { ok: false; error: string };

export type ProjectAssetsBridge = {
    write(input: ProjectAssetWriteInput): Promise<ProjectAssetBridgeResult<ProjectAssetResult>>;
    importPath(input: ProjectAssetImportPathInput): Promise<ProjectAssetBridgeResult<ProjectAssetResult>>;
    read(input: { workspacePath: string; ref: ProjectFileAssetRef }): Promise<ProjectAssetBridgeResult<{ bytes: Uint8Array; record: ProjectAssetRecord }>>;
    stat(input: { workspacePath: string; ref: ProjectFileAssetRef }): Promise<ProjectAssetBridgeResult<{ status: "ready"; record: ProjectAssetRecord } | { status: "missing" }>>;
    restore(input: ProjectAssetRestoreInput): Promise<ProjectAssetBridgeResult<ProjectAssetResult>>;
    watch(projectId: string, workspacePath: string): Promise<ProjectAssetBridgeResult<true>>;
    unwatch(projectId: string): Promise<void>;
    onChanged(listener: (event: ProjectAssetChangedEvent) => void): () => void;
    /** 更改目录：非破坏性迁移（复制 + 校验），成功结果才是允许绑定的新工作区 realpath。 */
    relocateWorkspace(input: ProjectWorkspaceRelocationInput): Promise<ProjectWorkspaceRelocationResult>;
};

const EXTENSION_KIND: Record<string, ProjectAssetKind> = {
    png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image", avif: "image",
    mp4: "video", webm: "video", mov: "video", m4v: "video",
    mp3: "audio", wav: "audio", m4a: "audio", aac: "audio", ogg: "audio", flac: "audio",
    pdf: "pdf",
    ppt: "presentation", pptx: "presentation",
    xls: "spreadsheet", xlsx: "spreadsheet",
    glb: "model3d", gltf: "model3d",
    md: "text", markdown: "text", txt: "text",
};

/** MIME-first classification with extension fallback; unmatched files are `other`（不是图片，也不内联给模型）。 */
export function classifyProjectAsset(name: string, mimeType = ""): ProjectAssetKind {
    const mime = mimeType.toLowerCase().split(";", 1)[0];
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    if (mime === "application/pdf") return "pdf";
    if (mime.startsWith("text/")) return "text";
    if (mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || mime === "application/vnd.ms-powerpoint") return "presentation";
    if (mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || mime === "application/vnd.ms-excel") return "spreadsheet";
    if (mime === "model/gltf-binary" || mime === "model/gltf+json") return "model3d";
    const extension = name.toLowerCase().split(".").pop() || "";
    return EXTENSION_KIND[extension] || "other";
}

const KIND_DIRECTORY: Record<ProjectAssetKind, string> = {
    image: "images",
    video: "videos",
    audio: "audio",
    model3d: "models",
    pdf: "documents",
    presentation: "documents",
    spreadsheet: "documents",
    text: "documents",
    other: "documents",
};

/** 按来源与媒体类别路由目录；画布/脚本 id 不进入路径。 */
export function projectAssetDirectory(source: ProjectAssetSource, kind: ProjectAssetKind): string {
    const kindDir = KIND_DIRECTORY[kind];
    if (source.type === "generated") return `assets/generated/${kindDir}`;
    if (source.type === "derived") return `assets/derived/${kindDir}`;
    return "assets/imported";
}
