import { describe, expect, it, vi } from "vitest";

// jsdom 30 + vitest 的 createObjectURL 兼容垫片处理 jsdom Blob 时崩溃（读不到内部 _buffer）。
// mediaMetadataOf 仅用 blob URL 读取音视频元数据，glb 两者皆非、立即返回空元数据，桩掉 URL 编解码即可。
vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-media");
vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

const uploadMediaFile = vi.hoisted(() => vi.fn(async () => ({ url: "blob:idb", storageKey: "glb:x", bytes: 4, mimeType: "model/gltf-binary" })));
vi.mock("@/services/file-storage", () => ({ uploadMediaFile, getMediaBlob: vi.fn(), setMediaBlob: vi.fn(), readVideoMeta: vi.fn(), readAudioMeta: vi.fn(), resolveMediaUrl: vi.fn() }));
vi.mock("@/services/image-storage", () => ({ uploadImage: vi.fn(), resolveImageUrl: vi.fn(), getImageBlob: vi.fn(), loadImageMeta: vi.fn(), setImageBlob: vi.fn() }));
vi.mock("@/stores/canvas/use-project-store", () => ({ useProjectStore: { getState: () => ({ projects: [] }) } }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

import { storeCanvasModelFile } from "./project-asset-storage";

const glbFile = () => new File(["glb-bytes"], "rig.glb", { type: "model/gltf-binary" });

describe("storeCanvasModelFile", () => {
    it("无桥（Web）回退 uploadMediaFile(file, 'glb')，保持 glb: 前缀现状", async () => {
        Object.defineProperty(window, "shotshot", { value: undefined, configurable: true });
        const stored = await storeCanvasModelFile(glbFile());
        expect(uploadMediaFile).toHaveBeenCalledWith(expect.any(File), "glb");
        expect(stored.storageKey).toBe("glb:x");
    });

    it("有桥 + 写上下文：走项目工作区，返回 assetRef-only（无 storageKey）", async () => {
        const ref = { backend: "project-file" as const, projectId: "p1", assetId: "a1", revision: 1, relativePath: "assets/imported/rig.glb" };
        const write = vi.fn(async () => ({ ok: true as const, value: { record: { ...ref, bytes: 9, mimeType: "model/gltf-binary", originalName: "rig.glb", kind: "file" as const, sha256: "h", createdAt: "", updatedAt: "", source: { type: "canvas-import" as const } }, ref } }));
        Object.defineProperty(window, "shotshot", { value: { projectAssets: { write, onChanged: vi.fn(() => () => {}) } }, configurable: true });
        const stored = await storeCanvasModelFile(glbFile(), { projectId: "p1", canvasId: "c1", workspacePath: "/ws/p1", source: { type: "canvas-import" } });
        expect(write).toHaveBeenCalled();
        expect(stored.assetRef).toEqual(ref);
        expect(stored.storageKey).toBeUndefined();
        expect(stored.mimeType).toBe("model/gltf-binary");
    });
});
