import { isAudioFile } from "@/lib/canvas/canvas-generation-helpers";

const EDITABLE_TARGET_SELECTOR = "[contenteditable='true'],[data-canvas-no-zoom],[data-canvas-media],[data-canvas-shortcuts-ignore]";

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
};

export function clipboardImageName(mimeType: string) {
    return `clipboard-image.${IMAGE_EXTENSION_BY_MIME[mimeType] || "png"}`;
}

export function ensurePasteFileName(file: File) {
    if (/\.(png|jpe?g|webp|gif|svg|bmp)$/i.test(file.name)) return file;
    return new File([file], clipboardImageName(file.type), { type: file.type });
}

export function extractPasteFiles(event: ClipboardEvent) {
    const data = event.clipboardData;
    if (!data) return [];
    const files = new Set<File>(Array.from(data.files ?? []));
    for (const item of Array.from(data.items ?? [])) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) files.add(file);
    }
    return Array.from(files);
}

export function isMediaFile(file: File) {
    return file.type.startsWith("image/") || file.type.startsWith("video/") || isAudioFile(file);
}

export function isEditablePasteTarget(target: EventTarget | null) {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
    return target instanceof Element && target.closest(EDITABLE_TARGET_SELECTOR) !== null;
}
