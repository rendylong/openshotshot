import { afterEach, describe, expect, test, vi } from "vitest";

const imageToDataUrl = vi.hoisted(() => vi.fn());
const getCanvasAssetBlob = vi.hoisted(() => vi.fn());

vi.mock("@/services/image-storage", () => ({ imageToDataUrl }));
vi.mock("@/services/project-asset-storage", () => ({ getCanvasAssetBlob }));
vi.mock("@/lib/image-utils", () => ({ getDataUrlByteSize: () => 1, readImageMeta: async () => ({ width: 2, height: 3, mimeType: "image/png" }) }));

import { buildCanvasResourceReferences, resolveCanvasImageForAgent, resolveCanvasReferenceImages } from "@/lib/canvas/canvas-resource-references";
import { registerNodeDefinitions, unregisterPluginNodes } from "@/lib/canvas/node-registry";
import { clearModel3dSnapshots, setLiveModel3dViews } from "@/lib/canvas/model-3d-snapshot";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";
import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeDefinition } from "@/types/canvas-plugin";

const TEST_PLUGIN = "test-refs-plugin";

const node3d = (metadata: Record<string, unknown>): CanvasNodeData =>
    ({ id: "n3d", type: "3d", title: "Model", position: { x: 0, y: 0 }, width: 640, height: 480, metadata }) as CanvasNodeData;

afterEach(() => {
    unregisterPluginNodes(TEST_PLUGIN);
    clearModel3dSnapshots();
    vi.clearAllMocks();
});

describe("project-file asset references", () => {
    const projectRef: CanvasAssetRef = { backend: "project-file", assetId: "a1", projectId: "project-a", relativePath: "assets/imported/a.png", revision: 1 };
    const glbRef: CanvasAssetRef = { backend: "project-file", assetId: "glb-1", projectId: "project-a", relativePath: "assets/imported/model.glb", revision: 1 };

    test("mention compilation reads project-file bytes through the facade", async () => {
        getCanvasAssetBlob.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
        const node: CanvasNodeData = { id: "img-1", type: "image", title: "Imported", position: { x: 0, y: 0 }, width: 10, height: 10, metadata: { content: "blob:stale", assetRef: projectRef } };
        const images = await resolveCanvasReferenceImages(buildCanvasResourceReferences([node]), [node]);
        expect(getCanvasAssetBlob).toHaveBeenCalledWith(projectRef);
        expect(imageToDataUrl).not.toHaveBeenCalled();
        expect(images[0].dataUrl).toMatch(/^data:image\/png;base64,/);
    });

    test("3D mention reads the snapshot source, never the top-level GLB ref", async () => {
        register3d(() => null);
        imageToDataUrl.mockResolvedValue("data:image/png;base64,U05BUA==");
        const node = node3d({ content: "blob:glb", assetRef: glbRef, model3d: { snapshot: { storageKey: "image:kept" } } });
        const [reference] = buildCanvasResourceReferences([node]);
        const images = await resolveCanvasReferenceImages(reference ? [reference] : [], [node]);
        expect(imageToDataUrl).toHaveBeenCalledWith({ storageKey: "image:kept", url: expect.anything() });
        expect(getCanvasAssetBlob).not.toHaveBeenCalled();
        expect(images[0].dataUrl).toBe("data:image/png;base64,U05BUA==");
    });

    test("3D node without a snapshot is skipped instead of decoding the GLB", async () => {
        register3d(() => null);
        // 前置测试残留的 mockResolvedValue 会伪造成功；这里钉住「实时快照也不可用」。
        imageToDataUrl.mockResolvedValue("");
        const node = node3d({ content: "blob:glb", assetRef: glbRef, mimeType: "model/gltf-binary", model3d: {} });
        const [reference] = buildCanvasResourceReferences([node]);
        const images = await resolveCanvasReferenceImages(reference ? [reference] : [], [node]);
        expect(getCanvasAssetBlob).not.toHaveBeenCalled();
        expect(images).toEqual([]);
    });

    test("agent image reads prefer the node assetRef over legacy keys", async () => {
        getCanvasAssetBlob.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
        const scope = { projectId: "project-a", canvasId: "canvas-a" };
        const node: CanvasNodeData = {
            id: "image-node", type: "image", title: "Ref", position: { x: 0, y: 0 }, width: 10, height: 10,
            metadata: { content: "blob:stale", assetRef: projectRef, naturalWidth: 8, naturalHeight: 8, mimeType: "image/png", bytes: 3 },
        };
        const result = await resolveCanvasImageForAgent({ scope, nodeId: node.id }, scope, [node]);
        expect(getCanvasAssetBlob).toHaveBeenCalledWith(projectRef);
        expect(imageToDataUrl).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: true, image: { width: 8, sizeBytes: 3 } });
    });

    test("falls back to legacy resolvers when the node has no assetRef", async () => {
        getCanvasAssetBlob.mockClear();
        imageToDataUrl.mockResolvedValue("data:image/png;base64,TEVHQUNZ");
        const scope = { projectId: "project-a", canvasId: "canvas-a" };
        const node: CanvasNodeData = {
            id: "image-node", type: "image", title: "Ref", position: { x: 0, y: 0 }, width: 10, height: 10,
            metadata: { content: "blob:legacy", storageKey: "image:legacy", naturalWidth: 5, naturalHeight: 5, mimeType: "image/png", bytes: 2 },
        };
        const result = await resolveCanvasImageForAgent({ scope, nodeId: node.id }, scope, [node]);
        expect(getCanvasAssetBlob).not.toHaveBeenCalled();
        expect(imageToDataUrl).toHaveBeenCalledWith({ storageKey: "image:legacy", url: "blob:legacy" });
        expect(result).toMatchObject({ ok: true, image: { width: 5 } });
    });
});

