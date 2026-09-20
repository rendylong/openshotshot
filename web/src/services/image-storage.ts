import localforage from "localforage";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";

export type UploadedImage = {
    url: string;
    storageKey?: string;
    provisionalLease?: ProvisionalImageLease;
    assetRef?: CanvasAssetRef;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

export type ProvisionalImageLease = { storageKey: string; generation: number };

const store = localforage.createInstance({ name: "shotshot", storeName: "image_files" });
const imageLogStore = localforage.createInstance({ name: "shotshot", storeName: "image_generation_logs" });
const videoLogStore = localforage.createInstance({ name: "shotshot", storeName: "video_generation_logs" });
const objectUrls = new Map<string, string>();
const pendingCleanupKeys = new Map<string, number>();
const storageGenerations = new Map<string, number>();
const provisionalLeases = new Map<string, number>();
const storageKeyQueues = new Map<string, Promise<void>>();
const IMAGE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const IMAGE_REMOTE_LOAD_TIMEOUT_MS = 10 * 60_000;
const IMAGE_DECODE_TIMEOUT_MS = 10_000;
const IMAGE_RESPONSE_ERROR = "ImageResponseError";
const IMAGE_TIMEOUT_ERROR = "ImageTimeoutError";

export type ImageReadOptions = { signal?: AbortSignal; isActive?: () => boolean; strictLocal?: boolean };
type RemoteImageStorageContext = { signal: AbortSignal; isActive: () => boolean; isStorageKeyReferenced?: (key: string) => boolean };
type LatestStorageReferences = () => unknown;

function collectAnyStorageKeys(value: unknown, keys: Set<string>) {
    if (!value || typeof value !== "object") return;
    if ("storageKey" in value && typeof value.storageKey === "string") keys.add(value.storageKey);
    Object.values(value).forEach((item) => Array.isArray(item) ? item.forEach((child) => collectAnyStorageKeys(child, keys)) : collectAnyStorageKeys(item, keys));
}

export async function collectGenerationLogStorageKeys(keys = new Set<string>()) {
    await Promise.all([
        imageLogStore.iterate((value) => { collectAnyStorageKeys(value, keys); }),
        videoLogStore.iterate((value) => { collectAnyStorageKeys(value, keys); }),
    ]);
    return keys;
}

export function getImageStorageBookkeeping() {
    return { generations: storageGenerations.size, pending: pendingCleanupKeys.size, leases: provisionalLeases.size, queues: storageKeyQueues.size };
}

function releaseStorageBookkeeping(key: string) {
    queueMicrotask(() => {
        if (!storageKeyQueues.has(key) && !pendingCleanupKeys.has(key) && !provisionalLeases.has(key) && !objectUrls.has(key)) storageGenerations.delete(key);
    });
}

function mutateStorageKey<T>(key: string, mutation: () => Promise<T>) {
    const operation = (storageKeyQueues.get(key) || Promise.resolve()).then(mutation, mutation);
    const tail = operation.then(() => undefined, () => undefined);
    storageKeyQueues.set(key, tail);
    void tail.then(() => {
        if (storageKeyQueues.get(key) !== tail) return;
        storageKeyQueues.delete(key);
        releaseStorageBookkeeping(key);
    });
    return operation;
}

function claimStorageKey(key: string) {
    const generation = (storageGenerations.get(key) || 0) + 1;
    storageGenerations.set(key, generation);
    pendingCleanupKeys.delete(key);
    return generation;
}

function registerPendingCleanup(key: string, generation: number) {
    if ((storageGenerations.get(key) || 0) === generation) pendingCleanupKeys.set(key, generation);
}

function clearPendingCleanup(key: string, generation: number) {
    if (pendingCleanupKeys.get(key) === generation) pendingCleanupKeys.delete(key);
}

function finalizeStoredImageRemoval(key: string, generation: number) {
    const url = objectUrls.get(key);
    if (url) URL.revokeObjectURL(url);
    objectUrls.delete(key);
    clearPendingCleanup(key, generation);
}

export async function uploadImage(input: string | Blob, options?: ImageReadOptions): Promise<UploadedImage> {
    if (typeof input !== "string") return storeImage(input, options);

    let blob: Blob;
    try {
        blob = await fetchImageBlob(input, options);
    } catch (error) {
        if (options?.strictLocal || options?.signal?.aborted || isNamedError(error, IMAGE_RESPONSE_ERROR) || isNamedError(error, IMAGE_TIMEOUT_ERROR) || !/^https?:\/\//i.test(input)) throw error;
        const meta = await loadImageMeta(input, options, IMAGE_REMOTE_LOAD_TIMEOUT_MS);
        if (!meta) throw error;
        return { url: input, width: meta.width, height: meta.height, bytes: 0, mimeType: "" };
    }
    throwIfInactive(options);
    return storeImage(blob, options);
}

export async function uploadRemoteImage(input: string | Blob, context: RemoteImageStorageContext): Promise<UploadedImage & { storageKey: string; provisionalLease: ProvisionalImageLease }> {
    throwIfInactive(context);
    await retryPendingCleanup(context);
    throwIfInactive(context);
    let image: UploadedImage | undefined;
    try {
        image = await uploadImage(input, { ...context, strictLocal: true });
        throwIfInactive(context);
        if (!image.storageKey) throw new Error("Remote image result is missing a local storageKey");
        if (!image.provisionalLease) throw new Error("Remote image result is missing a provisional storage lease");
        return image as UploadedImage & { storageKey: string; provisionalLease: ProvisionalImageLease };
    } catch (error) {
        if (image?.storageKey) {
            try {
                await discardRemoteImage(image);
            } catch (cleanupError) {
                throw cleanupFailure(error, cleanupError);
            }
        }
        throw error;
    }
}

async function storeImage(blob: Blob, options?: ImageReadOptions): Promise<UploadedImage> {
    const storageKey = `image:${nanoid()}`;
    const generation = claimStorageKey(storageKey);
    const url = URL.createObjectURL(blob);
    try {
        const meta = await loadImageMeta(url, options);
        if (!meta) throw new Error(i18n.t("common.imageReadFailed"));
        throwIfInactive(options);
        await mutateStorageKey(storageKey, async () => {
            await store.setItem(storageKey, blob);
            if (options?.strictLocal && (storageGenerations.get(storageKey) || 0) === generation) provisionalLeases.set(storageKey, generation);
        });
        throwIfInactive(options);
        objectUrls.set(storageKey, url);
        return { url, storageKey, ...(options?.strictLocal ? { provisionalLease: { storageKey, generation } } : {}), width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type.startsWith("image/") ? blob.type : "" };
    } catch (error) {
        URL.revokeObjectURL(url);
        try {
            await mutateStorageKey(storageKey, async () => {
                if ((storageGenerations.get(storageKey) || 0) !== generation) return;
                if (provisionalLeases.get(storageKey) === generation) provisionalLeases.delete(storageKey);
                await store.removeItem(storageKey);
            });
            clearPendingCleanup(storageKey, generation);
        } catch (cleanupError) {
            if (options?.strictLocal) {
                registerPendingCleanup(storageKey, generation);
                throw cleanupFailure(error, cleanupError);
            }
        }
        throw error;
    }
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

function cleanupFailure(originalError: unknown, cleanupError: unknown) {
    const error = new Error(`${errorMessage(originalError)}; provisional image cleanup failed: ${errorMessage(cleanupError)}`);
    error.name = "RemoteMediaCleanupError";
    return error;
}

async function retryPendingCleanup(context: RemoteImageStorageContext) {
    for (const [key, generation] of [...pendingCleanupKeys]) {
        throwIfInactive(context);
        if (pendingCleanupKeys.get(key) !== generation) continue;
        await mutateStorageKey(key, async () => {
            throwIfInactive(context);
            if ((storageGenerations.get(key) || 0) !== generation || pendingCleanupKeys.get(key) !== generation) return;
            if (provisionalLeases.get(key) === generation) return;
            if (context.isStorageKeyReferenced?.(key)) {
                pendingCleanupKeys.delete(key);
                return;
            }
            throwIfInactive(context);
            if ((storageGenerations.get(key) || 0) !== generation || provisionalLeases.get(key) === generation) return;
            await store.removeItem(key);
            finalizeStoredImageRemoval(key, generation);
        });
    }
}

export function releaseRemoteImageLease(image: UploadedImage) {
    const lease = image.provisionalLease;
    if (lease && provisionalLeases.get(lease.storageKey) === lease.generation) provisionalLeases.delete(lease.storageKey);
}

export async function discardRemoteImage(image: UploadedImage) {
    const lease = image.provisionalLease;
    if (!lease) return image.storageKey ? deleteStoredImages([image.storageKey]) : undefined;
    const { storageKey, generation } = lease;
    try {
        await mutateStorageKey(storageKey, async () => {
            if ((storageGenerations.get(storageKey) || 0) !== generation || provisionalLeases.get(storageKey) !== generation) return;
            provisionalLeases.delete(storageKey);
            await store.removeItem(storageKey);
            finalizeStoredImageRemoval(storageKey, generation);
        });
    } catch (error) {
        if (provisionalLeases.get(storageKey) === generation) provisionalLeases.delete(storageKey);
        registerPendingCleanup(storageKey, generation);
        throw error;
    }
}

async function fetchImageBlob(url: string, options?: ImageReadOptions) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener("abort", abort, { once: true });
    const timer = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, IMAGE_DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw namedError(IMAGE_RESPONSE_ERROR);
        return await response.blob();
    } catch (error) {
        if (timedOut) throw namedError(IMAGE_TIMEOUT_ERROR);
        if (options?.signal?.aborted) throw abortReason(options.signal);
        throw error;
    } finally {
        window.clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
    }
}

export function loadImageMeta(url: string, options?: ImageReadOptions, timeoutMs = IMAGE_DECODE_TIMEOUT_MS) {
    return new Promise<{ width: number; height: number } | null>((resolve, reject) => {
        if (options?.signal?.aborted) return reject(abortReason(options.signal));
        const image = new Image();
        let settled = false;
        const finish = (value: { width: number; height: number } | null) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            options?.signal?.removeEventListener("abort", abort);
            image.onload = null;
            image.onerror = null;
            resolve(value);
        };
        const abort = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            image.onload = null;
            image.onerror = null;
            reject(abortReason(options!.signal!));
        };
        const timer = window.setTimeout(() => finish(null), timeoutMs);
        options?.signal?.addEventListener("abort", abort, { once: true });
        image.onload = () => finish(image.naturalWidth && image.naturalHeight ? { width: image.naturalWidth, height: image.naturalHeight } : null);
        image.onerror = () => finish(null);
        image.src = url;
    });
}

