import { classifyAgentAttachment, isSupportedAgentAttachment } from "@/lib/agent/agent-attachments";
import { readFileAsDataUrl, readImageMeta } from "@/lib/image-utils";
import { randomId } from "@/lib/utils";
import type { AgentAttachment } from "@/stores/use-agent-store";

export async function readHomeAttachments(files: File[]): Promise<AgentAttachment[]> {
    const supported = files.filter((file) => isSupportedAgentAttachment(file.name, file.type));
    return Promise.all(supported.map(async (file) => {
        const kind = classifyAgentAttachment(file.name, file.type)!;
        const dataUrl = await readFileAsDataUrl(file);
        const dimensions = kind === "image" ? await readImageMeta(dataUrl) : null;
        return {
            id: randomId(),
            name: file.name,
            kind,
            mimeType: file.type || dimensions?.mimeType || "application/octet-stream",
            size: file.size,
            url: dataUrl,
            dataUrl,
            width: dimensions?.width,
            height: dimensions?.height,
        };
    }));
}
