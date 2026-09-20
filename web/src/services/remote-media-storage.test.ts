import { beforeEach, describe, expect, test, vi } from "vitest";

const stores = vi.hoisted(() => new Map<string, { setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn>; getItem: ReturnType<typeof vi.fn>; iterate: ReturnType<typeof vi.fn> }>());
const nextStorageId = vi.hoisted(() => vi.fn(() => "strict-key"));
const storeCanvasImage = vi.hoisted(() => vi.fn());
const storeCanvasMedia = vi.hoisted(() => vi.fn());

vi.mock("localforage", () => ({
    default: {
        createInstance: ({ storeName }: { storeName: string }) => {
            const store = { setItem: vi.fn(), removeItem: vi.fn(), getItem: vi.fn(), iterate: vi.fn() };
            stores.set(storeName, store);
            return store;
        },
    },
}));
vi.mock("nanoid", () => ({ nanoid: nextStorageId }));
vi.mock("@/services/project-asset-storage", () => ({ storeCanvasImage, storeCanvasMedia }));

import { cleanupUnusedMedia, deleteStoredMedia, discardRemoteMedia, getMediaBlob, getMediaStorageBookkeeping, releaseRemoteMediaLease, resolveMediaUrl, setMediaBlob, uploadMediaFile, uploadRemoteMediaFile } from "@/services/file-storage";
import { cleanupUnusedImages, deleteStoredImages, discardRemoteImage, getImageBlob, getImageStorageBookkeeping, releaseRemoteImageLease, resolveImageUrl, setImageBlob, uploadRemoteImage } from "@/services/image-storage";
import { normalizePluginAudio, storeGeneratedAudio, storeRemoteGeneratedAudio } from "@/services/api/audio";
import { storeGeneratedVideo, storeRemoteGeneratedVideo } from "@/services/api/video";
import type { ProjectAssetWriteContext } from "@/services/project-asset-storage";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

beforeEach(() => {
    nextStorageId.mockReset().mockReturnValue("strict-key");
    storeCanvasImage.mockReset();
    storeCanvasMedia.mockReset();
    stores.forEach((store) => {
        Object.values(store).forEach((mock) => mock.mockReset());
        store.setItem.mockResolvedValue(undefined);
        store.removeItem.mockResolvedValue(undefined);
    });
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:strict"), revokeObjectURL: vi.fn() });
    vi.stubGlobal("Image", class {
        naturalWidth = 640;
        naturalHeight = 480;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });
});

