import { prepareReferenceImages, hasReferenceMask, withReferenceImageSession } from "../reference-image-preparation";
import { assertByokGenerationAllowed } from "./ai-source-guard";
import { runRemoteQueryPlugin, runRemoteSubmitPlugin } from "./model-plugin";
import { getMediaAdapter } from "./media-adapters/registry";
import type { MediaGenerateRequest, MediaTaskQueryResult } from "./media-adapters/types";
import type { RemoteMediaCapability, RemoteTaskQueryInput, RemoteTaskQueryResult, RemoteTaskSubmitInput, RemoteTaskSubmitResult, RemoteTaskTemplate } from "@/types/remote-media-task";

function record(value: unknown, name: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must return an object`);
    return value as Record<string, unknown>;
}

export function normalizeRemoteTaskSubmit(value: unknown): RemoteTaskSubmitResult {
    const data = typeof value === "object" && value && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    const taskId = typeof value === "string" ? value.trim() : typeof data?.taskId === "string" ? data.taskId.trim() : "";
    if (!taskId) throw new Error("submit script must return a non-empty taskId");
    return { taskId };
}

export function normalizeRemoteTaskQuery(value: unknown): RemoteTaskQueryResult {
    const data = record(value, "query script");
    if (data.status === "succeeded") {
        if (!("result" in data) || data.result === undefined) throw new Error("succeeded task must return result");
        return { status: "succeeded", result: data.result };
    }
    if (data.status === "failed") {
        const error = typeof data.error === "string" ? data.error.trim() : "";
        if (!error) throw new Error("failed task must return error");
        return { status: "failed", error };
    }
    if (data.status !== "pending") throw new Error("query script must return status pending, succeeded, or failed");

    const phase = data.phase;
    if (phase !== undefined && phase !== "queued" && phase !== "running") throw new Error("pending task phase must be queued or running");
    const progress = data.progress;
    if (progress !== undefined && (typeof progress !== "number" || !Number.isFinite(progress))) throw new Error("pending task progress must be a number");
    return {
        status: "pending",
        ...(phase === undefined ? {} : { phase }),
        ...(progress === undefined ? {} : { progress: Math.min(100, Math.max(0, progress)) }),
    };
}

export async function submitRemoteMediaTask(input: RemoteTaskSubmitInput) {
    await assertByokGenerationAllowed(input.capability);
    return normalizeRemoteTaskSubmit(await runRemoteSubmitPlugin({ ...input, script: input.submitScript }));
}

export async function queryRemoteMediaTask(input: RemoteTaskQueryInput) {
    return normalizeRemoteTaskQuery(await runRemoteQueryPlugin({ capability: input.capability, config: input.config, script: input.queryScript, taskId: input.taskId, signal: input.signal }));
}

type AdapterRemoteTaskInput = MediaGenerateRequest & {
    adapterId: string;
    adapterVersion: number;
};

function requireRemoteTaskAdapter(adapterId: string, adapterVersion: number) {
    const adapter = getMediaAdapter(adapterId);
    if (!adapter || adapter.execution !== "remote_task") throw new Error(`Remote media task adapter ${adapterId} is unavailable`);
    if (adapter.version !== adapterVersion) throw new Error(`Remote media task adapter version ${adapterVersion} is unavailable for ${adapterId}`);
    return adapter;
}

const preparedSubmissions = new WeakMap<object, Map<string, Promise<AdapterRemoteTaskInput>>>();

export async function submitAdapterRemoteMediaTask(input: AdapterRemoteTaskInput): Promise<RemoteTaskSubmitResult> {
    const adapter = requireRemoteTaskAdapter(input.adapterId, input.adapterVersion);
    await assertByokGenerationAllowed(adapter.modality === "speech" || adapter.modality === "music" ? "audio" : adapter.modality);
    if (!adapter.submit) throw new Error(`Remote media task adapter ${input.adapterId} cannot submit tasks`);
    const prepare = async (): Promise<AdapterRemoteTaskInput> => ({ ...input, config: withReferenceImageSession(input.config), images: await prepareReferenceImages(input.config, input.images, { signal: input.signal, preserveOriginal: hasReferenceMask(input.params) }) });
    let prepared: Promise<AdapterRemoteTaskInput>;
    if (input.idempotencyKey) {
        let memo = preparedSubmissions.get(input.config);
        if (!memo) { memo = new Map(); preparedSubmissions.set(input.config, memo); }
        const key = `${input.adapterId}:${input.idempotencyKey}`;
        prepared = memo.get(key) ?? prepare();
        memo.set(key, prepared);
        void prepared.catch(() => { if (memo.get(key) === prepared) memo.delete(key); });
    } else prepared = prepare();
    return adapter.submit({ ...await prepared, signal: input.signal });
}

export async function queryAdapterRemoteMediaTask(input: AdapterRemoteTaskInput & { taskId: string; recover?: boolean }): Promise<MediaTaskQueryResult> {
    const adapter = requireRemoteTaskAdapter(input.adapterId, input.adapterVersion);
    if (!adapter.query) throw new Error(`Remote media task adapter ${input.adapterId} cannot query tasks`);
    return input.recover && adapter.recover ? adapter.recover(input) : adapter.query(input);
}

const hiapiImageTask: RemoteTaskTemplate = {
    label: "HiAPI GPT Image 2",
    submitScript: `// HiAPI GPT Image 2: POST /v1/tasks
const sizeMatch = String(params.size || "").match(/^([0-9]+)x([0-9]+)$/i);
let aspect = "auto";
if (sizeMatch) {
  const w = Number(sizeMatch[1]);
  const h = Number(sizeMatch[2]);
  let a = w, b = h;
  while (b) { const t = a % b; a = b; b = t; }
  const g = a || 1;
  aspect = (w / g) + ":" + (h / g);
}
const q = String(params.quality || "").toLowerCase();
const resolution = q === "high" || q === "4k" ? "4K" : q === "medium" || q === "2k" ? "2K" : "1K";
const isImg2Img = images.length > 0;
const created = await request({
  method: "post",
  url: baseUrl + "/v1/tasks",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
  data: {
    model: isImg2Img ? "gpt-image-2/image-to-image" : "gpt-image-2/text-to-image",
    input: Object.assign({ prompt, aspect_ratio: aspect, resolution }, isImg2Img ? { input_urls: images.slice(0, 5) } : {}),
  },
});
return (created && created.data && created.data.taskId) || (created && created.taskId);`,
    queryScript: `// HiAPI GPT Image 2: GET /v1/tasks/{taskId}
const state = await request({
  method: "get",
  url: baseUrl + "/v1/tasks/" + taskId,
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
});
const data = (state && (state.data || state)) || {};
if (data.status === "success") {
  const urls = (data.output || []).map((item) => (item && typeof item === "object" ? item.url : item)).filter((url) => typeof url === "string" && url);
  if (!urls.length) return { status: "failed", error: "任务成功但未返回图片" };
  return { status: "succeeded", result: urls };
}
if (["fail", "failed", "error", "cancelled"].includes(data.status)) {
  return { status: "failed", error: String((data.error && (data.error.message || data.error)) || data.message || ("任务状态：" + data.status)) };
}
return { status: "pending", phase: data.status === "queued" ? "queued" : "running" };`,
};

export function getRemoteTaskTemplates(): Record<RemoteMediaCapability, RemoteTaskTemplate[]> {
    return { image: [hiapiImageTask], video: [], audio: [] };
}
