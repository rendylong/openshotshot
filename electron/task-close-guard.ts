function normalizeCount(value: number) {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function createTaskCloseGuard(confirm: (count: number) => Promise<boolean>) {
    let activeCount = 0;
    let pending: Promise<boolean> | null = null;

    return {
        setActiveCount(value: number) {
            activeCount = normalizeCount(value);
        },
        requestClose() {
            if (!activeCount) return Promise.resolve(true);
            if (!pending) pending = confirm(activeCount).finally(() => { pending = null; });
            return pending;
        },
    };
}

export function createTaskActiveCountRegistry(onActiveCount: (count: number) => void) {
    const counts = new Map<number, number>();
    const publish = () => {
        const activeCount = [...counts.values()].reduce((sum, count) => sum + count, 0);
        onActiveCount(activeCount);
        return activeCount;
    };
    return {
        setActiveCount(ownerId: number, value: number) {
            const count = normalizeCount(value);
            if (count) counts.set(ownerId, count);
            else counts.delete(ownerId);
            publish();
        },
        deleteOwner(ownerId: number) {
            if (!counts.delete(ownerId)) return;
            publish();
        },
        getActiveCount: () => [...counts.values()].reduce((sum, count) => sum + count, 0),
    };
}

export function createTaskCountOwnerLifecycle(
    ownerId: number,
    registry: Pick<ReturnType<typeof createTaskActiveCountRegistry>, "deleteOwner">,
    unregister: () => void,
) {
    const clear = () => registry.deleteOwner(ownerId);
    const remove = () => {
        clear();
        unregister();
    };
    return {
        didStartNavigation(isInPlace: boolean, isMainFrame: boolean) {
            if (isMainFrame && !isInPlace) clear();
        },
        renderProcessGone: clear,
        destroyed: remove,
        closed: remove,
    };
}

export function isTrustedTaskCountSender<T extends { id: number }>(
    sender: T,
    owners: ReadonlyMap<number, { isDestroyed(): boolean; webContents: T }>,
) {
    const owner = owners.get(sender.id);
    return Boolean(owner && !owner.isDestroyed() && owner.webContents === sender);
}

export function createTaskCloseCoordinator(
    requestClose: () => Promise<boolean>,
    quit: () => void,
    onError: (error: unknown) => void,
) {
    let forceClosing = false;
    let quitRequested = false;
    let closeWindow: (() => void) | null = null;
    let pending: Promise<void> | null = null;

    const resetIntent = () => {
        quitRequested = false;
        closeWindow = null;
    };
    const decide = () => {
        if (forceClosing) return Promise.resolve();
        if (pending) return pending;
        let closeRequest: Promise<boolean>;
        try {
            closeRequest = requestClose();
        } catch (error) {
            resetIntent();
            onError(error);
            return Promise.resolve();
        }
        const decision = closeRequest.then((confirmed) => {
            if (!confirmed) {
                resetIntent();
                return;
            }
            forceClosing = true;
            const action = quitRequested ? quit : closeWindow;
            resetIntent();
            action?.();
        }).catch((error) => {
            resetIntent();
            onError(error);
        }).finally(() => {
            if (pending === decision) pending = null;
        });
        pending = decision;
        return decision;
    };

    return {
        requestWindowClose(close: () => void) {
            closeWindow = close;
            return decide();
        },
        requestAppQuit() {
            quitRequested = true;
            return decide();
        },
        isForceClosing: () => forceClosing,
        resetForNewWindow() {
            forceClosing = false;
            resetIntent();
        },
    };
}
