import { fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp } from "antd";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AccountSettings } from "./account-settings";
import i18n from "@/i18n";
import type { DesktopAccountSnapshot } from "@/lib/desktop/auth-types";
import type { AccountBridge } from "@/lib/desktop/account-bridge";
import { useUserStore } from "@/stores/use-user-store";

function snapshot(overrides: Partial<DesktopAccountSnapshot> = {}): DesktopAccountSnapshot {
    return {
        account: { subjectId: "subject-1", email: "user@example.com", displayName: "Shotshot User", avatarUrl: null },
        subscription: { plan: "pro", status: "active", currentPeriodEndsAt: "2026-10-01T00:00:00.000Z", cancelAtPeriodEnd: false },
        usage: { balance: 900, usedUnits: 100, periodStart: "2026-09-01", periodEnd: "2026-10-01" },
        entitlements: [{ code: "managed-models", state: "active", limitValue: 1000, validUntil: null }],
        fetchedAt: "2026-09-05T00:00:00.000Z",
        ...overrides,
    };
}

function view() {
    return render(<I18nextProvider i18n={i18n}><AntApp><AccountSettings /></AntApp></I18nextProvider>);
}

afterEach(() => {
    useUserStore.setState({ account: { state: "signed-out" } });
    delete window.shotshot;
});

describe("AccountSettings", () => {
    test("signs in from the signed-out state", () => {
        const signIn = vi.fn(async () => undefined);
        window.shotshot = { account: {} as AccountBridge, agent: {} as never, skills: {} as never, platform: "darwin" };
        useUserStore.setState({ account: { state: "signed-out" }, signIn });
        view();
        fireEvent.click(screen.getByRole("button", { name: "使用 Google 登录" }));
        expect(signIn).toHaveBeenCalledOnce();
    });

    test("offers retry and cancel actions while browser sign-in is pending", () => {
        const retrySignIn = vi.fn(async () => undefined);
        const cancelSignIn = vi.fn(async () => undefined);
        window.shotshot = { account: {} as AccountBridge, agent: {} as never, skills: {} as never, platform: "darwin" };
        useUserStore.setState({
            account: { state: "signing-in" },
            retrySignIn,
            cancelSignIn,
        });
        view();

        fireEvent.click(screen.getByRole("button", { name: "重新尝试" }));
        fireEvent.click(screen.getByRole("button", { name: /取\s*消/ }));

        expect(retrySignIn).toHaveBeenCalledOnce();
        expect(cancelSignIn).toHaveBeenCalledOnce();
    });

    test("shows identity, plan, remaining credits, and period usage", () => {
        useUserStore.setState({ account: { state: "ready", snapshot: snapshot() } });
        view();
        expect(screen.getByText("Shotshot User")).toBeInTheDocument();
        expect(screen.getByText("Pro")).toBeInTheDocument();
        expect(screen.getByText("900")).toBeInTheDocument();
        expect(screen.getByText("100")).toBeInTheDocument();
    });

    test("keeps zero balance visible and warns for stale/canceling data", () => {
        useUserStore.setState({ account: { state: "stale", code: "account_refresh_failed", snapshot: snapshot({
            usage: { ...snapshot().usage, balance: 0 },
            subscription: { ...snapshot().subscription, cancelAtPeriodEnd: true },
        }) } });
        view();
        expect(screen.getByText("0")).toBeInTheDocument();
        expect(screen.getByText("账户数据可能不是最新状态，当前显示上次成功获取的结果。")).toBeInTheDocument();
        expect(screen.getByText(/套餐将在/)).toBeInTheDocument();
    });

    test("renders loading and named errors without exposing implementation details", () => {
        useUserStore.setState({ account: { state: "error", code: "secure_storage_unavailable" } });
        view();
        expect(screen.getByText("当前系统无法安全保存登录凭据，请检查系统钥匙串后重试。")).toBeInTheDocument();
    });
});
