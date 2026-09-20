import type { ManagedModelDescriptor } from "@/lib/desktop/managed-model-types";
import { afterEach, describe, expect, test, vi } from "vitest";
import i18n from "@/i18n";
import { defaultConfig } from "@/stores/use-config-store";
import { createOpenAIVideoTask, pollOpenAIVideoTask } from "./video";
import { resetManagedUsageRefreshForTests } from "./model-transport";
const config = { ...defaultConfig, vquality: "768p横", videoSeconds: "5", compressReferenceImages: false, credentialMode: "shotshot" as const, credentialModes: { agent: "shotshot" as const, text: "shotshot" as const, image: "shotshot" as const, audio: "shotshot" as const, video: "shotshot" as const }, model: "minimax_h3_lightx2v_v5" };
const image = { id: "first", name: "first.png", type: "image/png", dataUrl: "data:image/png;base64,aW1hZ2U=" };
const slots = ["first_frame", "last_frame"].map(field => ({ field, kind: "image" as const, required: true, accept_types: ["image/png"] }));
function bridge(inputSlots = slots) {
    let uploads = 0;
    const fetch = vi.fn(async (request) => ({
        id: request.id, status: 200, statusText: "OK", headers: {},
        body: { kind: "text" as const, value: JSON.stringify(request.path === "/v1/assets/upload" ? { asset_id: `asset-${++uploads}` } : request.path === "/v1/media/tasks" ? { id: "task-1", state: "reserving" } : { status: "ready" }) },
    }));
    const listModels = vi.fn(async (): Promise<ManagedModelDescriptor[]> => [{ id: "minimax_h3_lightx2v_v5", name: "ShotShot Video", capability: "video" as const, execution: "remote_task" as const, video_specs: [{ resolution: "768p横", orientation: "landscape" as const, quality: "768p", duration: { min: 1, max: 10, default: 5, integer: true } }], input_slots: inputSlots }]);
    window.shotshot = { platform: "darwin", agent: {} as never, skills: {} as never, managedModels: { listModels, fetch, abort: vi.fn() } };
    return { fetch, listModels };
}
afterEach(() => { vi.restoreAllMocks(); resetManagedUsageRefreshForTests(); });
describe("managed video reference contract", () => {
    test("rejects the reported single-frame request before uploading anything", async () => {
        const { fetch } = bridge();
        await expect(createOpenAIVideoTask(config, "minimax_h3_lightx2v_v5", "move", [image])).rejects.toThrow(i18n.t("apiErrors.managedVideoMissingReference", { model: "ShotShot Video", field: "last_frame" }));
        expect(fetch).not.toHaveBeenCalled();
    });
    test("maps two images to the declared first and last frames", async () => {
        const { fetch } = bridge();
        await expect(createOpenAIVideoTask(config, "minimax_h3_lightx2v_v5", "move", [image, { ...image, id: "last" }])).resolves.toMatchObject({ id: "task-1", provider: "shotshot" });
        expect(JSON.parse(fetch.mock.calls.at(-1)![0].body.value).assets).toEqual({ first_frame: "asset-1", last_frame: "asset-2" });
    });
    test("does not silently drop extra references or invent undeclared slots", async () => {
        const { fetch } = bridge();
        await expect(createOpenAIVideoTask(config, "minimax_h3_lightx2v_v5", "move", [image, image, image])).rejects.toThrow(i18n.t("apiErrors.managedVideoUnexpectedReference", { model: "ShotShot Video", kind: "image", count: 2 }));
        expect(fetch).not.toHaveBeenCalled();
    });
    test("does not bypass the catalog when resolution fails", async () => {
        const { fetch, listModels } = bridge();
        listModels.mockRejectedValue(new Error("catalog_unavailable"));
        await expect(createOpenAIVideoTask(config, "minimax_h3_lightx2v_v5", "move", [image])).rejects.toThrow("catalog_unavailable");
        expect(fetch).not.toHaveBeenCalled();
    });
    test("uploads video references with video credentials when image generation uses BYOK", async () => {
        const { fetch } = bridge([{ ...slots[0]!, field: "ref_image_0" }]);
        const mixed = { ...config, credentialModes: { ...config.credentialModes, image: "byok" as const } };
        await expect(createOpenAIVideoTask(mixed, "minimax_h3_lightx2v_v5", "move", [image])).resolves.toMatchObject({ id: "task-1" });
        expect(fetch).toHaveBeenCalledTimes(4);
    });
    test("supports a single-image workflow using its declared slot", async () => {
        const { fetch } = bridge([{ ...slots[0]!, field: "ref_image_0" }]);
        await expect(createOpenAIVideoTask(config, "minimax_h3_lightx2v_v5", "move", [image])).resolves.toMatchObject({ id: "task-1" });
        expect(JSON.parse(fetch.mock.calls.at(-1)![0].body.value).assets).toEqual({ ref_image_0: "asset-1" });
    });
});

