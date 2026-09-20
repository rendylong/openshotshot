import { ApiError } from "@fal-ai/client";
import { compileFalInput, parseFalOutput } from "@/lib/models/fal/input";
import { getFalProfile } from "@/lib/models/fal/profiles";
import { createFalChannelClient } from "../fal-client";
import { resolveFalModelAvailability } from "../fal-catalog";
import type { MediaAdapter, MediaGenerateRequest, MediaTaskQueryResult } from "./types";

type Modality = "image" | "video";

function profileFor(request: MediaGenerateRequest, modality: Modality) {
    const profile = getFalProfile(request.config.model);
    if (!profile || profile.modality !== modality) throw new Error("fal_model_unsupported");
    return profile;
}

/** No provider body, request payload, credential or URL is attached to task errors. */
function safeError(error: unknown): Error {
    if (error instanceof ApiError) return new Error(`fal_http_${error.status}`);
    if (error instanceof Error && /^fal_[a-z_-]+$/.test(error.message)) return error;
    return new Error("fal_request_failed");
}

async function submit(request: MediaGenerateRequest, modality: Modality) {
    request.signal?.throwIfAborted();
    const profile = profileFor(request, modality);
    const channel = request.config.channels.find(channel => channel.id === request.channelId);
    const model = channel?.models.find(model => model.name === profile.endpointId);
    if (!channel || channel.provider !== "fal" || !model || channel.baseUrl !== request.config.baseUrl || channel.apiKey !== request.config.apiKey) throw new Error("fal_channel_invalid");
    const { availability } = await resolveFalModelAvailability(profile.endpointId, model.catalog);
    if (availability !== "ready") throw new Error(`fal_model_${availability}`);
    const input = compileFalInput(profile, request);
    try {
        const result = await createFalChannelClient(request.config).queue.submit(profile.endpointId, { input, abortSignal: request.signal });
        if (typeof result?.request_id !== "string" || !result.request_id.trim()) throw new Error("fal_missing_request_id");
        return { taskId: result.request_id };
    } catch (error) {
        request.signal?.throwIfAborted();
        throw safeError(error);
    }
}

async function query(request: MediaGenerateRequest & { taskId: string }, modality: Modality): Promise<MediaTaskQueryResult> {
    request.signal?.throwIfAborted();
    try {
        const profile = profileFor(request, modality);
        if (typeof request.taskId !== "string" || !request.taskId.trim()) throw new Error("fal_missing_request_id");
        const client = createFalChannelClient(request.config);
        const status = await client.queue.status(profile.endpointId, { requestId: request.taskId, logs: false, abortSignal: request.signal });
        if (status?.status === "IN_QUEUE") return { status: "pending", phase: "queued" };
        if (status?.status === "IN_PROGRESS") return { status: "pending", phase: "running" };
        if (status?.status !== "COMPLETED") throw new Error("fal_invalid_queue_status");
        const result = await client.queue.result(profile.endpointId, { requestId: request.taskId, abortSignal: request.signal });
        return { status: "succeeded", result: parseFalOutput(profile, result.data) };
    } catch (error) {
        request.signal?.throwIfAborted();
        const sanitized = safeError(error);
        if ("code" in sanitized && sanitized.code === "ERR_NETWORK") throw sanitized;
        return { status: "failed", error: sanitized.message };
    }
}

export const falImageAdapter: MediaAdapter = {
    id: "fal.image", version: 1, modality: "image", execution: "remote_task",
    submit: request => submit(request, "image"), query: request => query(request, "image"),
};
export const falVideoAdapter: MediaAdapter = {
    id: "fal.video", version: 1, modality: "video", execution: "remote_task",
    submit: request => submit(request, "video"), query: request => query(request, "video"),
};
