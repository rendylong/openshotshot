import localforage from "localforage";
import { nanoid } from "nanoid";

import { downloadRemoteMediaBlob } from "@/services/remote-media-download";
import { collectGenerationLogStorageKeys } from "@/services/image-storage";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";

export type ProvisionalMediaLease = { storageKey: string; generation: number };
export type UploadedFile = { url: string; storageKey: string; provisionalLease?: ProvisionalMediaLease; assetRef?: CanvasAssetRef; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };
export type RemoteMediaStorageContext = { signal: AbortSignal; isActive: () => boolean; isStorageKeyReferenced?: (key: string) => boolean };
type LatestStorageReferences = () => unknown;

const store = localforage.createInstance({ name: "shotshot", storeName: "media_files" });
const objectUrls = new Map<string, string>();
const pendingCleanupKeys = new Map<string, number>();
const storageGenerations = new Map<string, number>();
const provisionalLeases = new Map<string, number>();
const storageKeyQueues = new Map<string, Promise<void>>();

export function getMediaStorageBookkeeping() {
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

function finalizeStoredMediaRemoval(key: string, generation: number) {
    const url = objectUrls.get(key);
    if (url) URL.revokeObjectURL(url);
    objectUrls.delete(key);
    clearPendingCleanup(key, generation);
}

export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    const storageKey = `${prefix}:${nanoid()}`;
    claimStorageKey(storageKey);
    await mutateStorageKey(storageKey, () => store.setItem(storageKey, blob));
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const meta = blob.type.startsWith("video/") ? await readVideoMeta(url) : blob.type.startsWith("audio/") ? await readAudioMeta(url) : {};
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}

function remoteStorageAbort(context: RemoteMediaStorageContext) {
    return context.signal.reason instanceof Error ? context.signal.reason : new DOMException("Remote media task stopped", "AbortError");
}