describe("strict remote media persistence", () => {
    test("removes a provisional video key when abort happens during localforage setItem", async () => {
        const mediaStore = stores.get("media_files")!;
        const writing = deferred<void>();
        mediaStore.setItem.mockReturnValueOnce(writing.promise);
        const controller = new AbortController();
        let active = true;
        const storing = storeRemoteGeneratedVideo({ blob: new Blob(["video"], { type: "video/mp4" }) }, { signal: controller.signal, isActive: () => active });
        await vi.waitFor(() => expect(mediaStore.setItem).toHaveBeenCalledWith("video:strict-key", expect.any(Blob)));
        active = false;
        controller.abort(new DOMException("stopped", "AbortError"));
        writing.resolve();
        await expect(storing).rejects.toHaveProperty("name", "AbortError");
        expect(mediaStore.removeItem).toHaveBeenCalledWith("video:strict-key");
    });

    test("removes a provisional image key when abort happens during localforage setItem", async () => {
        const imageStore = stores.get("image_files")!;
        const writing = deferred<void>();
        imageStore.setItem.mockReturnValueOnce(writing.promise);
        const controller = new AbortController();
        let active = true;
        const storing = uploadRemoteImage(new Blob(["image"], { type: "image/png" }), { signal: controller.signal, isActive: () => active });
        await vi.waitFor(() => expect(imageStore.setItem).toHaveBeenCalledWith("image:strict-key", expect.any(Blob)));
        active = false;
        controller.abort(new DOMException("stopped", "AbortError"));
        writing.resolve();
        await expect(storing).rejects.toHaveProperty("name", "AbortError");
        expect(imageStore.removeItem).toHaveBeenCalledWith("image:strict-key");
    });

    test("cleans an image stored just before the remote wrapper becomes inactive", async () => {
        const imageStore = stores.get("image_files")!;
        const isActive = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false);
        await expect(uploadRemoteImage(new Blob(["image"], { type: "image/png" }), { signal: new AbortController().signal, isActive })).rejects.toHaveProperty("name", "AbortError");
        expect(imageStore.setItem).toHaveBeenCalledWith("image:strict-key", expect.any(Blob));
        expect(imageStore.removeItem).toHaveBeenCalledWith("image:strict-key");
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:strict");
    });

    test("removes a provisional audio key when abort happens during localforage setItem", async () => {
        const mediaStore = stores.get("media_files")!;
        const writing = deferred<void>();
        mediaStore.setItem.mockReturnValueOnce(writing.promise);
        const controller = new AbortController();
        let active = true;
        const storing = storeRemoteGeneratedAudio(new Blob(["audio"], { type: "audio/mpeg" }), "mp3", { signal: controller.signal, isActive: () => active });
        await vi.waitFor(() => expect(mediaStore.setItem).toHaveBeenCalledWith("audio:strict-key", expect.any(Blob)));
        active = false;
        controller.abort(new DOMException("stopped", "AbortError"));
        writing.resolve();
        await expect(storing).rejects.toHaveProperty("name", "AbortError");
        expect(mediaStore.removeItem).toHaveBeenCalledWith("audio:strict-key");
    });

    test("audio normalization observes the remote task signal before reading the response body", async () => {
        const response = deferred<Response>();
        vi.stubGlobal("fetch", vi.fn(() => response.promise));
        const controller = new AbortController();
        let active = true;
        const normalizing = normalizePluginAudio("https://example.test/audio.mp3", "mp3", { signal: controller.signal, isActive: () => active });
        active = false;
        controller.abort(new DOMException("stopped", "AbortError"));
        response.resolve({ ok: true, blob: vi.fn() } as unknown as Response);
        await expect(normalizing).rejects.toHaveProperty("name", "AbortError");
    });

    test("aborts strict video metadata that never resolves and removes its provisional key", async () => {
        const mediaStore = stores.get("media_files")!;
        const originalCreateElement = document.createElement.bind(document);
        vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => tagName === "video" ? { videoWidth: 0, videoHeight: 0, duration: Number.NaN, onloadedmetadata: null, onerror: null, src: "" } : originalCreateElement(tagName)) as typeof document.createElement);
        const controller = new AbortController();
        const storing = storeRemoteGeneratedVideo({ blob: new Blob(["video"], { type: "video/mp4" }) }, { signal: controller.signal, isActive: () => !controller.signal.aborted });
        await vi.waitFor(() => expect(mediaStore.setItem).toHaveBeenCalled());
        controller.abort(new DOMException("stopped", "AbortError"));
        await expect(storing).rejects.toHaveProperty("name", "AbortError");
        expect(mediaStore.removeItem).toHaveBeenCalledWith("video:strict-key");
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:strict");
    });

    test("aborts strict audio metadata that never resolves and removes its provisional key", async () => {
        const mediaStore = stores.get("media_files")!;
        const originalCreateElement = document.createElement.bind(document);
        vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => tagName === "audio" ? { duration: Number.NaN, onloadedmetadata: null, onerror: null, src: "" } : originalCreateElement(tagName)) as typeof document.createElement);
        const controller = new AbortController();
        const storing = storeRemoteGeneratedAudio(new Blob(["audio"], { type: "audio/mpeg" }), "mp3", { signal: controller.signal, isActive: () => !controller.signal.aborted });
        await vi.waitFor(() => expect(mediaStore.setItem).toHaveBeenCalled());
        controller.abort(new DOMException("stopped", "AbortError"));
        await expect(storing).rejects.toHaveProperty("name", "AbortError");
        expect(mediaStore.removeItem).toHaveBeenCalledWith("audio:strict-key");
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:strict");
    });

    test("surfaces provisional cleanup failure and retries it before the next strict write", async () => {
        const mediaStore = stores.get("media_files")!;
        const writing = deferred<void>();
        mediaStore.setItem.mockReturnValueOnce(writing.promise).mockResolvedValue(undefined);
        mediaStore.removeItem.mockRejectedValueOnce(new Error("cleanup unavailable")).mockResolvedValue(undefined);
        const controller = new AbortController();
        let active = true;
        const first = uploadRemoteMediaFile(new Blob(["first"], { type: "application/octet-stream" }), "file", { signal: controller.signal, isActive: () => active });
        await vi.waitFor(() => expect(mediaStore.setItem).toHaveBeenCalledTimes(1));
        active = false;
        controller.abort(new DOMException("stopped", "AbortError"));
        writing.resolve();
        await expect(first).rejects.toThrow(/stopped.*cleanup unavailable|cleanup unavailable.*stopped/);
        const secondContext = { signal: new AbortController().signal, isActive: () => true };
        await expect(uploadRemoteMediaFile(new Blob(["second"], { type: "application/octet-stream" }), "file", secondContext)).resolves.toMatchObject({ storageKey: "file:strict-key" });
        expect(mediaStore.removeItem).toHaveBeenCalledTimes(2);
        expect(mediaStore.removeItem).toHaveBeenLastCalledWith("file:strict-key");
    });

    test("registers a failed committed-image deletion and retries it before strict storage", async () => {
        const imageStore = stores.get("image_files")!;
        imageStore.removeItem.mockRejectedValueOnce(new Error("cleanup unavailable")).mockResolvedValue(undefined);
        await expect(deleteStoredImages(["image:strict-key"])).rejects.toThrow("cleanup unavailable");
        await expect(uploadRemoteImage(new Blob(["next"], { type: "image/png" }), { signal: new AbortController().signal, isActive: () => true })).resolves.toMatchObject({ storageKey: "image:strict-key" });
        expect(imageStore.removeItem).toHaveBeenCalledTimes(2);
        expect(imageStore.removeItem).toHaveBeenLastCalledWith("image:strict-key");
    });

    test("registers a failed committed-media deletion and retries it before strict storage", async () => {
        const mediaStore = stores.get("media_files")!;
        mediaStore.removeItem.mockRejectedValueOnce(new Error("cleanup unavailable")).mockResolvedValue(undefined);
        await expect(deleteStoredMedia(["video:strict-key"])).rejects.toThrow("cleanup unavailable");
        await expect(uploadRemoteMediaFile(new Blob(["next"], { type: "application/octet-stream" }), "file", { signal: new AbortController().signal, isActive: () => true })).resolves.toMatchObject({ storageKey: "file:strict-key" });
        expect(mediaStore.removeItem).toHaveBeenCalledTimes(2);
        expect(mediaStore.removeItem).toHaveBeenLastCalledWith("video:strict-key");
    });

    test("does not retry pending image cleanup after the task has stopped", async () => {
        const imageStore = stores.get("image_files")!;
        imageStore.removeItem.mockRejectedValueOnce(new Error("cleanup unavailable")).mockResolvedValue(undefined);
        await expect(deleteStoredImages(["image:strict-key"])).rejects.toThrow("cleanup unavailable");
        const controller = new AbortController();
        controller.abort(new DOMException("stopped", "AbortError"));

        await expect(uploadRemoteImage(new Blob(["stopped"], { type: "image/png" }), { signal: controller.signal, isActive: () => false })).rejects.toHaveProperty("name", "AbortError");
        expect(imageStore.removeItem).toHaveBeenCalledTimes(1);
        await setImageBlob("image:strict-key", new Blob(["claimed"], { type: "image/png" }));
    });

    test("explicit image and media writes claim a pending cleanup key", async () => {
        const imageStore = stores.get("image_files")!;
        const mediaStore = stores.get("media_files")!;
        imageStore.removeItem.mockRejectedValueOnce(new Error("image cleanup unavailable")).mockResolvedValue(undefined);
        mediaStore.removeItem.mockRejectedValueOnce(new Error("media cleanup unavailable")).mockResolvedValue(undefined);
        await expect(deleteStoredImages(["image:strict-key"])).rejects.toThrow("image cleanup unavailable");
        await expect(deleteStoredMedia(["file:strict-key"])).rejects.toThrow("media cleanup unavailable");
        await setImageBlob("image:strict-key", new Blob(["owned image"], { type: "image/png" }));
        await setMediaBlob("file:strict-key", new Blob(["owned media"], { type: "application/octet-stream" }));

        await uploadRemoteImage(new Blob(["next image"], { type: "image/png" }), { signal: new AbortController().signal, isActive: () => true });
        await uploadRemoteMediaFile(new Blob(["next media"], { type: "application/octet-stream" }), "file", { signal: new AbortController().signal, isActive: () => true });
        expect(imageStore.removeItem).toHaveBeenCalledTimes(1);
        expect(mediaStore.removeItem).toHaveBeenCalledTimes(1);
    });

    test("does not retry a pending key that is referenced by a project", async () => {
        const imageStore = stores.get("image_files")!;
        imageStore.removeItem.mockRejectedValueOnce(new Error("cleanup unavailable")).mockResolvedValue(undefined);
        await expect(deleteStoredImages(["image:strict-key"])).rejects.toThrow("cleanup unavailable");

        await uploadRemoteImage(new Blob(["next"], { type: "image/png" }), {
            signal: new AbortController().signal,
            isActive: () => true,
            isStorageKeyReferenced: (key) => key === "image:strict-key",
        });
        expect(imageStore.removeItem).toHaveBeenCalledTimes(1);
    });

    test("serializes an old image cleanup before a same-key replacement generation", async () => {
        const imageStore = stores.get("image_files")!;
        const blobs = new Map<string, Blob>([["image:strict-key", new Blob(["old"], { type: "image/png" })]]);
        imageStore.setItem.mockImplementation(async (key: string, blob: Blob) => { blobs.set(key, blob); });
        imageStore.removeItem.mockRejectedValueOnce(new Error("cleanup unavailable"));
        await expect(deleteStoredImages(["image:strict-key"])).rejects.toThrow("cleanup unavailable");
        const oldRemove = deferred<void>();
        imageStore.removeItem.mockImplementationOnce(async (key: string) => {
            await oldRemove.promise;
            blobs.delete(key);
        }).mockImplementation(async (key: string) => { blobs.delete(key); });
        nextStorageId.mockReturnValue("next-key");
        let referenced = false;
        const retrying = uploadRemoteImage(new Blob(["strict"], { type: "image/png" }), {
            signal: new AbortController().signal,
            isActive: () => true,
            isStorageKeyReferenced: (key) => referenced && key === "image:strict-key",
        });
        await vi.waitFor(() => expect(imageStore.removeItem).toHaveBeenCalledTimes(2));
        const replacement = new Blob(["replacement"], { type: "image/png" });
        const setting = setImageBlob("image:strict-key", replacement);

        oldRemove.resolve();
        await setting;
        referenced = true;
        await retrying;

        expect(blobs.get("image:strict-key")).toBe(replacement);
        expect(imageStore.removeItem).toHaveBeenCalledTimes(2);
    });

    test("serializes an old media cleanup before a same-key replacement generation", async () => {
        const mediaStore = stores.get("media_files")!;
        const blobs = new Map<string, Blob>([["video:strict-key", new Blob(["old"], { type: "video/mp4" })]]);
        mediaStore.setItem.mockImplementation(async (key: string, blob: Blob) => { blobs.set(key, blob); });
        mediaStore.removeItem.mockRejectedValueOnce(new Error("cleanup unavailable"));
        await expect(deleteStoredMedia(["video:strict-key"])).rejects.toThrow("cleanup unavailable");
        const oldRemove = deferred<void>();
        mediaStore.removeItem.mockImplementationOnce(async (key: string) => {
            await oldRemove.promise;
            blobs.delete(key);
        }).mockImplementation(async (key: string) => { blobs.delete(key); });
        nextStorageId.mockReturnValue("next-key");
        let referenced = false;
        const retrying = uploadRemoteMediaFile(new Blob(["strict"], { type: "application/octet-stream" }), "file", {
            signal: new AbortController().signal,
            isActive: () => true,
            isStorageKeyReferenced: (key) => referenced && key === "video:strict-key",
        });
        await vi.waitFor(() => expect(mediaStore.removeItem).toHaveBeenCalledTimes(2));
        const replacement = new Blob(["replacement"], { type: "video/mp4" });
        const setting = setMediaBlob("video:strict-key", replacement);

        oldRemove.resolve();
        await setting;
        referenced = true;
        await retrying;

        expect(blobs.get("video:strict-key")).toBe(replacement);
        expect(mediaStore.removeItem).toHaveBeenCalledTimes(2);
    });

    test("rechecks activity before each pending cleanup key", async () => {
        const imageStore = stores.get("image_files")!;
        imageStore.removeItem.mockRejectedValue(new Error("cleanup unavailable"));
        await expect(deleteStoredImages(["image:first", "image:second"])).rejects.toThrow("cleanup unavailable");
        imageStore.removeItem.mockReset();
        const firstRemove = deferred<void>();
        imageStore.removeItem.mockImplementationOnce(() => firstRemove.promise).mockResolvedValue(undefined);
        const controller = new AbortController();
        const retrying = uploadRemoteImage(new Blob(["next"], { type: "image/png" }), {
            signal: controller.signal,
            isActive: () => !controller.signal.aborted,
        });
        await vi.waitFor(() => expect(imageStore.removeItem).toHaveBeenCalledWith("image:first"));
        controller.abort(new DOMException("stopped", "AbortError"));
        firstRemove.resolve();

        await expect(retrying).rejects.toHaveProperty("name", "AbortError");
        expect(imageStore.removeItem).not.toHaveBeenCalledWith("image:second");
        await setImageBlob("image:second", new Blob(["claimed"], { type: "image/png" }));
    });

    test("does not start a pending cleanup remove when abort happens synchronously after the call", async () => {
        const imageStore = stores.get("image_files")!;
        imageStore.removeItem.mockRejectedValueOnce(new Error("cleanup unavailable"));
        await expect(deleteStoredImages(["image:sync-abort"])).rejects.toThrow("cleanup unavailable");
        imageStore.removeItem.mockReset().mockResolvedValue(undefined);
        const controller = new AbortController();

        const retrying = uploadRemoteImage(new Blob(["next"], { type: "image/png" }), {
            signal: controller.signal,
            isActive: () => !controller.signal.aborted,
        });
        controller.abort(new DOMException("stopped", "AbortError"));

        await expect(retrying).rejects.toHaveProperty("name", "AbortError");
        expect(imageStore.removeItem).not.toHaveBeenCalled();
        await setImageBlob("image:sync-abort", new Blob(["claimed"], { type: "image/png" }));
    });

    test("rechecks live references inside a blocked media cleanup mutation", async () => {
        const mediaStore = stores.get("media_files")!;
        mediaStore.removeItem.mockRejectedValueOnce(new Error("cleanup unavailable"));
        await expect(deleteStoredMedia(["video:blocked-reference"])).rejects.toThrow("cleanup unavailable");
        mediaStore.removeItem.mockReset();
        const blocked = deferred<void>();
        mediaStore.removeItem.mockImplementationOnce(() => blocked.promise).mockResolvedValue(undefined);
        const blockingDelete = deleteStoredMedia(["video:blocked-reference"]);
        const blockingFailure = expect(blockingDelete).rejects.toThrow("still unavailable");
        await vi.waitFor(() => expect(mediaStore.removeItem).toHaveBeenCalledTimes(1));
        nextStorageId.mockReturnValue("next-key");
        let referenced = false;
        const retrying = uploadRemoteMediaFile(new Blob(["next"], { type: "application/octet-stream" }), "file", {
            signal: new AbortController().signal,
            isActive: () => true,
            isStorageKeyReferenced: (key) => referenced && key === "video:blocked-reference",
        });
        referenced = true;
        blocked.reject(new Error("still unavailable"));

        await blockingFailure;
        await retrying;
        expect(mediaStore.removeItem).toHaveBeenCalledTimes(1);
    });

    test("unused image cleanup preserves a same-key restore and newly added reference", async () => {
        const imageStore = stores.get("image_files")!;
        const imageLogStore = stores.get("image_generation_logs")!;
        const videoLogStore = stores.get("video_generation_logs")!;
        const blobs = new Map<string, Blob>();
        imageStore.setItem.mockImplementation(async (key: string, blob: Blob) => { blobs.set(key, blob); });
        imageStore.removeItem.mockImplementation(async (key: string) => { blobs.delete(key); });
        imageLogStore.iterate.mockResolvedValue(undefined);
        videoLogStore.iterate.mockResolvedValue(undefined);
        const key = "image:restored-during-scan";
        await setImageBlob(key, new Blob(["old"], { type: "image/png" }));
        const scanning = deferred<void>();
        imageStore.iterate.mockImplementationOnce(async (visitor: (value: Blob, key: string) => void) => {
            await scanning.promise;
            visitor(blobs.get(key)!, key);
        });
        let referenced = false;
        const cleanup = cleanupUnusedImages({}, () => referenced ? { projects: [{ storageKey: key }] } : {});
        await vi.waitFor(() => expect(imageStore.iterate).toHaveBeenCalled());
        const replacement = new Blob(["replacement"], { type: "image/png" });
        await setImageBlob(key, replacement);
        referenced = true;
        scanning.resolve();

        await cleanup;
        expect(blobs.get(key)).toBe(replacement);
        expect(imageStore.removeItem).not.toHaveBeenCalledWith(key);
    });

    test("unused media cleanup preserves a same-key restore and newly added reference", async () => {
        const mediaStore = stores.get("media_files")!;
        const blobs = new Map<string, Blob>();
        mediaStore.setItem.mockImplementation(async (key: string, blob: Blob) => { blobs.set(key, blob); });
        mediaStore.removeItem.mockImplementation(async (key: string) => { blobs.delete(key); });
        const key = "video:restored-during-scan";
        await setMediaBlob(key, new Blob(["old"], { type: "video/mp4" }));
        const scanning = deferred<void>();
        mediaStore.iterate.mockImplementationOnce(async (visitor: (value: Blob, key: string) => void) => {
            await scanning.promise;
            visitor(blobs.get(key)!, key);
        });
        let referenced = false;
        const cleanup = cleanupUnusedMedia({}, () => referenced ? { assets: [{ storageKey: key }] } : {});
        await vi.waitFor(() => expect(mediaStore.iterate).toHaveBeenCalled());
        const replacement = new Blob(["replacement"], { type: "video/mp4" });
        await setMediaBlob(key, replacement);
        referenced = true;
        scanning.resolve();

        await cleanup;
        expect(blobs.get(key)).toBe(replacement);
        expect(mediaStore.removeItem).not.toHaveBeenCalledWith(key);
    });

    test("unused media cleanup rechecks generation-log references before removal", async () => {
        const mediaStore = stores.get("media_files")!;
        const imageLogStore = stores.get("image_generation_logs")!;
        const videoLogStore = stores.get("video_generation_logs")!;
        const key = "video:log-reference";
        await setMediaBlob(key, new Blob(["video"], { type: "video/mp4" }));
        mediaStore.iterate.mockImplementationOnce(async (visitor: (value: Blob, key: string) => void) => {
            visitor(new Blob(["video"], { type: "video/mp4" }), key);
        });
        let imageLogReads = 0;
        imageLogStore.iterate.mockImplementation(async (visitor: (value: unknown) => void) => {
            imageLogReads += 1;
            if (imageLogReads > 1) visitor({ output: { storageKey: key } });
        });
        videoLogStore.iterate.mockResolvedValue(undefined);

        await cleanupUnusedMedia({}, () => ({}));

        expect(mediaStore.removeItem).not.toHaveBeenCalledWith(key);
    });

    test("releases generation bookkeeping after successful image and media deletion", async () => {
        const beforeImage = getImageStorageBookkeeping();
        const beforeMedia = getMediaStorageBookkeeping();
        await setImageBlob("image:released-bookkeeping", new Blob(["image"], { type: "image/png" }));
        await setMediaBlob("video:released-bookkeeping", new Blob(["video"], { type: "video/mp4" }));
        await deleteStoredImages(["image:released-bookkeeping"]);
        await deleteStoredMedia(["video:released-bookkeeping"]);
        await Promise.resolve();
        await Promise.resolve();

        expect(getImageStorageBookkeeping()).toEqual(beforeImage);
        expect(getMediaStorageBookkeeping()).toEqual(beforeMedia);
    });

    test("does not let an old image finalizer release or delete a same-key lease generation", async () => {
        const imageStore = stores.get("image_files")!;
        const blobs = new Map<string, Blob>();
        imageStore.setItem.mockImplementation(async (key: string, blob: Blob) => { blobs.set(key, blob); });
        imageStore.getItem.mockImplementation(async (key: string) => blobs.get(key));
        imageStore.removeItem.mockImplementation(async (key: string) => { blobs.delete(key); });
        const oldImage = await uploadRemoteImage(new Blob(["old"], { type: "image/png" }), { signal: new AbortController().signal, isActive: () => true });
        const replacement = new Blob(["replacement"], { type: "image/png" });
        const newImage = await uploadRemoteImage(replacement, { signal: new AbortController().signal, isActive: () => true });
        const leased = getImageStorageBookkeeping().leases;

        await discardRemoteImage(oldImage);
        await cleanupUnusedImages({}, () => ({}));

        expect(await getImageBlob(newImage.storageKey)).toBe(replacement);
        expect(getImageStorageBookkeeping().leases).toBe(leased);
        releaseRemoteImageLease(newImage);
        expect(getImageStorageBookkeeping().leases).toBe(leased - 1);
    });

    test("does not let an old media finalizer release or delete a same-key lease generation", async () => {
        const mediaStore = stores.get("media_files")!;
        const blobs = new Map<string, Blob>();
        mediaStore.setItem.mockImplementation(async (key: string, blob: Blob) => { blobs.set(key, blob); });
        mediaStore.getItem.mockImplementation(async (key: string) => blobs.get(key));
        mediaStore.removeItem.mockImplementation(async (key: string) => { blobs.delete(key); });
        const oldMedia = await uploadRemoteMediaFile(new Blob(["old"], { type: "application/octet-stream" }), "file", { signal: new AbortController().signal, isActive: () => true });
        const replacement = new Blob(["replacement"], { type: "application/octet-stream" });
        const newMedia = await uploadRemoteMediaFile(replacement, "file", { signal: new AbortController().signal, isActive: () => true });
        const leased = getMediaStorageBookkeeping().leases;

        await discardRemoteMedia(oldMedia);
        await cleanupUnusedMedia({}, () => ({}));

        expect(await getMediaBlob(newMedia.storageKey)).toBe(replacement);
        expect(getMediaStorageBookkeeping().leases).toBe(leased);
        releaseRemoteMediaLease(newMedia);
        expect(getMediaStorageBookkeeping().leases).toBe(leased - 1);
    });

    test("finalizes image resources after a pending cleanup retry succeeds", async () => {
        const imageStore = stores.get("image_files")!;
        const before = getImageStorageBookkeeping().generations;
        nextStorageId.mockReturnValueOnce("retry-finalizer").mockReturnValueOnce("retry-trigger");
        const image = await uploadRemoteImage(new Blob(["old"], { type: "image/png" }), { signal: new AbortController().signal, isActive: () => true });
        imageStore.removeItem.mockRejectedValueOnce(new Error("cleanup unavailable")).mockResolvedValue(undefined);
        await expect(deleteStoredImages([image.storageKey])).rejects.toThrow("cleanup unavailable");

        const trigger = await uploadRemoteImage(new Blob(["trigger"], { type: "image/png" }), { signal: new AbortController().signal, isActive: () => true });
        await discardRemoteImage(trigger);
        await Promise.resolve();
        await Promise.resolve();

        expect(await resolveImageUrl(image.storageKey, "fallback")).toBe("fallback");
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:strict");
        expect(getImageStorageBookkeeping().generations).toBe(before);
    });

    test("finalizes media resources after a pending cleanup retry succeeds", async () => {
        const mediaStore = stores.get("media_files")!;
        const before = getMediaStorageBookkeeping().generations;
        nextStorageId.mockReturnValueOnce("retry-finalizer").mockReturnValueOnce("retry-trigger");
        const media = await uploadRemoteMediaFile(new Blob(["old"], { type: "application/octet-stream" }), "video", { signal: new AbortController().signal, isActive: () => true });
        mediaStore.removeItem.mockRejectedValueOnce(new Error("cleanup unavailable")).mockResolvedValue(undefined);
        await expect(deleteStoredMedia([media.storageKey])).rejects.toThrow("cleanup unavailable");

        const trigger = await uploadRemoteMediaFile(new Blob(["trigger"], { type: "application/octet-stream" }), "video", { signal: new AbortController().signal, isActive: () => true });
        await discardRemoteMedia(trigger);
        await Promise.resolve();
        await Promise.resolve();

        expect(await resolveMediaUrl(media.storageKey, "fallback")).toBe("fallback");
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:strict");
        expect(getMediaStorageBookkeeping().generations).toBe(before);
    });

    test("strict remote URL failures never fall back to an empty local storage key", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("download failed")));
        const context = { signal: new AbortController().signal, isActive: () => true };
        await expect(uploadRemoteMediaFile("https://example.test/video.mp4", "video", context)).rejects.toThrow("download failed");
        await expect(uploadRemoteImage("https://example.test/image.png", context)).rejects.toThrow("download failed");
        expect(stores.get("media_files")?.setItem).not.toHaveBeenCalled();
        expect(stores.get("image_files")?.setItem).not.toHaveBeenCalled();
    });
});

