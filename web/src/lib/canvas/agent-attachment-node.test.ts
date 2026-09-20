import { describe, expect, it } from "vitest";

import type { AgentFileContent } from "@/lib/agent/pi-agent-types";
import { agentAttachmentNodeType, type AgentAttachmentKind } from "@/lib/agent/agent-attachments";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";
import { attachmentNodeMetadata, attachmentNodeOp } from "./agent-attachment-node";

const glbAttachment: AgentFileContent = { handle: "h", name: "x.glb", kind: "glb" as AgentAttachmentKind, mimeType: "model/gltf-binary", size: 1, dataUrl: "data:x;base64,AA" };
const projectRef: CanvasAssetRef = { backend: "project-file", assetId: "a1", projectId: "p1", relativePath: "assets/imported/x.glb", revision: 1 };

describe("attachment canvas node mapping", () => {
    it.each([
        ["image", "image"], ["video", "video"], ["glb", "3d"], ["pdf", "file"],
    ] as const)("maps %s to the %s canvas node", (kind, nodeType) => {
        const attachment: AgentFileContent = { handle: "h", name: `x.${kind}`, kind: kind as AgentAttachmentKind, mimeType: "application/octet-stream", size: 1, dataUrl: "data:x;base64,AA" };
        expect(agentAttachmentNodeType(attachment.kind)).toBe(nodeType);
        expect(attachmentNodeOp(attachment, { x: 10, y: 20 })).toMatchObject({ type: "add_node", nodeType });
    });

    it("carries a stored assetRef into the node metadata without a storage key write", () => {
        const metadata = attachmentNodeMetadata({ ...glbAttachment, assetRef: projectRef });
        expect(metadata.assetRef).toEqual(projectRef);
        expect(metadata.model3d?.assetRef).toEqual(projectRef);
        expect(metadata.model3d?.storageKey).toBeUndefined();
    });

    it("keeps the legacy IndexedDB metadata when the attachment has no assetRef", () => {
        const metadata = attachmentNodeMetadata(glbAttachment);
        expect(metadata.assetRef).toBeUndefined();
        expect(metadata.model3d?.storageKey).toBe("agent-file:h");
    });
});
