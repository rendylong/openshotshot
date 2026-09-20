import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const downloadWebdavFile = vi.hoisted(() => vi.fn());
const uploadWebdavFile = vi.hoisted(() => vi.fn());
const getImageBlob = vi.hoisted(() => vi.fn());
const setImageBlob = vi.hoisted(() => vi.fn());
const resolveImageUrl = vi.hoisted(() => vi.fn());
const uploadImage = vi.hoisted(() => vi.fn());
const loadImageMeta = vi.hoisted(() => vi.fn());
const getMediaBlob = vi.hoisted(() => vi.fn());
const setMediaBlob = vi.hoisted(() => vi.fn());
const resolveMediaUrl = vi.hoisted(() => vi.fn());
const uploadMediaFile = vi.hoisted(() => vi.fn());
const readVideoMeta = vi.hoisted(() => vi.fn());
const readAudioMeta = vi.hoisted(() => vi.fn());

const projectStoreState = vi.hoisted(() => ({
    hydrated: true,
    projects: [] as Array<Record<string, unknown>>,
    replaceProjects: vi.fn(),
    setProjectWorkspacePath: vi.fn(),
}));
const assetStoreState = vi.hoisted(() => ({
    hydrated: true,
    assets: [] as Array<Record<string, unknown>>,
    replaceAssets: vi.fn(),
}));
const logStore = vi.hoisted(() => ({ iterate: vi.fn(), setItem: vi.fn(), clear: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() }));

vi.mock("localforage", () => ({ default: { createInstance: vi.fn(() => logStore) } }));
vi.mock("@/services/webdav-sync", () => ({ downloadWebdavFile, uploadWebdavFile, WEBDAV_MANIFEST_FILE_NAME: "manifest.json" }));
vi.mock("@/services/image-storage", () => ({ uploadImage, resolveImageUrl, getImageBlob, loadImageMeta, setImageBlob }));
vi.mock("@/services/file-storage", () => ({ uploadMediaFile, resolveMediaUrl, getMediaBlob, setMediaBlob, readVideoMeta, readAudioMeta }));
vi.mock("@/stores/use-asset-store", () => ({ useAssetStore: { getState: () => assetStoreState } }));
vi.mock("@/stores/canvas/use-project-store", () => ({ useProjectStore: { getState: () => projectStoreState, subscribe: vi.fn() } }));

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

