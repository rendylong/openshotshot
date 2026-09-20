import { describe, expect, it, vi } from "vitest";

import { createCanvasMutationQueue } from "./canvas-mutation-queue";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

describe("createCanvasMutationQueue", () => {
    it("serializes read-modify-write reducers on one canvas", async () => {
        const queue = createCanvasMutationQueue();
        const state = { count: 0 };
        const releaseFirst = deferred<void>();
        const firstEntered = deferred<void>();

        const first = queue.enqueue("canvas-1", async () => {
            firstEntered.resolve();
            await releaseFirst.promise;
            state.count += 1;
            return "first";
        });
        const second = queue.enqueue("canvas-1", async () => {
            const observed = state.count;
            state.count += 1;
            return observed;
        });
        await firstEntered.promise;

        state.count += 1;
        releaseFirst.resolve();
        await expect(Promise.all([first, second])).resolves.toEqual(["first", 2]);
        expect(state.count).toBe(3);
    });

    it("continues the same-canvas queue after a rejection", async () => {
        const queue = createCanvasMutationQueue();
        const releaseFailure = deferred<void>();
        const failure = queue.enqueue("canvas-1", async () => {
            await releaseFailure.promise;
            throw new Error("mutation failed");
        });
        const later = queue.enqueue("canvas-1", async () => "later");

        releaseFailure.reject(new Error("mutation failed"));
        await expect(failure).rejects.toThrow("mutation failed");
        await expect(later).resolves.toBe("later");
    });

    it("runs different canvases in parallel", async () => {
        const queue = createCanvasMutationQueue();
        const releaseFirst = deferred<void>();
        const releaseSecond = deferred<void>();
        const first = queue.enqueue("canvas-1", () => releaseFirst.promise);
        const second = queue.enqueue("canvas-2", () => releaseSecond.promise);

        releaseSecond.resolve();
        await expect(second).resolves.toBeUndefined();
        releaseFirst.resolve();
        await expect(first).resolves.toBeUndefined();
    });

    it("rejects an empty canvas id before starting a mutation", async () => {
        const queue = createCanvasMutationQueue();
        const mutation = vi.fn(async () => "unused");

        await expect(queue.enqueue("", mutation)).rejects.toThrow("非法画布 ID");
        expect(mutation).not.toHaveBeenCalled();
    });
});
