import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it } from "vitest";

import { AppReleaseForceModal } from "./app-release-force-modal";
import i18n from "@/i18n";
import { useAppReleaseStore } from "@/stores/use-app-release-store";

function setState(status: "force_update" | "soft_update" | "idle", snoozedUntil: number | null = null) {
    useAppReleaseStore.setState({
        state: {
            status,
            policy: status === "idle" ? null : {
                minVersion: "0.19.0", latestVersion: "0.19.0",
                downloadUrl: "https://shotshot.ai/download", notes: "修复升级提醒", updatedAt: null,
            },
            checkedAt: null,
        },
        snoozedUntil,
    });
}

function renderModal() {
    return render(
        <I18nextProvider i18n={i18n}>
            <AppReleaseForceModal />
        </I18nextProvider>,
    );
}

// antd Modal portal 到 document.body，断言统一查 body 而非 render 的 container。
describe("AppReleaseForceModal", () => {
    beforeEach(() => {
        setState("idle");
    });

    it("renders nothing when idle", () => {
        setState("idle");
        renderModal();
        expect(document.body.querySelector(".ant-modal")).toBeNull();
    });

    it("renders force modal with version and download/snooze actions, without a close button", () => {
        setState("force_update");
        renderModal();
        expect(screen.getByText(/0\.19\.0/)).toBeTruthy();
        expect(screen.getByRole("button", { name: "前往下载" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "稍后提醒" })).toBeTruthy();
        expect(document.body.querySelector(".ant-modal-close")).toBeNull();
    });

    it("hidden while snoozed", () => {
        setState("force_update", Date.now() + 60_000);
        renderModal();
        expect(document.body.querySelector(".ant-modal")).toBeNull();
    });
});
