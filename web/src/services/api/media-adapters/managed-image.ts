import { referenceImageSession, referenceImageDigest, waitForReferenceWork } from "@/services/reference-image-preparation";
import { useUserStore } from "@/stores/use-user-store";
import i18n from "@/i18n";
import { dataUrlToFile } from "@/lib/image-utils";
import { managedErrorStatus, resolveManagedModel, requestModel } from "@/services/api/model-transport";
import { imageToDataUrl } from "@/services/image-storage";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";

import type { MediaAdapter, MediaGenerateRequest, MediaTaskQueryResult } from "./types";

// The submit `resolution` carries the canonical managed spec string (`<ratio>` or
// `<ratio>|<second-axis>`), never a folded pixel size. C2's resolveManagedSpecSize owns that
// grammar, so this adapter reuses it and must not re-derive the key.

type ManagedImageDescriptor = Awaited<ReturnType<typeof resolveManagedModel>>;

const MANAGED_DESKTOP_REQUIRED = async () => { throw new Error("managed_desktop_required"); };

/** image.ts imports the dispatcher, so importing resolveManagedSpecSize statically would cycle; load it on demand. */
async function managedSpecSize(config: AiConfig, spec: ManagedImageDescriptor["spec"]) {
    const { resolveManagedSpecSize } = await import("@/services/api/image");
    return resolveManagedSpecSize(config, spec);
}

function selectedCount(request: MediaGenerateRequest) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(request.params.count ?? request.config.count)) || 1)));
}

/** Declared slots come first; a single array slot consumes subsequent ref_image_N entries in gateway catalog validation. */
function imageField(descriptor: ManagedImageDescriptor | undefined, index: number) {
    return descriptor?.input_slots?.filter((slot) => slot.kind === "image")[index]?.field || `ref_image_${index}`;
}

async function referenceFile(source: string, index: number): Promise<File> {
    const dataUrl = await imageToDataUrl({ dataUrl: source });
    if (!dataUrl) throw new Error(i18n.t("apiErrors.referenceImageReadFailed"));
    return dataUrlToFile({ id: `adapter-reference-${index}`, name: `reference-${index + 1}.png`, type: source.match(/^data:([^;,]+)/i)?.[1] || "image/png", dataUrl });
}

/** Mirror the managed video path: metadata → bytes → complete, then reference the asset id. */
async function uploadReference(request: MediaGenerateRequest, source: string, index: number) {
    const file = await referenceFile(source, index);
    const metadata = await requestModel<{ asset_id?: string }>({
        config: request.config,
        timeoutClass: "image",
        path: "/v1/assets/upload",
        body: { mime_type: file.type || "image/png", byte_size: file.size, filename: file.name || `reference-${index + 1}.png` },
        responseType: "json",
        signal: request.signal,
        byok: MANAGED_DESKTOP_REQUIRED,
    });
    if (!metadata.asset_id) throw new Error("managed_media_asset_upload_failed");
    await requestModel({
        config: request.config,
        timeoutClass: "image",
        path: `/v1/assets/${encodeURIComponent(metadata.asset_id)}/content`,
        method: "POST",
        headers: { "content-type": file.type || "image/png" },
        body: new Uint8Array(await file.arrayBuffer()),
        responseType: "json",
        signal: request.signal,
        byok: MANAGED_DESKTOP_REQUIRED,
    });
    await requestModel({
        config: request.config,
        timeoutClass: "image",
        path: `/v1/assets/${encodeURIComponent(metadata.asset_id)}/complete`,
        method: "POST",
        body: { byte_size: file.size },
        responseType: "json",
        signal: request.signal,
        byok: MANAGED_DESKTOP_REQUIRED,
    });
    return metadata.asset_id;
}

async function sharedReferenceUpload(request: MediaGenerateRequest, source: string, index: number) {
    const session = referenceImageSession(request.config);
    const account = useUserStore.getState().account;
    if (!session || !source.startsWith("data:image/") || (account.state !== "ready" && account.state !== "stale")) return uploadReference(request, source, index);
    const key = `${account.snapshot.account.subjectId}:${await referenceImageDigest(source)}`;
    let upload = session.uploads.get(key);
    if (!upload) {
        // One caller cancelling must not abort a shared upload needed by another shot.
        upload = uploadReference({ ...request, signal: undefined }, source, index);
        session.uploads.set(key, upload);
        void upload.catch(() => { if (session.uploads.get(key) === upload) session.uploads.delete(key); });
    }
    return waitForReferenceWork(upload, request.signal);
}

/** The content route returns bytes; normalizePluginImages needs a data URL source. */
async function resultSource(config: AiConfig, taskId: string, signal?: AbortSignal) {
    const content = await requestModel<Blob>({
        config,
        timeoutClass: "image",
        path: `/v1/media/tasks/${encodeURIComponent(taskId)}/content`,
        method: "GET",
        responseType: "blob",
        signal,
        byok: MANAGED_DESKTOP_REQUIRED,
    });
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("apiErrors.noImageReturned")));
        reader.readAsDataURL(content);
    });
}

const CONTENT_RETRY_DELAYS_MS = [1_000, 3_000] as const;

/** A task can report `succeeded` while its content route still answers 404 `result_not_ready` or 5xx:
 * the gateway conflates database saturation with a genuine not-ready race. Give it a short bounded
 * retry before surfacing the failure; the runner keeps the original task for manual recovery. */
