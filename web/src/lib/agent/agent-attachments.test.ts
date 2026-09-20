import { describe, expect, it } from "vitest";

import { classifyProjectAsset } from "@/lib/project-assets/project-asset-types";
import { agentAttachmentNodeType, attachmentToImageContent, classifyAgentAttachment } from "./agent-attachments";

describe("agent attachment contracts", () => {
    it("classifies supported extensions and rejects unknown files", () => {
        expect(classifyAgentAttachment("hero.png", "image/png")).toBe("image");
        expect(classifyAgentAttachment("clip.mp4", "video/mp4")).toBe("video");
        expect(classifyAgentAttachment("brief.pdf", "application/pdf")).toBe("pdf");
        expect(classifyAgentAttachment("model.glb", "model/gltf-binary")).toBe("glb");
        expect(classifyAgentAttachment("notes.docx", "application/octet-stream")).toBeNull();
    });

    it("converts a data URL image into the pi ImageContent payload", () => {
        expect(attachmentToImageContent({ id: "a1", name: "a.png", kind: "image", mimeType: "image/png", size: 3, url: "data:image/png;base64,AAA", dataUrl: "data:image/png;base64,AAA" })).toEqual({ type: "image", data: "AAA", mimeType: "image/png" });
    });

    it("maps PDF to the file node and GLB to the registered 3d node", () => {
        expect(agentAttachmentNodeType("pdf")).toBe("file");
        expect(agentAttachmentNodeType("glb")).toBe("3d");
    });

    it("classifies the expanded kinds and keeps glb mapping to project kind model3d", () => {
        expect(classifyAgentAttachment("voice.mp3", "audio/mpeg")).toBe("audio");
        expect(classifyAgentAttachment("deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe("presentation");
        expect(classifyAgentAttachment("budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("spreadsheet");
        expect(classifyAgentAttachment("notes.md", "text/markdown")).toBe("text");
        expect(classifyAgentAttachment("model.glb", "model/gltf-binary")).toBe("glb");
        expect(classifyProjectAsset("model.glb", "model/gltf-binary")).toBe("model3d");
    });
});
