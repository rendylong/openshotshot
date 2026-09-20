import { afterEach, describe, expect, test, vi } from "vitest";

import i18n from "@/i18n";
import { resetManagedCatalogForTests } from "@/lib/desktop/managed-catalog-cache";
import type { ManagedModelDescriptor } from "@/lib/desktop/managed-model-types";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";

import { managedImageAdapter } from "./managed-image";

function config(model: string, overrides: Partial<AiConfig> = {}): AiConfig {
    return {
        ...defaultConfig,
        credentialMode: "shotshot",
        credentialModes: { agent: "shotshot", text: "shotshot", image: "shotshot", video: "shotshot", audio: "shotshot" },
        model,
        size: "16:9",
        quality: "2K",
        baseUrl: "should-not-be-used",
        apiKey: "should-not-be-used",
        ...overrides,
    };
}

const descriptor = {
    id: "gpt-image-2/image-to-image",
    name: "GPT Image 2 (edit)",
    capability: "image" as const,
    execution: "remote_task" as const,
    spec: { aspectRatios: ["16:9"], resolutions: ["1K", "2K", "4K"] },
    input_slots: [{ field: "input_urls", kind: "image" as const, required: true, accept_types: ["image/png"] }],
};

const textDescriptor = {
    ...descriptor,
    id: "gpt-image-2/text-to-image",
    name: "GPT Image 2",
    input_slots: [],
};

function bridge(fetch: ReturnType<typeof vi.fn>, models: ManagedModelDescriptor[] = [descriptor]) {
    window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(async () => models), fetch: fetch as never, abort: vi.fn() } };
    return fetch;
}

function jsonResponse(request: { id: string }, value: string) {
    return { id: request.id, status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: { kind: "text" as const, value } };
}

function errorResponse(request: { id: string }, status: number, value: string) {
    return { id: request.id, status, statusText: "error", headers: { "content-type": "application/json" }, body: { kind: "text" as const, value } };
}

/** jsdom's FileReader never settles under fake timers, so fake the read synchronously. */
function stubImmediateFileReader() {
    class ImmediateFileReader {
        result: string | null = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsDataURL(blob: Blob) {
            void blob.arrayBuffer().then((buffer) => {
                const bytes = new Uint8Array(buffer);
                this.result = `data:${blob.type};base64,${btoa(String.fromCharCode(...bytes))}`;
                this.onload?.();
            });
        }
    }
    vi.stubGlobal("FileReader", ImmediateFileReader);
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetManagedCatalogForTests();
});