async function resultSourceWithRetry(config: AiConfig, taskId: string, signal?: AbortSignal) {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await resultSource(config, taskId, signal);
        } catch (error) {
            const status = managedErrorStatus(error);
            const transient = status === 404 || status === 429 || (status !== undefined && status >= 500);
            if (!transient || attempt >= CONTENT_RETRY_DELAYS_MS.length || signal?.aborted) throw error;
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                    signal?.removeEventListener("abort", onAbort);
                    resolve();
                }, CONTENT_RETRY_DELAYS_MS[attempt]);
                const onAbort = () => {
                    clearTimeout(timer);
                    reject(new DOMException("The operation was aborted", "AbortError"));
                };
                signal?.addEventListener("abort", onAbort, { once: true });
            });
        }
    }
}

type ManagedTaskState = { id?: string; state?: string; error_code?: string; recovery_action?: string };

function unknownSubmissionMessage(data: ManagedTaskState, taskId: string) {
    const keys: Record<string, string> = {
        recovery_snapshot_missing: "canvas.remoteTask.confirmationMissing",
        recovery_snapshot_invalid: "canvas.remoteTask.confirmationInvalid",
        idempotency_mismatch: "canvas.remoteTask.confirmationInvalid",
        idempotency_expired: "canvas.remoteTask.confirmationExpired",
        recovery_configuration_changed: "canvas.remoteTask.confirmationConfiguration",
        recovery_unsupported: "canvas.remoteTask.confirmationMissing",
    };
    return data.error_code && keys[data.error_code]
        ? i18n.t(keys[data.error_code], { taskId })
        : data.recovery_action === "confirm_submission"
            ? i18n.t("canvas.remoteTask.confirmationAvailable", { taskId })
            : i18n.t("canvas.remoteTask.submissionUnknown");
}

async function queryManagedImage({ config, taskId, signal, onPhase }: MediaGenerateRequest & { taskId: string }, recover = false): Promise<MediaTaskQueryResult> {
    const read = (confirm: boolean) => requestModel<ManagedTaskState>({
        config, timeoutClass: "image",
        path: `/v1/media/tasks/${encodeURIComponent(taskId)}${confirm ? "/recover" : ""}`,
        method: confirm ? "POST" : "GET", responseType: "json", signal, byok: MANAGED_DESKTOP_REQUIRED,
    });
    // Read first: a lost recovery response may already have queued or completed
    // the original task. Never create a new generation or replay a released failure.
    let data = await read(false);
    if (recover && data.state === "submission_unknown" && data.recovery_action === "confirm_submission") data = await read(true);
    if (recover && data.state === "delivery_blocked" && data.recovery_action === "retry_delivery") data = await read(true);
    if (data.state === "delivery_blocked") return { status: "failed", error: i18n.t("canvas.remoteTask.deliveryBlocked", { code: data.error_code || "delivery_failed" }) };
    if (data.state === "succeeded") await onPhase?.("downloading");
    if (data.state === "succeeded") {
        try {
            return { status: "succeeded", result: { kind: "image", sources: [await resultSourceWithRetry(config, taskId, signal)] } };
        } catch (error) {
            // 已成功任务的交付读取失败可恢复（网关/存储瞬时故障，2026-09-17 交付 404 事故）：
            // 停在 downloading 让 runner 继续轮询至 deadline，由既有 timed_out 语义兜底，不升格终态 failed。
            if (signal?.aborted) throw error;
            return { status: "pending", phase: "downloading" };
        }
    }
    if (data.state === "submission_unknown") return { status: "submission_unknown", error: unknownSubmissionMessage(data, taskId) };
    if (data.state === "failed") return { status: "failed", error: data.error_code || i18n.t("apiErrors.imageGenerationFailed") };
    if (data.state === "reconciling" || data.recovery_action === "confirm_submission") return { status: "pending", phase: "queued", recoveryPhase: "confirming" };
    if (data.state === "delivering") return { status: "pending", phase: "delivering" };
    if (data.state === "settle_pending") return { status: "pending", phase: "settling" };
    return { status: "pending", phase: "running", ...(recover ? { recoveryPhase: "fetching" as const } : {}) };
}

export const managedImageAdapter: MediaAdapter = {
    id: "shotshot.managed-image",
    version: 1,
    modality: "image",
    execution: "remote_task",
    idempotentSubmit: true,
    submit: async (request) => {
        const model = modelOptionName(request.config.model);
        const descriptor = await resolveManagedModel(request.config, "image", model).catch(() => undefined);
        const missingRequiredImageSlot = descriptor?.input_slots?.some((slot) => slot.kind === "image" && slot.required) && request.images.length === 0;
        if (missingRequiredImageSlot) throw new Error(i18n.t("apiErrors.managedImageMissingReference", { model }));
        const assets: Record<string, string> = {};
        for (const [index, source] of request.images.slice(0, 16).entries()) {
            const field = imageField(descriptor, index);
            assets[field] = await sharedReferenceUpload(request, source, index);
        }
        const data = await requestModel<{ id?: string }>({
            config: request.config,
            timeoutClass: "image",
            path: "/v1/media/tasks",
            body: {
                model,
                prompt: request.prompt,
                resolution: await managedSpecSize(request.config, descriptor?.spec),
                count: selectedCount(request),
                assets,
                idempotency_key: request.idempotencyKey,
            },
            responseType: "json",
            signal: request.signal,
            byok: MANAGED_DESKTOP_REQUIRED,
        });
        if (!data.id) throw new Error(i18n.t("apiErrors.noImageTaskId"));
        return { taskId: data.id };
    },
    query: (request) => queryManagedImage(request),
    recover: (request) => queryManagedImage(request, true),
};
