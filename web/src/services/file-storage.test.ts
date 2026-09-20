import { describe, expect, test, vi } from "vitest";

// 单测钉（spec §7）：collectMediaStorageKeys 深遍历必须命中镜头音频快照的 storageKey，
// 这是上传音频 blob 不被 cleanupUnusedMedia 回收的前提。mock localforage 保持纯单元级。
vi.mock("localforage", () => ({
    default: { createInstance: () => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), iterate: vi.fn() }) },
}));

import { collectMediaStorageKeys } from "@/services/file-storage";

describe("collectMediaStorageKeys（GC 依赖钉，spec §7）", () => {
    test("深遍历 nodes[].metadata.script 命中 sfxAudio.storageKey", () => {
        const data = {
            schemaVersion: 1,
            nodes: [
                {
                    id: "script-1",
                    type: "script",
                    metadata: {
                        script: {
                            output: {
                                shots: [{ shotId: "s1", sfxAudio: { name: "x", storageKey: "audio:abc" } }],
                            },
                        },
                    },
                },
            ],
        };
        expect(collectMediaStorageKeys(data).has("audio:abc")).toBe(true);
    });
});
