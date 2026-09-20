import { describe, expect, it } from "vitest";

import { audioMetadata, imageMetadata, referenceUrl, videoMetadata } from "./canvas-node-factory";

describe("referenceUrl", () => {
    it("storageKey 优先（image: 回归）", () => {
        expect(referenceUrl({ id: "1", name: "a.png", type: "image/png", dataUrl: "blob:dead", storageKey: "image:abc" })).toBe("image:abc");
    });
    it("project-file assetRef → pfile: token", () => {
        const url = referenceUrl({ id: "1", name: "a.png", type: "image/png", dataUrl: "blob:live", assetRef: { backend: "project-file", projectId: "p1", assetId: "a1", revision: 2, relativePath: "x/y.png" } });
        expect(url).toBe("pfile:p1:a1:2:x%2Fy.png");
    });
    it("indexeddb assetRef（storageKey 形态）→ storageKey", () => {
        expect(referenceUrl({ id: "1", name: "a.png", type: "image/png", dataUrl: "", assetRef: { backend: "indexeddb", storageKey: "image:xyz" } })).toBe("image:xyz");
    });
    it("无 storageKey/assetRef：非 data: dataUrl 回退（回归）、data: → undefined（回归）", () => {
        expect(referenceUrl({ id: "1", name: "a.png", type: "image/png", dataUrl: "blob:only" })).toBe("blob:only");
        expect(referenceUrl({ id: "1", name: "a.png", type: "image/png", dataUrl: "data:image/png;base64,AA" })).toBeUndefined();
    });
    it("project-file assetRef 与 storageKey 同时存在 → token 优先（move 语义，storageKey 字节可能已删）", () => {
        const url = referenceUrl({ id: "1", name: "a.png", type: "image/png", dataUrl: "blob:dead", storageKey: "image:abc", assetRef: { backend: "project-file", projectId: "p1", assetId: "a1", revision: 2, relativePath: "x/y.png" } });
        expect(url).toBe("pfile:p1:a1:2:x%2Fy.png");
    });
});

describe("metadata 工厂（project-file assetRef 时不携带 storageKey）", () => {
    const ref = { backend: "project-file" as const, projectId: "p1", assetId: "a1", revision: 1, relativePath: "assets/generated/images/a1.png" };
    it("imageMetadata", () => {
        const metadata = imageMetadata({ url: "blob:u", storageKey: "image:x", assetRef: ref, width: 1, height: 1, bytes: 2, mimeType: "image/png" });
        expect(metadata.storageKey).toBeUndefined();
        expect("storageKey" in metadata).toBe(false);
    });
    it("videoMetadata / audioMetadata", () => {
        expect("storageKey" in videoMetadata({ url: "blob:v", assetRef: ref, bytes: 1, mimeType: "video/mp4", width: 2, height: 2 })).toBe(false);
        expect("storageKey" in audioMetadata({ url: "blob:a", assetRef: ref, bytes: 1, mimeType: "audio/mpeg" })).toBe(false);
        expect(videoMetadata({ url: "blob:v", storageKey: "video:x", bytes: 1, mimeType: "video/mp4", width: 2, height: 2 }).storageKey).toBe("video:x");
    });
});
