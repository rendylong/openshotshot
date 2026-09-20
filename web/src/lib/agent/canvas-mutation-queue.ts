export type CanvasMutationQueue = {
    enqueue<T>(canvasId: string, mutation: () => Promise<T>): Promise<T>;
};

export function createCanvasMutationQueue(): CanvasMutationQueue {
    const tails = new Map<string, Promise<unknown>>();

    return {
        enqueue(canvasId, mutation) {
            if (typeof canvasId !== "string" || canvasId.length === 0) {
                return Promise.reject(new Error("非法画布 ID"));
            }
            const previous = tails.get(canvasId) ?? Promise.resolve();
            const operation = previous.then(mutation, mutation);
            const tail = operation.then(
                () => undefined,
                () => undefined,
            );
            tails.set(canvasId, tail);
            void tail.then(() => {
                if (tails.get(canvasId) === tail) tails.delete(canvasId);
            });
            return operation;
        },
    };
}
