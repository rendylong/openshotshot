import { beforeEach, describe, expect, it, vi } from "vitest";

import { exportCanvasNodes } from "@/lib/canvas/canvas-export";
import type { CanvasAssetRef, ProjectAssetRecord } from "@/lib/project-assets/project-asset-types";
import type { Project } from "@/types/project";
import type { CanvasNodeData } from "@/types/canvas";

const createZip = vi.hoisted(() => vi.fn());
const readZip = vi.hoisted(() => vi.fn());
const saveAs = vi.hoisted(() => vi.fn());
const getImageBlob = vi.hoisted(() => vi.fn());
const setImageBlob = vi.hoisted(() => vi.fn());
const getMediaBlob = vi.hoisted(() => vi.fn());
const setMediaBlob = vi.hoisted(() => vi.fn());
const ensureProjectAssetWorkspace = vi.hoisted(() => vi.fn());
const readSyncedProjectAsset = vi.hoisted(() => vi.fn());
const restoreSyncedAsset = vi.hoisted(() => vi.fn());
const getCanvasAssetBlob = vi.hoisted(() => vi.fn());
const replaceProjects = vi.hoisted(() => vi.fn());

vi.mock("@/lib/zip", () => ({ createZip, readZip }));
vi.mock("file-saver", () => ({ saveAs }));
vi.mock("@/services/image-storage", () => ({ getImageBlob, setImageBlob }));
vi.mock("@/services/file-storage", () => ({ getMediaBlob, setMediaBlob }));
vi.mock("@/services/project-asset-storage", () => ({ ensureProjectAssetWorkspace, readSyncedProjectAsset, restoreSyncedAsset, getCanvasAssetBlob }));
vi.mock("@/stores/canvas/use-project-store", () => ({ useProjectStore: { getState: () => ({ projects: [], replaceProjects }) } }));

const projectRef: CanvasAssetRef = { backend: "project-file", assetId: "a1", projectId: "p1", relativePath: "assets/generated/images/a.png", revision: 1 };
const record: ProjectAssetRecord = {
    ...projectRef,
    originalName: "a.png",
    kind: "image",
    mimeType: "image/png",
    bytes: 4,
    sha256: "hash",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "generated" },
};
const nodeWithRef: CanvasNodeData = {
    id: "n1", type: "image", title: "A", position: { x: 0, y: 0 }, width: 10, height: 10,
    metadata: { assetRef: projectRef },
};
const makeProject = (overrides: Partial<Project> = {}): Project => ({
    id: "p1", title: "P", category: "未分类", icon: "folder", color: "#000000",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    canvases: [{
        id: "c1", title: "C", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        nodes: [nodeWithRef], connections: [], chatSessions: [], activeChatId: null,
        backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
    }],
    workspacePath: "/ws/p1",
    ...overrides,
});
const pngBlob = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
const archive = (projects: unknown[]) =>
    new Blob([JSON.stringify({ app: "shotshot", version: 3, exportedAt: "2026-01-01T00:00:00.000Z", projects })], { type: "application/zip" });

beforeEach(() => {
    vi.resetModules();
    createZip.mockReset().mockResolvedValue(new Blob(["zip"]));
    readZip.mockReset();
    saveAs.mockReset();
    getImageBlob.mockReset();
    setImageBlob.mockReset().mockResolvedValue("blob:image");
    getMediaBlob.mockReset();
    setMediaBlob.mockReset().mockResolvedValue("blob:media");
    ensureProjectAssetWorkspace.mockReset().mockResolvedValue({ ok: true, path: "/ws/p1" });
    readSyncedProjectAsset.mockReset();
    restoreSyncedAsset.mockReset();
    getCanvasAssetBlob.mockReset();
    replaceProjects.mockReset();
});

describe("canvas project archive export", () => {
    it("exports project-file bytes under projects/<projectId>/files/<relativePath> with manifest records", async () => {
        readSyncedProjectAsset.mockResolvedValue({ blob: pngBlob(), record });
        const { exportCanvasProjects } = await import("@/lib/canvas/canvas-export");
        await exportCanvasProjects([makeProject()], "demo");
        const files = createZip.mock.calls[0][0] as Array<{ name: string; data: BlobPart }>;
        expect(files.map((file) => file.name)).toContain("projects/p1/files/assets/generated/images/a.png");
        const manifest = JSON.parse(files.find((file) => file.name === "projects.json")!.data as string) as {
            projects: Array<{ project: Record<string, unknown>; files: Array<Record<string, unknown>>; assets: Array<Record<string, unknown>> }>;
        };
        expect(manifest.projects[0].assets[0]).toMatchObject({ assetId: "a1", projectId: "p1", relativePath: "assets/generated/images/a.png", sha256: "hash" });
        expect(manifest.projects[0].files).toEqual([]);
        expect(manifest.projects[0].project).not.toHaveProperty("workspacePath");
        expect(saveAs).toHaveBeenCalled();
    });

    it("still exports legacy IndexedDB media with unchanged entries", async () => {
        getImageBlob.mockResolvedValue(pngBlob());
        readSyncedProjectAsset.mockResolvedValue(null);
        const legacyProject = makeProject({ canvases: [{
            id: "c1", title: "C", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
            nodes: [{ ...nodeWithRef, metadata: { storageKey: "image:abc", assetRef: undefined } }], connections: [], chatSessions: [], activeChatId: null,
            backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
        }] });
        const { exportCanvasProjects } = await import("@/lib/canvas/canvas-export");
        await exportCanvasProjects([legacyProject], "demo");
        const files = createZip.mock.calls[0][0] as Array<{ name: string; data: BlobPart }>;
        expect(files.map((file) => file.name)).toContain("projects/p1/files/image_abc.png");
        const manifest = JSON.parse(files.find((file) => file.name === "projects.json")!.data as string) as {
            projects: Array<{ files: Array<Record<string, unknown>>; assets: Array<Record<string, unknown>> }>;
        };
        expect(manifest.projects[0].files[0]).toMatchObject({ storageKey: "image:abc", path: "projects/p1/files/image_abc.png" });
        expect(manifest.projects[0].assets).toEqual([]);
    });
});

