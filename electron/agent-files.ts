import { randomUUID } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { AGENT_ATTACHMENTS_CUSTOM_TYPE, type PiAgentPromptFile } from "@/lib/agent/pi-agent-types";
import { classifyAgentAttachment, type AgentAttachmentKind } from "@/lib/agent/agent-attachments";

export type AgentFileInput = { name: string; mimeType: string; size: number; dataUrl?: string; sourcePath?: string };
export type AgentFileDescriptor = { handle: string; name: string; kind: AgentAttachmentKind; mimeType: string; size: number; sourcePath?: string };
export type AgentFileContent = AgentFileDescriptor & { dataUrl: string };

// Image view bounds, mirrored from Claude Code's auto-resize/recompress behavior so the
// `local_file_read` tool can return a typed image block without flooding the LLM transcript
// with raw bytes. Keep these aligned with pi-ai's provider image limits (typically ~5MB).
const MAX_LONG_EDGE_PX = 2048;
const TARGET_BYTES = 500 * 1024;
const HARD_LIMIT_BYTES = 5 * 1024 * 1024;

export type ImageForView = {
    mimeType: string;
    /** Base64-encoded image bytes (no data URL prefix). */
    base64: string;
    width: number;
    height: number;
    /** Size of the returned base64-decoded bytes, not the on-disk original. */
    sizeBytes: number;
    /** True when the original was resized or recompressed to fit the view budget. */
    transformed: boolean;
    /** True when the original exceeded HARD_LIMIT_BYTES and was returned as-is. */
    oversized: boolean;
};

export type ImageViewDetail = "high" | "original";

function rawImageForView(mimeType: string, originalBytes: Buffer, dimensions = { width: 0, height: 0 }): ImageForView {
    return {
        mimeType,
        base64: originalBytes.toString("base64"),
        width: dimensions.width,
        height: dimensions.height,
        sizeBytes: originalBytes.byteLength,
        transformed: false,
        oversized: originalBytes.byteLength > HARD_LIMIT_BYTES,
    };
}

/** Validate and prepare an image data URL for a typed Pi image result. */
export async function prepareImageForView(dataUrl: string, detail: ImageViewDetail = "high"): Promise<ImageForView | { error: string }> {
    const originalMatch = dataUrl.match(/^data:(image\/[^;,]+);base64,(.*)$/);
    if (!originalMatch) return { error: "图片 dataUrl 格式无效" };
    const originalBytes = Buffer.from(originalMatch[2], "base64");
    const mimeType = originalMatch[1];

    let nativeImage: typeof import("electron")["nativeImage"] | undefined;
    try {
        nativeImage = (await import("electron")).nativeImage;
    } catch {
        return rawImageForView(mimeType, originalBytes);
    }
    if (!nativeImage) return rawImageForView(mimeType, originalBytes);

    const decoded = nativeImage.createFromBuffer(originalBytes);
    if (decoded.isEmpty()) return { error: "图片解码失败" };
    const { width, height } = decoded.getSize();
    if (detail === "original") return rawImageForView(mimeType, originalBytes, { width, height });

    try {
        const longestEdge = Math.max(width, height);
        let working = decoded;
        let didResize = false;
        if (longestEdge > MAX_LONG_EDGE_PX) {
            const scale = MAX_LONG_EDGE_PX / longestEdge;
            working = decoded.resize({ width: Math.round(width * scale), quality: "best" });
            didResize = true;
        }
        let jpeg = working.toJPEG(80);
        if (jpeg.byteLength > TARGET_BYTES) jpeg = working.toJPEG(60);
        if (jpeg.byteLength > TARGET_BYTES) {
            const fallbackEdge = Math.min(1024, longestEdge);
            const scale = fallbackEdge / longestEdge;
            working = decoded.resize({ width: Math.round(width * scale), quality: "best" });
            didResize = true;
            jpeg = working.toJPEG(70);
        }
        const usedRecompress = jpeg.byteLength < originalBytes.byteLength;
        if (!usedRecompress) return rawImageForView(mimeType, originalBytes, { width, height });
        const finalDims = working.getSize();
        return {
            mimeType: "image/jpeg",
            base64: jpeg.toString("base64"),
            width: finalDims.width,
            height: finalDims.height,
            sizeBytes: jpeg.byteLength,
            transformed: didResize || usedRecompress,
            oversized: originalBytes.byteLength > HARD_LIMIT_BYTES,
        };
    } catch {
        return rawImageForView(mimeType, originalBytes, { width, height });
    }
}

