import { beforeEach, describe, expect, test, vi } from "vitest";

import { CanvasNodeType } from "@/types/canvas";

const uploadImage = vi.hoisted(() => vi.fn());
const imageToDataUrl = vi.hoisted(() => vi.fn());
const deleteStoredImages = vi.hoisted(() => vi.fn());
const getCanvasAssetBlob = vi.hoisted(() => vi.fn());
const readFileAsDataUrl = vi.hoisted(() => vi.fn());

vi.mock("@/services/image-storage", () => ({
    uploadImage,
    imageToDataUrl,
    deleteStoredImages,
}));

vi.mock("@/services/project-asset-storage", () => ({ getCanvasAssetBlob }));
vi.mock("@/lib/image-utils", () => ({ readFileAsDataUrl }));

import {
    clearModel3dSnapshots,
    ensureModel3dViews,
    ensureSnapshot,
    getLiveModel3dViews,
    getLiveSnapshot,
    isPluginNodeType,
    persistSnapshot,
    registerCaptureFn,
    setLiveSnapshot,
    unregisterNodeSnapshots,
} from "@/lib/canvas/model-3d-snapshot";

describe("setLiveSnapshot", () => {
    test("stores the dataUrl for the synchronous resource() contract and cleanup removes it", () => {
        setLiveSnapshot("node-3d-1", "data:image/png;base64,SET");
        expect(getLiveSnapshot("node-3d-1")).toBe("data:image/png;base64,SET");
        unregisterNodeSnapshots("node-3d-1");
        expect(getLiveSnapshot("node-3d-1")).toBeNull();
    });
});

const node3d = (overrides: Record<string, unknown> = {}) =>
    ({
        id: "node-3d-1",
        type: "3d",
        title: "Model",
        position: { x: 0, y: 0 },
        width: 640,
        height: 480,
        metadata: { model3d: { name: "a.glb", storageKey: "file:glb-1", content: "blob:glb" } },
        ...overrides,
    }) as Parameters<typeof ensureSnapshot>[0];

beforeEach(() => {
    vi.clearAllMocks();
    clearModel3dSnapshots();
});

describe("isPluginNodeType", () => {
    test("treats 3d as a plugin type", () => {
        expect(isPluginNodeType("3d")).toBe(true);
    });

    test("treats every CanvasNodeType enum member as non-plugin", () => {
        for (const value of Object.values(CanvasNodeType)) {
            expect(isPluginNodeType(value)).toBe(false);
        }
    });
});

describe("ensureSnapshot", () => {
    test("prefers a live viewport capture, persists it, and deletes the stale key after the metadata callback", async () => {
        registerCaptureFn("node-3d-1", () => ["data:image/png;base64,LIVE"]);
        uploadImage.mockResolvedValue({ storageKey: "image:new", url: "blob:new" });
        const onPersisted = vi.fn();
        const snapshot = await ensureSnapshot(node3d({ metadata: { model3d: { snapshot: { storageKey: "image:old" } } } }), { onPersisted });
        expect(snapshot).toBe("data:image/png;base64,LIVE");
        expect(uploadImage).toHaveBeenCalledWith("data:image/png;base64,LIVE");
        expect(onPersisted).toHaveBeenCalledWith("image:new");
        expect(deleteStoredImages).toHaveBeenCalledWith(["image:old"]);
        expect(getLiveSnapshot("node-3d-1")).toBe("data:image/png;base64,LIVE");
    });

    test("keeps the recorded storageKey when no metadata callback can adopt the fresh upload", async () => {
        registerCaptureFn("node-3d-1", () => ["data:image/png;base64,LIVE"]);
        uploadImage.mockResolvedValue({ storageKey: "image:new", url: "blob:new" });
        await ensureSnapshot(node3d({ metadata: { model3d: { snapshot: { storageKey: "image:old" } } } }));
        expect(deleteStoredImages).not.toHaveBeenCalled();
    });

    test("resolves the persisted storageKey when no live capture is registered", async () => {
        imageToDataUrl.mockResolvedValue("data:image/png;base64,STORED");
        const snapshot = await ensureSnapshot(node3d({ metadata: { model3d: { snapshot: { storageKey: "image:kept" } } } }));
        expect(snapshot).toBe("data:image/png;base64,STORED");
        expect(imageToDataUrl).toHaveBeenCalledWith({ storageKey: "image:kept" });
        expect(uploadImage).not.toHaveBeenCalled();
    });

    test("falls back to the in-memory cache when the capture fn yields nothing and no storageKey exists", async () => {
        registerCaptureFn("node-3d-1", () => ["data:image/png;base64,CACHED"]);
        uploadImage.mockResolvedValue({ storageKey: "image:one", url: "blob:one" });
        await ensureSnapshot(node3d());
        registerCaptureFn("node-3d-1", () => []);
        const snapshot = await ensureSnapshot(node3d());
        expect(snapshot).toBe("data:image/png;base64,CACHED");
        expect(uploadImage).toHaveBeenCalledTimes(1);
    });

    test("returns null when nothing can provide a snapshot", async () => {
        const snapshot = await ensureSnapshot(node3d());
        expect(snapshot).toBeNull();
        expect(uploadImage).not.toHaveBeenCalled();
    });

    test("degrades to the memory-only capture when persistence fails", async () => {
        registerCaptureFn("node-3d-1", () => ["data:image/png;base64,LIVE"]);
        uploadImage.mockRejectedValue(new Error("quota"));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const snapshot = await ensureSnapshot(node3d());
        expect(snapshot).toBe("data:image/png;base64,LIVE");
        expect(getLiveSnapshot("node-3d-1")).toBe("data:image/png;base64,LIVE");
        warn.mockRestore();
    });

    test("deduplicates concurrent calls into a single upload", async () => {
        registerCaptureFn("node-3d-1", () => ["data:image/png;base64,LIVE"]);
        let resolveUpload!: (value: { storageKey: string }) => void;
        uploadImage.mockReturnValue(new Promise((resolve) => (resolveUpload = resolve)));
        const first = ensureSnapshot(node3d());
        const second = ensureSnapshot(node3d());
        resolveUpload({ storageKey: "image:one" });
        expect(await first).toBe("data:image/png;base64,LIVE");
        expect(await second).toBe("data:image/png;base64,LIVE");
        expect(uploadImage).toHaveBeenCalledTimes(1);
    });
});