function register3d(resourceImpl: CanvasNodeDefinition["resource"]) {
    registerNodeDefinitions(
        [{ type: "3d", title: "3D", defaultSize: { width: 640, height: 480 }, defaultMetadata: {}, referenceKind: "image", resource: resourceImpl } as unknown as CanvasNodeDefinition],
        TEST_PLUGIN,
    );
}

describe("resourceKind static declaration", () => {
    test("cold 3d node (resource() null) is still an image reference via the static declaration", () => {
        register3d(() => null);
        const references = buildCanvasResourceReferences([node3d({ model3d: { snapshot: { storageKey: "image:kept" } } })]);
        expect(references).toHaveLength(1);
        expect(references[0].kind).toBe("image");
        expect(references[0].nodeId).toBe("n3d");
    });

    test("3d mention preview prefers the snapshot URL over the GLB blob content", () => {
        register3d(() => ({ kind: "image", url: "data:image/png;base64,SNAP" }));
        const references = buildCanvasResourceReferences([node3d({ content: "blob:glb", model3d: { snapshot: { storageKey: "image:kept" } } })]);
        expect(references[0].previewUrl).toBe("data:image/png;base64,SNAP");
    });
});

describe("resolveCanvasReferenceImages for 3d nodes", () => {
    test("resolves the 3d snapshot storageKey, not the GLB blob URL", async () => {
        register3d(() => null);
        imageToDataUrl.mockResolvedValue("data:image/png;base64,RESOLVED");
        const node = node3d({ content: "blob:glb", model3d: { snapshot: { storageKey: "image:kept" } } });
        const [reference] = buildCanvasResourceReferences([node]);
        const images = await resolveCanvasReferenceImages(reference ? [reference] : [], [node]);
        expect(imageToDataUrl).toHaveBeenCalledWith({ storageKey: "image:kept", url: expect.anything() });
        expect(images[0].dataUrl).toBe("data:image/png;base64,RESOLVED");
        expect(images[0].width).toBe(2);
    });
});

