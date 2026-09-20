import { emitCanvasEvent, onCanvasEvent } from "@/lib/canvas/canvas-event-bus";
import { audioMetadata, imageMetadata, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { normalizePluginAudio, storeRemoteGeneratedAudio } from "@/services/api/audio";
import { normalizePluginImages } from "@/services/api/image";
import { normalizePluginVideo, storeRemoteGeneratedVideo } from "@/services/api/video";
import { deleteStoredMedia, discardRemoteMedia, getMediaBlob, releaseRemoteMediaLease, type UploadedFile } from "@/services/file-storage";
import { deleteStoredImages, discardRemoteImage, getImageBlob, releaseRemoteImageLease, uploadRemoteImage, type UploadedImage } from "@/services/image-storage";
import { deleteStoredMediaKeys } from "@/services/stored-media-delete";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";
import { storeCanvasImage, storeCanvasMedia, type ProjectAssetWriteContext } from "@/services/project-asset-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { CanvasPersistenceTransactionError, useProjectStore } from "@/stores/canvas/use-project-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeImage, type CanvasRemoteTaskMetadata } from "@/types/canvas";
import type { RemoteMediaTask, RemoteMediaTaskTarget, RemoteTaskDeliveryOutcome } from "@/types/remote-media-task";

export type RemoteTaskDeliveryOutput =
    | { capability: "image"; value: UploadedImage }
    | { capability: "video"; value: UploadedFile }
    | { capability: "audio"; value: UploadedFile };

export type RemoteCanvasTaskEvent = {
    projectId: string;
    canvasId: string;
    task: RemoteMediaTask;
    output?: RemoteTaskDeliveryOutput;
};

export type RemoteTaskDeliveryContext = { signal: AbortSignal; isActive: () => boolean; assetWriteContext?: ProjectAssetWriteContext };
type RemoteCanvasTaskEventHandler = (event: RemoteCanvasTaskEvent) => void;

const ACTIVE_TASK_STATUSES = new Set(["submitting", "pending", "waiting_network", "waiting_configuration"]);
const REMOTE_CANVAS_TASK_EVENT = "remote-media-task";

function taskMetadata(task: RemoteMediaTask): CanvasRemoteTaskMetadata {
    return { ...(task.recoveryPhase ? { recoveryPhase: task.recoveryPhase } : {}), id: task.id, status: task.status, phase: task.phase, progress: task.progress, submittedAt: task.submittedAt, sourceNodeId: task.target.sourceNodeId };
}

function sameTaskMetadata(current: CanvasRemoteTaskMetadata | undefined, next: CanvasRemoteTaskMetadata) {
    return Boolean(current && current.id === next.id && current.status === next.status && current.recoveryPhase === next.recoveryPhase && current.phase === next.phase && current.progress === next.progress && current.submittedAt === next.submittedAt && current.sourceNodeId === next.sourceNodeId);
}

function taskError(task: RemoteMediaTask) {
    return task.error || task.status;
}

function aggregateImageStatus(images: CanvasNodeImage[]) {
    if (images.some((image) => image.status === "success")) return "success" as const;
    if (images.length && images.every((image) => image.status === "error")) return "error" as const;
    return "loading" as const;
}

function updateConfigSource(nodes: CanvasNodeData[], target: RemoteMediaTaskTarget) {
    if (!target.sourceNodeId || target.sourceNodeId === target.nodeId) return nodes;
    const child = nodes.find((node) => node.id === target.nodeId);
    const source = nodes.find((node) => node.id === target.sourceNodeId);
    if (!child || source?.type !== CanvasNodeType.Config) return nodes;
    const status = child.metadata?.status;
    if (status !== "success" && status !== "error" && status !== "loading") return nodes;
    const errorDetails = status === "error" ? child.metadata?.errorDetails : undefined;
    if (source.metadata?.status === status && source.metadata.errorDetails === errorDetails) return nodes;
    return nodes.map((node) => node.id === source.id ? { ...node, metadata: { ...node.metadata, status, errorDetails } } : node);
}

function targetType(capability: RemoteMediaTask["capability"]) {
    return capability === "image" ? CanvasNodeType.Image : capability === "video" ? CanvasNodeType.Video : CanvasNodeType.Audio;
}

function hasTarget(nodes: CanvasNodeData[], task: RemoteMediaTask) {
    const node = nodes.find((item) => item.id === task.target.nodeId);
    if (!node || node.type !== targetType(task.capability)) return false;
    return !task.target.itemId || Boolean(node.metadata?.images?.some((image) => image.id === task.target.itemId));
}

