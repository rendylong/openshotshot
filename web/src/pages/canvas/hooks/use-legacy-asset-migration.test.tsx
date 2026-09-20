import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const migrateProjectAssets = vi.hoisted(() => vi.fn(async () => ({ migrated: 0, missing: [] as string[] })));
const cleanupImages = vi.hoisted(() => vi.fn());
vi.mock("@/lib/project-assets/project-asset-migration", () => ({ migrateProjectAssets }));
vi.mock("@/stores/use-asset-store", () => ({ useAssetStore: Object.assign(vi.fn((selector: (s: { cleanupImages: unknown }) => unknown) => selector({ cleanupImages })), { getState: () => ({ cleanupImages }) }) }));
vi.mock("@/stores/canvas/use-project-store", () => ({ useProjectStore: Object.assign(vi.fn((selector: (s: { hydrated: boolean }) => unknown) => selector({ hydrated: true })), { getState: () => ({ hydrated: true }) }) }));
vi.mock("@/stores/use-script-entity-store", () => ({ useScriptEntityStore: Object.assign(vi.fn((selector: (s: { hydrated: boolean }) => unknown) => selector({ hydrated: true })), { getState: () => ({ hydrated: true }) }) }));

import { useLegacyAssetMigration } from "./use-legacy-asset-migration";

function withBridge(value: unknown) {
    Object.defineProperty(window, "shotshot", { value, configurable: true });
}

beforeEach(() => {
    vi.clearAllMocks();
    withBridge({ projectAssets: {} });
});

describe("useLegacyAssetMigration", () => {
    it("无桌面桥（Web）零执行", async () => {
        withBridge(undefined);
        renderHook(() => useLegacyAssetMigration("p1"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(migrateProjectAssets).not.toHaveBeenCalled();
    });

    it("成功执行一次并在同会话去重；migrated>0 时触发 cleanupImages", async () => {
        migrateProjectAssets.mockResolvedValue({ migrated: 3, missing: [] });
        const { rerender } = renderHook(() => useLegacyAssetMigration("p1"));
        await waitFor(() => expect(migrateProjectAssets).toHaveBeenCalledWith("p1"));
        rerender();
        rerender();
        await waitFor(() => expect(cleanupImages).toHaveBeenCalled());
        expect(migrateProjectAssets).toHaveBeenCalledTimes(1);
    });

    it("失败后允许下次打开重试", async () => {
        migrateProjectAssets.mockRejectedValueOnce(new Error("workspace unavailable"));
        const { unmount } = renderHook(() => useLegacyAssetMigration("p2"));
        await waitFor(() => expect(migrateProjectAssets).toHaveBeenCalled());
        unmount();
        renderHook(() => useLegacyAssetMigration("p2"));
        await waitFor(() => expect(migrateProjectAssets).toHaveBeenCalledTimes(2));
    });
});