describe("managed image adapter", () => {
    test("submits the canonical spec string, count, assets and idempotency key", async () => {
        const fetch = bridge(vi.fn(async (request) => jsonResponse(request, '{"id":"img-1"}')), [textDescriptor]);
        const request = {
            config: config("gpt-image-2/text-to-image"),
            channelId: "shotshot-managed",
            prompt: "a product shot",
            images: [],
            params: { count: "2" },
            idempotencyKey: "idem-1",
        };

        await expect(managedImageAdapter.submit!(request)).resolves.toEqual({ taskId: "img-1" });

        const body = JSON.parse(fetch.mock.calls[0]![0].body.value) as Record<string, unknown>;
        expect(fetch.mock.calls[0]![0]).toMatchObject({ method: "POST", path: "/v1/media/tasks" });
        expect(body).toMatchObject({
            model: "gpt-image-2/text-to-image",
            prompt: "a product shot",
            resolution: "16:9|2K",
            count: 2,
            assets: {},
            idempotency_key: "idem-1",
        });
        expect(body.resolution).not.toMatch(/\d+x\d+/);
        expect(body).not.toHaveProperty("size");
        expect(body).not.toHaveProperty("quality");
    });

    test("defaults a stale global quality to the first declared resolution before submitting", async () => {
        const fetch = bridge(vi.fn(async (request) => jsonResponse(request, '{"id":"img-default"}')), [textDescriptor]);

        await expect(managedImageAdapter.submit!({
            config: config("gpt-image-2/text-to-image", { quality: "high" }),
            channelId: "shotshot-managed",
            prompt: "a product shot",
            images: [],
            params: {},
            idempotencyKey: "idem-default",
        })).resolves.toEqual({ taskId: "img-default" });

        expect(JSON.parse(fetch.mock.calls[0]![0].body.value).resolution).toBe("16:9|1K");
    });

    test("rejects a managed image model with required image slots before submitting without references", async () => {
        const fetch = bridge(vi.fn(async (request) => jsonResponse(request, '{"id":"must-not-submit"}')));

        await expect(managedImageAdapter.submit!({
            config: config(descriptor.id),
            channelId: "shotshot-managed",
            prompt: "generate without reference",
            images: [],
            params: {},
        })).rejects.toThrow(i18n.t("apiErrors.managedImageMissingReference", { model: descriptor.id }));

        expect(fetch).not.toHaveBeenCalled();
    });

    test("uploads reference images and keys them by the declared field name", async () => {
        const fetch = bridge(vi.fn(async (request) => request.path === "/v1/assets/upload" ? jsonResponse(request, '{"asset_id":"asset-1"}') : jsonResponse(request, '{"id":"img-2"}')));
        const request = {
            config: config("gpt-image-2/image-to-image"),
            channelId: "shotshot-managed",
            prompt: "edit this",
            images: ["data:image/png;base64,aW1hZ2U="],
            params: {},
            idempotencyKey: "idem-2",
        };

        await expect(managedImageAdapter.submit!(request)).resolves.toEqual({ taskId: "img-2" });

        expect(fetch.mock.calls.map(([item]) => [item.method, item.path])).toEqual([
            ["POST", "/v1/assets/upload"],
            ["POST", "/v1/assets/asset-1/content"],
            ["POST", "/v1/assets/asset-1/complete"],
            ["POST", "/v1/media/tasks"],
        ]);
        expect(JSON.parse(fetch.mock.calls.at(-1)![0].body.value).assets).toEqual({ input_urls: "asset-1" });
    });

    test("reports a gateway unknown submission without pretending it is running", async () => {
        const fetch = bridge(vi.fn(async (request) => jsonResponse(request, '{"id":"img-unknown","state":"submission_unknown"}')));
        const result = await managedImageAdapter.query!({ config: config(descriptor.id), prompt: "", images: [], params: {}, taskId: "img-unknown" });
        expect(result).toEqual({ status: "submission_unknown", error: i18n.t("canvas.remoteTask.submissionUnknown") });
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[0][0]).toMatchObject({ method: "GET", path: "/v1/media/tasks/img-unknown" });
    });

    test("uploads multiple references using the gateway ordered-array contract", async () => {
        let asset = 0;
        const fetch = bridge(vi.fn(async (request) => request.path === "/v1/assets/upload"
            ? jsonResponse(request, JSON.stringify({ asset_id: `asset-${++asset}` }))
            : jsonResponse(request, '{"id":"img-multi"}')));
        await managedImageAdapter.submit!({ config: config(descriptor.id), prompt: "edit", images: Array(3).fill("data:image/png;base64,aW1hZ2U="), params: {} });
        expect(JSON.parse(fetch.mock.calls.at(-1)![0].body.value).assets).toEqual({ input_urls: "asset-1", ref_image_1: "asset-2", ref_image_2: "asset-3" });
    });

    test("queries the task then downloads the result bytes as an image source", async () => {
        const fetch = bridge(vi.fn()
            .mockImplementationOnce(async (request) => jsonResponse(request, '{"id":"img-3","state":"succeeded"}'))
            .mockImplementationOnce(async (request) => ({ id: request.id, status: 200, statusText: "OK", headers: { "content-type": "image/png" }, body: { kind: "bytes" as const, value: new Uint8Array([1, 2, 3]), contentType: "image/png" } })));

        const state = await managedImageAdapter.query!({ config: config("gpt-image-2/image-to-image"), prompt: "", images: [], params: {}, taskId: "img-3" });

        expect(fetch.mock.calls.map(([item]) => [item.method, item.path])).toEqual([
            ["GET", "/v1/media/tasks/img-3"],
            ["GET", "/v1/media/tasks/img-3/content"],
        ]);
        expect(state).toEqual({ status: "succeeded", result: { kind: "image", sources: ["data:image/png;base64,AQID"] } });
    });

    test("retries a transient not-ready content download before delivering", async () => {
        vi.useFakeTimers();
        stubImmediateFileReader();
        const fetch = bridge(vi.fn()
            .mockImplementationOnce(async (request) => jsonResponse(request, '{"id":"img-6","state":"succeeded"}'))
            .mockImplementationOnce(async (request) => errorResponse(request, 404, '{"error":"result_not_ready"}'))
            .mockImplementationOnce(async (request) => ({ id: request.id, status: 200, statusText: "OK", headers: { "content-type": "image/png" }, body: { kind: "bytes" as const, value: new Uint8Array([1, 2, 3]), contentType: "image/png" } })));

        const pending = managedImageAdapter.query!({ config: config("gpt-image-2/image-to-image"), prompt: "", images: [], params: {}, taskId: "img-6" });
        const assertion = expect(pending).resolves.toEqual({ status: "succeeded", result: { kind: "image", sources: ["data:image/png;base64,AQID"] } });
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(0);

        await assertion;
        expect(fetch.mock.calls.map(([item]) => item.path)).toEqual([
            "/v1/media/tasks/img-6",
            "/v1/media/tasks/img-6/content",
            "/v1/media/tasks/img-6/content",
        ]);
    });

    test("exhausts the content retry and parks a succeeded task as downloading", async () => {
        vi.useFakeTimers();
        stubImmediateFileReader();
        const fetch = bridge(vi.fn()
            .mockImplementationOnce(async (request) => jsonResponse(request, '{"id":"img-7","state":"succeeded"}'))
            .mockImplementation(async (request) => errorResponse(request, 404, '{"error":"result_not_ready"}')));

        const pending = managedImageAdapter.query!({ config: config("gpt-image-2/image-to-image"), prompt: "", images: [], params: {}, taskId: "img-7" });
        const assertion = pending.then((result) => expect(result).toEqual({ status: "pending", phase: "downloading" }));
        await vi.advanceTimersByTimeAsync(4_000);
        await assertion;
        expect(fetch).toHaveBeenCalledTimes(4);
    });

    test("does not retry a non-transient content failure within the poll cycle and parks as downloading", async () => {
        const fetch = bridge(vi.fn()
            .mockImplementationOnce(async (request) => jsonResponse(request, '{"id":"img-8","state":"succeeded"}'))
            .mockImplementationOnce(async (request) => errorResponse(request, 400, '{"error":"invalid_request"}')));

        await expect(managedImageAdapter.query!({ config: config("gpt-image-2/image-to-image"), prompt: "", images: [], params: {}, taskId: "img-8" }))
            .resolves.toEqual({ status: "pending", phase: "downloading" });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    test("propagates an abort while downloading content", async () => {
        const controller = new AbortController();
        const fetch = bridge(vi.fn()
            .mockImplementationOnce(async (request) => jsonResponse(request, '{"id":"img-9","state":"succeeded"}'))
            .mockImplementationOnce(async () => {
                controller.abort();
                throw new DOMException("The operation was aborted", "AbortError");
            }));
        await expect(managedImageAdapter.query!({ config: config("gpt-image-2/image-to-image"), prompt: "", images: [], params: {}, taskId: "img-9", signal: controller.signal }))
            .rejects.toThrow();
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    test("reports a failed task with its gateway error code and pending otherwise", async () => {
        const failing = bridge(vi.fn(async (request) => jsonResponse(request, '{"id":"img-4","state":"failed","error_code":"upstream_rejected"}')));
        await expect(managedImageAdapter.query!({ config: config("gpt-image-2/image-to-image"), prompt: "", images: [], params: {}, taskId: "img-4" }))
            .resolves.toEqual({ status: "failed", error: "upstream_rejected" });
        expect(failing).toHaveBeenCalledOnce();

        const pending = bridge(vi.fn(async (request) => jsonResponse(request, '{"id":"img-5","state":"submitted"}')));
        await expect(managedImageAdapter.query!({ config: config("gpt-image-2/image-to-image"), prompt: "", images: [], params: {}, taskId: "img-5" }))
            .resolves.toEqual({ status: "pending", phase: "running" });
        expect(pending).toHaveBeenCalledOnce();
    });

    test("declares itself an idempotent remote_task image adapter", () => {
        expect(managedImageAdapter).toMatchObject({ id: "shotshot.managed-image", modality: "image", execution: "remote_task", idempotentSubmit: true });
    });

    test("requires a task id from the gateway", async () => {
        bridge(vi.fn(async (request) => jsonResponse(request, "{}")), [textDescriptor]);
        await expect(managedImageAdapter.submit!({ config: config("gpt-image-2/text-to-image"), prompt: "x", images: [], params: {} }))
            .rejects.toThrow(i18n.t("apiErrors.noImageTaskId"));
    });
});

test("managed recovery confirms only the saved gateway task and exposes progress", async () => {
    const fetch = bridge(vi.fn(async (request) => jsonResponse(request, JSON.stringify(request.method === "POST"
        ? { id: "original-task", state: "reconciling", recovery_action: "confirm_submission" }
        : { id: "original-task", state: "submission_unknown", recovery_action: "confirm_submission" }))));
    const result = await managedImageAdapter.recover!({ config: config(descriptor.id), prompt: "ignored edited prompt", images: [], params: {}, taskId: "original-task" });
    expect(result).toEqual({ status: "pending", phase: "queued", recoveryPhase: "confirming" });
    expect(fetch.mock.calls.map(([request]) => [request.method, request.path])).toEqual([
        ["GET", "/v1/media/tasks/original-task"], ["POST", "/v1/media/tasks/original-task/recover"],
    ]);
});

test.each(["idempotency_expired", "recovery_snapshot_missing", "recovery_snapshot_invalid"])("managed recovery refuses %s without submitting", async error_code => {
    const fetch = bridge(vi.fn(async (request) => jsonResponse(request, JSON.stringify({ id: "original-task", state: "submission_unknown", recovery_action: "none", error_code }))));
    const result = await managedImageAdapter.recover!({ config: config(descriptor.id), prompt: "", images: [], params: {}, taskId: "original-task" });
    expect(result).toMatchObject({ status: "submission_unknown", error: expect.stringContaining("original-task") });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0].method).toBe("GET");
});

test("retry after a lost recovery response joins queued work without another recovery POST", async () => {
    const fetch = bridge(vi.fn(async (request) => jsonResponse(request, '{"id":"original-task","state":"reconciling","recovery_action":"confirm_submission"}')));
    await expect(managedImageAdapter.recover!({ config: config(descriptor.id), prompt: "", images: [], params: {}, taskId: "original-task" })).resolves.toMatchObject({ status: "pending", recoveryPhase: "confirming" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0].method).toBe("GET");
});

test("a released failed gateway task is never resubmitted by result recovery", async () => {
    const fetch = bridge(vi.fn(async (request) => jsonResponse(request, '{"id":"original-task","state":"failed","error_code":"upstream_failed"}')));
    await expect(managedImageAdapter.recover!({ config: config(descriptor.id), prompt: "", images: [], params: {}, taskId: "original-task" })).resolves.toEqual({ status: "failed", error: "upstream_failed" });
    expect(fetch).toHaveBeenCalledOnce();
});


test("blocked image recovery retries delivery on the saved task without confirming a new submission", async () => {
    const fetch = bridge(vi.fn(async request => jsonResponse(request, JSON.stringify({ state: request.method === "POST" ? "delivering" : "delivery_blocked", error_code: "asset_validation_failed", recovery_action: "retry_delivery" }))));
    const request = { config: config(descriptor.id), taskId: "original-task", prompt: "", images: [], params: {} };
    await expect(managedImageAdapter.query!(request)).resolves.toEqual({ status: "failed", error: i18n.t("canvas.remoteTask.deliveryBlocked", { code: "asset_validation_failed" }) });
    fetch.mockClear();
    await expect(managedImageAdapter.recover!(request)).resolves.toEqual({ status: "pending", phase: "delivering" });
    expect(fetch.mock.calls.map(([r]) => [r.method, r.path])).toEqual([["GET", "/v1/media/tasks/original-task"], ["POST", "/v1/media/tasks/original-task/recover"]]);
});