function targetCanvas(task: RemoteMediaTask) {
    const project = useProjectStore.getState().projects.find((item) => item.id === task.target.projectId);
    return project?.canvases.find((item) => item.id === task.target.canvasId);
}

export function hasRemoteTaskTarget(task: RemoteMediaTask) {
    const canvas = targetCanvas(task);
    return Boolean(canvas && hasTarget(canvas.nodes, task));
}

/** 交付幂等比较（终审 I3 如实化）：仅保证「同一次交付的 output 对象重放」不重复应用——
 *  持久 content 一致，且（storageKey 对）或（project-file assetId+revision 对）即视为同一产物。
 *  assetRef 比较分支在恢复重交付场景不可达：seedAssetUrl 每次产生新 objectURL、writeBytes 每次产生
 *  新 assetId，content 比较先行失败；spec §1 声称的「恢复重交付以 assetRef 去重、避免同产物重复写
 *  工作区」并未由此交付（恢复重交付会写新资产，属预期外行为，待用户裁决）。 */
function sameDeliveredOutput(current: { storageKey?: string; assetRef?: CanvasAssetRef; content?: string }, delivered: { storageKey?: string; assetRef?: CanvasAssetRef; url: string }) {
    if (current.content !== delivered.url) return false;
    if (current.storageKey && delivered.storageKey) return current.storageKey === delivered.storageKey;
    const persisted = current.assetRef;
    const adopted = delivered.assetRef;
    return Boolean(persisted && adopted && persisted.backend === "project-file" && adopted.backend === "project-file" && persisted.assetId === adopted.assetId && persisted.revision === adopted.revision);
}

export function applyRemoteImageOutput(nodes: CanvasNodeData[], target: RemoteMediaTaskTarget, image: UploadedImage) {
    const node = nodes.find((item) => item.id === target.nodeId);
    if (!node || node.type !== CanvasNodeType.Image) return nodes;
    const images = node.metadata?.images;
    const current = target.itemId ? images?.find((item) => item.id === target.itemId) : undefined;
    if (target.itemId && !current) return nodes;
    if (current?.status === "success" && sameDeliveredOutput(current, image)) return nodes;
    const completed: CanvasNodeImage = {
        id: target.itemId || node.metadata?.primaryImageId || node.id,
        status: "success",
        content: image.url,
        ...(image.assetRef?.backend === "project-file" || !image.storageKey ? {} : { storageKey: image.storageKey }),
        ...(image.assetRef ? { assetRef: image.assetRef } : {}),
        naturalWidth: image.width,
        naturalHeight: image.height,
        bytes: image.bytes,
        mimeType: image.mimeType,
        remoteTask: current?.remoteTask,
    };
    return nodes.map((item) => {
        if (item.id !== target.nodeId) return item;
        const nextImages = images?.map((imageItem) => imageItem.id === completed.id ? completed : imageItem);
        const promote = !item.metadata?.primaryImageId;
        return {
            ...item,
            metadata: {
                ...item.metadata,
                ...(promote ? imageMetadata(image) : { status: "success" as const, errorDetails: undefined }),
                images: nextImages,
                primaryImageId: promote ? completed.id : item.metadata?.primaryImageId,
            },
        };
    });
}

function applyRemoteFileOutput(nodes: CanvasNodeData[], target: RemoteMediaTaskTarget, file: UploadedFile, capability: "video" | "audio") {
    const expectedType = capability === "video" ? CanvasNodeType.Video : CanvasNodeType.Audio;
    const current = nodes.find((node) => node.id === target.nodeId && node.type === expectedType);
    if (!current) return nodes;
    if (current.metadata?.status === "success" && sameDeliveredOutput(current.metadata, file)) return nodes;
    return nodes.map((node) => node.id === target.nodeId
        ? { ...node, metadata: { ...node.metadata, ...(capability === "video" ? videoMetadata(file) : audioMetadata(file)), errorDetails: undefined } }
        : node);
}

