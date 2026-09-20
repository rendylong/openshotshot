import { useRef, useState } from "react";
import { Alert, Avatar, Button, Popover, Tag } from "antd";
import { BookOpen, CircleUserRound, ExternalLink, Gift, History, Languages, LogIn, RefreshCw, Settings2, SunMoon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DOCS_URL } from "@/constant/env";
import { changeAppLocale, type AppLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import type { DesktopAccountSnapshot } from "@/lib/desktop/auth-types";
import { ReferralModal } from "@/components/layout/referral-modal";
import { useReferralInfo } from "@/components/layout/use-referral-info";
import { useAppReleaseStore } from "@/stores/use-app-release-store";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";

const menuRowClass =
    "flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground transition hover:bg-accent hover:text-foreground";

function Segmented({ options, value, onChange }: { options: Array<{ value: string; label: string }>; value: string; onChange: (value: string) => void }) {
    return (
        <span className="flex shrink-0 items-center rounded-md bg-stone-100 p-0.5 dark:bg-stone-800">
            {options.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    onClick={() => onChange(option.value)}
                    className={cn(
                        "rounded px-2 py-0.5 text-xs transition",
                        option.value === value ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                >
                    {option.label}
                </button>
            ))}
        </span>
    );
}

// 桌面端专属账户入口（Web 端无账户 bridge，本组件返回 null，由 sidebar 渲染 SettingsPopover）。
// 浮层结构 = 账户区（随登录态变化）+ 通用菜单（恒定，不依赖登录态）+ 已登录底部「管理账户与套餐」。
// 退出登录不放在浮层，唯一入口保留在配置弹窗「账户」tab。
// collapsed = 侧栏折叠态：触发器收成 40px 图标按钮（仅头像），浮层内容不变。
export function UserMenuButton({ onOpenChange, collapsed = false }: { onOpenChange?: (open: boolean) => void; collapsed?: boolean }) {
    const { t, i18n } = useTranslation();
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const account = useUserStore((state) => state.account);
    const signIn = useUserStore((state) => state.signIn);
    const retrySignIn = useUserStore((state) => state.retrySignIn);
    const cancelSignIn = useUserStore((state) => state.cancelSignIn);
    const openAccountPage = useUserStore((state) => state.openAccountPage);
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const releaseStatus = useAppReleaseStore((state) => state.state.status);
    const setReleaseModalOpen = useAppReleaseStore((state) => state.setReleaseModalOpen);
    const { info: referralInfo, reload: reloadReferral } = useReferralInfo();
    const [inviteOpen, setInviteOpen] = useState(false);
    const hasNewVersion = releaseStatus === "soft_update" || releaseStatus === "force_update";
    const desktop = typeof window !== "undefined" && Boolean(window.shotshot?.account);
    const locale = i18n.resolvedLanguage as AppLocale;
    // 与 account-settings.tsx 一致：loading 沿用上次快照，避免登录跳转期间闪回未登录
    const snapshot = account.state === "ready" || account.state === "stale"
        ? account.snapshot
        : account.state === "loading" ? account.previous : undefined;
    const identity = snapshot ? snapshot.account.displayName || snapshot.account.email || t("config.account.anonymous") : "";
    const statusDot = account.state === "stale" ? "bg-amber-500" : account.state === "error" ? "bg-red-500" : null;

    const updateOpen = (next: boolean) => {
        setOpen(next);
        onOpenChange?.(next);
    };
    const close = () => updateOpen(false);

    if (!desktop) return null;

    const trigger = (
        <button
            ref={triggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={snapshot ? t("sidebar.user.account") : t("sidebar.user.signIn")}
            className={cn(
                "flex h-10 items-center rounded-lg text-sm leading-6 text-muted-foreground transition hover:bg-accent hover:text-foreground",
                collapsed ? "w-10 shrink-0 justify-center" : "min-w-0 flex-1 gap-2.5 px-2",
            )}
        >
            <span className="relative shrink-0">
                {snapshot ? (
                    <Avatar size={24} src={snapshot.account.avatarUrl || undefined}>
                        {identity.slice(0, 1).toUpperCase()}
                    </Avatar>
                ) : (
                    <span className="grid size-6 place-items-center rounded-full border border-dashed border-stone-300 text-stone-400 dark:border-stone-600">
                        <CircleUserRound className="size-3.5" strokeWidth={1.5} />
                    </span>
                )}
                {statusDot ? <span className={cn("absolute -right-0.5 -top-0.5 size-2 rounded-full ring-1 ring-background", statusDot)} /> : null}
            </span>
            {!collapsed && <span className="min-w-0 truncate">{snapshot ? t(`config.account.plans.${snapshot.subscription.plan}`) : t("sidebar.user.signIn")}</span>}
        </button>
    );

    const content = (
        <div className="w-72 py-1">
            {account.state === "signing-in" ? (
                <div className="px-3 pb-1 pt-2">
                    <Alert type="info" showIcon title={t("config.account.browserOpened")} />
                    <div className="mt-2 flex justify-end gap-2">
                        {/* autoInsertSpace 关闭：antd 默认在两字中文按钮插入空格，会改变可访问名称「取消」 */}
                        <Button size="small" autoInsertSpace={false} onClick={() => void cancelSignIn()}>{t("config.account.cancelSignIn")}</Button>
                        <Button size="small" type="primary" icon={<RefreshCw className="size-3" />} onClick={() => void retrySignIn()}>{t("config.account.retrySignIn")}</Button>
                    </div>
                </div>
            ) : null}
            {!snapshot && account.state !== "signing-in" && account.state !== "loading" ? (
                <div className="px-3 pb-2 pt-3">
                    <div className="flex items-center gap-3">
                        <Avatar size={40} className="border border-dashed border-stone-300 !bg-transparent text-stone-400 dark:border-stone-600">
                            <CircleUserRound className="size-5" strokeWidth={1.5} />
                        </Avatar>
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold">{t("sidebar.user.guideTitle")}</div>
                            <div className="mt-0.5 text-xs leading-5 text-stone-500">{t("sidebar.user.guideDescription")}</div>
                        </div>
                    </div>
                    {account.state === "error" ? (
                        <Alert
                            type="error"
                            showIcon
                            className="mt-3"
                            title={t(`config.account.errors.${account.code}`, { defaultValue: t("config.account.errors.unknown") })}
                        />
                    ) : (
                        <>
                            <Button block type="primary" icon={<LogIn className="size-4" />} className="mt-3" onClick={() => void signIn()}>
                                {t("config.account.signIn")}
                            </Button>
                            <div className="mt-2 text-center text-xs text-stone-400">{t("sidebar.user.signInHint")}</div>
                        </>
                    )}
                </div>
            ) : null}
            {snapshot ? (
                <div className="px-3 pb-2 pt-3">
                    <div className="flex min-w-0 items-center gap-3">
                        <Avatar size={40} src={snapshot.account.avatarUrl || undefined}>{identity.slice(0, 1).toUpperCase()}</Avatar>
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold" title={identity}>{identity}</div>
                            {snapshot.account.email && snapshot.account.email !== identity ? <div className="truncate text-xs text-stone-500">{snapshot.account.email}</div> : null}
                        </div>
                        <Tag color={snapshot.subscription.status === "active" ? "green" : "default"}>{t(`config.account.plans.${snapshot.subscription.plan}`)}</Tag>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                        <div className="rounded-lg bg-stone-50 p-2.5 dark:bg-stone-900/70">
                            <div className="text-xs text-stone-500">{t("config.account.remainingCredits")}</div>
                            <div className="mt-0.5 text-lg font-semibold tabular-nums">{snapshot.usage.balance.toLocaleString()}</div>
                        </div>
                        <div className="rounded-lg bg-stone-50 p-2.5 dark:bg-stone-900/70">
                            <div className="text-xs text-stone-500">{t("config.account.usedCredits")}</div>
                            <div className="mt-0.5 text-lg font-semibold tabular-nums">{snapshot.usage.usedUnits.toLocaleString()}</div>
                        </div>
                    </div>
                    {snapshot.subscription.cancelAtPeriodEnd ? (
                        <Alert
                            type="warning"
                            showIcon
                            className="mt-2"
                            title={t("config.account.canceling", { date: snapshot.subscription.currentPeriodEndsAt ? new Date(snapshot.subscription.currentPeriodEndsAt).toLocaleDateString(i18n.resolvedLanguage) : t("config.account.periodEnd") })}
                        />
                    ) : null}
                    {account.state === "stale" ? <Alert type="warning" showIcon className="mt-2" title={t("config.account.stale")} /> : null}
                </div>
            ) : null}
            <div className="my-1 h-px bg-stone-200 dark:bg-stone-800" />
            <div className="py-1">
                <button
                    type="button"
                    className={menuRowClass}
                    onClick={() => {
                        openConfigDialog(false);
                        close();
                    }}
                >
                    <Settings2 className="size-4" strokeWidth={1.5} />
                    {t("sidebar.user.settings")}
                </button>
                {snapshot && referralInfo ? (
                    <button
                        type="button"
                        className={menuRowClass}
                        onClick={() => {
                            setInviteOpen(true);
                            close();
                        }}
                    >
                        <Gift className="size-4" strokeWidth={1.5} />
                        {t("config.account.referral.title")}
                    </button>
                ) : null}
                <button
                    type="button"
                    className={menuRowClass}
                    onClick={() => {
                        setReleaseModalOpen(true);
                        close();
                    }}
                >
                    <History className="size-4" strokeWidth={1.5} />
                    {t("sidebar.user.updates")}
                    {hasNewVersion ? <span className="ml-1 size-1.5 rounded-full bg-green-500" aria-hidden="true" /> : null}
                </button>
                <div className={menuRowClass}>
                    <SunMoon className="size-4" strokeWidth={1.5} />
                    {t("sidebar.user.theme")}
                    <span className="flex-1" />
                    <Segmented
                        options={[{ value: "light", label: t("sidebar.user.themeLight") }, { value: "dark", label: t("sidebar.user.themeDark") }]}
                        value={theme}
                        onChange={(next) => setTheme(next as "light" | "dark")}
                    />
                </div>
                <div className={menuRowClass}>
                    <Languages className="size-4" strokeWidth={1.5} />
                    {t("sidebar.user.language")}
                    <span className="flex-1" />
                    <Segmented
                        options={[{ value: "zh-CN", label: t("locale.zhCN") }, { value: "en-US", label: t("locale.enUS") }]}
                        value={locale}
                        onChange={(next) => void changeAppLocale(next as AppLocale)}
                    />
                </div>
                <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className={menuRowClass} onClick={close}>
                    <BookOpen className="size-4" strokeWidth={1.5} />
                    {t("sidebar.settings.docs")}
                </a>
            </div>
            {snapshot ? (
                <>
                    <div className="my-1 h-px bg-stone-200 dark:bg-stone-800" />
                    <div className="py-1">
                        <button
                            type="button"
                            className={menuRowClass}
                            onClick={() => {
                                void openAccountPage();
                                close();
                            }}
                        >
                            <ExternalLink className="size-4" strokeWidth={1.5} />
                            {t("config.account.manage")}
                        </button>
                    </div>
                </>
            ) : null}
        </div>
    );

    return (
        <>
            <Popover
                open={open}
                onOpenChange={updateOpen}
                trigger="click"
                placement="top"
                content={content}
                afterOpenChange={(visible) => {
                    if (!visible) triggerRef.current?.focus();
                }}
            >
                {trigger}
            </Popover>
            {referralInfo ? (
                <ReferralModal open={inviteOpen} info={referralInfo} reload={reloadReferral} onClose={() => setInviteOpen(false)} />
            ) : null}
        </>
    );
}
