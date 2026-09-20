import { describe, expect, test, vi } from "vitest";

import { createTaskActiveCountRegistry, createTaskCloseCoordinator, createTaskCloseGuard, createTaskCountOwnerLifecycle, isTrustedTaskCountSender } from "./task-close-guard";

describe("task close guard", () => {
    test("allows close without active tasks", async () => {
        const confirm = vi.fn();
        const guard = createTaskCloseGuard(confirm);

        guard.setActiveCount(0);

        await expect(guard.requestClose()).resolves.toBe(true);
        expect(confirm).not.toHaveBeenCalled();
    });

    test("deduplicates concurrent close requests", async () => {
        let finish!: (value: boolean) => void;
        const confirm = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
        const guard = createTaskCloseGuard(confirm);
        guard.setActiveCount(2);

        const first = guard.requestClose();
        const second = guard.requestClose();

        expect(confirm).toHaveBeenCalledOnce();
        expect(confirm).toHaveBeenCalledWith(2);
        finish(true);
        await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    });

    test("cancel keeps the next close attempt guarded", async () => {
        const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const guard = createTaskCloseGuard(confirm);
        guard.setActiveCount(1);

        await expect(guard.requestClose()).resolves.toBe(false);
        await expect(guard.requestClose()).resolves.toBe(true);

        expect(confirm).toHaveBeenCalledTimes(2);
    });
});

describe("task active count registry", () => {
    test("aggregates counts by renderer owner and removes stale owners", () => {
        const onActiveCount = vi.fn();
        const registry = createTaskActiveCountRegistry(onActiveCount);

        registry.setActiveCount(11, 2);
        registry.setActiveCount(22, 3);
        registry.setActiveCount(11, 1);
        registry.deleteOwner(22);

        expect(onActiveCount.mock.calls.map(([count]) => count)).toEqual([2, 5, 4, 1]);
        expect(registry.getActiveCount()).toBe(1);
    });

    test("renderer loss clears its count without overwriting other owners", () => {
        const onActiveCount = vi.fn();
        const registry = createTaskActiveCountRegistry(onActiveCount);
        registry.setActiveCount(11, 2);
        registry.setActiveCount(22, 1);

        registry.deleteOwner(11);

        expect(registry.getActiveCount()).toBe(1);
        expect(onActiveCount).toHaveBeenLastCalledWith(1);
    });

    test("renderer lifecycle clears count on reload, crash, and destruction", () => {
        const registry = createTaskActiveCountRegistry(vi.fn());
        const unregister = vi.fn();
        const lifecycle = createTaskCountOwnerLifecycle(11, registry, unregister);
        registry.setActiveCount(11, 2);

        lifecycle.didStartNavigation(false, true);
        expect(registry.getActiveCount()).toBe(0);

        registry.setActiveCount(11, 2);
        lifecycle.renderProcessGone();
        expect(registry.getActiveCount()).toBe(0);

        registry.setActiveCount(11, 2);
        lifecycle.destroyed();
        expect(registry.getActiveCount()).toBe(0);
        expect(unregister).toHaveBeenCalledOnce();
    });

    test("in-place navigation preserves the current renderer count", () => {
        const registry = createTaskActiveCountRegistry(vi.fn());
        const lifecycle = createTaskCountOwnerLifecycle(11, registry, vi.fn());
        registry.setActiveCount(11, 2);

        lifecycle.didStartNavigation(true, true);

        expect(registry.getActiveCount()).toBe(2);
    });

    test("accepts only the registered live window webContents sender", () => {
        const trustedSender = { id: 11 };
        const forgedSender = { id: 11 };
        const owner = { isDestroyed: vi.fn(() => false), webContents: trustedSender };
        const owners = new Map([[11, owner]]);

        expect(isTrustedTaskCountSender(trustedSender, owners)).toBe(true);
        expect(isTrustedTaskCountSender(forgedSender, owners)).toBe(false);
        expect(isTrustedTaskCountSender({ id: 22 }, owners)).toBe(false);
        owner.isDestroyed.mockReturnValue(true);
        expect(isTrustedTaskCountSender(trustedSender, owners)).toBe(false);
    });
});