export function applyRemoteTaskState(nodes: CanvasNodeData[], task: RemoteMediaTask) {
    if (!hasTarget(nodes, task)) return nodes;
    const active = ACTIVE_TASK_STATUSES.has(task.status);
    const failed = !active && task.status !== "succeeded";
    const remoteTask = taskMetadata(task);
    let changed = false;
    let next = nodes.map((node) => {
        if (node.id !== task.target.nodeId) return node;
        if (task.target.itemId) {
            const images = node.metadata!.images!;
            const nextImages = images.map((image) => {
                if (image.id !== task.target.itemId) return image;
                const status = active ? "loading" as const : failed ? "error" as const : image.status;
                const errorDetails = failed ? taskError(task) : active ? undefined : image.errorDetails;
                if (image.status === status && image.errorDetails === errorDetails && sameTaskMetadata(image.remoteTask, remoteTask)) return image;
                changed = true;
                return { ...image, status, errorDetails, remoteTask };
            });
            if (!changed) return node;
            const status = aggregateImageStatus(nextImages);
            const errorDetails = status === "error" ? nextImages.find((image) => image.errorDetails)?.errorDetails || taskError(task) : undefined;
            return { ...node, metadata: { ...node.metadata, remoteTask: undefined, images: nextImages, status, errorDetails } };
        }
        const status = active ? "loading" as const : failed ? "error" as const : node.metadata?.status;
        const errorDetails = failed ? taskError(task) : active ? undefined : node.metadata?.errorDetails;
        const metadata = node.metadata;
        if (metadata && metadata.status === status && metadata.errorDetails === errorDetails && sameTaskMetadata(metadata.remoteTask, remoteTask)) return node;
        changed = true;
        return { ...node, metadata: { ...node.metadata, remoteTask, status, errorDetails } };
    });
    if (!changed) return nodes;
    next = updateConfigSource(next, task.target);
    return next;
}

function targetRemoteTask(nodes: CanvasNodeData[], task: RemoteMediaTask) {
    const node = nodes.find((item) => item.id === task.target.nodeId);
    if (!node) return undefined;
    return task.target.itemId
        ? node.metadata?.images?.find((image) => image.id === task.target.itemId)?.remoteTask
        : node.metadata?.remoteTask;
}

export function getEmbeddedRemoteTaskStatus(task: RemoteMediaTask) {
    const canvas = targetCanvas(task);
    const embedded = canvas ? targetRemoteTask(canvas.nodes, task) : undefined;
    return embedded?.id === task.id ? embedded.status : undefined;
}

export function reconcileTerminalRemoteTaskMetadata(nodes: CanvasNodeData[], tasks: RemoteMediaTask[]) {
    return tasks.reduce((current, task) => {
        const embedded = targetRemoteTask(current, task);
        if (ACTIVE_TASK_STATUSES.has(task.status) || !embedded || embedded.id !== task.id || !ACTIVE_TASK_STATUSES.has(embedded.status)) return current;
        return applyRemoteTaskState(current, task);
    }, nodes);
}

export function applyRemoteTaskEvent(nodes: CanvasNodeData[], event: RemoteCanvasTaskEvent) {
    if (!event.output) return applyRemoteTaskState(nodes, event.task);
    let next = event.output.capability === "image"
        ? applyRemoteImageOutput(nodes, event.task.target, event.output.value)
        : applyRemoteFileOutput(nodes, event.task.target, event.output.value, event.output.capability);
    if (next === nodes) return nodes;
    next = applyRemoteTaskState(next, { ...event.task, status: "succeeded", progress: 100, error: undefined });
    return updateConfigSource(next, event.task.target);
}

function abortReason(context: RemoteTaskDeliveryContext) {
    return context.signal.reason instanceof Error ? context.signal.reason : new DOMException("Remote media task stopped", "AbortError");
}

function requireActive(context: RemoteTaskDeliveryContext) {
    if (context.signal.aborted || !context.isActive()) throw abortReason(context);
}

function referencesStorageKey(key: string) {
    const visit = (value: unknown): boolean => Boolean(value && typeof value === "object" && (
        ("storageKey" in value && value.storageKey === key)
        || Object.values(value).some((item) => Array.isArray(item) ? item.some(visit) : visit(item))
    ));
    return visit(useProjectStore.getState().projects) || visit(useAssetStore.getState().assets);
}

function storageContext(context: RemoteTaskDeliveryContext) {
    return { signal: context.signal, isActive: context.isActive, isStorageKeyReferenced: referencesStorageKey };
}

/** 交付阶段的项目资产写上下文：调用方显式携带优先；否则桌面桥存在时按任务目标从项目 store 推导。
 *  source 的 canvasId/nodeId 恒由任务目标决定（不得丢失）；脚本血统按序加法合成——
 *  任务记录上的 dispatch 溯源优先，调用方显式 source 上的血统字段兜底保留。 */
