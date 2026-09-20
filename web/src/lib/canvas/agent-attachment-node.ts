import { nanoid } from "nanoid";

import type { AgentFileContent } from "@/lib/agent/pi-agent-types";
import { agentAttachmentNodeType } from "@/lib/agent/agent-attachments";
import type { CanvasAgentOp } from "./canvas-agent-op-types";
import type { CanvasNodeMetadata, Position } from "@/types/canvas";

/** 已存储附件直接消费 assetRef（Task 5 发送时已落库）；旧消息无 assetRef 时保留 legacy storageKey 形态。 */
export function attachmentNodeMetadata(attachment: AgentFileContent): CanvasNodeMetadata {
    const assetRef = attachment.assetRef ? { assetRef: attachment.assetRef } : {};
    const storageKey = attachment.assetRef ? {} : { storageKey: `agent-file:${attachment.handle}` };
    const base = { content: attachment.dataUrl, status: "success" as const, mimeType: attachment.mimeType, bytes: attachment.size, sourceHandle: attachment.handle, ...storageKey, ...assetRef };
    return attachment.kind === "glb" ? { ...base, model3d: { name: attachment.name, content: attachment.dataUrl, mimeType: attachment.mimeType, bytes: attachment.size, ...storageKey, ...assetRef } } : base;
}

export function attachmentNodeOp(attachment: AgentFileContent, position: Position): CanvasAgentOp {
    const nodeType = agentAttachmentNodeType(attachment.kind);
    return { type: "add_node", id: `${nodeType}-${nanoid()}`, nodeType, title: attachment.name, position, metadata: attachmentNodeMetadata(attachment) };
}