describe("task close coordinator", () => {
    test("upgrades a pending window close to app quit and confirms once", async () => {
        let finish!: (value: boolean) => void;
        const confirm = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
        const guard = createTaskCloseGuard(confirm);
        guard.setActiveCount(2);
        const closeWindow = vi.fn();
        const quit = vi.fn();
        const coordinator = createTaskCloseCoordinator(guard.requestClose, quit, vi.fn());

        const closing = coordinator.requestWindowClose(closeWindow);
        const quitting = coordinator.requestAppQuit();
        finish(true);
        await Promise.all([closing, quitting]);

        expect(confirm).toHaveBeenCalledOnce();
        expect(closeWindow).not.toHaveBeenCalled();
        expect(quit).toHaveBeenCalledOnce();
    });

    test("cancel resets intent so a later close is guarded and can continue", async () => {
        const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const guard = createTaskCloseGuard(confirm);
        guard.setActiveCount(1);
        const firstClose = vi.fn();
        const secondClose = vi.fn();
        const coordinator = createTaskCloseCoordinator(guard.requestClose, vi.fn(), vi.fn());

        await coordinator.requestWindowClose(firstClose);
        await coordinator.requestWindowClose(secondClose);

        expect(firstClose).not.toHaveBeenCalled();
        expect(secondClose).toHaveBeenCalledOnce();
        expect(confirm).toHaveBeenCalledTimes(2);
    });

    test("confirmed app quit re-entry bypasses a second confirmation", async () => {
        const confirm = vi.fn().mockResolvedValue(true);
        const guard = createTaskCloseGuard(confirm);
        guard.setActiveCount(1);
        let coordinator!: ReturnType<typeof createTaskCloseCoordinator>;
        const quit = vi.fn(() => {
            expect(coordinator.isForceClosing()).toBe(true);
            void coordinator.requestAppQuit();
        });
        coordinator = createTaskCloseCoordinator(guard.requestClose, quit, vi.fn());

        await coordinator.requestAppQuit();

        expect(confirm).toHaveBeenCalledOnce();
        expect(quit).toHaveBeenCalledOnce();
    });

    test("confirmed window close does not quit the app", async () => {
        const guard = createTaskCloseGuard(vi.fn().mockResolvedValue(true));
        guard.setActiveCount(1);
        const closeWindow = vi.fn();
        const quit = vi.fn();
        const coordinator = createTaskCloseCoordinator(guard.requestClose, quit, vi.fn());

        await coordinator.requestWindowClose(closeWindow);

        expect(closeWindow).toHaveBeenCalledOnce();
        expect(quit).not.toHaveBeenCalled();
    });

    test("dialog rejection keeps the app open and resets the next attempt", async () => {
        const confirm = vi.fn().mockRejectedValueOnce(new Error("dialog failed")).mockResolvedValueOnce(true);
        const guard = createTaskCloseGuard(confirm);
        guard.setActiveCount(1);
        const closeWindow = vi.fn();
        const onError = vi.fn();
        const coordinator = createTaskCloseCoordinator(guard.requestClose, vi.fn(), onError);

        await coordinator.requestWindowClose(closeWindow);
        expect(closeWindow).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledOnce();

        await coordinator.requestWindowClose(closeWindow);
        expect(closeWindow).toHaveBeenCalledOnce();
        expect(confirm).toHaveBeenCalledTimes(2);
    });

    test("active count zero closes without opening a dialog", async () => {
        const confirm = vi.fn();
        const guard = createTaskCloseGuard(confirm);
        const closeWindow = vi.fn();
        const coordinator = createTaskCloseCoordinator(guard.requestClose, vi.fn(), vi.fn());

        await coordinator.requestWindowClose(closeWindow);

        expect(closeWindow).toHaveBeenCalledOnce();
        expect(confirm).not.toHaveBeenCalled();
    });
});
