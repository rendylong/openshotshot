import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "antd";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, test, vi } from "vitest";
import { UserMenuButton } from "./user-menu-button";
import i18n, { changeAppLocale } from "@/i18n";
import type { AccountBridge } from "@/lib/desktop/account-bridge";
import type { DesktopAccountSnapshot } from "@/lib/desktop/auth-types";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";

// antd Popover 依赖 jsdom 没有的布局 API，替换为受控透传；其余 antd 组件按真实实现渲染
// （account-settings.test.tsx 已验证真实 antd 可在 jsdom 工作）。
vi.mock("antd", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    Popover: ({ children, content, open, onOpenChange }: { children: React.ReactNode; content: React.ReactNode; open: boolean; onOpenChange?: (open: boolean) => void }) => (
        <>
            <span onClick={() => onOpenChange?.(!open)}>{children}</span>
            {open ? <div role="menu">{content}</div> : null}
        </>
    ),
}));

// 避免真实切换语言污染模块级 i18n 单例，只断言调用参数。
vi.mock("@/i18n", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    changeAppLocale: vi.fn(async () => undefined),
}));

const snapshot: DesktopAccountSnapshot = {
    account: { subjectId: "subject-1", email: "user@example.com", displayName: "Longhai", avatarUrl: null },
    subscription: { plan: "free", status: "active", currentPeriodEndsAt: null, cancelAtPeriodEnd: false },
    usage: { balance: 1240, usedUnits: 86, periodStart: "2026-09-01", periodEnd: "2026-10-01" },
    entitlements: [],
    fetchedAt: "2026-09-15T00:00:00.000Z",
};

function withDesktopBridge() {
    window.shotshot = { account: {} as AccountBridge, agent: {} as never, skills: {} as never, platform: "darwin" };
}

function view() {
    return render(<I18nextProvider i18n={i18n}><UserMenuButton /></I18nextProvider>);
}

afterEach(() => {
    useUserStore.setState({ account: { state: "signed-out" } });
    useConfigStore.setState({ config: defaultConfig });
    useThemeStore.setState({ theme: "dark" });
    vi.mocked(changeAppLocale).mockClear();
    delete window.shotshot;
});