const capturedViews = () => [
    { id: "primary" as const, dataUrl: "data:image/png;base64,PRIMARY" },
    { id: "left" as const, dataUrl: "data:image/png;base64,LEFT" },
    { id: "right" as const, dataUrl: "data:image/png;base64,RIGHT" },
    { id: "top" as const, dataUrl: "data:image/png;base64,TOP" },
];

describe("ensureModel3dViews", () => {
    test("passes the persisted target camera into live capture for immediate Agent camera-to-generation flows", async () => {
        const capture = vi.fn(capturedViews);
        const camera = { azimuth: 135, elevation: 20, distanceRatio: 3 };
        registerCaptureFn("node-3d-1", capture);
        uploadImage.mockImplementation(async (dataUrl: string) => ({ storageKey: `image:${dataUrl.split(",")[1]}` }));
        await ensureModel3dViews(node3d({ metadata: { model3d: { camera } } }));
        expect(capture).toHaveBeenCalledWith(camera);
    });

    test("returns and persists live views in stable semantic order", async () => {
        registerCaptureFn("node-3d-1", capturedViews);
        uploadImage.mockImplementation(async (dataUrl: string) => ({ storageKey: `image:${dataUrl.split(",")[1].toLowerCase()}` }));
        const onPersisted = vi.fn();
        const views = await ensureModel3dViews(node3d(), { onPersisted });

        expect(views.map((view) => view.id)).toEqual(["primary", "left", "right", "top"]);
        expect(views.map((view) => view.dataUrl)).toEqual(capturedViews().map((view) => view.dataUrl));
        expect(onPersisted).toHaveBeenCalledWith([
            { id: "primary", storageKey: "image:primary" },
            { id: "left", storageKey: "image:left" },
            { id: "right", storageKey: "image:right" },
            { id: "top", storageKey: "image:top" },
        ]);
        expect(getLiveModel3dViews("node-3d-1").map((view) => view.id)).toEqual(["primary", "left", "right", "top"]);
    });

    test("hydrates a persisted four-view set when WebGL is not mounted", async () => {
        imageToDataUrl.mockImplementation(async ({ storageKey }: { storageKey: string }) => `data:image/png;base64,${storageKey.split(":")[1].toUpperCase()}`);
        const views = await ensureModel3dViews(node3d({
            metadata: { model3d: { views: [
                { id: "primary", storageKey: "image:primary" },
                { id: "left", storageKey: "image:left" },
                { id: "right", storageKey: "image:right" },
                { id: "top", storageKey: "image:top" },
            ] } },
        }));
        expect(views.map((view) => view.dataUrl)).toEqual([
            "data:image/png;base64,PRIMARY",
            "data:image/png;base64,LEFT",
            "data:image/png;base64,RIGHT",
            "data:image/png;base64,TOP",
        ]);
        expect(uploadImage).not.toHaveBeenCalled();
    });

    const projectFileRef = (assetId: string) => ({ backend: "project-file" as const, projectId: "p1", assetId, revision: 1, relativePath: `assets/generated/${assetId}.png` });

    test("hydrates migrated assetRef-only views from the workspace and counts them as persisted without re-upload (终审 I2)", async () => {
        getCanvasAssetBlob.mockResolvedValue(new Blob(["workspace-bytes"], { type: "image/png" }));
        readFileAsDataUrl.mockResolvedValue("data:image/png;base64,WORKSPACE");
        const views = await ensureModel3dViews(node3d({
            metadata: { model3d: { views: [
                { id: "primary", assetRef: projectFileRef("a1") },
                { id: "left", assetRef: projectFileRef("a2") },
            ] } },
        }));
        // assetRef-only 视图被 persistedViewKeys 判定为已物化并从工作区水合（而非丢失或回退快照）
        expect(views.map((view) => view.id)).toEqual(["primary", "left"]);
        expect(views.map((view) => view.dataUrl)).toEqual(["data:image/png;base64,WORKSPACE", "data:image/png;base64,WORKSPACE"]);
        expect(getCanvasAssetBlob).toHaveBeenCalledTimes(2);
        // 不触发 uploadImage 写回 IndexedDB（防回弹）
        expect(uploadImage).not.toHaveBeenCalled();
        expect(imageToDataUrl).not.toHaveBeenCalled();
    });

    test("falls back to the legacy storageKey only when the workspace asset cannot be read", async () => {
        getCanvasAssetBlob.mockResolvedValue(null);
        imageToDataUrl.mockResolvedValue("data:image/png;base64,STORED");
        const views = await ensureModel3dViews(node3d({
            metadata: { model3d: { views: [{ id: "primary", storageKey: "image:kept", assetRef: projectFileRef("a1") }] } },
        }));
        expect(views).toEqual([{ id: "primary", dataUrl: "data:image/png;base64,STORED", storageKey: "image:kept", assetRef: projectFileRef("a1") }]);
        expect(uploadImage).not.toHaveBeenCalled();
    });

    test("keeps an old single snapshot as a primary-only compatibility reference", async () => {
        imageToDataUrl.mockResolvedValue("data:image/png;base64,LEGACY");
        const views = await ensureModel3dViews(node3d({ metadata: { model3d: { snapshot: { storageKey: "image:legacy" } } } }));
        expect(views).toEqual([{ id: "primary", dataUrl: "data:image/png;base64,LEGACY", storageKey: "image:legacy" }]);
    });

    test("keeps all live views usable without adopting a partial persisted set", async () => {
        registerCaptureFn("node-3d-1", capturedViews);
        uploadImage.mockImplementation(async (dataUrl: string) => {
            if (dataUrl.endsWith("LEFT")) throw new Error("quota");
            return { storageKey: `image:${dataUrl.split(",")[1].toLowerCase()}` };
        });
        const onPersisted = vi.fn();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const views = await ensureModel3dViews(node3d(), { onPersisted });
        expect(views).toHaveLength(4);
        expect(onPersisted).not.toHaveBeenCalled();
        expect(getLiveModel3dViews("node-3d-1")).toHaveLength(4);
        warn.mockRestore();
    });

    test("deduplicates concurrent four-view capture and persistence", async () => {
        registerCaptureFn("node-3d-1", capturedViews);
        uploadImage.mockImplementation(async (dataUrl: string) => ({ storageKey: `image:${dataUrl.split(",")[1]}` }));
        const first = ensureModel3dViews(node3d());
        const second = ensureModel3dViews(node3d());
        expect(await first).toEqual(await second);
        expect(uploadImage).toHaveBeenCalledTimes(4);
    });
});

describe("persistSnapshot", () => {
    test("uploads the dataUrl and reports the new storageKey, deleting the previous key", async () => {
        uploadImage.mockResolvedValue({ storageKey: "image:fresh", url: "blob:fresh" });
        const persisted = await persistSnapshot("data:image/png;base64,FRESH", "image:stale");
        expect(persisted?.storageKey).toBe("image:fresh");
        expect(deleteStoredImages).toHaveBeenCalledWith(["image:stale"]);
    });

    test("returns null on upload failure instead of throwing", async () => {
        uploadImage.mockRejectedValue(new Error("quota"));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const persisted = await persistSnapshot("data:image/png;base64,FRESH");
        expect(persisted).toBeNull();
        warn.mockRestore();
    });
});
