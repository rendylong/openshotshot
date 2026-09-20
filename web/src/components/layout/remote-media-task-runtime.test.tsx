import { StrictMode } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { useProjectStore } from "@/stores/canvas/use-project-store";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useRemoteMediaTaskStore } from "@/stores/use-remote-media-task-store";
import type { RemoteMediaTaskRunner, RemoteMediaTaskRunnerDeps } from "@/services/remote-media-task-runner";
import { RemoteMediaTaskRuntime } from "./remote-media-task-runtime";

const mocks = vi.hoisted(() => ({
    order: [] as string[],
    runners: [] as RemoteMediaTaskRunner[],
    runnerDeps: [] as RemoteMediaTaskRunnerDeps[],
    startPromise: null as Promise<void> | null,
    reconcile: vi.fn(async () => { mocks.order.push("reconcile"); }),
    register: vi.fn(() => {
        mocks.order.push("register");
        return () => { mocks.order.push("unregister"); };
    }),
}));

vi.mock("@/lib/canvas/remote-media-task-result", async (importOriginal) => ({
    ...await importOriginal<typeof import("@/lib/canvas/remote-media-task-result")>(),
    reconcileTerminalRemoteTasksToProjects: mocks.reconcile,
}));

vi.mock("@/services/remote-media-task-runner", async (importOriginal) => ({
    ...await importOriginal<typeof import("@/services/remote-media-task-runner")>(),
    createRemoteMediaTaskRunner: vi.fn((deps: RemoteMediaTaskRunnerDeps) => {
        mocks.order.push("create");
        mocks.runnerDeps.push(deps);
        const runner: RemoteMediaTaskRunner = {
            retryResult: vi.fn().mockResolvedValue(undefined),
            retrySubmission: async () => {},
            start: vi.fn(async () => {
                mocks.order.push("start");
                await mocks.startPromise;
            }),
            wake: vi.fn(),
            abort: vi.fn(),
            stop: vi.fn(async () => undefined),
            stopByTarget: vi.fn(async () => undefined),
            dispose: vi.fn(() => { mocks.order.push("dispose"); }),
        };
        mocks.runners.push(runner);
        return runner;
    }),
    registerRemoteMediaTaskRunner: mocks.register,
}));

function activeTask() {
    return {
        id: "task-1", remoteTaskId: "remote-1", capability: "image" as const,
        target: { projectId: "project-1", canvasId: "canvas-1", nodeId: "node-1" },
        channelId: "channel-1", modelName: "image-model", baseUrlSnapshot: "https://snapshot.example",
        queryScriptSnapshot: "return { status: 'pending' }", status: "pending" as const,
        submittedAt: 1_000, deadlineAt: 301_000,
    };
}

