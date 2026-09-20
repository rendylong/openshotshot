import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";
import type { CanvasAssetWriteInput } from "@/services/project-asset-storage";

const uploadImage = vi.hoisted(() => vi.fn());
const resolveImageUrl = vi.hoisted(() => vi.fn());
const getImageBlob = vi.hoisted(() => vi.fn());
const loadImageMeta = vi.hoisted(() => vi.fn());
const uploadMediaFile = vi.hoisted(() => vi.fn());
const resolveMediaUrl = vi.hoisted(() => vi.fn());
const getMediaBlob = vi.hoisted(() => vi.fn());
const readVideoMeta = vi.hoisted(() => vi.fn());
const readAudioMeta = vi.hoisted(() => vi.fn());
const projectStoreState = vi.hoisted(() => ({
    projects: [{ id: "p1", title: "P", workspacePath: "/ws/p1" }] as Array<Record<string, unknown>>,
    setProjectWorkspacePath: vi.fn(),
}));

vi.mock("@/services/image-storage", () => ({ uploadImage, resolveImageUrl, getImageBlob, loadImageMeta }));
vi.mock("@/services/file-storage", () => ({ uploadMediaFile, resolveMediaUrl, getMediaBlob, readVideoMeta, readAudioMeta }));
vi.mock("@/stores/canvas/use-project-store", () => ({ useProjectStore: { getState: () => projectStoreState } }));

const ensureProjectWorkspace = vi.fn();
let changedListener: ((event: unknown) => void) | null = null;
const projectAssetsBridge = {
    write: vi.fn(),
    importPath: vi.fn(),
    read: vi.fn(),
    stat: vi.fn(),
    restore: vi.fn(),
    watch: vi.fn(),
    unwatch: vi.fn(),
    onChanged: vi.fn((listener: (event: unknown) => void) => {
        changedListener = listener;
        return () => { changedListener = null; };
    }),
};

const record = {
    backend: "project-file",
    assetId: "a1",
    projectId: "p1",
    relativePath: "assets/imported/clip.mp4",
    revision: 1,
    originalName: "clip.mp4",
    kind: "video",
    mimeType: "video/mp4",
    bytes: 1,
    sha256: "hash",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "canvas-import", canvasId: "c1" },
};
const projectRef: CanvasAssetRef = { backend: "project-file", assetId: "a1", projectId: "p1", relativePath: "assets/imported/clip.mp4", revision: 1 };
const blob = () => new Blob(["x"], { type: "video/mp4" });
const webContext: CanvasAssetWriteInput = { projectId: "p1", projectTitle: "P", canvasId: "c1", source: { type: "canvas-import", canvasId: "c1" } };
const writeResult = () => ({ ok: true, value: { record, ref: projectRef } });

beforeEach(() => {
    vi.resetModules();
    changedListener = null;
    Object.values(projectAssetsBridge).forEach((mock) => (mock as ReturnType<typeof vi.fn>).mockReset());
    projectAssetsBridge.onChanged.mockImplementation((listener: (event: unknown) => void) => {
        changedListener = listener;
        return () => { changedListener = null; };
    });
    ensureProjectWorkspace.mockReset();
    projectStoreState.setProjectWorkspacePath.mockReset();
    uploadImage.mockReset(); resolveImageUrl.mockReset(); getImageBlob.mockReset();
    uploadMediaFile.mockReset(); resolveMediaUrl.mockReset(); getMediaBlob.mockReset();
    readVideoMeta.mockReset(); readAudioMeta.mockReset(); loadImageMeta.mockReset();
    readVideoMeta.mockResolvedValue({ width: 1920, height: 1080, durationMs: 1000 });
    loadImageMeta.mockResolvedValue({ width: 640, height: 480 });
    window.shotshot = { agent: { ensureProjectWorkspace }, projectAssets: projectAssetsBridge, platform: "darwin" } as unknown as typeof window.shotshot;
    let urlCount = 0;
    // 类形式保持 URL 可构造：resetModules 后动态 import 的模块解析内部会 new URL。
    const UrlStub = class extends URL {};
    UrlStub.createObjectURL = vi.fn(() => `blob:url-${(urlCount += 1)}`);
    UrlStub.revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", UrlStub);
});

