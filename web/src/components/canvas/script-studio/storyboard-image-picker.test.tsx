import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StoryboardImagePicker } from "./storyboard-image-picker";
import { useAssetStore } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeStatus } from "@/types/canvas";

const node = (id: string, status: CanvasNodeStatus = "success"): CanvasNodeData => ({ id, title: id, type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "data:image/png;base64,test", status } });
beforeEach(() => useAssetStore.setState({ assets: [] }));
describe("StoryboardImagePicker", () => {
    it("filters unavailable canvas images, searches the complete list and selects by node id", async () => {
        const onSelect = vi.fn().mockResolvedValue(undefined);
        const onClose = vi.fn();
        render(<StoryboardImagePicker source="canvas" canvasImageNodes={[...Array.from({ length: 12 }, (_, i) => node(`image-${i}`)), node("loading", "loading"), node("failed", "error")]}
            onSelect={onSelect} onClose={onClose} />);
        expect(screen.queryByRole("button", { name: "loading" })).toBeNull();
        expect(screen.queryByRole("button", { name: "failed" })).toBeNull();
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "image-11" } });
        fireEvent.click(screen.getByRole("button", { name: "image-11" }));
        await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
        expect(onSelect).toHaveBeenCalledWith({ kind: "canvas", nodeId: "image-11" });
    });
    it("only offers image assets and keeps the picker open when loading fails", async () => {
        useAssetStore.setState({ assets: [
            { id: "image", kind: "image", title: "Library image", coverUrl: "", tags: [], createdAt: "", updatedAt: "", data: { dataUrl: "test", storageKey: "stored", width: 100, height: 100, bytes: 1, mimeType: "image/png" } },
            { id: "text", kind: "text", title: "Text asset", coverUrl: "", tags: [], createdAt: "", updatedAt: "", data: { content: "text" } },
        ] });
        const onSelect = vi.fn().mockRejectedValue(new Error("missing image"));
        const onClose = vi.fn();
        render(<StoryboardImagePicker source="library" canvasImageNodes={[]} onSelect={onSelect} onClose={onClose} />);
        expect(screen.queryByText("Text asset")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Library image" }));
        await screen.findByRole("alert");
        expect(onSelect).toHaveBeenCalledWith({ kind: "library", assetId: "image" });
        expect(onClose).not.toHaveBeenCalled();
    });
});
