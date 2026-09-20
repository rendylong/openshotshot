import type { RemoteMediaTask } from "@/types/remote-media-task";
import type { CanvasNodeData, CanvasRemoteTaskMetadata } from "@/types/canvas";

const RESULT_RECOVERABLE_IMAGE_ADAPTERS = new Set(["fal.image", "hiapi.image"]);

export function isResultRecoverableImageAdapter(adapterId: string | undefined) {
    return Boolean(adapterId && RESULT_RECOVERABLE_IMAGE_ADAPTERS.has(adapterId));
}

export function selectNodeRemoteTaskDisplay(node: CanvasNodeData) {
    const images = node.metadata?.images;
    const image = images?.find((item) => item.id === node.metadata?.primaryImageId) || images?.[0];
    return {
        task: node.metadata?.remoteTask || image?.remoteTask,
        errorDetails: image?.errorDetails || node.metadata?.errorDetails,
    };
}

export function remoteTaskForNode(node: CanvasNodeData, imageId?: string) {
    if (imageId) return node.metadata?.images?.find((image) => image.id === imageId)?.remoteTask;
    return selectNodeRemoteTaskDisplay(node).task;
}

export function remoteTaskTerminalText(task: CanvasRemoteTaskMetadata | undefined, translate: (key: string) => string) {
    if (task?.status === "timed_out") return translate("canvas.remoteTask.timedOut");
    if (task?.status === "interrupted") return translate("canvas.remoteTask.interrupted");
    if (task?.status === "submission_unknown") return translate("canvas.remoteTask.submissionUnknown");
    if (task?.status === "failed") return translate("canvas.remoteTask.failed");
    return "";
}

// 远端任务返回的 error_code 对应文案（上游 shotshot_media_task.go:44-46）；
// 未列出的码原样透出，优于 generic 文案。
const REMOTE_TASK_ERROR_CODE_I18N: Record<string, string> = {
    upstream_failed: "canvas.remoteTask.errorUpstreamFailed",
    rejected_before_submit: "canvas.remoteTask.errorRejectedBeforeSubmit",
    delivery_failed: "canvas.remoteTask.errorDeliveryFailed",
};

export function remoteTaskErrorText(task: CanvasRemoteTaskMetadata | undefined, errorDetails: string | undefined, translate: (key: string) => string) {
    if (errorDetails && errorDetails !== task?.status) {
        const key = REMOTE_TASK_ERROR_CODE_I18N[errorDetails];
        return key ? translate(key) : errorDetails;
    }
    return remoteTaskTerminalText(task, translate) || translate("canvas.node.failed");
}

/** Recovery is tied to the stored task, never the node's currently selected model.
 * Unresolved task records and missing remote IDs still route here so recovery can fail closed. */
export function isRemoteResultRetry(node: CanvasNodeData, tasks: readonly RemoteMediaTask[], imageId?: string) {
    const embedded = remoteTaskForNode(node, imageId);
    if (!embedded) return false;
    if (embedded.status === "submission_unknown") return true;
    if (!["failed", "timed_out"].includes(embedded.status)) return false;
    if (node.type === "video") return true;
    const saved = tasks.find((task) => task.id === embedded.id);
    return node.type === "image" && (!saved || saved.capability !== "image" || isResultRecoverableImageAdapter(saved.adapterId));
}
