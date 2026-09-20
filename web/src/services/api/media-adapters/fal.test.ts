import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelChannel, defaultConfig } from "@/stores/use-config-store";
import { falImageAdapter, falVideoAdapter } from "./fal";
import type { MediaGenerateRequest } from "./types";
import cases from "@/lib/models/fal/fixtures/contract-cases.json";
import { resolveFalModelAvailability } from "../fal-catalog";
vi.mock("../fal-catalog", () => ({ resolveFalModelAvailability: vi.fn(async () => ({ availability: "ready", diagnostics: [] })) }));
function request(model = "fal-ai/flux-2-pro"): MediaGenerateRequest {
    const channel = createModelChannel({ provider: "fal", apiKey: "fixture-key", models: [{ name: model, capability: model.includes("kling") ? "video" : "image" }] });
    return { channelId: channel.id, config: { ...defaultConfig, channels: [channel], model, baseUrl: channel.baseUrl, apiKey: channel.apiKey }, prompt: "cup", images: [], params: {} };
}
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("fal persistent adapters", () => {
    it("submits once and immediately returns the request ID", async () => {
        const fetcher = vi.fn<typeof fetch>(async () => Response.json({ request_id: "r1" })); vi.stubGlobal("fetch", fetcher);
        await expect(falImageAdapter.submit!(request("fal-ai/nano-banana"))).resolves.toEqual({ taskId: "r1" });
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({ prompt: "cup", num_images: 1 });
    });
    it.each(cases.map(testCase => [testCase.endpointId, testCase] as const))("submits and retrieves the reviewed exact endpoint %s", async (_endpointId, testCase) => {
        const input = { ...request(testCase.endpointId), ...testCase.request };
        input.config.channels[0].models[0].capability = testCase.expectedResult.kind === "image" ? "image" : "video";
        const adapter = testCase.expectedResult.kind === "image" ? falImageAdapter : falVideoAdapter;
        const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ request_id: "r1" })).mockResolvedValueOnce(Response.json({ status: "COMPLETED" })).mockResolvedValueOnce(Response.json(testCase.providerOutput));
        vi.stubGlobal("fetch", fetcher);
        await expect(adapter.submit!(input)).resolves.toEqual({ taskId: "r1" });
        expect(fetcher.mock.calls[0][0]).toBe(`https://queue.fal.run/${testCase.endpointId}`);
        expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(testCase.expectedInput);
        await expect(adapter.query!({ ...input, taskId: "r1", images: [], params: {}, prompt: "" })).resolves.toEqual({ status: "succeeded", result: testCase.expectedResult });
        expect(fetcher).toHaveBeenCalledTimes(3);
    });
    it("uses the exact channel ID even when channels share credentials and base URL", async () => {
        const input = request();
        const wrong = structuredClone(input.config.channels[0]); wrong.id = "wrong";
        wrong.models[0].catalog = { version: 1, source: "provider_models", providerStatus: "deprecated" };
        const selected = input.config.channels[0]; selected.models[0].catalog = { version: 1, source: "provider_models", providerStatus: "active" };
        input.config.channels = [wrong, selected];
        const fetcher = vi.fn(async () => Response.json({ request_id: "r1" })); vi.stubGlobal("fetch", fetcher);
        await falImageAdapter.submit!(input);
        expect(resolveFalModelAvailability).toHaveBeenCalledWith(input.config.model, selected.models[0].catalog);
        await expect(falImageAdapter.submit!({ ...input, channelId: undefined })).rejects.toThrow("fal_channel_invalid");
        await expect(falImageAdapter.submit!({ ...input, channelId: "missing" })).rejects.toThrow("fal_channel_invalid");
        expect(fetcher).toHaveBeenCalledOnce();
    });
    it("does not treat COMPLETED as a successful result", async () => {
        const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).includes("/status") ? Response.json({ status: "COMPLETED", request_id: "r1" }) : Response.json({ detail: "generation failed fixture-key" }, { status: 422 }));
        vi.stubGlobal("fetch", fetcher);
        const result = await falImageAdapter.query!({ ...request(), taskId: "r1" });
        expect(result.status).toBe("failed"); expect(JSON.stringify(result)).not.toContain("fixture-key");
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it.each([["IN_QUEUE", "queued"], ["IN_PROGRESS", "running"]])("maps %s without fetching a result", async (status, phase) => {
        const fetcher = vi.fn(async () => Response.json({ status })); vi.stubGlobal("fetch", fetcher);
        await expect(falImageAdapter.query!({ ...request(), taskId: "r1" })).resolves.toEqual({ status: "pending", phase });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it.each(["BROKEN", null, {}, "FAILED"])("fails a malformed or terminal provider status %s", async status => {
        const fetcher = vi.fn(async () => Response.json({ status, error: "fixture-key" })); vi.stubGlobal("fetch", fetcher);
        await expect(falImageAdapter.query!({ ...request(), taskId: "r1" })).resolves.toMatchObject({ status: "failed" });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it.each([403, 429, 503])("never retries HTTP %s or leaks response bodies", async status => {
        const fetcher = vi.fn(async () => Response.json({ message: "fixture-key", detail: "data:image/png;base64,secret" }, { status })); vi.stubGlobal("fetch", fetcher);
        await expect(falImageAdapter.submit!(request())).rejects.toThrow(`fal_http_${status}`);
        expect(fetcher).toHaveBeenCalledTimes(1);
        const result = await falImageAdapter.query!({ ...request(), taskId: "r1" });
        expect(result).toEqual({ status: "failed", error: `fal_http_${status}` });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it("preserves network classification without automatic retransmission", async () => {
        const fetcher = vi.fn(async () => { throw new TypeError("Failed to fetch fixture-key"); }); vi.stubGlobal("fetch", fetcher);
        await expect(falImageAdapter.submit!(request())).rejects.toMatchObject({ code: "ERR_NETWORK", message: "fal_network_error" });
        await expect(falImageAdapter.query!({ ...request(), taskId: "r1" })).rejects.toMatchObject({ code: "ERR_NETWORK", message: "fal_network_error" });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it("does not resubmit when the response has no request ID", async () => {
        const fetcher = vi.fn(async () => Response.json({})); vi.stubGlobal("fetch", fetcher);
        await expect(falImageAdapter.submit!(request())).rejects.toThrow("fal_missing_request_id");
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it("rejects empty output after COMPLETED", async () => {
        const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ status: "COMPLETED" })).mockResolvedValueOnce(Response.json({ images: [] })); vi.stubGlobal("fetch", fetcher);
        await expect(falImageAdapter.query!({ ...request(), taskId: "r1" })).resolves.toEqual({ status: "failed", error: "fal_output_invalid" });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it("queries the original exact video queue root independent of changed inputs and availability", async () => {
        const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ status: "COMPLETED" })).mockResolvedValueOnce(Response.json({ video: { url: "https://cdn.example/out.mp4", content_type: "video/mp4" } })); vi.stubGlobal("fetch", fetcher);
        const input = { ...request("fal-ai/kling-video/v3/pro/image-to-video"), taskId: "original-id", images: [], prompt: "", params: { invalid: new Blob() } };
        await expect(falVideoAdapter.query!(input)).resolves.toEqual({ status: "succeeded", result: { kind: "video", source: "https://cdn.example/out.mp4", mimeType: "video/mp4" } });
        expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["https://queue.fal.run/fal-ai/kling-video/requests/original-id/status?logs=0", "https://queue.fal.run/fal-ai/kling-video/requests/original-id"]);
        expect(resolveFalModelAvailability).not.toHaveBeenCalled();
    });
    it.each(["deprecated", "schema-incompatible", "unsupported"] as const)("restores availability and blocks %s submit", async availability => {
        vi.mocked(resolveFalModelAvailability).mockResolvedValueOnce({ availability, diagnostics: [] });
        const input = request(); const metadata = { version: 1, source: "provider_models", providerStatus: "deprecated" } as const; input.config.channels[0].models[0].catalog = metadata;
        const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
        await expect(falImageAdapter.submit!(input)).rejects.toThrow(`fal_model_${availability}`);
        expect(resolveFalModelAvailability).toHaveBeenCalledWith(input.config.model, metadata);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it("compiles exact profiles and rejects Blob references before any upload", async () => {
        const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
        await expect(falVideoAdapter.submit!({ ...request("fal-ai/kling-video/v3/pro/image-to-video"), images: [new Blob() as never] })).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
    });
});


it("real catalog admission blocks unknown outer versions while original task query remains available", async () => {
    const actual = await vi.importActual<typeof import("../fal-catalog")>("../fal-catalog");
    vi.mocked(resolveFalModelAvailability).mockImplementationOnce(actual.resolveFalModelAvailability);
    const input = request("fal-ai/nano-banana-2");
    const future = { version: 99, source: "provider_models", providerStatus: "unknown" } as const;
    input.config.channels[0].models[0].catalog = future;
    const fetcher = vi.fn().mockResolvedValue(Response.json({ status: "IN_QUEUE" })); vi.stubGlobal("fetch", fetcher);
    await expect(falImageAdapter.submit!(input)).rejects.toThrow("fal_model_unsupported");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(falImageAdapter.query!({ ...input, taskId: "original" })).resolves.toEqual({ status: "pending", phase: "queued" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]?.method).not.toBe("POST");
    expect(input.config.channels[0].models[0].catalog).toEqual(future);
});