function projectAssetWriteTarget(task: RemoteMediaTask, context: RemoteTaskDeliveryContext): ProjectAssetWriteContext | undefined {
    const source: ProjectAssetWriteContext["source"] = {
        ...context.assetWriteContext?.source,
        type: "generated",
        canvasId: task.target.canvasId,
        nodeId: task.target.nodeId,
        ...task.scriptSource,
    };
    if (context.assetWriteContext) return { ...context.assetWriteContext, nodeId: task.target.nodeId, source };
    if (!window.shotshot?.projectAssets) return undefined;
    const project = useProjectStore.getState().projects.find((item) => item.id === task.target.projectId);
    if (!project) return undefined;
    return { projectId: project.id, projectTitle: project.title, workspacePath: project.workspacePath, canvasId: task.target.canvasId, nodeId: task.target.nodeId, source };
}

/** 节点成功前把远端产物写入项目工作区：返回带 assetRef 的合并值；失败即交付失败，严格副本走既有清理。 */
async function adoptProjectAsset(output: RemoteTaskDeliveryOutput, task: RemoteMediaTask, context: RemoteTaskDeliveryContext): Promise<RemoteTaskDeliveryOutput> {
    const writeContext = projectAssetWriteTarget(task, context);
    if (!writeContext) return output;
    requireActive(context);
    try {
        if (output.capability === "image") {
            const blob = await getImageBlob(output.value.storageKey || "");
            if (!blob) throw new Error("Generated image result is no longer readable for project storage");
            const stored = await storeCanvasImage(blob, writeContext);
            return { ...output, value: { ...output.value, url: stored.url, ...(stored.assetRef ? { assetRef: stored.assetRef } : {}), width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType || output.value.mimeType } };
        }
        const blob = await getMediaBlob(output.value.storageKey);
        if (!blob) throw new Error(`Generated ${output.capability} result is no longer readable for project storage`);
        const stored = await storeCanvasMedia(blob, writeContext);
        return {
            ...output,
            value: {
                ...output.value,
                url: stored.url,
                ...(stored.assetRef ? { assetRef: stored.assetRef } : {}),
                bytes: stored.bytes,
                mimeType: stored.mimeType,
                ...(stored.width !== undefined ? { width: stored.width } : {}),
                ...(stored.height !== undefined ? { height: stored.height } : {}),
                ...(stored.durationMs !== undefined ? { durationMs: stored.durationMs } : {}),
            },
        };
    } catch (error) {
        await cleanupRemoteTaskOutput(output, error);
        throw error;
    }
}