const config = { url: "https://dav.example", username: "u", password: "p", directory: "sync", lastSyncedAt: "" };
const projectRef = { backend: "project-file", assetId: "a1", projectId: "p1", relativePath: "assets/generated/images/a.png", revision: 1 };
const record = {
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
const nodeWithRef = {
    id: "n1", type: "image", title: "A", position: { x: 0, y: 0 }, width: 10, height: 10,
    metadata: { assetRef: projectRef },
};
const makeProject = (overrides: Record<string, unknown> = {}) => ({
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
const remoteFileEntry = {
    storageKey: "project:p1:a1",
    path: "canvas/files/projects/p1/assets/generated/images/a.png",
    mimeType: "image/png",
    bytes: 4,
    assetId: "a1",
    projectId: "p1",
    relativePath: "assets/generated/images/a.png",
    revision: 1,
    sha256: "hash",
    originalName: "a.png",
    kind: "image" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    source: { type: "generated" } as const,
};
const pngBlob = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
const manifestBlob = (projects: unknown[], files: unknown[]) =>
    new Blob([JSON.stringify({ app: "shotshot", version: 1, domain: "canvas", exportedAt: "2026-01-02T00:00:00.000Z", data: { projects }, files })], { type: "application/json" });

beforeEach(() => {
    vi.resetModules();
    changedListener = null;
    Object.values(projectAssetsBridge).forEach((mock) => (mock as ReturnType<typeof vi.fn>).mockReset());
    projectAssetsBridge.onChanged.mockImplementation((listener: (event: unknown) => void) => {
        changedListener = listener;
        return () => { changedListener = null; };
    });
    // 默认回显输入身份：restore 产物与输入 ref 一致，便于断言改写结果。
    projectAssetsBridge.restore.mockImplementation(async (input: { assetId: string; projectId: string; relativePath: string; revision: number }) => ({
        ok: true,
        value: { record: { ...record, ...input }, ref: { backend: "project-file", assetId: input.assetId, projectId: input.projectId, relativePath: input.relativePath, revision: input.revision } },
    }));
    projectAssetsBridge.stat.mockResolvedValue({ ok: true, value: { status: "ready", record } });
    projectAssetsBridge.read.mockResolvedValue({ ok: true, value: { bytes: new Uint8Array([1, 2, 3, 4]), record } });
    ensureProjectWorkspace.mockReset().mockResolvedValue({ ok: true, path: "/ws/p1" });
    projectStoreState.replaceProjects.mockReset();
    projectStoreState.setProjectWorkspacePath.mockReset();
    projectStoreState.projects = [];
    assetStoreState.assets = [];
    assetStoreState.replaceAssets.mockReset();
    downloadWebdavFile.mockReset().mockResolvedValue(null);
    uploadWebdavFile.mockReset().mockResolvedValue(undefined);
    getImageBlob.mockReset(); setImageBlob.mockReset().mockResolvedValue("blob:image");
    getMediaBlob.mockReset(); setMediaBlob.mockReset().mockResolvedValue("blob:media");
    resolveImageUrl.mockReset(); resolveMediaUrl.mockReset(); uploadImage.mockReset(); uploadMediaFile.mockReset();
    loadImageMeta.mockReset(); readVideoMeta.mockReset(); readAudioMeta.mockReset();
    logStore.iterate.mockReset().mockResolvedValue(undefined);
    logStore.setItem.mockReset().mockResolvedValue(undefined);
    logStore.clear.mockReset().mockResolvedValue(undefined);
    window.shotshot = { agent: { ensureProjectWorkspace }, projectAssets: projectAssetsBridge, platform: "darwin" } as unknown as typeof window.shotshot;
});

afterEach(() => {
    delete window.shotshot;
});

describe("app sync project-backed assets", () => {
    it("uploads project-file bytes with portable relative metadata", async () => {
        projectStoreState.projects = [makeProject()];
        const { syncAppDataToWebdav } = await import("@/services/app-sync");
        await syncAppDataToWebdav(config);
        expect(projectAssetsBridge.read).toHaveBeenCalledWith(expect.objectContaining({ ref: expect.objectContaining({ projectId: "p1", assetId: "a1" }) }));
        expect(uploadWebdavFile).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("files/"), expect.any(Blob), "image/png");
        const manifestCall = uploadWebdavFile.mock.calls.find((item) => item[1] === "canvas/manifest.json");
        expect(manifestCall).toBeTruthy();
        const manifest = JSON.parse(await (manifestCall![2] as Blob).text()) as { files: Array<Record<string, unknown>> };
        expect(manifest.files[0]).toMatchObject({ assetId: "a1", projectId: "p1", relativePath: "assets/generated/images/a.png", sha256: "hash" });
        expect(JSON.stringify(manifest)).not.toContain("/ws/p1");
    });

    it("skips re-uploading a project asset whose remote sha256 already matches", async () => {
        projectStoreState.projects = [makeProject()];
        downloadWebdavFile.mockImplementation(async (_config: unknown, path: string) => {
            if (path === "canvas/manifest.json") return manifestBlob([], [remoteFileEntry]);
            return null;
        });
        const { syncAppDataToWebdav } = await import("@/services/app-sync");
        await syncAppDataToWebdav(config);
        expect(uploadWebdavFile).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("files/"), expect.any(Blob), "image/png");
    });

    it("restores a remote project asset into the receiving device workspace", async () => {
        const { downloadMissingFiles } = await import("@/services/app-sync");
        const data = { projects: [makeProject({ workspacePath: undefined })] };
        projectStoreState.projects = data.projects;
        projectAssetsBridge.stat.mockResolvedValue({ ok: true, value: { status: "missing" } });
        downloadWebdavFile.mockResolvedValue(pngBlob());
        await downloadMissingFiles(config, "canvas", data, [remoteFileEntry]);
        expect(window.shotshot!.projectAssets!.restore).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", assetId: "a1" }));
        expect(ensureProjectWorkspace).toHaveBeenCalledWith("p1", "");
        expect(data.projects[0].workspacePath).toBe("/ws/p1");
    });

    it("rebases a conflicting remote asset onto a new identity before merge", async () => {
        const remoteProject = makeProject({ updatedAt: "2026-01-02T00:00:00.000Z", workspacePath: "/other-device/p1" });
        projectStoreState.projects = [makeProject()];
        projectAssetsBridge.stat.mockResolvedValue({ ok: true, value: { status: "ready", record: { ...record, sha256: "local-hash" } } });
        // 回显恢复后的真实身份：a1′ 的本地 record 携带再定基后的相对路径与远端 sha256（restore 按声明哈希校验过字节）。
        projectAssetsBridge.read.mockImplementation(async (input: { ref: { assetId: string } }) => ({
            ok: true,
            value: {
                bytes: new Uint8Array(input.ref.assetId === "a1" ? [1, 2, 3, 4] : [9, 9, 9, 9]),
                record: { ...record, ...input.ref, sha256: input.ref.assetId === "a1" ? "local-hash" : "remote-hash" },
            },
        }));
        downloadWebdavFile.mockImplementation(async (_config: unknown, path: string) => {
            if (path === "canvas/manifest.json") return manifestBlob([remoteProject], [{ ...remoteFileEntry, sha256: "remote-hash" }]);
            if (String(path).endsWith("manifest.json")) return null;
            return pngBlob();
        });
        const { syncAppDataToWebdav } = await import("@/services/app-sync");
        await syncAppDataToWebdav(config);
        const restoreCall = projectAssetsBridge.restore.mock.calls[0]?.[0] as { assetId: string; sha256: string; relativePath: string } | undefined;
        expect(restoreCall).toBeTruthy();
        expect(restoreCall!.assetId).not.toBe("a1");
        expect(restoreCall!.sha256).toBe("remote-hash");
        const applied = (projectStoreState.replaceProjects.mock.calls[0][0] as Array<Record<string, unknown>>).find((project) => project.id === "p1") as { canvases: Array<{ nodes: Array<{ metadata: { assetRef: { assetId: string } } }> }> };
        expect(applied.canvases[0].nodes[0].metadata.assetRef.assetId).toBe(restoreCall!.assetId);
        expect(projectAssetsBridge.restore.mock.calls.every((call) => (call[0] as { assetId: string }).assetId !== "a1")).toBe(true);
        // 再定基后的字节必须 PUT 到新路径；旧 identity 路径不被覆盖（本地在 merge 中落败）。
        const rebasedRelative = `assets/generated/images/a--${restoreCall!.assetId.slice(0, 8)}.png`;
        expect(restoreCall!.relativePath).toBe(rebasedRelative);
        expect(uploadWebdavFile).toHaveBeenCalledWith(expect.anything(), `canvas/files/projects/p1/${rebasedRelative}`, expect.any(Blob), "image/png");
        expect(uploadWebdavFile).not.toHaveBeenCalledWith(expect.anything(), "canvas/files/projects/p1/assets/generated/images/a.png", expect.anything(), expect.anything());
        const manifestCall = uploadWebdavFile.mock.calls.find((item) => item[1] === "canvas/manifest.json");
        const manifest = JSON.parse(await (manifestCall![2] as Blob).text()) as { files: Array<Record<string, unknown>> };
        expect(manifest.files).toHaveLength(1);
        expect(manifest.files[0]).toMatchObject({ assetId: restoreCall!.assetId, sha256: "remote-hash", relativePath: rebasedRelative, path: `canvas/files/projects/p1/${rebasedRelative}` });
    });

    it("materializes remote project assets into IndexedDB and patches refs on web", async () => {
        delete window.shotshot;
        const remoteProject = makeProject({ updatedAt: "2026-01-02T00:00:00.000Z", workspacePath: undefined });
        downloadWebdavFile.mockImplementation(async (_config: unknown, path: string) => {
            if (path === "canvas/manifest.json") return manifestBlob([remoteProject], [remoteFileEntry]);
            if (String(path).endsWith("manifest.json")) return null;
            return pngBlob();
        });
        const { syncAppDataToWebdav } = await import("@/services/app-sync");
        await syncAppDataToWebdav(config);
        expect(setImageBlob).toHaveBeenCalledWith(expect.stringMatching(/^image:/), expect.any(Blob));
        const applied = (projectStoreState.replaceProjects.mock.calls[0][0] as Array<{ id: string; canvases: Array<{ nodes: Array<{ metadata: { assetRef: unknown } }> }> }>).find((project) => project.id === "p1")!;
        expect(applied.canvases[0].nodes[0].metadata.assetRef).toEqual({ backend: "indexeddb", storageKey: setImageBlob.mock.calls[0][0] });
    });

    it("keeps uploading legacy IndexedDB media with unchanged entries", async () => {
        const legacyProject = makeProject({ canvases: [{
            id: "c1", title: "C", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
            nodes: [{ ...nodeWithRef, metadata: { storageKey: "image:abc" } }], connections: [], chatSessions: [], activeChatId: null,
            backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
        }] });
        projectStoreState.projects = [legacyProject];
        getImageBlob.mockResolvedValue(pngBlob());
        const { syncAppDataToWebdav } = await import("@/services/app-sync");
        await syncAppDataToWebdav(config);
        expect(uploadWebdavFile).toHaveBeenCalledWith(expect.anything(), "canvas/files/image_abc.png", expect.any(Blob), "image/png");
        const manifestCall = uploadWebdavFile.mock.calls.find((item) => item[1] === "canvas/manifest.json");
        const manifest = JSON.parse(await (manifestCall![2] as Blob).text()) as { files: Array<Record<string, unknown>> };
        expect(manifest.files[0]).toEqual({ storageKey: "image:abc", path: "canvas/files/image_abc.png", mimeType: "image/png", bytes: 4 });
    });

    it("downloads missing legacy media into IndexedDB stores", async () => {
        const legacyProject = makeProject({ updatedAt: "2026-01-02T00:00:00.000Z", canvases: [{
            id: "c1", title: "C", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
            nodes: [{ ...nodeWithRef, metadata: { storageKey: "image:abc" } }], connections: [], chatSessions: [], activeChatId: null,
            backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
        }] });
        projectStoreState.projects = [];
        getImageBlob.mockResolvedValue(null);
        downloadWebdavFile.mockImplementation(async (_config: unknown, path: string) => {
            if (path === "canvas/manifest.json") return manifestBlob([legacyProject], [{ storageKey: "image:abc", path: "canvas/files/image_abc.png", mimeType: "image/png", bytes: 4 }]);
            if (String(path).endsWith("manifest.json")) return null;
            return pngBlob();
        });
        const { syncAppDataToWebdav } = await import("@/services/app-sync");
        await syncAppDataToWebdav(config);
        expect(setImageBlob).toHaveBeenCalledWith("image:abc", expect.any(Blob));
    });
});