describe("canvas project archive import", () => {
    const archiveEntry = (project: unknown, assets: unknown[]) => [
        ["projects.json", new Blob([JSON.stringify({ app: "shotshot", version: 3, exportedAt: "2026-01-01T00:00:00.000Z", projects: [{ project, files: [], assets }] })], { type: "application/json" })],
        ["projects/p1/files/assets/generated/images/a.png", pngBlob()],
    ] as const;

    it("materializes project assets before committing the imported project record", async () => {
        readZip.mockResolvedValue(new Map(archiveEntry(makeProject(), [record])));
        restoreSyncedAsset.mockImplementation(async (input: { assetId: string; projectId: string; relativePath: string; revision: number }) => ({
            ok: true,
            ref: { backend: "project-file", assetId: input.assetId, projectId: input.projectId, relativePath: input.relativePath, revision: input.revision },
        }));
        const { importCanvasProjects } = await import("@/lib/canvas/canvas-export");
        const ids = await importCanvasProjects(archive([makeProject()]));
        expect(ids).toHaveLength(1);
        expect(ids[0]).not.toBe("p1");
        expect(restoreSyncedAsset.mock.invocationCallOrder[0]).toBeLessThan(replaceProjects.mock.invocationCallOrder[0]);
        expect(restoreSyncedAsset).toHaveBeenCalledWith(expect.objectContaining({ projectId: ids[0], assetId: "a1", relativePath: "assets/generated/images/a.png", sha256: "hash" }));
        const committed = (replaceProjects.mock.calls[0][0] as Array<Record<string, unknown>>)[0] as { id: string; canvases: Array<{ nodes: Array<{ metadata: { assetRef: Record<string, unknown> } }> }> };
        expect(committed.id).toBe(ids[0]);
        expect(committed.canvases[0].nodes[0].metadata.assetRef).toMatchObject({ backend: "project-file", assetId: "a1", projectId: ids[0] });
    });

    it("patches imported project refs to IndexedDB when restore runs on web", async () => {
        readZip.mockResolvedValue(new Map(archiveEntry(makeProject(), [record])));
        restoreSyncedAsset.mockResolvedValue({ ok: true, ref: { backend: "indexeddb", storageKey: "image:restored" } });
        const { importCanvasProjects } = await import("@/lib/canvas/canvas-export");
        await importCanvasProjects(archive([makeProject()]));
        const committed = (replaceProjects.mock.calls[0][0] as Array<{ canvases: Array<{ nodes: Array<{ metadata: { assetRef: unknown } }> }> }>)[0];
        expect(committed.canvases[0].nodes[0].metadata.assetRef).toEqual({ backend: "indexeddb", storageKey: "image:restored" });
    });

    it("restores legacy archive files into IndexedDB under their original keys", async () => {
        const legacyProject = makeProject({ canvases: [{
            id: "c1", title: "C", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
            nodes: [{ ...nodeWithRef, metadata: { storageKey: "video:abc", assetRef: undefined } }], connections: [], chatSessions: [], activeChatId: null,
            backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
        }] });
        const legacyFiles = [{ storageKey: "video:abc", path: "projects/p1/files/video_abc.mp4", mimeType: "video/mp4", bytes: 4 }];
        readZip.mockResolvedValue(new Map([
            ["projects.json", new Blob([JSON.stringify({ app: "shotshot", version: 3, exportedAt: "2026-01-01T00:00:00.000Z", projects: [{ project: legacyProject, files: legacyFiles, assets: [] }] })], { type: "application/json" })],
            ["projects/p1/files/video_abc.mp4", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "video/mp4" })],
        ] as Array<[string, Blob]>));
        const { importCanvasProjects } = await import("@/lib/canvas/canvas-export");
        await importCanvasProjects(archive([legacyProject]));
        expect(setMediaBlob).toHaveBeenCalledWith("video:abc", expect.any(Blob));
        expect(restoreSyncedAsset).not.toHaveBeenCalled();
        expect(replaceProjects).toHaveBeenCalledTimes(1);
    });
});

describe("exportCanvasNodes assetRef 分支", () => {
    it("assetRef-only 节点导出媒体字节而非 JSON 兜底", async () => {
        getCanvasAssetBlob.mockResolvedValueOnce(new Blob(["video-bytes"], { type: "video/mp4" }));
        const node: CanvasNodeData = { id: "v1", type: "video", title: "Clip", position: { x: 0, y: 0 }, width: 10, height: 10, metadata: { assetRef: projectRef, content: "blob:dead" } };
        await exportCanvasNodes([node], "nodes");
        const files = createZip.mock.calls[0][0] as { name: string; data: BlobPart }[];
        const exported = await getCanvasAssetBlob.mock.results[0].value;
        expect(files.some((file) => file.name === "Clip.mp4" && file.data === exported)).toBe(true);
    });
});
