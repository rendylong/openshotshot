// project-file 资产的持久引用 token（metadata.references 用）：pfile:<projectId>:<assetId>:<revision>:<enc(relativePath)>。
// 纯字符串函数、零依赖——消费方拿 token 换字节（getCanvasAssetBlob），序列化只落在 referenceUrl 写侧。
import type { ProjectFileAssetRef } from "@/lib/project-assets/project-asset-types";

const PFILE_PREFIX = "pfile:";

export function isAssetRefToken(value: string): boolean {
    return value.startsWith(PFILE_PREFIX);
}

export function serializeProjectAssetToken(ref: ProjectFileAssetRef): string {
    return `${PFILE_PREFIX}${ref.projectId}:${ref.assetId}:${ref.revision}:${encodeURIComponent(ref.relativePath)}`;
}

export function parseAssetRefToken(value: string): ProjectFileAssetRef | undefined {
    if (!isAssetRefToken(value)) return undefined;
    const [projectId, assetId, revision, relativePath] = value.slice(PFILE_PREFIX.length).split(":");
    const parsedRevision = Number(revision);
    if (!projectId || !assetId || !Number.isFinite(parsedRevision) || relativePath === undefined) return undefined;
    try {
        return { backend: "project-file", projectId, assetId, revision: parsedRevision, relativePath: decodeURIComponent(relativePath) };
    } catch {
        return undefined;
    }
}
