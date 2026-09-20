// 发送时才做持久化：Composer 阶段只保留临时 Data URL 预览，sendPrompt 在解析项目工作区后
// 把每个附件写入项目资产（assets/imported/），返回带 assetRef/relativePath 的持久身份。
// 任何一次写入失败都整体抛错，由 sendPrompt 恢复草稿且不追加用户消息。
import { storeCanvasImage, storeCanvasMedia, type CanvasAssetWriteInput } from "@/services/project-asset-storage";
import type { AgentAttachment } from "@/stores/use-agent-store";

async function attachmentBlob(dataUrl: string): Promise<Blob> {
    const response = await fetch(dataUrl);
    return await response.blob();
}

export async function materializePendingAttachments(attachments: AgentAttachment[], context: CanvasAssetWriteInput): Promise<AgentAttachment[]> {
    const stored = new Map<string, { assetRef?: AgentAttachment["assetRef"]; relativePath?: string }>();
    for (const attachment of attachments) {
        if (attachment.assetRef || !attachment.dataUrl) continue;
        const blob = await attachmentBlob(attachment.dataUrl);
        const writeContext: CanvasAssetWriteInput = {
            ...context,
            name: attachment.name,
            mimeType: attachment.mimeType || "application/octet-stream",
            source: { ...context.source, canvasId: context.source.canvasId ?? context.canvasId },
        };
        const written = attachment.kind === "image"
            ? await storeCanvasImage(blob, writeContext)
            : await storeCanvasMedia(blob, writeContext);
        const assetRef = written.assetRef;
        stored.set(attachment.id, {
            assetRef,
            relativePath: assetRef?.backend === "project-file" ? assetRef.relativePath : undefined,
        });
    }
    if (!stored.size) return attachments;
    return attachments.map((attachment) => {
        const write = stored.get(attachment.id);
        return write ? { ...attachment, ...write } : attachment;
    });
}
