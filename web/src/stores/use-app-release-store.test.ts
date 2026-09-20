// web 测试环境为 jsdom（web/vitest.config.ts）
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appReleaseForceModalVisible, useAppReleaseStore } from "./use-app-release-store";
import type { AppReleaseState } from "@/lib/desktop/app-release-bridge";

const FORCE_STATE: AppReleaseState = {
    status: "force_update",
    policy: { minVersion: "0.19.0", latestVersion: "0.19.0", downloadUrl: "https://shotshot.ai/download", notes: "", updatedAt: null },
    checkedAt: "2026-09-18T00:00:00.000Z",
};

describe("appReleaseForceModalVisible", () => {
    it("visible on force_update without snooze", () => {
        expect(appReleaseForceModalVisible(FORCE_STATE, null, 1000)).toBe(true);
    });
    it("hidden while snoozed, visible after expiry", () => {
        expect(appReleaseForceModalVisible(FORCE_STATE, 2000, 1000)).toBe(false);
        expect(appReleaseForceModalVisible(FORCE_STATE, 2000, 2000)).toBe(true);
    });
    it("hidden for non-force statuses", () => {
        expect(appReleaseForceModalVisible({ ...FORCE_STATE, status: "soft_update" }, null, 1000)).toBe(false);
        expect(appReleaseForceModalVisible({ ...FORCE_STATE, status: "idle" }, null, 1000)).toBe(false);
    });
});

describe("useAppReleaseStore", () => {
    beforeEach(() => {
        useAppReleaseStore.setState({ state: { status: "idle", policy: null, checkedAt: null }, snoozedUntil: null });
        vi.restoreAllMocks();
    });

    it("snooze sets a future timestamp", () => {
        const before = Date.now();
        useAppReleaseStore.getState().snooze();
        expect(useAppReleaseStore.getState().snoozedUntil!).toBeGreaterThanOrEqual(before + 30 * 60 * 1000 - 5);
    });

    it("initialize reads state from the bridge without web bridge", async () => {
        await useAppReleaseStore.getState().initialize();
        expect(useAppReleaseStore.getState().state.status).toBe("idle");
    });

    it("refresh returns false without bridge", async () => {
        await expect(useAppReleaseStore.getState().refresh()).resolves.toBe(false);
    });
});
