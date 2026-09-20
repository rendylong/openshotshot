import { describe, expect, it, vi } from "vitest";

const uploadImage = vi.hoisted(() => vi.fn(async () => ({ url: "blob:i", storageKey: "image:x", width: 10, height: 10, bytes: 4, mimeType: "image/png" })));
const uploadMediaFile = vi.hoisted(() => vi.fn(async () => ({ url: "blob:v", storageKey: "video:x", bytes: 8, mimeType: "video/mp4" })));
const storeCanvasImage = vi.hoisted(() => vi.fn());
const storeCanvasMedia = vi.hoisted(() => vi.fn());
vi.mock("@/services/image-storage", () => ({ uploadImage }));
vi.mock("@/services/file-storage", () => ({ uploadMediaFile }));
vi.mock("@/services/project-asset-storage", () => ({ storeCanvasImage, storeCanvasMedia }));

import { attachmentImportOp } from "./agent-op-router";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-op-types";

type AddNodeOp = Extract<CanvasAgentOp, { type: "add_node" }>;
// CanvasAgentOp 是联合类型，metadata 仅 add_node 变体携带；测试统一收窄以保持断言写法与 brief 一致。
const runOp = async (...args: Parameters<typeof attachmentImportOp>): Promise<AddNodeOp & { metadata: NonNullable<AddNodeOp["metadata"]> }> =>
    (await attachmentImportOp(...args)) as AddNodeOp & { metadata: NonNullable<AddNodeOp["metadata"]> };

const imageAttachment = { kind: "image" as const, handle: "h1", name: "a.png", mimeType: "image/png", size: 4, dataUrl: "data:image/png;base64,AA" };
const glbAttachment = { kind: "glb" as const, handle: "h2", name: "rig.glb", mimeType: "model/gltf-binary", size: 8, dataUrl: "data:model/gltf-binary;base64,AA" };
const writeContext = { projectId: "p1", canvasId: "c1", source: { type: "agent-attachment" as const, canvasId: "c1" } };

describe("attachmentImportOp 写入分流", () => {
    it("桌面（有写上下文）：图片走 storeCanvasImage，元数据 assetRef-only", async () => {
        const ref = { backend: "project-file" as const, projectId: "p1", assetId: "a1", revision: 1, relativePath: "assets/imported/a.png" };
        storeCanvasImage.mockResolvedValueOnce({ url: "blob:stored", assetRef: ref, width: 10, height: 10, bytes: 4, mimeType: "image/png" });
        const op = await runOp(imageAttachment, 0, { x: 0, y: 0 }, writeContext);
        expect(storeCanvasImage).toHaveBeenCalledWith(imageAttachment.dataUrl, expect.objectContaining({ projectId: "p1" }));
        expect(op.metadata.storageKey).toBeUndefined();
        expect(op.metadata.assetRef).toEqual(ref);
    });

    it("桌面 GLB：走 storeCanvasMedia，model3d 元数据 assetRef-only", async () => {
        const ref = { backend: "project-file" as const, projectId: "p1", assetId: "a2", revision: 1, relativePath: "assets/imported/rig.glb" };
        storeCanvasMedia.mockResolvedValueOnce({ url: "blob:stored-glb", assetRef: ref, bytes: 8, mimeType: "model/gltf-binary" });
        const op = await runOp(glbAttachment, 0, { x: 0, y: 0 }, writeContext);
        expect(storeCanvasMedia).toHaveBeenCalled();
        expect(op.metadata.model3d?.assetRef).toEqual(ref);
        expect(op.metadata.model3d?.storageKey).toBeUndefined();
    });

    it("Web（无写上下文）：既有 IDB 直写不变", async () => {
        const op = await runOp(imageAttachment, 0, { x: 0, y: 0 });
        expect(uploadImage).toHaveBeenCalledWith(imageAttachment.dataUrl);
        expect(op.metadata.storageKey).toBe("image:x");
        expect(op.metadata.assetRef).toBeUndefined();
    });
});
