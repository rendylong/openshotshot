import { encodeReferenceJpeg } from "./reference-image-codec";

self.onmessage = async (event: MessageEvent<Blob>) => {
    try {
        self.postMessage({ blob: await encodeReferenceJpeg(event.data) });
    } catch {
        self.postMessage({ error: "reference_image_encoding_failed" });
    }
};
