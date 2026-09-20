import { describe, expect, it, vi } from "vitest";

const deleteStoredImages = vi.hoisted(() => vi.fn(async () => undefined));
const deleteStoredMedia = vi.hoisted(() => vi.fn(async (_keys: string[]) => undefined));
vi.mock("@/services/image-storage", () => ({ deleteStoredImages }));
vi.mock("@/services/file-storage", () => ({ deleteStoredMedia }));

import { deleteStoredMediaKeys, isImageStorageKey } from "./stored-media-delete";

describe("deleteStoredMediaKeys", () => {
    it("image: 分流到 image-files，其余前缀分流到 media_files", async () => {
        await deleteStoredMediaKeys(["image:a", "video:b", "audio:c", "glb:d", "image:a"]);
        expect(deleteStoredImages).toHaveBeenCalledWith(["image:a"]);
        expect(deleteStoredMedia).toHaveBeenCalledTimes(1);
        expect(deleteStoredMedia.mock.calls[0][0].sort()).toEqual(["audio:c", "glb:d", "video:b"]);
    });

    it("删除失败不抛出：失败键 warn 后进入返回值，成功键不受影响", async () => {
        deleteStoredImages.mockRejectedValueOnce(new Error("boom"));
        const failures = await deleteStoredMediaKeys(["image:bad", "video:good"]);
        expect(failures).toEqual(["image:bad"]);
    });

    it("大批次失败经逐键收集不抛出（for..of 路径，终审 M3）", async () => {
        deleteStoredMedia.mockRejectedValueOnce(new Error("boom"));
        const failures = await deleteStoredMediaKeys(["video:a", "video:b", "video:c"]);
        expect(failures).toEqual(["video:a", "video:b", "video:c"]);
    });

    it("isImageStorageKey 只认 image: 前缀", () => {
        expect(isImageStorageKey("image:x")).toBe(true);
        expect(isImageStorageKey("video:x")).toBe(false);
    });
});