/**
 * Decode a registry entry's image, downscale/recompress to fit the view budget, and
 * return base64 ready for a typed `ImageContent` block. Non-image kinds return an
 * error so the caller can fall back to a metadata-only response.
 *
 * When Electron's nativeImage is unavailable (test env, unsupported format), the
 * raw bytes are returned unchanged with `width: 0, height: 0` so the model still
 * sees the image — the caller should warn the user via the `oversized` flag.
 */
export async function readAsImageForView(handle: string, registry: { read: (handle: string) => Promise<{ ok: true; file: AgentFileContent } | { ok: false; error: string }> }): Promise<ImageForView | { error: string }> {
    const result = await registry.read(handle);
    if (!result.ok) return { error: result.error };
    const file = result.file;
    if (file.kind !== "image") return { error: `不支持的附件类型：${file.kind}（仅 image 支持视觉预览）` };

    const prepared = await prepareImageForView(file.dataUrl, "high");
    if ("error" in prepared && prepared.error.includes("dataUrl")) return { error: "附件 dataUrl 格式无效" };
    return prepared;
}

type RegistryOptions = { allowedRoots: string[] };

function pathWithin(path: string, root: string) {
    const fromRoot = relative(root, path);
    return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

export function createAgentFileRegistry(options: RegistryOptions) {
    const entries = new Map<string, AgentFileDescriptor & { dataUrl?: string; sourcePath?: string }>();
    const roots = options.allowedRoots.map((root) => resolve(root));

    const safePath = async (sourcePath: string, expectDirectory = false) => {
        if (!isAbsolute(sourcePath)) throw new Error("只允许读取绝对路径");
        const resolved = await realpath(sourcePath);
        const resolvedRoots = await Promise.all(roots.map((root) => realpath(root).catch(() => root)));
        if (!resolvedRoots.some((root) => pathWithin(resolved, root))) throw new Error("不允许访问该路径");
        const details = await stat(resolved);
        if (expectDirectory ? !details.isDirectory() : !details.isFile()) throw new Error(expectDirectory ? "路径不是文件夹" : "路径不是文件");
        return { path: resolved, details };
    };

    const register = async (files: AgentFileInput[]): Promise<AgentFileDescriptor[]> => {
        const descriptors: AgentFileDescriptor[] = [];
        for (const input of files) {
            const kind = classifyAgentAttachment(input.name, input.mimeType);
            if (!kind) throw new Error(`不支持的附件类型：${input.name}`);
            let sourcePath: string | undefined;
            let size = input.size;
            if (input.sourcePath) {
                const safe = await safePath(input.sourcePath);
                sourcePath = safe.path;
                size = safe.details.size;
            }
            const handle = randomUUID();
            const descriptor = { handle, name: input.name, kind, mimeType: input.mimeType || "application/octet-stream", size, ...(sourcePath ? { sourcePath } : {}), ...(input.dataUrl ? { dataUrl: input.dataUrl } : {}) };
            entries.set(handle, descriptor);
            descriptors.push({ handle, name: descriptor.name, kind: descriptor.kind, mimeType: descriptor.mimeType, size: descriptor.size, ...(sourcePath ? { sourcePath } : {}) });
        }
        return descriptors;
    };

    const read = async (handle: string): Promise<{ ok: true; file: AgentFileContent } | { ok: false; error: string }> => {
        const entry = entries.get(handle);
        if (!entry) return { ok: false, error: "附件句柄不存在或已过期" };
        try {
            const dataUrl = entry.dataUrl || (entry.sourcePath ? `data:${entry.mimeType};base64,${(await readFile((await safePath(entry.sourcePath)).path)).toString("base64")}` : "");
            if (!dataUrl) return { ok: false, error: "附件内容不可读取" };
            return { ok: true, file: { handle: entry.handle, name: entry.name, kind: entry.kind, mimeType: entry.mimeType, size: entry.size, dataUrl, ...(entry.sourcePath ? { sourcePath: entry.sourcePath } : {}) } };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    };

    const listFolder = async (sourcePath: string, recursive: boolean): Promise<{ ok: true; files: AgentFileDescriptor[] } | { ok: false; error: string }> => {
        try {
            const folder = await safePath(sourcePath, true);
            const paths: string[] = [];
            const visit = async (directory: string) => {
                for (const item of await readdir(directory, { withFileTypes: true })) {
                    const child = resolve(directory, item.name);
                    if (item.isDirectory() && recursive) await visit(child);
                    else if (item.isFile()) paths.push(child);
                }
            };
            await visit(folder.path);
            const supported = paths.filter((path) => classifyAgentAttachment(path, "") !== null);
            const descriptors: AgentFileDescriptor[] = [];
            for (const path of supported) {
                const details = await stat(path);
                const name = path.slice(path.lastIndexOf(sep) + 1);
                const kind = classifyAgentAttachment(name, "");
                if (!kind) continue;
                descriptors.push(...await register([{ name, mimeType: mimeFor(kind, name), size: details.size, sourcePath: path }]));
            }
            return { ok: true, files: descriptors };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    };

    return { register, read, listFolder, clear: () => entries.clear() };
}

export type AgentFileRegistry = ReturnType<typeof createAgentFileRegistry>;

export function mimeFor(kind: AgentAttachmentKind, name: string) {
    if (kind === "image") return `image/${name.toLowerCase().endsWith(".jpg") || name.toLowerCase().endsWith(".jpeg") ? "jpeg" : name.split(".").pop() || "png"}`;
    if (kind === "video") return `video/${name.split(".").pop() || "mp4"}`;
    if (kind === "audio") return `audio/${name.split(".").pop() || "mp3"}`;
    if (kind === "pdf") return "application/pdf";
    if (kind === "presentation") return name.toLowerCase().endsWith(".ppt") ? "application/vnd.ms-powerpoint" : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    if (kind === "spreadsheet") return name.toLowerCase().endsWith(".xls") ? "application/vnd.ms-excel" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (kind === "text") return "text/plain";
    if (kind === "file") return "application/octet-stream";
    return name.toLowerCase().endsWith(".gltf") ? "model/gltf+json" : "model/gltf-binary";
}

// ---------------------------------------------------------------------------
// 附件清单持久化：写入 session 自定义 entry（不参与 LLM 上下文，提示词里的
// 有界清单由 dispatchAgentPrompt 拼 Into text）。恢复历史时投影层按相邻用户消息归属。
// ---------------------------------------------------------------------------

export type AgentAttachmentManifestData = { projectId: string; files: Array<PiAgentPromptFile & { revision?: number }> };

export function attachmentsManifestData(projectId: string, files: PiAgentPromptFile[]): AgentAttachmentManifestData {
    return { projectId, files: files.map((file) => ({ ...file })) };
}

const ATTACHMENT_KINDS = new Set<string>(["image", "video", "audio", "pdf", "presentation", "spreadsheet", "glb", "text", "file"]);

function isBoundedRelativePath(value: unknown): value is string {
    if (typeof value !== "string" || !value) return false;
    if (isAbsolute(value) || value.startsWith("~")) return false;
    return value.split(/[\\/]/).every((segment) => segment && segment !== "." && segment !== "..");
}

export function parseAttachmentsManifestData(data: unknown): AgentAttachmentManifestData | null {
    if (typeof data !== "object" || data === null) return null;
    const { projectId, files } = data as { projectId?: unknown; files?: unknown };
    if (typeof projectId !== "string" || !projectId || !Array.isArray(files)) return null;
    const parsed: Array<PiAgentPromptFile & { revision?: number }> = [];
    for (const file of files) {
        if (typeof file !== "object" || file === null) return null;
        const entry = file as Record<string, unknown>;
        if (typeof entry.assetId !== "string" || !entry.assetId) return null;
        if (!isBoundedRelativePath(entry.relativePath)) return null;
        if (typeof entry.name !== "string" || !entry.name) return null;
        if (typeof entry.kind !== "string" || !ATTACHMENT_KINDS.has(entry.kind)) return null;
        if (typeof entry.mimeType !== "string" || !entry.mimeType) return null;
        if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) return null;
        if (entry.revision !== undefined && (typeof entry.revision !== "number" || !Number.isSafeInteger(entry.revision) || entry.revision < 1)) return null;
        parsed.push({
            assetId: entry.assetId,
            relativePath: entry.relativePath,
            name: entry.name,
            kind: entry.kind as AgentAttachmentKind,
            mimeType: entry.mimeType,
            size: entry.size,
            ...(entry.revision !== undefined ? { revision: entry.revision } : {}),
        });
    }
    return { projectId, files: parsed };
}

/** prompt 失败时把刚写入的清单标记为已作废：恢复历史时投影层绝不附着孤儿清单。 */
export function attachmentManifestAbortData(entryId: string): { abortedEntryId: string } {
    return { abortedEntryId: entryId };
}

export function parseAttachmentManifestAbort(data: unknown): string | null {
    if (typeof data !== "object" || data === null) return null;
    const { abortedEntryId } = data as { abortedEntryId?: unknown };
    return typeof abortedEntryId === "string" && abortedEntryId ? abortedEntryId : null;
}