describe("resolveCanvasImageForAgent", () => {
    const scope = { projectId: "project-a", canvasId: "canvas-a" };
    const baseNode = {
        id: "image-node",
        type: "image",
        title: "Reference",
        position: { x: 0, y: 0 },
        width: 320,
        height: 240,
    } satisfies Omit<CanvasNodeData, "metadata">;

    test("reads the legacy image source from the requested canvas", async () => {
        imageToDataUrl.mockResolvedValue("data:image/png;base64,T1JJR0lOQUw=");
        const result = await resolveCanvasImageForAgent(
            { scope, nodeId: baseNode.id },
            scope,
            [{ ...baseNode, metadata: { content: "blob:legacy", storageKey: "image:legacy", naturalWidth: 800, naturalHeight: 600, mimeType: "image/png", bytes: 8 } }],
        );

        expect(imageToDataUrl).toHaveBeenCalledWith({ storageKey: "image:legacy", url: "blob:legacy" });
        expect(result).toEqual({
            ok: true,
            image: { nodeId: "image-node", title: "Reference", dataUrl: "data:image/png;base64,T1JJR0lOQUw=", mimeType: "image/png", width: 800, height: 600, sizeBytes: 8 },
        });
    });

    test("uses the current primary image or an exact requested alternative", async () => {
        imageToDataUrl.mockImplementation(async ({ storageKey }: { storageKey?: string }) => `data:image/png;base64,${storageKey}`);
        const node: CanvasNodeData = {
            ...baseNode,
            metadata: {
                primaryImageId: "second",
                images: [
                    { id: "first", status: "success", content: "blob:first", storageKey: "image:first", naturalWidth: 100, naturalHeight: 80, bytes: 10, mimeType: "image/png" },
                    { id: "second", status: "success", content: "blob:second", storageKey: "image:second", naturalWidth: 200, naturalHeight: 160, bytes: 20, mimeType: "image/png" },
                ],
            },
        };

        await expect(resolveCanvasImageForAgent({ scope, nodeId: node.id }, scope, [node])).resolves.toMatchObject({ ok: true, image: { imageId: "second", width: 200 } });
        await expect(resolveCanvasImageForAgent({ scope, nodeId: node.id, imageId: "first" }, scope, [node])).resolves.toMatchObject({ ok: true, image: { imageId: "first", width: 100 } });
    });

    test("reads an exact 3D viewport capture and defaults to the primary view", async () => {
        const node = node3d({ model3d: {} });
        setLiveModel3dViews(node.id, [
            { id: "primary", dataUrl: "data:image/png;base64,PRIMARY" },
            { id: "left", dataUrl: "data:image/png;base64,LEFT" },
            { id: "right", dataUrl: "data:image/png;base64,RIGHT" },
            { id: "top", dataUrl: "data:image/png;base64,TOP" },
        ]);

        await expect(resolveCanvasImageForAgent({ scope, nodeId: node.id }, scope, [node])).resolves.toMatchObject({ ok: true, image: { nodeId: "n3d", imageId: "primary", dataUrl: "data:image/png;base64,PRIMARY" } });
        await expect(resolveCanvasImageForAgent({ scope, nodeId: node.id, imageId: "left" }, scope, [node])).resolves.toMatchObject({ ok: true, image: { nodeId: "n3d", imageId: "left", dataUrl: "data:image/png;base64,LEFT" } });
    });

    test("rejects a stale canvas scope before reading image storage", async () => {
        const result = await resolveCanvasImageForAgent({ scope: { projectId: "project-a", canvasId: "canvas-b" }, nodeId: baseNode.id }, scope, [{ ...baseNode, metadata: { content: "blob:image" } }]);

        expect(result).toEqual({ ok: false, error: expect.stringContaining("当前画布") });
        expect(imageToDataUrl).not.toHaveBeenCalled();
    });

    test.each([
        ["missing node", "missing", [{ ...baseNode, metadata: { content: "blob:image" } }], "不存在"],
        ["wrong node type", baseNode.id, [{ ...baseNode, type: "text", metadata: { content: "text" } }], "图片或 3D 节点"],
        ["missing image id", baseNode.id, [{ ...baseNode, metadata: { images: [{ id: "first", status: "success", content: "blob:first", naturalWidth: 1, naturalHeight: 1, bytes: 1, mimeType: "image/png" }] } }], "missing"],
    ])("rejects %s", async (_label, nodeId, nodes, message) => {
        await expect(resolveCanvasImageForAgent({ scope, nodeId, ...(_label === "missing image id" ? { imageId: "missing" } : {}) }, scope, nodes as CanvasNodeData[])).resolves.toEqual({ ok: false, error: expect.stringContaining(message) });
    });
});
