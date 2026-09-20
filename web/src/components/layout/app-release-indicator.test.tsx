import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppReleaseIndicator } from "./app-release-indicator";
import type { AppReleaseState } from "@/lib/desktop/app-release-bridge";
import i18n from "@/i18n";
import { useAppReleaseStore } from "@/stores/use-app-release-store";

function releaseState(status: AppReleaseState["status"]): AppReleaseState {
    return {
        status,
        policy: status === "idle" ? null : { minVersion: "0.1.0", latestVersion: "9.9.9", downloadUrl: "https://shotshot.ai/download", notes: "", updatedAt: null },
        checkedAt: null,
    };
}

function renderIndicator() {
    return render(
        <I18nextProvider i18n={i18n}>
            <AppReleaseIndicator className="release-indicator" />
        </I18nextProvider>,
    );
}

function mountBridge() {
    (window as unknown as { shotshot?: unknown }).shotshot = { appRelease: { getState: async () => releaseState("idle"), refresh: async () => releaseState("idle"), openDownload: async () => undefined, onChanged: () => () => undefined } };
}

describe("AppReleaseIndicator", () => {
    beforeEach(() => {
        useAppReleaseStore.setState({ state: releaseState("idle"), snoozedUntil: null, releaseModalOpen: false });
    });

    afterEach(() => {
        (window as unknown as { shotshot?: unknown }).shotshot = undefined;
    });

    it("renders nothing on web (no bridge)", () => {
        renderIndicator();
        expect(document.body.querySelector(".release-indicator")).toBeNull();
    });

    it("renders nothing when up to date", () => {
        mountBridge();
        useAppReleaseStore.setState({ state: releaseState("up_to_date") });
        renderIndicator();
        expect(document.body.querySelector(".release-indicator")).toBeNull();
    });

    it("shows 新版本 on soft update and opens the release modal on click", () => {
        mountBridge();
        useAppReleaseStore.setState({ state: releaseState("soft_update") });
        renderIndicator();
        expect(screen.getByText("新版本")).toBeTruthy();
        fireEvent.click(screen.getByText("新版本"));
        expect(useAppReleaseStore.getState().releaseModalOpen).toBe(true);
    });

    it("shows on force update too", () => {
        mountBridge();
        useAppReleaseStore.setState({ state: releaseState("force_update") });
        renderIndicator();
        expect(screen.getByText("新版本")).toBeTruthy();
    });
});