describe("managed video exact settings", () => {
    test("sends the selected exact landscape spec and duration, without generic dimensions or unsupported switches", async () => {
        const { fetch } = bridge([{ ...slots[0]!, field: "ref_image_0" }]);
        await createOpenAIVideoTask({ ...config, size: "1280x720", videoSeconds: "7" }, "minimax_h3_lightx2v_v5", "move", [image]);
        const body = JSON.parse(fetch.mock.calls.at(-1)![0].body.value);
        expect(body).toMatchObject({ resolution: "768p横", duration_milliseconds: 7000, assets: { ref_image_0: "asset-1" } });
        for (const key of ["size", "generate_audio", "watermark"]) expect(body).not.toHaveProperty(key);
    });
    test.each([{ vquality: "720" }, { vquality: "768p竖" }, { videoSeconds: "11" }, { videoSeconds: "5.5" }])("rejects incompatible persisted settings before uploading: %j", async patch => {
        const { fetch } = bridge([{ ...slots[0]!, field: "ref_image_0" }]);
        await expect(createOpenAIVideoTask({ ...config, ...patch }, "minimax_h3_lightx2v_v5", "move", [image])).rejects.toThrow();
        expect(fetch).not.toHaveBeenCalled();
    });
    test("rejects a catalog with no video specs instead of submitting a default", async () => {
        const { fetch, listModels } = bridge();
        listModels.mockResolvedValueOnce([{ id: "minimax_h3_lightx2v_v5", name: "Video", capability: "video", execution: "remote_task", input_slots: slots }] as never);
        await expect(createOpenAIVideoTask(config, "minimax_h3_lightx2v_v5", "move", [image])).rejects.toThrow(i18n.t("settingsPanels.video.managedUnavailable"));
        expect(fetch).not.toHaveBeenCalled();
    });
});

test("converts fractional model durations to integer milliseconds", async () => {
    const { fetch, listModels } = bridge([]);
    listModels.mockResolvedValueOnce([{ id: "minimax_h3_lightx2v", name: "Video", capability: "video", execution: "remote_task", input_slots: [], video_specs: [{ resolution: "768p横", orientation: "landscape", quality: "768p", duration: { min: 1, max: 15, default: 5, integer: false } }] }]);
    await createOpenAIVideoTask({ ...config, videoSeconds: "1.001" }, "minimax_h3_lightx2v", "move", []);
    expect(JSON.parse(fetch.mock.calls.at(-1)![0].body.value).duration_milliseconds).toBe(1001);
});

test("submits the exact 1080p token for the supported model", async () => {
    const { managedVideoProfile } = await import("@/lib/models/managed-video-profiles");
    const id = "minimax_h3_image_audio_to_video_v2";
    const { fetch, listModels } = bridge([]);
    listModels.mockResolvedValueOnce([{ id, name: "Video", capability: "video", execution: "remote_task", input_slots: [], video_specs: managedVideoProfile(id)!.specs }]);
    await createOpenAIVideoTask({ ...config, model: id, vquality: "1080p横", videoSeconds: "10" }, id, "move", []);
    expect(JSON.parse(fetch.mock.calls.at(-1)![0].body.value)).toMatchObject({ model: id, resolution: "1080p横", duration_milliseconds: 10000 });
});