afterEach(() => {
    vi.unstubAllGlobals();
    delete window.shotshot;
});

describe("canvas asset storage facade", () => {
    it("writes to the project bridge when Electron workspace context exists", async () => {
        const { storeCanvasMedia } = await import("@/services/project-asset-storage");
        projectAssetsBridge.write.mockResolvedValue(writeResult());
        const result = await storeCanvasMedia(blob(), {
            projectId: "p1", workspacePath: "/ws/p1", canvasId: "c1",
            name: "clip.mp4", source: { type: "canvas-import", canvasId: "c1" },
        });
        expect(window.shotshot!.projectAssets!.write).toHaveBeenCalled();
        expect(result.assetRef).toMatchObject({ backend: "project-file", projectId: "p1" });
    });

    it("uses IndexedDB when no desktop bridge is available", async () => {
        delete window.shotshot;
        const { storeCanvasMedia } = await import("@/services/project-asset-storage");
        uploadMediaFile.mockImplementation(async (_input: Blob, prefix: string) => ({ url: "blob:web", storageKey: `${prefix}:abc`, bytes: 1, mimeType: "video/mp4" }));
        const result = await storeCanvasMedia(blob(), webContext);
        expect(result.assetRef).toEqual({ backend: "indexeddb", storageKey: expect.stringMatching(/^video:/) });
    });

    it("ensures a missing Electron workspace instead of falling back to IndexedDB", async () => {
        const { storeCanvasMedia } = await import("@/services/project-asset-storage");
        ensureProjectWorkspace.mockResolvedValue({ ok: true, path: "/ws/p1" });
        projectAssetsBridge.write.mockResolvedValue(writeResult());
        await storeCanvasMedia(blob(), webContext);
        expect(ensureProjectWorkspace).toHaveBeenCalledWith("p1", "P");
        expect(projectStoreState.setProjectWorkspacePath).toHaveBeenCalledWith("p1", "/ws/p1");
        expect(window.shotshot!.projectAssets!.write).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: "/ws/p1" }));
        expect(uploadMediaFile).not.toHaveBeenCalled();
        expect(uploadImage).not.toHaveBeenCalled();
    });

    it("surfaces an ensure failure as a visible storage error without an IndexedDB fallback", async () => {
        const { storeCanvasMedia } = await import("@/services/project-asset-storage");
        ensureProjectWorkspace.mockResolvedValue({ ok: false, error: "disk error" });
        await expect(storeCanvasMedia(blob(), webContext)).rejects.toThrow("disk error");
        expect(uploadMediaFile).not.toHaveBeenCalled();
        expect(uploadImage).not.toHaveBeenCalled();
    });

    it("stores a canvas image through the bridge with image metadata and assetRef", async () => {
        const { storeCanvasImage } = await import("@/services/project-asset-storage");
        projectAssetsBridge.write.mockResolvedValue({ ok: true, value: { record: { ...record, kind: "image", mimeType: "image/png", originalName: "art.png", relativePath: "assets/imported/art.png" }, ref: projectRef } });
        const result = await storeCanvasImage(new Blob(["img"], { type: "image/png" }), {
            projectId: "p1", workspacePath: "/ws/p1", canvasId: "c1",
            name: "art.png", source: { type: "canvas-import", canvasId: "c1" },
        });
        expect(result.assetRef).toMatchObject({ backend: "project-file" });
        expect(result).toMatchObject({ width: 640, height: 480, mimeType: "image/png" });
        expect(uploadImage).not.toHaveBeenCalled();
    });

    it("revokes and recreates an object URL after an asset change event", async () => {
        const { resolveCanvasAssetUrl } = await import("@/services/project-asset-storage");
        projectAssetsBridge.read.mockResolvedValue({ ok: true, value: { bytes: new Uint8Array([1]), record } });
        const first = await resolveCanvasAssetUrl(projectRef, "");
        changedListener!({ type: "changed", record: { ...record, revision: 2 } });
        const second = await resolveCanvasAssetUrl({ ...projectRef, revision: 2 }, "");
        expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
        expect(second).not.toBe(first);
    });

    it("serves repeat resolutions of the same asset from the URL cache", async () => {
        const { resolveCanvasAssetUrl } = await import("@/services/project-asset-storage");
        projectAssetsBridge.read.mockResolvedValue({ ok: true, value: { bytes: new Uint8Array([1]), record } });
        const first = await resolveCanvasAssetUrl(projectRef, "");
        const second = await resolveCanvasAssetUrl(projectRef, "");
        expect(second).toBe(first);
        expect(projectAssetsBridge.read).toHaveBeenCalledTimes(1);
    });

    it("returns the fallback after a missing event instead of reusing an old URL", async () => {
        const { resolveCanvasAssetUrl, isCanvasAssetMissing } = await import("@/services/project-asset-storage");
        projectAssetsBridge.read.mockResolvedValue({ ok: true, value: { bytes: new Uint8Array([1]), record } });
        await resolveCanvasAssetUrl(projectRef, "fallback");
        changedListener!({ type: "missing", ref: projectRef });
        expect(isCanvasAssetMissing(projectRef)).toBe(true);
        expect(await resolveCanvasAssetUrl(projectRef, "fallback")).toBe("fallback");
    });

    it("ignores change events from other projects when revoking cached URLs", async () => {
        const { resolveCanvasAssetUrl } = await import("@/services/project-asset-storage");
        projectAssetsBridge.read.mockResolvedValue({ ok: true, value: { bytes: new Uint8Array([1]), record } });
        const url = await resolveCanvasAssetUrl(projectRef, "");
        changedListener!({ type: "changed", record: { ...record, projectId: "p2" } });
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        expect(await resolveCanvasAssetUrl(projectRef, "")).toBe(url);
    });

    it("resolves an IndexedDB asset ref through the matching legacy resolver", async () => {
        const { resolveCanvasAssetUrl } = await import("@/services/project-asset-storage");
        resolveImageUrl.mockResolvedValue("blob:image");
        resolveMediaUrl.mockResolvedValue("blob:media");
        expect(await resolveCanvasAssetUrl({ backend: "indexeddb", storageKey: "image:abc" }, "fb")).toBe("blob:image");
        expect(await resolveCanvasAssetUrl({ backend: "indexeddb", storageKey: "video:abc" }, "fb")).toBe("blob:media");
        expect(resolveImageUrl).toHaveBeenCalledWith("image:abc", "fb");
        expect(resolveMediaUrl).toHaveBeenCalledWith("video:abc", "fb");
    });

    it("reads a project asset as a typed blob", async () => {
        const { getCanvasAssetBlob } = await import("@/services/project-asset-storage");
        projectAssetsBridge.read.mockResolvedValue({ ok: true, value: { bytes: new Uint8Array([1, 2]), record } });
        const result = await getCanvasAssetBlob(projectRef);
        expect(result).toBeInstanceOf(Blob);
        expect(result?.type).toBe("video/mp4");
    });

    it("releases only the exact revision URL through the centralized cache", async () => {
        const { resolveCanvasAssetUrl, releaseCanvasAssetUrl } = await import("@/services/project-asset-storage");
        projectAssetsBridge.read.mockResolvedValue({ ok: true, value: { bytes: new Uint8Array([1]), record } });
        const url = await resolveCanvasAssetUrl(projectRef, "");
        releaseCanvasAssetUrl({ ...projectRef, revision: 2 });
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        releaseCanvasAssetUrl(projectRef);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
        projectAssetsBridge.read.mockClear();
        expect(await resolveCanvasAssetUrl(projectRef, "fb")).not.toBe(url);
        expect(projectAssetsBridge.read).toHaveBeenCalledTimes(1);
    });
});