describe("RemoteMediaTaskRuntime", () => {
    let setActiveCount: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mocks.order.length = 0;
        mocks.runners.length = 0;
        mocks.runnerDeps.length = 0;
        mocks.startPromise = null;
        mocks.reconcile.mockClear();
        mocks.register.mockClear();
        useProjectStore.setState({ hydrated: false, hydrationStatus: "pending", projects: [] });
        useRemoteMediaTaskStore.setState({ hydrated: false, tasks: [] });
        useConfigStore.setState({ config: defaultConfig });
        setActiveCount = vi.fn();
        Object.defineProperty(window, "shotshot", {
            configurable: true,
            value: { tasks: { setActiveCount } },
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        Reflect.deleteProperty(window, "shotshot");
    });

    test("syncs active task count before runtime bootstrap and on later task changes", async () => {
        useRemoteMediaTaskStore.setState({ tasks: [activeTask()] });

        render(<RemoteMediaTaskRuntime />);

        await waitFor(() => expect(setActiveCount).toHaveBeenLastCalledWith(1));
        expect(mocks.runners).toHaveLength(0);

        act(() => useRemoteMediaTaskStore.setState((state) => ({
            tasks: state.tasks.map((task) => ({ ...task, status: "succeeded" as const })),
        })));
        await waitFor(() => expect(setActiveCount).toHaveBeenLastCalledWith(0));
    });

    test("does not let an older lifecycle owner cleanup clear the current active count", async () => {
        useRemoteMediaTaskStore.setState({ tasks: [activeTask()] });
        const older = render(<RemoteMediaTaskRuntime />);
        const current = render(<RemoteMediaTaskRuntime />);
        await waitFor(() => expect(setActiveCount).toHaveBeenLastCalledWith(1));
        setActiveCount.mockClear();

        older.unmount();

        expect(setActiveCount).not.toHaveBeenCalledWith(0);
        current.unmount();
        expect(setActiveCount).toHaveBeenLastCalledWith(0);
    });

    test("keeps the count when the newer lifecycle owner unmounts before the older owner", async () => {
        useRemoteMediaTaskStore.setState({ tasks: [activeTask()] });
        const older = render(<RemoteMediaTaskRuntime />);
        const newer = render(<RemoteMediaTaskRuntime />);
        await waitFor(() => expect(setActiveCount).toHaveBeenLastCalledWith(1));
        setActiveCount.mockClear();

        newer.unmount();

        expect(setActiveCount).toHaveBeenLastCalledWith(1);
        older.unmount();
        expect(setActiveCount).toHaveBeenLastCalledWith(0);
    });

    test("StrictMode remount leaves the active count owned until final unmount", async () => {
        useRemoteMediaTaskStore.setState({ tasks: [activeTask()] });

        const view = render(<StrictMode><RemoteMediaTaskRuntime /></StrictMode>);

        await waitFor(() => expect(setActiveCount).toHaveBeenLastCalledWith(1));
        view.unmount();
        expect(setActiveCount).toHaveBeenLastCalledWith(0);
    });

    test("reconciles and starts once only after project and task stores hydrate", async () => {
        render(<RemoteMediaTaskRuntime />);
        expect(mocks.runners).toHaveLength(0);

        act(() => useProjectStore.setState({ hydrated: true, hydrationStatus: "success" }));
        expect(mocks.runners).toHaveLength(0);
        act(() => useRemoteMediaTaskStore.setState({ hydrated: true }));

        await waitFor(() => expect(mocks.runners).toHaveLength(1));
        expect(mocks.order.slice(0, 4)).toEqual(["reconcile", "create", "register", "start"]);
        expect(mocks.reconcile).toHaveBeenCalledWith(useRemoteMediaTaskStore.getState().tasks);
    });

    test("keeps one registered runner through the StrictMode development remount", async () => {
        useProjectStore.setState({ hydrated: true, hydrationStatus: "success" });
        useRemoteMediaTaskStore.setState({ hydrated: true });

        const view = render(<StrictMode><RemoteMediaTaskRuntime /></StrictMode>);

        await waitFor(() => expect(mocks.runners).toHaveLength(1));
        expect(mocks.runners[0].start).toHaveBeenCalledOnce();
        expect(mocks.register).toHaveBeenCalledTimes(1);

        view.unmount();
        expect(mocks.order).toContain("unregister");
        expect(mocks.runners[0].dispose).toHaveBeenCalledOnce();
    });

    test("unregisters and disposes while an old asynchronous start is still settling", async () => {
        let finishStart!: () => void;
        mocks.startPromise = new Promise<void>((resolve) => { finishStart = resolve; });
        useProjectStore.setState({ hydrated: true, hydrationStatus: "success" });
        useRemoteMediaTaskStore.setState({ hydrated: true });
        const view = render(<RemoteMediaTaskRuntime />);
        await waitFor(() => expect(mocks.runners[0]?.start).toHaveBeenCalledOnce());

        view.unmount();
        finishStart();
        await act(async () => mocks.startPromise);

        expect(mocks.order.filter((item) => item === "register")).toHaveLength(1);
        expect(mocks.order.filter((item) => item === "unregister")).toHaveLength(1);
        expect(mocks.runners[0].dispose).toHaveBeenCalledOnce();
    });

    test.each(["degraded", "error"] as const)("keeps a valid remote task paused while project hydration is %s, then starts after a successful rehydrate", async (hydrationStatus) => {
        const task = {
            id: "task-1", remoteTaskId: "remote-1", capability: "image" as const,
            target: { projectId: "project-1", canvasId: "canvas-1", nodeId: "node-1" },
            channelId: "channel-1", modelName: "image-model", baseUrlSnapshot: "https://snapshot.example",
            queryScriptSnapshot: "return { status: 'pending' }", status: "pending" as const,
            submittedAt: 1_000, deadlineAt: 301_000,
        };
        useRemoteMediaTaskStore.setState({ hydrated: true, tasks: [task] });
        useProjectStore.setState({ hydrated: true, hydrationStatus, projects: [] });
        render(<RemoteMediaTaskRuntime />);

        await act(async () => undefined);
        expect(mocks.reconcile).not.toHaveBeenCalled();
        expect(mocks.runners).toHaveLength(0);
        expect(useRemoteMediaTaskStore.getState().tasks[0].status).toBe("pending");

        act(() => useProjectStore.setState({ hydrationStatus: "success" }));
        await waitFor(() => expect(mocks.runners).toHaveLength(1));
    });

    test("does not reconcile or start before persisted configuration hydrates", async () => {
        let finishHydration!: (state: ReturnType<typeof useConfigStore.getState>) => void;
        const hasHydrated = vi.spyOn(useConfigStore.persist, "hasHydrated").mockReturnValue(false);
        vi.spyOn(useConfigStore.persist, "onFinishHydration").mockImplementation((listener) => {
            finishHydration = listener;
            return () => undefined;
        });
        useProjectStore.setState({ hydrated: true, hydrationStatus: "success" });
        useRemoteMediaTaskStore.setState({ hydrated: true });
        render(<RemoteMediaTaskRuntime />);

        await act(async () => undefined);
        expect(mocks.reconcile).not.toHaveBeenCalled();
        expect(mocks.runners).toHaveLength(0);

        hasHydrated.mockReturnValue(true);
        act(() => finishHydration(useConfigStore.getState()));

        await waitFor(() => expect(mocks.runners).toHaveLength(1));
    });

    test("supplies the runner with the latest channel key instead of a startup config snapshot", async () => {
        useProjectStore.setState({ hydrated: true, hydrationStatus: "success" });
        useRemoteMediaTaskStore.setState({ hydrated: true });
        render(<RemoteMediaTaskRuntime />);
        await waitFor(() => expect(mocks.runnerDeps).toHaveLength(1));

        act(() => useConfigStore.setState({
            config: {
                ...defaultConfig,
                channels: [{ ...defaultConfig.channels[0], id: "current-channel", apiKey: "fresh-key" }],
            },
        }));

        expect(mocks.runnerDeps[0].getConfig().channels[0]).toMatchObject({ id: "current-channel", apiKey: "fresh-key" });
    });

    test("supplies legacy script recovery through the named queryLegacy boundary", async () => {
        useProjectStore.setState({ hydrated: true, hydrationStatus: "success" });
        useRemoteMediaTaskStore.setState({ hydrated: true });

        render(<RemoteMediaTaskRuntime />);
        await waitFor(() => expect(mocks.runnerDeps).toHaveLength(1));

        expect(mocks.runnerDeps[0].queryLegacy).toBeTypeOf("function");
        expect(mocks.runnerDeps[0]).not.toHaveProperty("query");
    });
});
