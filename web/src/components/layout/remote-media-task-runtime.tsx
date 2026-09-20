import { useEffect, useState } from "react";

import { applyRemoteTaskStateToProject, deliverRemoteTaskToProject, getEmbeddedRemoteTaskStatus, reconcileTerminalRemoteTasksToProjects } from "@/lib/canvas/remote-media-task-result";
import { queryRemoteMediaTask } from "@/services/api/remote-media-task";
import { createRemoteMediaTaskRunner, registerRemoteMediaTaskRunner, type RemoteMediaTaskRunner } from "@/services/remote-media-task-runner";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { useConfigStore } from "@/stores/use-config-store";
import { useRemoteMediaTaskStore } from "@/stores/use-remote-media-task-store";

const taskLifecycleOwners = new Set<symbol>();

function useConfigHydrated() {
    const [hydrated, setHydrated] = useState(() => useConfigStore.persist.hasHydrated());
    useEffect(() => {
        if (useConfigStore.persist.hasHydrated()) {
            setHydrated(true);
            return;
        }
        return useConfigStore.persist.onFinishHydration(() => setHydrated(true));
    }, []);
    return hydrated;
}

export function RemoteMediaTaskRuntime() {
    const projectsHydrated = useProjectStore((state) => state.hydrated);
    const projectHydrationStatus = useProjectStore((state) => state.hydrationStatus);
    const tasksHydrated = useRemoteMediaTaskStore((state) => state.hydrated);
    const configHydrated = useConfigHydrated();

    useEffect(() => {
        const bridge = window.shotshot?.tasks;
        if (!bridge) return;
        const owner = Symbol("remote-media-task-lifecycle");
        taskLifecycleOwners.add(owner);
        const syncActiveCount = () => bridge.setActiveCount(useRemoteMediaTaskStore.getState().activeCount());
        syncActiveCount();
        const unsubscribe = useRemoteMediaTaskStore.subscribe(syncActiveCount);
        return () => {
            unsubscribe();
            taskLifecycleOwners.delete(owner);
            bridge.setActiveCount(taskLifecycleOwners.size ? useRemoteMediaTaskStore.getState().activeCount() : 0);
        };
    }, []);

    useEffect(() => {
        if (!projectsHydrated || projectHydrationStatus !== "success" || !tasksHydrated || !configHydrated) return;
        let cancelled = false;
        let runner: RemoteMediaTaskRunner | null = null;
        let unregisterRunner: (() => void) | null = null;
        void (async () => {
            await reconcileTerminalRemoteTasksToProjects(useRemoteMediaTaskStore.getState().tasks);
            if (cancelled) return;
            runner = createRemoteMediaTaskRunner({
                getTasks: () => useRemoteMediaTaskStore.getState().tasks,
                patchTask: (id, patch) => useRemoteMediaTaskStore.getState().patchTask(id, patch),
                persistTaskPatch: async (id, patch) => (await useRemoteMediaTaskStore.getState().persistTaskPatches([{ id, patch }]))[0],
                flush: () => useRemoteMediaTaskStore.getState().flush(),
                applyTaskState: applyRemoteTaskStateToProject,
                getEmbeddedTaskStatus: getEmbeddedRemoteTaskStatus,
                getConfig: () => useConfigStore.getState().config,
                queryLegacy: queryRemoteMediaTask,
                deliver: deliverRemoteTaskToProject,
                reportLateDeliveryError: (task, error) => console.error(`[remote-media-task] late delivery failed for ${task.id}: ${error}`),
            });
            unregisterRunner = registerRemoteMediaTaskRunner(runner);
            await runner.start();
        })().catch((error) => {
            if (!cancelled) console.error("[remote-media-task] durable runner transition failed", error);
        });
        return () => {
            cancelled = true;
            if (!runner) return;
            unregisterRunner?.();
            runner.dispose();
            runner = null;
        };
    }, [configHydrated, projectHydrationStatus, projectsHydrated, tasksHydrated]);

    return null;
}
