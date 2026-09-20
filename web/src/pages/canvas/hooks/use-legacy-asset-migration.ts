// 存量 IDB 媒体迁移接线（P2 spec §3）：项目画布页挂载后静默执行一次 migrateProjectAssets。
// Web（无桥）零执行；模块级 Set + in-flight promise 双重去重（StrictMode 双挂载安全）；
// idle 一拍再触发（大项目全量 copy-verify 不与首屏 hydrate 抢 IO）；失败 warn 并允许下次打开重试；
// 发生删除后触发一次素材库 cleanup 兜底回收残留键（spec §5）。
import { useEffect } from "react";

import { migrateProjectAssets } from "@/lib/project-assets/project-asset-migration";
import { useAssetStore } from "@/stores/use-asset-store";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { useScriptEntityStore } from "@/stores/use-script-entity-store";

const migratedProjectIds = new Set<string>();
const inFlight = new Map<string, Promise<void>>();

function waitForIdle(): Promise<void> {
    return new Promise((resolve) => {
        const idle = (window as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
        if (idle) idle(resolve, { timeout: 5_000 });
        else setTimeout(resolve, 200);
    });
}

export function useLegacyAssetMigration(projectId: string): void {
    const hydrated = useProjectStore((state) => state.hydrated);
    const entitiesHydrated = useScriptEntityStore((state) => state.hydrated);

    useEffect(() => {
        if (!hydrated || !entitiesHydrated) return;
        if (!window.shotshot?.projectAssets) return;
        if (migratedProjectIds.has(projectId) || inFlight.has(projectId)) return;
        const task = (async () => {
            try {
                await waitForIdle();
                const result = await migrateProjectAssets(projectId);
                migratedProjectIds.add(projectId);
                console.info(`[legacy-asset-migration] project=${projectId} migrated=${result.migrated} missing=${result.missing.length}`);
                if (result.migrated > 0) useAssetStore.getState().cleanupImages();
            } catch (error) {
                migratedProjectIds.delete(projectId);
                console.warn("[legacy-asset-migration] failed, will retry on next open:", error instanceof Error ? error.message : String(error));
            } finally {
                inFlight.delete(projectId);
            }
        })();
        inFlight.set(projectId, task);
    }, [projectId, hydrated, entitiesHydrated]);
}
