import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import copy from "copy-to-clipboard";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ReferralSettings } from "./referral-settings";
import i18n from "@/i18n";
import type { AccountBridge, ReferralInfo } from "@/lib/desktop/account-bridge";
import type { DesktopAccountSnapshot } from "@/lib/desktop/auth-types";
import { useUserStore } from "@/stores/use-user-store";

vi.mock("copy-to-clipboard", () => ({ default: vi.fn() }));

function snapshot(): DesktopAccountSnapshot {
    return {
        account: { subjectId: "subject-1", email: "user@example.com", displayName: "Shotshot User", avatarUrl: null },
        subscription: { plan: "pro", status: "active", currentPeriodEndsAt: "2026-10-01T00:00:00.000Z", cancelAtPeriodEnd: false },
        usage: { balance: 900, usedUnits: 100, periodStart: "2026-09-01", periodEnd: "2026-10-01" },
        entitlements: [{ code: "managed-models", state: "active", limitValue: 1000, validUntil: null }],
        fetchedAt: "2026-09-05T00:00:00.000Z",
    };
}

function referralInfo(overrides: Partial<ReferralInfo> = {}): ReferralInfo {
    return {
        enabled: true,
        code: "AB2CD9EF",
        referrerRewardCredits: 100,
        refereeBonusCredits: 50,
        invitedCount: 3,
        revokedCount: 0,
        earnedCreditsTotal: 300,
        shareUrl: "https://shotshot.ai/i/AB2CD9EF",
        ...overrides,
    };
}

function stubDesktop(getReferralInfo: AccountBridge["getReferralInfo"]) {
    window.shotshot = { account: { getReferralInfo } as unknown as AccountBridge, agent: {} as never, skills: {} as never, platform: "darwin" };
}

function view() {
    return render(<I18nextProvider i18n={i18n}><AntApp><ReferralSettings /></AntApp></I18nextProvider>);
}

afterEach(() => {
    useUserStore.setState({ account: { state: "signed-out" } });
    delete window.shotshot;
    vi.mocked(copy).mockClear();
});

describe("ReferralSettings", () => {
    test("renders title, reward line, share link, and copies the link for a signed-in user", async () => {
        const getReferralInfo = vi.fn(async () => referralInfo());
        stubDesktop(getReferralInfo);
        useUserStore.setState({ account: { state: "ready", snapshot: snapshot() } });
        view();

        expect(await screen.findByRole("region", { name: "邀请好友" })).toBeInTheDocument();
        expect(screen.getByText("当前活动：每邀请 1 位新用户注册，你获得 100 积分（以对方注册时的活动奖励为准）")).toBeInTheDocument();
        expect(screen.getByText("https://shotshot.ai/i/AB2CD9EF")).toBeInTheDocument();
        expect(screen.getByText("已邀请 3 人 · 已获得 300 积分")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "复制邀请链接" }));
        expect(copy).toHaveBeenCalledWith("https://shotshot.ai/i/AB2CD9EF");
    });

    test("renders nothing when the referral campaign is disabled", async () => {
        const getReferralInfo = vi.fn(async () => referralInfo({ enabled: false }));
        stubDesktop(getReferralInfo);
        useUserStore.setState({ account: { state: "ready", snapshot: snapshot() } });
        view();

        await waitFor(() => expect(getReferralInfo).toHaveBeenCalledOnce());
        await act(async () => {});
        expect(screen.queryByText("邀请好友")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "复制邀请链接" })).not.toBeInTheDocument();
    });

    test("renders nothing when the referral info channel fails", async () => {
        const getReferralInfo = vi.fn(async () => Promise.reject(new Error("invalid_referral_payload")));
        stubDesktop(getReferralInfo);
        useUserStore.setState({ account: { state: "ready", snapshot: snapshot() } });
        view();

        await waitFor(() => expect(getReferralInfo).toHaveBeenCalledOnce());
        await act(async () => {});
        expect(screen.queryByText("邀请好友")).not.toBeInTheDocument();
    });

    test("renders nothing outside the desktop app", () => {
        useUserStore.setState({ account: { state: "ready", snapshot: snapshot() } });
        view();
        expect(screen.queryByText("邀请好友")).not.toBeInTheDocument();
    });
});
