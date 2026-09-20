import { saveAs } from "file-saver";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { createZip, readZip } from "@/lib/zip";
import { migrateLegacyProject } from "@/lib/canvas/project-model";
import { collectProjectAssetRefs, classifyProjectAsset, rewriteProjectAssetRefs, type CanvasAssetRef, type ProjectAssetRecord } from "@/lib/project-assets/project-asset-types";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import { getCanvasAssetBlob, readSyncedProjectAsset, restoreSyncedAsset } from "@/services/project-asset-storage";
import type { CanvasExportAsset, CanvasExportFile, CanvasProjectExportItem } from "@/types/canvas-export";
import type { Project } from "@/types/project";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { useProjectStore } from "@/stores/canvas/use-project-store";

/** 导出清单条目：旧 IndexedDB 文件记录 + 项目文件资产 record（可移植，不含本机绝对路径）。 */
type CanvasProjectArchiveItem = CanvasProjectExportItem & { assets?: ProjectAssetRecord[] };

export async function exportCanvasProjects(projects: Project[], fileName = i18n.t("canvas.export.defaultProjectName")) {
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const exportedProjects = await Promise.all(
        projects.map(async (project) => {
            const files: CanvasExportAsset[] = [];
            const assets: ProjectAssetRecord[] = [];
            await Promise.all([
                ...collectStorageKeys(project).map(async (storageKey) => {
                    const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
                    if (!blob) return;
                    const path = `projects/${project.id}/files/${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`;
                    files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
                    zipFiles.push({ name: path, data: blob });
                }),
                ...collectProjectAssetRefs(project).map(async (ref) => {
                    const record = await readSyncedProjectAsset(ref);
                    if (!record) return;
                    const path = `projects/${project.id}/files/${record.record.relativePath}`;
                    assets.push(record.record);
                    zipFiles.push({ name: path, data: record.blob });
                }),
            ]);
            const item: CanvasProjectArchiveItem = { project: portableProject(project), files, assets };
            return item;
        }),
    );

    const data: CanvasExportFile = { app: "shotshot", version: 3, exportedAt: new Date().toISOString(), projects: exportedProjects };
    const zip = await createZip([{ name: "projects.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    saveAs(zip, `${safeFileName(fileName)}.zip`);
}

/** 解析项目 ZIP 归档：先物化全部媒体（桌面经 projectAssets.restore / IndexedDB 直写），再提交导入的项目记录。 */
export async function importCanvasProjects(file: Blob): Promise<string[]> {
    const entries = await readZip(file);
    const manifestEntry = entries.get("projects.json");
    if (!manifestEntry) throw new Error("Project archive is missing projects.json");
    const parsed = JSON.parse(await manifestEntry.text()) as { app?: string; version?: number; projects?: CanvasProjectArchiveItem[] };
    if (parsed.app !== "shotshot" || parsed.version !== 3 || !Array.isArray(parsed.projects)) throw new Error("Unsupported project archive format");

    const imported: string[] = [];
    for (const item of parsed.projects) {
        const migrated = migrateLegacyProject(item.project);
        if (!migrated) continue;
        // 与 importProject 相同的 id 再生成语义：项目与画布都换新 id，避免与既有数据冲突。
        const project = { ...migrated, id: nanoid(), canvases: migrated.canvases.map((canvas) => ({ ...canvas, id: nanoid() })) };
        const originalProjectId = migrated.id;

        // 旧 IndexedDB 文件按原 storageKey 物化，旧引用在新设备直接可解析。
        await Promise.all(
            (item.files ?? []).map(async (legacy) => {
                const blob = entries.get(legacy.path);
                if (!blob) return;
                const typed = blob.type ? blob : blob.slice(0, blob.size, legacy.mimeType);
                if (legacy.storageKey.startsWith("image:")) await setImageBlob(legacy.storageKey, typed);
                else await setMediaBlob(legacy.storageKey, typed);
            }),
        );

        // project-file 资产：逐条物化（保持 assetId/relativePath 身份，projectId 换成本机新 id），全部完成后再提交。
        const records = new Map((item.assets ?? []).map((record) => [`${record.projectId}:${record.assetId}`, record]));
        const materialized = new Map<string, CanvasAssetRef>();
        let workspacePath: string | undefined;
        for (const ref of collectProjectAssetRefs({ canvases: project.canvases })) {
            const record = records.get(`${ref.projectId}:${ref.assetId}`);
            const blob = entries.get(`projects/${originalProjectId}/files/${ref.relativePath}`);
            if (!record || !blob) continue; // 缺 record 或缺字节：保留原引用，按缺失展示，不伪造成功
            const restored = await restoreSyncedAsset({
                projectId: project.id,
                assetId: ref.assetId,
                relativePath: ref.relativePath,
                revision: ref.revision,
                originalName: record.originalName || fileNameOf(ref.relativePath),
                kind: record.kind || classifyProjectAsset(fileNameOf(ref.relativePath), record.mimeType),
                mimeType: record.mimeType || blob.type || "application/octet-stream",
                sha256: record.sha256,
                createdAt: record.createdAt,
                source: record.source,
                blob,
            });
            if (!restored.ok) continue;
            if (restored.workspacePath) workspacePath = restored.workspacePath;
            materialized.set(`${ref.projectId}:${ref.assetId}`, restored.ref);
        }

        const materializedProject = rewriteProjectAssetRefs(
            project,
            (ref) => materialized.has(`${ref.projectId}:${ref.assetId}`),
            (ref) => materialized.get(`${ref.projectId}:${ref.assetId}`)!,
        ) as Project;
        materializedProject.workspacePath = workspacePath;
        useProjectStore.getState().replaceProjects([materializedProject, ...useProjectStore.getState().projects]);
        imported.push(project.id);
    }
    return imported;
}

/** 导出/同步不携带本机工作区绝对路径；跨设备身份只由 projectId + assetId + relativePath 决定。 */
function portableProject(project: Project): Project {
    return { ...project, workspacePath: undefined };
}

function fileNameOf(relativePath: string) {
    return relativePath.split("/").pop() || "asset";
}

export async function exportCanvasNodes(nodes: CanvasNodeData[], fileName = i18n.t("canvas.export.defaultNodesName")) {
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const used = new Set<string>();
    const uniqueName = (base: string, ext: string) => {
        const safe = safeFileName(base) || i18n.t("canvas.export.item");
        let name = `${safe}.${ext}`;
        for (let i = 1; used.has(name); i += 1) name = `${safe}-${i}.${ext}`;
        used.add(name);
        return name;
    };

    await Promise.all(
        nodes.map(async (node) => {
            const title = node.title || node.type;
            const storageKey = node.metadata?.storageKey || "";
            const assetRef = node.metadata?.assetRef?.backend === "project-file" ? node.metadata.assetRef : undefined;
            if (storageKey) {
                const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
                if (blob) return void zipFiles.push({ name: uniqueName(title, fileExtension(blob.type, storageKey)), data: blob });
            }
            if (assetRef) {
                const blob = await getCanvasAssetBlob(assetRef);
                if (blob) return void zipFiles.push({ name: uniqueName(title, fileExtension(blob.type, storageKey)), data: blob });
            }
            if (node.type === CanvasNodeType.Text) return void zipFiles.push({ name: uniqueName(title, "txt"), data: node.metadata?.content || node.metadata?.prompt || "" });
            const content = node.metadata?.content;
            if (content && content.startsWith("data:")) {
                const blob = await (await fetch(content)).blob();
                return void zipFiles.push({ name: uniqueName(title, fileExtension(blob.type, storageKey)), data: blob });
            }
            zipFiles.push({ name: uniqueName(title, "json"), data: JSON.stringify(node, null, 2) });
        }),
    );

    const zip = await createZip(zipFiles);
    saveAs(zip, `${safeFileName(fileName)}.zip`);
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return [...keys];
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return [...keys];
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, storageKey: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("ogg")) return "ogg";
    return storageKey.startsWith("image:") ? "png" : "bin";
}