describe("managed video delivery", () => {
    const original = { id: "original-task", provider: "shotshot" as const, model: config.model };
    test.each([
        ["reserving", "queued"], ["reserved", "queued"], ["queued", "queued"], ["submitted", "running"], ["running", "running"],
        ["delivering", "delivering"], ["settle_pending", "settling"],
    ])("maps %s to %s", async (state, phase) => {
        const { fetch } = bridge([]);
        fetch.mockImplementation(async request => ({ id: request.id, status: 200, statusText: "OK", headers: {}, body: { kind: "text", value: JSON.stringify({ id: original.id, state }) } }));
        await expect(pollOpenAIVideoTask(config, original)).resolves.toEqual({ status: "pending", phase });
    });
    test("pauses blocked delivery and recovers only the original ID on explicit retry", async () => {
        const { openAIVideoAdapter } = await import("./media-adapters/openai-gemini");
        const { fetch } = bridge([]);
        fetch.mockImplementation(async request => ({ id: request.id, status: 200, statusText: "OK", headers: {}, body: { kind: "text", value: JSON.stringify({ id: original.id, state: request.method === "POST" ? "delivering" : "delivery_blocked", error_code: "asset_validation_failed", recovery_action: "retry_delivery" }) } }));
        const request = { config, taskId: original.id, prompt: "edited prompt must not be submitted", images: [], params: {} };
        await expect(openAIVideoAdapter.query!(request)).resolves.toEqual({ status: "failed", error: i18n.t("canvas.remoteTask.deliveryBlocked", { code: "asset_validation_failed" }) });
        expect(fetch).toHaveBeenCalledOnce();
        fetch.mockClear();
        await expect(openAIVideoAdapter.recover!(request)).resolves.toEqual({ status: "pending", phase: "delivering" });
        expect(fetch.mock.calls.map(([r]) => [r.method, r.path])).toEqual([["GET", "/v1/media/tasks/original-task"], ["POST", "/v1/media/tasks/original-task/recover"]]);
    });
    test("a lost recovery response rejoins delivering without another POST", async () => {
        const { fetch } = bridge([]);
        fetch.mockImplementation(async request => ({ id: request.id, status: 200, statusText: "OK", headers: {}, body: { kind: "text", value: '{"state":"delivering"}' } }));
        await expect(pollOpenAIVideoTask(config, original, { recoverDelivery: true })).resolves.toEqual({ status: "pending", phase: "delivering" });
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[0][0].method).toBe("GET");
    });
    test("preserves bridge recovery errors without attempting a generation", async () => {
        const { fetch } = bridge([]);
        fetch.mockImplementation(async request => ({ id: request.id, status: request.method === "POST" ? 403 : 200, statusText: "", headers: {}, body: { kind: "text", value: request.method === "POST" ? '{"error":{"code":"task_owner_mismatch"}}' : '{"state":"delivery_blocked","recovery_action":"retry_delivery"}' } }));
        await expect(pollOpenAIVideoTask(config, original, { recoverDelivery: true })).rejects.toMatchObject({ status: 403 });
        expect(fetch.mock.calls.map(([r]) => r.path)).toEqual(["/v1/media/tasks/original-task", "/v1/media/tasks/original-task/recover"]);
    });
    test("persists downloading before fetching content", async () => {
        const { fetch } = bridge([]);
        fetch.mockImplementation(async request => ({ id: request.id, status: 200, statusText: "OK", headers: { "content-type": "video/mp4" }, body: request.path.endsWith("/content") ? { kind: "base64", value: "AQID" } : { kind: "text", value: '{"state":"succeeded"}' } }) as never);
        const onPhase = vi.fn(async phase => { expect(phase).toBe("downloading"); expect(fetch).toHaveBeenCalledOnce(); });
        await expect(pollOpenAIVideoTask(config, original, { onPhase })).resolves.toMatchObject({ status: "completed" });
        expect(onPhase).toHaveBeenCalledOnce();
        expect(fetch.mock.calls.at(-1)![0].path).toBe("/v1/media/tasks/original-task/content");
    });
});