function requireRemoteStorageActive(context: RemoteMediaStorageContext) {
    if (context.signal.aborted || !context.isActive()) throw remoteStorageAbort(context);
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

function cleanupFailure(originalError: unknown, cleanupError: unknown) {
    const error = new Error(`${errorMessage(originalError)}; provisional media cleanup failed: ${errorMessage(cleanupError)}`);
    error.name = "RemoteMediaCleanupError";
    return error;
}

async function retryPendingCleanup(context: RemoteMediaStorageContext) {
    for (const [key, generation] of [...pendingCleanupKeys]) {
        requireRemoteStorageActive(context);
        if (pendingCleanupKeys.get(key) !== generation) continue;
        await mutateStorageKey(key, async () => {
            requireRemoteStorageActive(context);
            if ((storageGenerations.get(key) || 0) !== generation || pendingCleanupKeys.get(key) !== generation) return;
            if (provisionalLeases.get(key) === generation) return;
            if (context.isStorageKeyReferenced?.(key)) {
                pendingCleanupKeys.delete(key);
                return;
            }
            requireRemoteStorageActive(context);
            if ((storageGenerations.get(key) || 0) !== generation || provisionalLeases.get(key) === generation) return;
            await store.removeItem(key);
            finalizeStoredMediaRemoval(key, generation);
        });
    }
}

async function cleanupProvisionalMedia(storageKey: string, generation: number, originalError: unknown) {
    try {
        await mutateStorageKey(storageKey, async () => {
            if ((storageGenerations.get(storageKey) || 0) !== generation) return;
            if (provisionalLeases.get(storageKey) === generation) provisionalLeases.delete(storageKey);
            await store.removeItem(storageKey);
        });
        clearPendingCleanup(storageKey, generation);
    } catch (cleanupError) {
        registerPendingCleanup(storageKey, generation);
        throw cleanupFailure(originalError, cleanupError);
    }
}

export async function uploadRemoteMediaFile(input: string | Blob, prefix: string, context: RemoteMediaStorageContext): Promise<UploadedFile> {
    requireRemoteStorageActive(context);
    await retryPendingCleanup(context);
    requireRemoteStorageActive(context);
    let blob: Blob;
    if (typeof input === "string") {
        blob = await downloadRemoteMediaBlob(input, context.signal);
        requireRemoteStorageActive(context);
    } else blob = input;
    const storageKey = `${prefix}:${nanoid()}`;
    const generation = claimStorageKey(storageKey);
    let url = "";
    try {
        requireRemoteStorageActive(context);
        await mutateStorageKey(storageKey, async () => {
            await store.setItem(storageKey, blob);
            if ((storageGenerations.get(storageKey) || 0) === generation) provisionalLeases.set(storageKey, generation);
        });
        requireRemoteStorageActive(context);
        url = URL.createObjectURL(blob);
        objectUrls.set(storageKey, url);
        const meta = blob.type.startsWith("video/") ? await readVideoMeta(url, context.signal) : blob.type.startsWith("audio/") ? await readAudioMeta(url, context.signal) : {};
        requireRemoteStorageActive(context);
        return { url, storageKey, provisionalLease: { storageKey, generation }, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
    } catch (error) {
        if (url) URL.revokeObjectURL(url);
        objectUrls.delete(storageKey);
        await cleanupProvisionalMedia(storageKey, generation, error);
        throw error;
    }
}

export function releaseRemoteMediaLease(file: UploadedFile) {
    const lease = file.provisionalLease;
    if (lease && provisionalLeases.get(lease.storageKey) === lease.generation) provisionalLeases.delete(lease.storageKey);
}

export async function discardRemoteMedia(file: UploadedFile) {
    const lease = file.provisionalLease;
    if (!lease) return deleteStoredMedia([file.storageKey]);
    const { storageKey, generation } = lease;
    try {
        await mutateStorageKey(storageKey, async () => {
            if ((storageGenerations.get(storageKey) || 0) !== generation || provisionalLeases.get(storageKey) !== generation) return;
            provisionalLeases.delete(storageKey);
            await store.removeItem(storageKey);
            finalizeStoredMediaRemoval(storageKey, generation);
        });
    } catch (error) {
        if (provisionalLeases.get(storageKey) === generation) provisionalLeases.delete(storageKey);
        registerPendingCleanup(storageKey, generation);
        throw error;
    }
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getMediaBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
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

export async function deleteStoredMedia(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const generation = storageGenerations.get(key) || 0;
            try {
                await mutateStorageKey(key, async () => {
                    if ((storageGenerations.get(key) || 0) !== generation) return;
                    if (provisionalLeases.get(key) === generation) provisionalLeases.delete(key);
                    await store.removeItem(key);
                    finalizeStoredMediaRemoval(key, generation);
                });
            } catch (error) {
                registerPendingCleanup(key, generation);
                throw error;
            }
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown, latestReferences: LatestStorageReferences = () => usedData) {
    const usedKeys = collectMediaStorageKeys(usedData);
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
                if ((await collectGenerationLogStorageKeys()).has(key) || collectMediaStorageKeys(latestReferences()).has(key)) return;
                if ((storageGenerations.get(key) || 0) !== generation) return;
                if (provisionalLeases.get(key) === generation) return;
                await store.removeItem(key);
                finalizeStoredMediaRemoval(key, generation);
            });
        } catch (error) {
            registerPendingCleanup(key, generation);
            throw error;
        }
    }));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

export function readVideoMeta(url: string, signal?: AbortSignal) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve, reject) => {
        const video = document.createElement("video");
        let settled = false;
        const cleanup = () => {
            signal?.removeEventListener("abort", abort);
            video.onloadedmetadata = null;
            video.onerror = null;
        };
        const done = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        };
        const abort = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
        };
        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort, { once: true });
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = url;
    });
}

export function readAudioMeta(url: string, signal?: AbortSignal) {
    return new Promise<{ durationMs?: number }>((resolve, reject) => {
        const audio = document.createElement("audio");
        let settled = false;
        const cleanup = () => {
            signal?.removeEventListener("abort", abort);
            audio.onloadedmetadata = null;
            audio.onerror = null;
        };
        const done = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        };
        const abort = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
        };
        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort, { once: true });
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}
