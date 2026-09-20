import { describe, expect, test } from "vitest";

import { isRemoteMediaTask } from "./remote-media-task";

function validTask(patch: Record<string, unknown> = {}) {
    return {
        id: "task-1",
        capability: "image",
        target: { projectId: "p-1", canvasId: "c-1", nodeId: "n-1" },
        channelId: "ch-1",
        modelName: "gpt-image-2/image-to-image",
        baseUrlSnapshot: "https://api.hiapi.ai",
        adapterId: "hiapi.image",
        adapterVersion: 1,
        status: "submission_unknown",
        submittedAt: 1_000,
        deadlineAt: 301_000,
        ...patch,
    };
}

describe("isRemoteMediaTask idempotencyKey", () => {
    test("accepts a task carrying a non-empty idempotency key", () => {
        expect(isRemoteMediaTask(validTask({ idempotencyKey: "0e2c4c3e-6f7a-4b1c-9a2d-8f3e5b6a7c8d" }))).toBe(true);
    });

    test("accepts a task without an idempotency key (existing snapshots)", () => {
        expect(isRemoteMediaTask(validTask())).toBe(true);
    });

    test("rejects blank or non-string idempotency keys", () => {
        expect(isRemoteMediaTask(validTask({ idempotencyKey: "   " }))).toBe(false);
        expect(isRemoteMediaTask(validTask({ idempotencyKey: 42 }))).toBe(false);
    });
});

describe("isRemoteMediaTask scriptSource", () => {
    test("accepts a task carrying dispatch-time script lineage", () => {
        expect(isRemoteMediaTask(validTask({ scriptSource: { scriptNodeId: "script-1", shotId: "shot-1", role: "video", version: 2 } }))).toBe(true);
        expect(isRemoteMediaTask(validTask({ scriptSource: { scriptNodeId: "script-1" } }))).toBe(true);
        expect(isRemoteMediaTask(validTask({ scriptSource: { scriptNodeId: "script-1", shotId: "shot-1", role: "storyboard" } }))).toBe(true);
    });

    test("accepts a task without scriptSource (existing snapshots)", () => {
        expect(isRemoteMediaTask(validTask())).toBe(true);
    });

    test("rejects malformed script lineage", () => {
        expect(isRemoteMediaTask(validTask({ scriptSource: { shotId: "shot-1" } }))).toBe(false);
        expect(isRemoteMediaTask(validTask({ scriptSource: { scriptNodeId: "" } }))).toBe(false);
        expect(isRemoteMediaTask(validTask({ scriptSource: { scriptNodeId: "s", role: "cameo" } }))).toBe(false);
        expect(isRemoteMediaTask(validTask({ scriptSource: { scriptNodeId: "s", version: Number.NaN } }))).toBe(false);
        expect(isRemoteMediaTask(validTask({ scriptSource: "script-1" }))).toBe(false);
    });
});
describe("persisted managed recovery intent", () => {
    test("retains additive recovery fields through serialization while accepting old tasks", () => {
        const restored = JSON.parse(JSON.stringify(validTask({ recoveryRequested: true, recoveryPhase: "confirming" })));
        expect(isRemoteMediaTask(restored)).toBe(true);
        expect(restored.recoveryRequested).toBe(true);
        expect(restored.recoveryPhase).toBe("confirming");
        expect(isRemoteMediaTask(validTask())).toBe(true);
    });
    test("rejects malformed recovery intent instead of silently replaying it", () => {
        expect(isRemoteMediaTask(validTask({ recoveryRequested: "true" }))).toBe(false);
        expect(isRemoteMediaTask(validTask({ recoveryPhase: "submit" }))).toBe(false);
    });
});


test.each(["queued", "running", "delivering", "downloading", "saving"])("retains optional delivery phase %s and accepts old records", phase => {
    expect(isRemoteMediaTask(JSON.parse(JSON.stringify(validTask({ phase }))))).toBe(true);
    expect(isRemoteMediaTask(validTask())).toBe(true);
    expect(isRemoteMediaTask(validTask({ phase: "unknown" }))).toBe(false);
});