function storageKey(output: RemoteTaskDeliveryOutput) {
    return output.value.storageKey || "";
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

function combinedDeliveryError(originalError: unknown, cleanupError: unknown) {
    return new Error(`${errorMessage(originalError)}; stored media cleanup failed: ${errorMessage(cleanupError)}`);
}

async function cleanupRemoteTaskOutput(output: RemoteTaskDeliveryOutput, originalError?: unknown) {
    const key = storageKey(output);
    if (!key) return;
    try {
        if (output.capability === "image") {
            if (output.value.provisionalLease) await discardRemoteImage(output.value);
            else await deleteStoredImages([key]);
        } else if (output.value.provisionalLease) await discardRemoteMedia(output.value);
        else await deleteStoredMedia([key]);
    } catch (cleanupError) {
        if (originalError) throw combinedDeliveryError(originalError, cleanupError);
        throw cleanupError;
    }
}

function releaseRemoteTaskOutput(output: RemoteTaskDeliveryOutput) {
    if (!output.value.provisionalLease) return;
    if (output.capability === "image") releaseRemoteImageLease(output.value);
    else releaseRemoteMediaLease(output.value);
}

function settleRemoteTaskOutputAfterRepair(output: RemoteTaskDeliveryOutput, error: CanvasPersistenceTransactionError) {
    const pending = error.pendingMediaDisposition;
    if (!pending) return false;
    void pending.then(async (disposition) => {
        if (disposition === "retain") releaseRemoteTaskOutput(output);
        else await cleanupRemoteTaskOutput(output, error);
    }).catch((settleError) => {
        console.error("[remote-media-task] pending repair media finalization failed", settleError);
    });
    return true;
}

async function finalizeStoredOutput(output: RemoteTaskDeliveryOutput, context: RemoteTaskDeliveryContext) {
    try {
        requireActive(context);
        if (!storageKey(output) && output.value.assetRef?.backend !== "project-file") throw new Error(`Remote ${output.capability} result is missing a local storageKey`);
        return output;
    } catch (error) {
        await cleanupRemoteTaskOutput(output, error);
        throw error;
    }
}

export async function deliverRemoteTaskResult(task: RemoteMediaTask, raw: unknown, context: RemoteTaskDeliveryContext): Promise<RemoteTaskDeliveryOutput> {
    requireActive(context);
    if (task.capability === "image") {
        const source = normalizePluginImages(raw)[0];
        requireActive(context);
        return finalizeStoredOutput(await adoptProjectAsset({ capability: "image", value: await uploadRemoteImage(source, storageContext(context)) }, task, context), context);
    }
    if (task.capability === "video") {
        const normalized = normalizePluginVideo(raw);
        requireActive(context);
        return finalizeStoredOutput(await adoptProjectAsset({ capability: "video", value: await storeRemoteGeneratedVideo(normalized, storageContext(context)) }, task, context), context);
    }
    const format = task.outputFormat || "mp3";
    const normalized = await normalizePluginAudio(raw, format, context);
    requireActive(context);
    return finalizeStoredOutput(await adoptProjectAsset({ capability: "audio", value: await storeRemoteGeneratedAudio(normalized, format, storageContext(context)) }, task, context), context);
}

function emitRemoteCanvasTaskEvent(event: RemoteCanvasTaskEvent) {
    emitCanvasEvent(REMOTE_CANVAS_TASK_EVENT, event);
}

export function subscribeRemoteCanvasTaskEvents(handler: RemoteCanvasTaskEventHandler) {
    const unsubscribe = onCanvasEvent(REMOTE_CANVAS_TASK_EVENT, (event) => handler(event as RemoteCanvasTaskEvent));
    return () => { unsubscribe(); };
}

async function applyRemoteTaskEventToProject(event: RemoteCanvasTaskEvent, context?: RemoteTaskDeliveryContext): Promise<RemoteTaskDeliveryOutcome> {
    const store = useProjectStore.getState();
    if (context && (context.signal.aborted || !context.isActive())) {
        if (event.output) await cleanupRemoteTaskOutput(event.output, abortReason(context));
        return { applied: false, reason: "inactive" };
    }
    const canvas = targetCanvas(event.task);
    if (!canvas || !hasTarget(canvas.nodes, event.task)) {
        if (event.output) await cleanupRemoteTaskOutput(event.output, new Error("Remote media task target is missing"));
        return { applied: false, reason: "missing_target" };
    }
    if (context && (context.signal.aborted || !context.isActive())) {
        if (event.output) await cleanupRemoteTaskOutput(event.output, abortReason(context));
        return { applied: false, reason: "inactive" };
    }
    let targetPresent = true;
    let changed = false;
    try {
        const transaction = await store.transactCanvasNodes(event.projectId, event.canvasId, (nodes) => {
            targetPresent = hasTarget(nodes, event.task);
            const next = targetPresent ? applyRemoteTaskEvent(nodes, event) : nodes;
            changed = next !== nodes;
            return next;
        }, { context, onCommitted: () => emitRemoteCanvasTaskEvent(event), isTargetPresent: (nodes) => hasTarget(nodes, event.task) });
        if (!transaction.applied && transaction.reason === "missing_target") targetPresent = false;
        if (event.output) {
            if (transaction.applied || (!changed && targetPresent)) {
                releaseRemoteTaskOutput(event.output);
                // 桌面已采纳进工作区（move 语义）：删除 IDB 暂存键；Web 的暂存键即本体，绝不删。
                // 删除失败不翻转交付结果（spec §1，Task 1 工具内部已 catch）。
                // 空键守卫（终审 M2）：暂存键缺失（如元数据只有 assetRef）时不得以空键调用删除。
                const staging = storageKey(event.output);
                if (staging && event.output.value.assetRef?.backend === "project-file") await deleteStoredMediaKeys([staging]);
            } else {
                await cleanupRemoteTaskOutput(event.output, new Error(targetPresent ? "Remote canvas task was not committed" : "Remote media task target is missing"));
            }
        }
        return transaction.applied ? { applied: true } : { applied: false, reason: targetPresent ? "unchanged" : "missing_target" };
    } catch (error) {
        if (event.output) {
            const repairOwnsLease = error instanceof CanvasPersistenceTransactionError && settleRemoteTaskOutputAfterRepair(event.output, error);
            if (!repairOwnsLease) {
                if (error instanceof CanvasPersistenceTransactionError && error.preserveMedia) releaseRemoteTaskOutput(event.output);
                else await cleanupRemoteTaskOutput(event.output, error);
            }
        }
        throw error;
    }
}

export function applyRemoteTaskStateToProject(task: RemoteMediaTask, context?: RemoteTaskDeliveryContext) {
    return applyRemoteTaskEventToProject({ projectId: task.target.projectId, canvasId: task.target.canvasId, task }, context);
}

export async function applyRemoteTaskStatesToProject(tasks: RemoteMediaTask[]): Promise<RemoteTaskDeliveryOutcome> {
    if (!tasks.length) return { applied: false, reason: "unchanged" };
    const [{ target }] = tasks;
    if (tasks.some((task) => task.target.projectId !== target.projectId || task.target.canvasId !== target.canvasId)) {
        throw new Error("Remote task batch must target one project canvas");
    }
    const canvas = targetCanvas(tasks[0]);
    if (!canvas || tasks.every((task) => !hasTarget(canvas.nodes, task))) return { applied: false, reason: "missing_target" };
    const store = useProjectStore.getState();
    const transaction = await store.transactCanvasNodes(target.projectId, target.canvasId, (nodes) => tasks.reduce(applyRemoteTaskState, nodes), {
        isTargetPresent: (nodes) => tasks.some((task) => hasTarget(nodes, task)),
        onCommitted: () => tasks.forEach((task) => emitRemoteCanvasTaskEvent({ projectId: target.projectId, canvasId: target.canvasId, task })),
    });
    return transaction.applied ? { applied: true } : { applied: false, reason: transaction.reason };
}

/** Task6 startup recovery hook: call after task and project stores hydrate. */
export async function reconcileTerminalRemoteTasksToProjects(tasks: RemoteMediaTask[]) {
    const terminal = tasks.filter((task) => !ACTIVE_TASK_STATUSES.has(task.status));
    const outcomes = [];
    for (const task of terminal) {
        const canvas = targetCanvas(task);
        const embedded = canvas ? targetRemoteTask(canvas.nodes, task) : undefined;
        if (!embedded || embedded.id !== task.id || !ACTIVE_TASK_STATUSES.has(embedded.status)) continue;
        outcomes.push({ taskId: task.id, outcome: await applyRemoteTaskStateToProject(task) });
    }
    return outcomes;
}

export function applyRemoteTaskOutputToProject(task: RemoteMediaTask, output: RemoteTaskDeliveryOutput, context?: RemoteTaskDeliveryContext) {
    return applyRemoteTaskEventToProject({ projectId: task.target.projectId, canvasId: task.target.canvasId, task, output }, context);
}

/** 交付中断（停止/超时）不落错误态：节点状态由 runner 的 interrupted 语义负责。 */
function isDeliveryInterrupted(error: unknown, context: RemoteTaskDeliveryContext) {
    return context.signal.aborted || !context.isActive() || (error instanceof Error && error.name === "AbortError");
}

/** 远端已完成但本地持久化失败：保留远端任务身份，把本地持久化错误落到目标节点，不自动重提请求。 */
async function surfaceRemoteDeliveryFailure(task: RemoteMediaTask, error: unknown, context: RemoteTaskDeliveryContext) {
    if (isDeliveryInterrupted(error, context)) return;
    try {
        await applyRemoteTaskStateToProject({ ...task, status: "failed", error: errorMessage(error) });
    } catch (surfaceError) {
        console.error("[remote-media-task] delivery failure could not be applied to the target", surfaceError);
    }
}

export async function deliverRemoteTaskToProject(task: RemoteMediaTask, raw: unknown, context: RemoteTaskDeliveryContext) {
    requireActive(context);
    if (!hasRemoteTaskTarget(task)) return { applied: false, reason: "missing_target" } as const;
    let output: RemoteTaskDeliveryOutput;
    try {
        output = await deliverRemoteTaskResult(task, raw, context);
    } catch (error) {
        await surfaceRemoteDeliveryFailure(task, error, context);
        throw error;
    }
    return applyRemoteTaskOutputToProject(task, output, context);
}