function namedError(name: string) {
    const error = new Error(i18n.t("common.imageReadFailed"));
    error.name = name;
    return error;
}

function isNamedError(error: unknown, name: string) {
    return error instanceof Error && error.name === name;
}

function abortReason(signal: AbortSignal) {
    return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw abortReason(signal);
}

function throwIfInactive(options?: { signal?: AbortSignal; isActive?: () => boolean }) {
    throwIfAborted(options?.signal);
    if (options?.isActive && !options.isActive()) throw options.signal?.reason instanceof Error ? options.signal.reason : new DOMException("Remote media task stopped", "AbortError");
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getImageBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    const generation = claimStorageKey(storageKey);
    try {
        await mutateStorageKey(storageKey, () => store.setItem(storageKey, blob));
    } catch (error) {
        registerPendingCleanup(storageKey, generation);
        throw error;
    }
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }, options?: ImageReadOptions) {
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await fetchImageBlob(url, options));
}

export async function deleteStoredImages(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const generation = storageGenerations.get(key) || 0;
            try {
                await mutateStorageKey(key, async () => {
                    if ((storageGenerations.get(key) || 0) !== generation) return;
                    if (provisionalLeases.get(key) === generation) provisionalLeases.delete(key);
                    await store.removeItem(key);
                    finalizeStoredImageRemoval(key, generation);
                });
            } catch (error) {
                registerPendingCleanup(key, generation);
                throw error;
            }
        }),
    );
}

async function isImageStorageKeyReferenced(key: string, latestReferences: LatestStorageReferences) {
    return (await collectGenerationLogStorageKeys()).has(key) || collectImageStorageKeys(latestReferences()).has(key);
}

export async function cleanupUnusedImages(usedData: unknown, latestReferences: LatestStorageReferences = () => usedData) {
    const usedKeys = collectImageStorageKeys(usedData);
    await collectGenerationLogStorageKeys(usedKeys);
    const unused: Array<{ key: string; generation: number }> = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push({ key, generation: storageGenerations.get(key) || 0 });
    });
    await Promise.all(unused.map(async ({ key, generation }) => {
        try {
            await mutateStorageKey(key, async () => {
                if ((storageGenerations.get(key) || 0) !== generation) return;
                if (provisionalLeases.get(key) === generation) return;
                if (await isImageStorageKeyReferenced(key, latestReferences)) return;
                if ((storageGenerations.get(key) || 0) !== generation) return;
                if (provisionalLeases.get(key) === generation) return;
                await store.removeItem(key);
                finalizeStoredImageRemoval(key, generation);
            });
        } catch (error) {
            registerPendingCleanup(key, generation);
            throw error;
        }
    }));
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        reader.readAsDataURL(blob);
    });
}
