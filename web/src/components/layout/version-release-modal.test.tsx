import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VersionReleaseModal } from "./version-release-modal";
import type { AppReleaseBridge, AppReleaseState } from "@/lib/desktop/app-release-bridge";
import i18n from "@/i18n";
import { useAppReleaseStore } from "@/stores/use-app-release-store";

const SOFT_UPDATE_STATE: AppReleaseState = {
    status: "soft_update",
    policy: {
        minVersion: "0.1.0",
        latestVersion: "9.9.9",
        downloadUrl: "https://shotshot.ai/download",
        notes: "云端策略版本说明",
        updatedAt: null,
    },
    checkedAt: null,
};

function mockAppReleaseBridge(state: AppReleaseState): AppReleaseBridge {
    const bridge: AppReleaseBridge = {
        getState: vi.fn().mockResolvedValue(state),
        refresh: vi.fn().mockResolvedValue(state),
        openDownload: vi.fn().mockResolvedValue(undefined),
        onChanged: vi.fn().mockReturnValue(() => {}),
    };
    (window as unknown as { shotshot?: unknown }).shotshot = { appRelease: bridge };
    return bridge;
}

function renderModal() {
    return render(
        <I18nextProvider i18n={i18n}>
            <VersionReleaseModal />
        </I18nextProvider>,
    );
}

// 纯弹窗：开关在 store（入口=侧栏顶部「新版本」提醒与设置菜单）。antd Modal portal 到 document.body，断言统一查 body。
describe("VersionReleaseModal", () => {
    beforeEach(() => {
        useAppReleaseStore.setState({ state: { status: "idle", policy: null, checkedAt: null }, snoozedUntil: null, releaseModalOpen: false });
        // 挡住打开时的 VERSION/CHANGELOG 探测请求，测试内不访问真实网络
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        (window as unknown as { shotshot?: unknown }).shotshot = undefined;
    });

    it("renders nothing while closed", () => {
        renderModal();
        expect(document.body.querySelector(".ant-modal")).toBeNull();
    });

    it("opens from the store with cloud version, notes and download button under electron bridge", async () => {
        const bridge = mockAppReleaseBridge(SOFT_UPDATE_STATE);
        useAppReleaseStore.setState({ state: SOFT_UPDATE_STATE, releaseModalOpen: true });
        renderModal();
        await waitFor(() => expect(document.body.querySelector(".ant-modal")).not.toBeNull());
        expect(screen.getByText("9.9.9")).toBeTruthy();
        expect(screen.getByRole("button", { name: "下载新版本" })).toBeTruthy();
        expect(screen.getByText("版本说明")).toBeTruthy();
        expect(screen.getByText("云端策略版本说明")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "下载新版本" }));
        expect(bridge.openDownload).toHaveBeenCalledTimes(1);
    });

    it("closing the modal resets the store flag", async () => {
        mockAppReleaseBridge(SOFT_UPDATE_STATE);
        useAppReleaseStore.setState({ state: SOFT_UPDATE_STATE, releaseModalOpen: true });
        renderModal();
        await waitFor(() => expect(document.body.querySelector(".ant-modal")).not.toBeNull());
        fireEvent.click(document.body.querySelector(".ant-modal-close")!);
        await waitFor(() => expect(useAppReleaseStore.getState().releaseModalOpen).toBe(false));
        // jsdom 无 transitionend，antd 退场动画不结束、DOM 不会移除——只断言 store 开关复位
    });

    it("web mode renders the modal without the download button", async () => {
        useAppReleaseStore.setState({ releaseModalOpen: true });
        renderModal();
        await waitFor(() => expect(document.body.querySelector(".ant-modal")).not.toBeNull());
        expect(screen.queryByRole("button", { name: "下载新版本" })).toBeNull();
    });
});
