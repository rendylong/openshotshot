import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasAssetWriteInput } from "@/services/project-asset-storage";
import type { AgentAttachment } from "@/stores/use-agent-store";

vi.mock("@/services/project-asset-storage", () => ({
    storeCanvasImage: vi.fn(),
    storeCanvasMedia: vi.fn(),
}));

import { storeCanvasImage, storeCanvasMedia } from "@/services/project-asset-storage";
import { materializePendingAttachments } from "./register-pending-attachments";

const storeCanvasImageMock = vi.mocked(storeCanvasImage);
const storeCanvasMediaMock = vi.mocked(storeCanvasMedia);

const context: CanvasAssetWriteInput = {
    projectId: "project-1",
    projectTitle: "项目",
    workspacePath: "/Users/me/ws/p1",
    canvasId: "canvas-1",
    source: { type: "agent-attachment" },
};

function attachment(overrides: Partial<AgentAttachment> = {}): AgentAttachment {
    return {
        id: "m",
        name: "budget.xlsx",
        kind: "spreadsheet",
        size: 64,
        url: "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,AA==",
        dataUrl: "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,AA==",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ...overrides,
    };
}

describe("materializePendingAttachments", () => {
    beforeEach(() => {
        storeCanvasImageMock.mockReset();
        storeCanvasMediaMock.mockReset();
    });

    it("stores files through the project asset facade and attaches the returned asset ref", async () => {
        const projectRef = { backend: "project-file" as const, projectId: "project-1", assetId: "asset-1", relativePath: "assets/imported/budget--a1b2c3d4.xlsx", revision: 1 };
        storeCanvasMediaMock.mockResolvedValue({ url: "blob:stored", assetRef: projectRef, bytes: 64, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

        const [stored] = await materializePendingAttachments([attachment()], context);

        expect(storeCanvasMediaMock).toHaveBeenCalledWith(expect.any(Blob), {
            ...context,
            name: "budget.xlsx",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            source: { type: "agent-attachment", canvasId: "canvas-1" },
        });
        expect(stored.assetRef).toEqual(projectRef);
        expect(stored.relativePath).toBe("assets/imported/budget--a1b2c3d4.xlsx");
    });

    it("routes images through the image writer and keeps other kinds on the media writer", async () => {
        storeCanvasImageMock.mockResolvedValue({
            url: "blob:image",
            assetRef: { backend: "project-file", projectId: "project-1", assetId: "asset-2", relativePath: "assets/imported/photo--a1b2c3d4.png", revision: 1 },
            width: 32,
            height: 16,
            bytes: 8,
            mimeType: "image/png",
        });

        const [stored] = await materializePendingAttachments([attachment({ id: "img", name: "photo.png", kind: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,AA==", url: "data:image/png;base64,AA==" })], context);

        expect(storeCanvasImageMock).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({ projectId: "project-1", name: "photo.png" }));
        expect(storeCanvasMediaMock).not.toHaveBeenCalled();
        expect(stored.relativePath).toBe("assets/imported/photo--a1b2c3d4.png");
    });

    it("skips attachments that already carry an asset ref", async () => {
        const stored = attachment({ assetRef: { backend: "indexeddb", storageKey: "file:kept" } });
        const attachments = [stored];

        await expect(materializePendingAttachments(attachments, context)).resolves.toBe(attachments);
        expect(storeCanvasImageMock).not.toHaveBeenCalled();
        expect(storeCanvasMediaMock).not.toHaveBeenCalled();
    });

    it("propagates write failures so the send can roll back", async () => {
        storeCanvasMediaMock.mockRejectedValue(new Error("workspace offline"));

        await expect(materializePendingAttachments([attachment()], context)).rejects.toThrow("workspace offline");
    });
});
