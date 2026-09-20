import i18n from "@/i18n";
import { readFileAsDataUrl } from "@/lib/image-utils";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import { imageToDataUrl } from "./image-storage";
import { encodeReferenceJpeg } from "./reference-image-codec";

// Reuse HiAPI's bounded 32-entry memo, now shared by all generation routes.
const MEMO_LIMIT = 32;
const COMPRESSION_CONCURRENCY = 2;
const completed = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();
const queue: Array<() => void> = [];
let active = 0;

const sessionKey = Symbol("reference-image-session");
export type ReferenceImageSession = {
    enabled: boolean;
    uploads: Map<string, Promise<string>>;
};
type SessionConfig = AiConfig & { [sessionKey]?: ReferenceImageSession };
export function createReferenceImageSession(enabled: boolean): ReferenceImageSession {
    return { enabled, uploads: new Map() };
}
/** Symbol metadata survives config spreads but is never serialized into settings or tasks. */
export function withReferenceImageSession(config: AiConfig, session?: ReferenceImageSession): AiConfig {
    return { ...config, [sessionKey]: session ?? (config as SessionConfig)[sessionKey] ?? createReferenceImageSession(config.compressReferenceImages !== false) } as SessionConfig;
}
export function referenceImageSession(config: AiConfig) {
    return (config as SessionConfig)[sessionKey];
}
export function referenceCompressionEnabled(config: AiConfig) {
    return referenceImageSession(config)?.enabled ?? config.compressReferenceImages !== false;
}

export function waitForReferenceWork<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return work;
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}
function schedule<T>(run: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        const start = () => {
            active++;
            run().then(resolve, reject).finally(() => { active--; queue.shift()?.(); });
        };
        if (active < COMPRESSION_CONCURRENCY) start(); else queue.push(start);
    });
}
async function encode(blob: Blob) {
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return encodeReferenceJpeg(blob);
    const worker = new Worker(new URL("./reference-image.worker.ts", import.meta.url), { type: "module" });
    try {
        return await new Promise<Blob>((resolve, reject) => {
            worker.onmessage = (event: MessageEvent<{ blob?: Blob }>) => event.data.blob ? resolve(event.data.blob) : reject(new Error("reference_image_encoding_failed"));
            worker.onerror = () => reject(new Error("reference_image_encoding_failed"));
            worker.postMessage(blob);
        });
    } finally { worker.terminate(); }
}
async function digest(value: string) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
function remember(key: string, value: string) {
    completed.delete(key);
    completed.set(key, value);
    if (completed.size > MEMO_LIMIT) completed.delete(completed.keys().next().value!);
}
async function compress(source: string): Promise<string> {
    // Read remote URLs anew; memoize content, not mutable remote addresses.
    const dataUrl = source.startsWith("image:")
        ? await imageToDataUrl({ storageKey: source })
        : await imageToDataUrl({ dataUrl: source });
    if (!dataUrl) throw new Error("reference_image_read_failed");
    const key = await digest(dataUrl);
    const cached = completed.get(key);
    if (cached) { remember(key, cached); return cached; }
    const pending = inFlight.get(key);
    if (pending) return pending;
    const work = schedule(async () => {
        const blob = await (await fetch(dataUrl)).blob();
        const jpeg = await encode(blob);
        const result = jpeg === blob ? dataUrl : await readFileAsDataUrl(new File([jpeg], "reference.jpg", { type: "image/jpeg" }));
        remember(key, result);
        // Re-entering a lower-level OpenAI/Gemini route must not encode again.
        remember(await digest(result), result);
        return result;
    });
    inFlight.set(key, work);
    try { return await work; } finally { inFlight.delete(key); }
}

/** Masks and paired edit bases are functional data; preserve their geometry and alpha. */
export function hasReferenceMask(params?: Record<string, unknown>) {
    return Boolean(params && Object.entries(params).some(([key, value]) => /(^|_)mask($|_)/i.test(key) && value));
}
export async function prepareReferenceImages(config: AiConfig, images: readonly string[], options: { signal?: AbortSignal; preserveOriginal?: boolean } = {}): Promise<string[]> {
    options.signal?.throwIfAborted();
    if (!images.length || !referenceCompressionEnabled(config) || options.preserveOriginal) return [...images];
    try {
        return await Promise.all(images.map(source => waitForReferenceWork(compress(source), options.signal)));
    } catch {
        options.signal?.throwIfAborted();
        throw new Error(i18n.t("apiErrors.referenceImageCompressionFailed"));
    }
}
export async function prepareReferenceObjects(config: AiConfig, images: readonly ReferenceImage[], options: { signal?: AbortSignal; preserveOriginal?: boolean } = {}): Promise<ReferenceImage[]> {
    if (!referenceCompressionEnabled(config) || options.preserveOriginal) return [...images];
    const sources = await Promise.all(images.map(image => imageToDataUrl(image, { signal: options.signal })));
    const prepared = await prepareReferenceImages(config, sources, options);
    return images.map((image, index) => ({ ...image, name: image.name.replace(/\.[^.]*$/, "") + ".jpg", type: "image/jpeg", dataUrl: prepared[index], storageKey: undefined, url: undefined }));
}

/** Content keys for task-scoped upload deduplication; never store source bytes in diagnostics. */
export const referenceImageDigest = digest;
export function resetReferenceImageMemoForTests() { completed.clear(); inFlight.clear(); }
