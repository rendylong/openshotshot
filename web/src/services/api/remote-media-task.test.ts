import { afterEach, describe, expect, test, vi } from "vitest";

import { normalizeRemoteTaskQuery, normalizeRemoteTaskSubmit, submitAdapterRemoteMediaTask, queryAdapterRemoteMediaTask } from "./remote-media-task";

import { createModelChannel, defaultConfig } from "@/stores/use-config-store";
afterEach(() => vi.unstubAllGlobals());

describe("remote media task protocol", () => {
    test("routes fal submission and recovery through the versioned adapter protocol", async () => {
        const channel = createModelChannel({ provider: "fal", apiKey: "fixture-key", models: [{ name: "fal-ai/flux-2-pro", capability: "image" }] });
        const input = { adapterId: "fal.image", adapterVersion: 1, channelId: channel.id, config: { ...defaultConfig, channels: [channel], model: "fal-ai/flux-2-pro", apiKey: channel.apiKey, baseUrl: channel.baseUrl }, prompt: "cup", images: [], params: {} };
        const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ request_id: "r1" })).mockResolvedValueOnce(Response.json({ status: "COMPLETED" })).mockResolvedValueOnce(Response.json({ images: [{ url: "https://cdn.example/out.png" }] }));
        vi.stubGlobal("fetch", fetcher);
        await expect(submitAdapterRemoteMediaTask(input)).resolves.toEqual({ taskId: "r1" });
        // The old task still recovers after its model is removed from channel settings.
        input.config.channels[0].models = [];
        await expect(queryAdapterRemoteMediaTask({ ...input, taskId: "r1" })).resolves.toEqual({ status: "succeeded", result: { kind: "image", sources: ["https://cdn.example/out.png"] } });
        expect(fetcher).toHaveBeenCalledTimes(3);
        await expect(queryAdapterRemoteMediaTask({ ...input, adapterVersion: 2, taskId: "r1" })).rejects.toThrow("version 2 is unavailable");
        expect(fetcher).toHaveBeenCalledTimes(3);
    });
    test("normalizes submit results", () => {
        expect(normalizeRemoteTaskSubmit("task-1")).toEqual({ taskId: "task-1" });
        expect(normalizeRemoteTaskSubmit({ taskId: "task-2" })).toEqual({ taskId: "task-2" });
        expect(() => normalizeRemoteTaskSubmit({ taskId: "" })).toThrow("taskId");
    });

    test("normalizes query results and rejects invalid terminal data", () => {
        expect(normalizeRemoteTaskQuery({ status: "pending", phase: "running", progress: 35 })).toEqual({ status: "pending", phase: "running", progress: 35 });
        expect(normalizeRemoteTaskQuery({ status: "succeeded", result: { url: "https://example.com/out.mp4" } }).status).toBe("succeeded");
        expect(normalizeRemoteTaskQuery({ status: "failed", error: "denied" })).toEqual({ status: "failed", error: "denied" });
        expect(() => normalizeRemoteTaskQuery({ status: "succeeded" })).toThrow("result");
    });
});