describe("UserMenuButton", () => {
    test("renders nothing without the desktop bridge", () => {
        const { container } = view();
        expect(container).toBeEmptyDOMElement();
    });

    test("signed-out shows the sign-in guide and the shared menu", () => {
        const signIn = vi.fn(async () => undefined);
        withDesktopBridge();
        useUserStore.setState({ account: { state: "signed-out" }, signIn });
        view();
        fireEvent.click(screen.getByRole("button", { name: "登录" }));
        expect(screen.getByText("登录 Shotshot")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "使用 Google 登录" })).toBeInTheDocument();
        // 通用菜单不依赖登录态（spec §9.5）：BYOK 入口未登录也必须可达
        expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
        expect(screen.getByText("主题")).toBeInTheDocument();
        expect(screen.getByText("语言")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "帮助与文档" })).toHaveAttribute("href", "https://shotshot.ai/docs");
        fireEvent.click(screen.getByRole("button", { name: "使用 Google 登录" }));
        expect(signIn).toHaveBeenCalledOnce();
    });

    test("signing-in shows browser status with cancel and retry", () => {
        const cancelSignIn = vi.fn(async () => undefined);
        const retrySignIn = vi.fn(async () => undefined);
        withDesktopBridge();
        useUserStore.setState({ account: { state: "signing-in" }, cancelSignIn, retrySignIn });
        view();
        fireEvent.click(screen.getByRole("button", { name: "登录" }));
        expect(screen.getByText("浏览器已打开。授权完成后会自动返回 Shotshot。")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "取消" }));
        expect(cancelSignIn).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByRole("button", { name: /重新尝试/ }));
        expect(retrySignIn).toHaveBeenCalledOnce();
    });

    test("ready shows plan, credits and the account entry without sign-out", () => {
        const openConfigDialog = vi.fn();
        withDesktopBridge();
        useUserStore.setState({ account: { state: "ready", snapshot } });
        useConfigStore.setState({ openConfigDialog });
        view();
        fireEvent.click(screen.getByRole("button", { name: "账户" }));
        expect(screen.getAllByText("免费版").length).toBeGreaterThan(0);
        expect(screen.getByText("1,240")).toBeInTheDocument();
        expect(screen.getByText("86")).toBeInTheDocument();
        // 决策 4：退出登录不在浮层，唯一入口在配置弹窗「账户」tab
        expect(screen.queryByText(/退出登录/)).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "设置" }));
        expect(openConfigDialog).toHaveBeenCalledWith(false);
    });

    test("manage entry reopens after settings closes and calls openAccountPage", async () => {
        const openAccountPage = vi.fn(async () => undefined);
        withDesktopBridge();
        useUserStore.setState({ account: { state: "ready", snapshot }, openAccountPage });
        view();
        fireEvent.click(screen.getByRole("button", { name: "账户" }));
        // 「设置」收起浮层（与 settings-popover 行为一致），重新点触发按钮再进「管理账户与套餐」
        fireEvent.click(screen.getByRole("button", { name: "设置" }));
        fireEvent.click(screen.getByRole("button", { name: "账户" }));
        fireEvent.click(screen.getByRole("button", { name: "管理账户与套餐" }));
        await waitFor(() => expect(openAccountPage).toHaveBeenCalledOnce());
    });

    const referralInfo = {
        enabled: true,
        code: "A7K2QM9",
        referrerRewardCredits: 100,
        refereeBonusCredits: 50,
        invitedCount: 6,
        revokedCount: 0,
        earnedCreditsTotal: 600,
        shareUrl: "https://shotshot.ai/i/A7K2QM9",
    };

    test("invite entry opens the referral modal when the campaign is enabled", async () => {
        const getReferralInfo = vi.fn(async () => referralInfo);
        withDesktopBridge();
        window.shotshot!.account!.getReferralInfo = getReferralInfo;
        useUserStore.setState({ account: { state: "ready", snapshot } });
        render(<I18nextProvider i18n={i18n}><App><UserMenuButton /></App></I18nextProvider>);
        fireEvent.click(screen.getByRole("button", { name: "账户" }));
        const inviteRow = await screen.findByRole("button", { name: "邀请好友" });
        fireEvent.click(inviteRow);
        // 弹窗为独立 Modal：打开后展示链接、双向奖励与统计，并刷新一次统计
        expect(await screen.findByText("你的专属邀请链接")).toBeInTheDocument();
        expect(screen.getByText("已邀请好友")).toBeInTheDocument();
        expect(screen.getByText("6 人")).toBeInTheDocument();
        await waitFor(() => expect(getReferralInfo.mock.calls.length).toBeGreaterThanOrEqual(2));
    });

    test("invite entry stays hidden when the campaign is disabled", async () => {
        const getReferralInfo = vi.fn(async () => ({ ...referralInfo, enabled: false }));
        withDesktopBridge();
        window.shotshot!.account!.getReferralInfo = getReferralInfo;
        useUserStore.setState({ account: { state: "ready", snapshot } });
        view();
        fireEvent.click(screen.getByRole("button", { name: "账户" }));
        await waitFor(() => expect(getReferralInfo).toHaveBeenCalledOnce());
        expect(screen.queryByRole("button", { name: "邀请好友" })).not.toBeInTheDocument();
    });

    test("theme and language segmented controls dispatch", () => {
        withDesktopBridge();
        useUserStore.setState({ account: { state: "signed-out" } });
        useThemeStore.setState({ theme: "light" });
        view();
        fireEvent.click(screen.getByRole("button", { name: "登录" }));
        fireEvent.click(screen.getByRole("button", { name: "深色" }));
        expect(useThemeStore.getState().theme).toBe("dark");
        fireEvent.click(screen.getByRole("button", { name: "English" }));
        expect(vi.mocked(changeAppLocale)).toHaveBeenCalledWith("en-US");
    });

    test("stale keeps showing the snapshot with a warning", () => {
        withDesktopBridge();
        useUserStore.setState({ account: { state: "stale", snapshot, code: "account_refresh_failed" } });
        view();
        fireEvent.click(screen.getByRole("button", { name: "账户" }));
        expect(screen.getByText("账户数据可能不是最新状态，当前显示上次成功获取的结果。")).toBeInTheDocument();
    });

    test("collapsed mode keeps only the avatar trigger", () => {
        withDesktopBridge();
        useUserStore.setState({ account: { state: "ready", snapshot } });
        render(<I18nextProvider i18n={i18n}><UserMenuButton collapsed /></I18nextProvider>);
        const trigger = screen.getByRole("button", { name: "账户" });
        expect(trigger).toHaveClass("w-10", "justify-center");
        // 侧栏折叠态：只留头像，无套餐文字
        expect(trigger).not.toHaveTextContent("免费版");
    });
});
