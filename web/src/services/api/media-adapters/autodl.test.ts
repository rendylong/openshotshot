import { beforeEach, describe, expect, test, vi } from "vitest";
import axios from "axios";
import { AUTODL_WORKFLOWS } from "@/lib/models/autodl-workflows";
import { defaultConfig } from "@/stores/use-config-store";
import { autodlVideoAdapter, buildAutodlVideoBody } from "./autodl";
import type { MediaGenerateRequest } from "./types";
vi.mock("axios", () => ({ default: { post: vi.fn(), get: vi.fn(), isAxiosError: (e: unknown) => Boolean(e && typeof e === "object" && "isAxiosError" in e) } }));
const request = (id = "minimax_h3_lightx2v_no_pic"): MediaGenerateRequest => ({ config: { ...defaultConfig, baseUrl: "https://autodl.art", apiKey: "test-token", model: id }, prompt: "A red cube rotates.", images: [], params: { seconds: "5", resolution: AUTODL_WORKFLOWS.find(w => w.id === id)!.resolution.default } });
beforeEach(() => vi.clearAllMocks());

describe("AutoDL video requests", () => {
    test.each(AUTODL_WORKFLOWS)("builds only documented fields: $id", workflow => {
        const input = request(workflow.id);
        for (const kind of ["image", "audio", "video"] as const) {
            const values = workflow.media.filter(slot => slot.kind === kind && slot.required).map((_, i) => `https://example.com/${kind}${i}`);
            if (kind === "image") input.images = values;
            else if (kind === "audio") input.audios = values;
            else input.videos = values;
        }
        const body = buildAutodlVideoBody(input);
        expect(Object.keys(body).sort()).toEqual(["resolution", ...(workflow.prompt ? ["prompt"] : []), ...(workflow.duration ? [workflow.duration.field] : []), ...workflow.media.filter(slot => slot.required).map(slot => slot.field)].sort());
        if (workflow.duration) expect(body[workflow.duration.field]).toBe(5);
    });
    test("submits raw Token and exact workflow path", async () => {
        vi.mocked(axios.post).mockResolvedValue({ data: { code: "Success", data: { task_id: "remote-1" } } });
        const input = request(); input.config.baseUrl += "/api/v1/";
        await expect(autodlVideoAdapter.submit!(input)).resolves.toEqual({ taskId: "remote-1" });
        expect(axios.post).toHaveBeenCalledWith("https://autodl.art/api/v1/comfyui/comfyui_workflow/minimax_h3_lightx2v_no_pic", { prompt: input.prompt, duration: 5, resolution: "768p竖" }, expect.objectContaining({ headers: { Authorization: "test-token", "Content-Type": "application/json" } }));
    });
    test("submit 输出 task 回执", async () => {
        const spy = vi.spyOn(console, "info").mockImplementation(() => {});
        const requestFixture = request("minimax_h3_lightx2v_v5"); requestFixture.images = ["https://example.com/a.png"];
        vi.mocked(axios.post).mockResolvedValue({ data: { code: "Success", data: { task_id: "remote-9" } } });
        await autodlVideoAdapter.submit!(requestFixture);
        const line = spy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("[autodl] submit"));
        expect(line).toContain("task=");
        expect(line).toContain("ref_image_0");
        spy.mockRestore();
    });
    test.each([0,16,NaN,5.5])("rejects invalid integer duration %s before HTTP", async seconds => {
        const input = request(); input.params.seconds = seconds;
        await expect(autodlVideoAdapter.submit!(input)).rejects.toThrow(); expect(axios.post).not.toHaveBeenCalled();
    });
    test("does not discard surplus media or invalid enum", () => {
        const input = request(); input.images = ["https://example.com/a.png"];
        expect(() => buildAutodlVideoBody(input)).toThrow(); input.images = []; input.params.resolution = "4K";
        expect(() => buildAutodlVideoBody(input)).toThrow();
    });
    test("requires both first and last frame, checks media MIME and local paths", () => {
        const input = request("minimax_h3_lightx2v"); input.images = ["https://example.com/a.png"];
        expect(() => buildAutodlVideoBody(input)).toThrow();
        input.images = ["data:image/gif;base64,AAAA", "https://example.com/b.png"]; expect(() => buildAutodlVideoBody(input)).toThrow();
        input.images = ["/tmp/a.png", "https://example.com/b.png"]; expect(() => buildAutodlVideoBody(input)).toThrow();
    });
    test.each(["QUEUED", "RUNNING"])("maps pending %s", async status => {
        vi.mocked(axios.get).mockResolvedValue({ data: { code: "Success", data: { status } } });
        await expect(autodlVideoAdapter.query!({ ...request(), taskId: "id/a" })).resolves.toEqual({ status: "pending", phase: status === "QUEUED" ? "queued" : "running" });
        expect(axios.get).toHaveBeenCalledWith(expect.stringContaining("id%2Fa"), expect.anything());
    });
    test.each(["SUCCESS", "completed"])("maps documented success %s and skips preview", async status => {
        vi.mocked(axios.get).mockResolvedValue({ data: { code: "Success", data: { status, results: [{ type: "video", output_type: "preview", url: "https://example.com/preview.mp4" }, { type: "video", output_type: "output", url: "https://example.com/out.mp4", file_type: "mp4" }] } } });
        await expect(autodlVideoAdapter.query!({ ...request(), taskId: "id" })).resolves.toEqual({ status: "succeeded", result: { kind: "video", source: "https://example.com/out.mp4", mimeType: "video/mp4" } });
    });
    test.each(["FAILED", "UNEXPECTED", "SUCCESS"])("never treats invalid/failed response %s as pending", async status => {
        vi.mocked(axios.get).mockResolvedValue({ data: { code: "Success", data: { status, results: [] } } });
        await expect(autodlVideoAdapter.query!({ ...request(), taskId: "id" })).resolves.toMatchObject({ status: "failed" });
    });
    test("network failure retains safe network code without Axios request secrets", async () => {
        vi.mocked(axios.post).mockRejectedValue({ isAxiosError: true, code: "ERR_NETWORK", config: { headers: { Authorization: "test-token" } } });
        const error = await autodlVideoAdapter.submit!(request()).catch(e => e);
        expect(error.code).toBe("ERR_NETWORK"); expect(JSON.stringify(error)).not.toContain("test-token"); expect(error.cause).toBeUndefined();
    });
    test("redacts normalized tokens echoed by provider errors", async () => {
        const input = request(); input.config.apiKey = "  test-token\n";
        vi.mocked(axios.post).mockResolvedValue({ data: { code: "Denied", msg: "Invalid test-token" } });
        await expect(autodlVideoAdapter.submit!(input)).rejects.toThrow("Invalid [redacted]");
        vi.mocked(axios.get).mockResolvedValue({ data: { code: "Success", data: { status: "FAILED", error: "Invalid test-token" } } });
        await expect(autodlVideoAdapter.query!({ ...input, taskId: "id" })).resolves.toEqual({ status: "failed", error: "Invalid [redacted]" });
    });

});
