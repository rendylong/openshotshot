// `glb` 保留旧名称以兼容既有消息与节点映射；写入项目资产时映射为 ProjectAssetKind 的 model3d。
export type AgentAttachmentKind = "image" | "video" | "audio" | "pdf" | "presentation" | "spreadsheet" | "glb" | "text" | "file";
type AgentAttachmentLike = { id?: string; name?: string; kind?: AgentAttachmentKind; dataUrl?: string; mimeType?: string; [key: string]: unknown };

const EXTENSION_KIND: Record<string, AgentAttachmentKind> = {
    png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image", avif: "image",
    mp4: "video", webm: "video", mov: "video", m4v: "video",
    mp3: "audio", wav: "audio", m4a: "audio", aac: "audio", ogg: "audio", flac: "audio",
    pdf: "pdf",
    ppt: "presentation", pptx: "presentation",
    xls: "spreadsheet", xlsx: "spreadsheet",
    glb: "glb", gltf: "glb",
    md: "text", markdown: "text", txt: "text",
};

export function classifyAgentAttachment(name: string, mimeType = ""): AgentAttachmentKind | null {
    const mime = mimeType.toLowerCase().split(";", 1)[0];
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    if (mime === "application/pdf") return "pdf";
    if (mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || mime === "application/vnd.ms-powerpoint") return "presentation";
    if (mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || mime === "application/vnd.ms-excel") return "spreadsheet";
    if (mime === "model/gltf-binary" || mime === "model/gltf+json") return "glb";
    if (mime.startsWith("text/")) return "text";
    const extension = name.toLowerCase().split(".").pop() || "";
    return EXTENSION_KIND[extension] || null;
}

export function isSupportedAgentAttachment(name: string, mimeType?: string) {
    return classifyAgentAttachment(name, mimeType) !== null;
}

export function attachmentToImageContent(attachment: AgentAttachmentLike) {
    if (attachment.kind !== "image" || !attachment.dataUrl) return null;
    const match = attachment.dataUrl.match(/^data:([^;,]+);base64,(.*)$/);
    if (!match) return null;
    return { type: "image" as const, data: match[2], mimeType: attachment.mimeType || match[1] };
}

export function agentAttachmentNodeType(kind: AgentAttachmentKind) {
    return kind === "image" ? "image" : kind === "video" ? "video" : kind === "glb" ? "3d" : "file";
}