describe("direct generation project asset routing", () => {
    const writeContext: ProjectAssetWriteContext = {
        projectId: "project-1",
        projectTitle: "Project",
        workspacePath: "/workspaces/project-1",
        canvasId: "canvas-1",
        nodeId: "video-1",
        source: { type: "generated", canvasId: "canvas-1", nodeId: "video-1" },
    };

    test("routes direct generated audio through the project asset write context", async () => {
        const stored = { url: "blob:project-audio", assetRef: { backend: "project-file", assetId: "asset-audio", projectId: "project-1", relativePath: "assets/generated/asset-audio", revision: 1 }, bytes: 32, mimeType: "audio/mpeg", durationMs: 1_500 };
        storeCanvasMedia.mockResolvedValue(stored);
        const result = await storeGeneratedAudio(new Blob(["audio"], { type: "audio/mpeg" }), "mp3", writeContext);
        expect(storeCanvasMedia).toHaveBeenCalledWith(expect.any(Blob), writeContext);
        expect(result.assetRef).toEqual(stored.assetRef);
        expect(result.url).toBe(stored.url);
        expect(stores.get("media_files")?.setItem).not.toHaveBeenCalled();
    });

    test("keeps direct audio on the IndexedDB backend without a project context", async () => {
        const originalCreateElement = document.createElement.bind(document);
        const audioElement = { duration: Number.NaN, onloadedmetadata: null as (() => void) | null, onerror: null as (() => void) | null, src: "" };
        const createElementSpy = vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
            if (tagName !== "audio") return originalCreateElement(tagName);
            queueMicrotask(() => audioElement.onloadedmetadata?.());
            return audioElement;
        }) as typeof document.createElement);
        const result = await storeGeneratedAudio(new Blob(["audio"], { type: "audio/mpeg" }), "mp3");
        expect(storeCanvasMedia).not.toHaveBeenCalled();
        expect(stores.get("media_files")?.setItem).toHaveBeenCalledWith("audio:strict-key", expect.any(Blob));
        expect(result.storageKey).toBe("audio:strict-key");
        createElementSpy.mockRestore();
    });

    test("routes direct generated video blobs through the project asset write context", async () => {
        const stored = { url: "blob:project-video", assetRef: { backend: "project-file", assetId: "asset-video", projectId: "project-1", relativePath: "assets/generated/asset-video", revision: 1 }, bytes: 64, mimeType: "video/mp4", width: 1280, height: 720, durationMs: 2_000 };
        storeCanvasMedia.mockResolvedValue(stored);
        const result = await storeGeneratedVideo({ blob: new Blob(["video"], { type: "video/mp4" }) }, writeContext);
        expect(storeCanvasMedia).toHaveBeenCalledWith(expect.any(Blob), writeContext);
        expect(result.assetRef).toEqual(stored.assetRef);
    });

    test("surfaces a project video write failure instead of falling back to a bare remote URL", async () => {
        storeCanvasMedia.mockRejectedValue(new Error("disk full"));
        await expect(storeGeneratedVideo({ url: "https://example.test/video.mp4" }, writeContext)).rejects.toThrow("disk full");
        expect(stores.get("media_files")?.setItem).not.toHaveBeenCalled();
    });

    test("keeps the bare remote URL fallback for url results without a project context", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("download failed")));
        const result = await storeGeneratedVideo({ url: "https://example.test/video.mp4", mimeType: "video/mp4" });
        expect(storeCanvasMedia).not.toHaveBeenCalled();
        expect(result).toMatchObject({ url: "https://example.test/video.mp4", storageKey: "" });
    });
});
