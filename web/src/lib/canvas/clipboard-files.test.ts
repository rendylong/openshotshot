import { describe, expect, it } from "vitest";

import { clipboardImageName, ensurePasteFileName, extractPasteFiles, isEditablePasteTarget, isMediaFile } from "./clipboard-files";

function pasteEvent(clipboardData: unknown) {
    return { clipboardData } as unknown as ClipboardEvent;
}

function fakeItems(entries: Array<{ kind: string; file: File | null }>) {
    return entries.map((entry) => ({ kind: entry.kind, getAsFile: () => entry.file })) as unknown as DataTransferItemList;
}

function fakeFiles(files: File[]) {
    return files as unknown as FileList;
}

describe("extractPasteFiles", () => {
    it("returns files from clipboardData.files", () => {
        const file = new File(["a"], "a.png", { type: "image/png" });
        expect(extractPasteFiles(pasteEvent({ files: fakeFiles([file]), items: [] }))).toEqual([file]);
    });

    it("merges file items and deduplicates the same File object", () => {
        const file = new File(["a"], "a.png", { type: "image/png" });
        expect(extractPasteFiles(pasteEvent({ files: fakeFiles([file]), items: fakeItems([{ kind: "file", file }]) }))).toEqual([file]);
    });

    it("collects image items that are not exposed via .files", () => {
        const file = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
        expect(extractPasteFiles(pasteEvent({ files: fakeFiles([]), items: fakeItems([{ kind: "file", file }]) }))).toEqual([file]);
    });

    it("skips non-file items and null getAsFile results", () => {
        const file = new File(["a"], "a.png", { type: "image/png" });
        expect(
            extractPasteFiles(pasteEvent({
                files: fakeFiles([]),
                items: fakeItems([{ kind: "string", file: null }, { kind: "file", file: null }, { kind: "file", file }]),
            })),
        ).toEqual([file]);
    });

    it("returns an empty array when clipboardData is missing", () => {
        expect(extractPasteFiles(pasteEvent(null))).toEqual([]);
    });
});

describe("isMediaFile", () => {
    it("accepts image and video mime types", () => {
        expect(isMediaFile(new File([], "a.png", { type: "image/png" }))).toBe(true);
        expect(isMediaFile(new File([], "a.mp4", { type: "video/mp4" }))).toBe(true);
    });

    it("accepts audio via mime type or mp3/wav extension", () => {
        expect(isMediaFile(new File([], "a.mp3", { type: "" }))).toBe(true);
        expect(isMediaFile(new File([], "b.wav", { type: "" }))).toBe(true);
        expect(isMediaFile(new File([], "a.ogg", { type: "audio/ogg" }))).toBe(true);
    });

    it("rejects non-media files", () => {
        expect(isMediaFile(new File([], "a.pdf", { type: "application/pdf" }))).toBe(false);
    });
});

describe("clipboardImageName", () => {
    it("maps known mime types to extensions", () => {
        expect(clipboardImageName("image/png")).toBe("clipboard-image.png");
        expect(clipboardImageName("image/jpeg")).toBe("clipboard-image.jpg");
        expect(clipboardImageName("image/webp")).toBe("clipboard-image.webp");
    });

    it("falls back to png for unknown mime types", () => {
        expect(clipboardImageName("image/avif")).toBe("clipboard-image.png");
        expect(clipboardImageName("")).toBe("clipboard-image.png");
    });
});

describe("ensurePasteFileName", () => {
    it("keeps files that already carry a known image extension", () => {
        const file = new File(["a"], "photo.jpeg", { type: "image/jpeg" });
        expect(ensurePasteFileName(file)).toBe(file);
    });

    it("renames files without a usable image extension using the mime type", () => {
        const file = new File(["a"], "", { type: "image/webp" });
        const renamed = ensurePasteFileName(file);
        expect(renamed.name).toBe("clipboard-image.webp");
        expect(renamed.type).toBe("image/webp");
    });
});

describe("isEditablePasteTarget", () => {
    it("treats form fields as editable", () => {
        expect(isEditablePasteTarget(document.createElement("input"))).toBe(true);
        expect(isEditablePasteTarget(document.createElement("textarea"))).toBe(true);
        expect(isEditablePasteTarget(document.createElement("select"))).toBe(true);
    });

    it("treats contenteditable and canvas-guarded elements as editable", () => {
        const editable = document.createElement("div");
        editable.setAttribute("contenteditable", "true");
        document.body.append(editable);
        const child = document.createElement("span");
        editable.append(child);
        expect(isEditablePasteTarget(editable)).toBe(true);
        expect(isEditablePasteTarget(child)).toBe(true);
        expect(isEditablePasteTarget(document.querySelector("[data-canvas-no-zoom]") ?? null)).toBe(false);
        editable.remove();
    });

    it("treats plain elements and null as non-editable", () => {
        expect(isEditablePasteTarget(document.body)).toBe(false);
        expect(isEditablePasteTarget(null)).toBe(false);
    });
});
