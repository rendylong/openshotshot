/** Upload copies only. Never write these bytes back to the local image store. */
export const REFERENCE_JPEG_QUALITY = 0.94;
export const REFERENCE_MAX_EDGE = 3072;

export async function encodeReferenceJpeg(blob: Blob): Promise<Blob> {
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    try {
        // Avoid another lossy generation for JPEGs already within the size budget.
        if (blob.type === "image/jpeg" && Math.max(bitmap.width, bitmap.height) <= REFERENCE_MAX_EDGE) return blob;
        const scale = Math.min(1, REFERENCE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
        const context = canvas.getContext("2d", { colorSpace: "srgb" }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
        if (!context) throw new Error("reference_image_canvas_unavailable");
        context.fillStyle = "#ffffff"; // Image pixels, not a UI/theme color: JPEG has no alpha channel.
        context.fillRect(0, 0, width, height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(bitmap, 0, 0, width, height);
        const result = "convertToBlob" in canvas
            ? await canvas.convertToBlob({ type: "image/jpeg", quality: REFERENCE_JPEG_QUALITY })
            : await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("reference_image_encoding_failed")), "image/jpeg", REFERENCE_JPEG_QUALITY));
        if (result.type !== "image/jpeg" || !result.size) throw new Error("reference_image_encoding_failed");
        return result;
    } finally {
        bitmap.close();
    }
}
