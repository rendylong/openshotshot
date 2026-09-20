import { Alert, Avatar, Button, Skeleton, Tag } from "antd";
import { ExternalLink, LogIn, LogOut, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DesktopAccountSnapshot } from "@/lib/desktop/auth-types";
import { useUserStore } from "@/stores/use-user-store";

function Snapshot({ snapshot }: { snapshot: DesktopAccountSnapshot }) {
    const { t, i18n } = useTranslation();
    const identity = snapshot.account.displayName || snapshot.account.email || t("config.account.anonymous");
    const periodEnd = snapshot.subscription.currentPeriodEndsAt
        ? new Date(snapshot.subscription.currentPeriodEndsAt).toLocaleDateString(i18n.resolvedLanguage)
        : null;
    return (
        <div className="space-y-4">
            <div className="flex min-w-0 items-center gap-3 rounded-xl border border-stone-200 p-4 dark:border-stone-800">
                <Avatar size={44} src={snapshot.account.avatarUrl || undefined}>{identity.slice(0, 1).toUpperCase()}</Avatar>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold" title={identity}>{identity}</div>
                    {snapshot.account.email && snapshot.account.email !== identity ? <div className="truncate text-xs text-stone-500">{snapshot.account.email}</div> : null}
                </div>
                <Tag color={snapshot.subscription.status === "active" ? "green" : "default"}>
                    {t(`config.account.plans.${snapshot.subscription.plan}`)}
                </Tag>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl bg-stone-50 p-4 dark:bg-stone-900/70">
                    <div className="text-xs text-stone-500">{t("config.account.remainingCredits")}</div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums">{snapshot.usage.balance.toLocaleString()}</div>
                </div>
                <div className="rounded-xl bg-stone-50 p-4 dark:bg-stone-900/70">
                    <div className="text-xs text-stone-500">{t("config.account.usedCredits")}</div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums">{snapshot.usage.usedUnits.toLocaleString()}</div>
                </div>
            </div>
            {snapshot.subscription.cancelAtPeriodEnd ? (
                <Alert type="warning" showIcon title={t("config.account.canceling", { date: periodEnd || t("config.account.periodEnd") })} />
            ) : null}
        </div>
    );
}

export function AccountSettings() {
    const { t } = useTranslation();
    const account = useUserStore((state) => state.account);
    const signIn = useUserStore((state) => state.signIn);
    const retrySignIn = useUserStore((state) => state.retrySignIn);
    const cancelSignIn = useUserStore((state) => state.cancelSignIn);
    const signOut = useUserStore((state) => state.signOut);
    const refresh = useUserStore((state) => state.refresh);
    const openAccountPage = useUserStore((state) => state.openAccountPage);
    const desktop = typeof window !== "undefined" && Boolean(window.shotshot?.account);
    const snapshot = account.state === "ready" || account.state === "stale"
        ? account.snapshot
        : account.state === "loading" ? account.previous : undefined;

    return (
        <section className="space-y-4" aria-label={t("config.account.title")}>
            <div>
                <h3 className="text-sm font-semibold">{t("config.account.title")}</h3>
                <p className="mt-1 text-xs text-stone-500">{t("config.account.description")}</p>
            </div>
            {account.state === "stale" ? <Alert type="warning" showIcon title={t("config.account.stale")} /> : null}
            {account.state === "error" ? <Alert type="error" showIcon title={t(`config.account.errors.${account.code}`, { defaultValue: t("config.account.errors.unknown") })} /> : null}
            {snapshot ? <Snapshot snapshot={snapshot} /> : null}
            {account.state === "loading" && !snapshot ? <Skeleton active paragraph={{ rows: 3 }} /> : null}
            {(account.state === "signed-out" || account.state === "error") ? (
                <div className="rounded-xl border border-dashed border-stone-300 p-6 text-center dark:border-stone-700">
                    <div className="text-sm font-medium">{t("config.account.signedOut")}</div>
                    <div className="mt-1 text-xs text-stone-500">{t(desktop ? "config.account.signInDescription" : "config.account.desktopOnly")}</div>
                    <Button className="mt-4" type="primary" icon={<LogIn className="size-4" />} disabled={!desktop} onClick={() => void signIn()}>
                        {t("config.account.signIn")}
                    </Button>
                </div>
            ) : null}
            {account.state === "signing-in" ? (
                <Alert
                    type="info"
                    showIcon
                    title={t("config.account.browserOpened")}
                    action={(
                        <div className="flex flex-wrap justify-end gap-2">
                            <Button size="small" onClick={() => void cancelSignIn()}>{t("config.account.cancelSignIn")}</Button>
                            <Button size="small" type="primary" icon={<RefreshCw className="size-4" />} onClick={() => void retrySignIn()}>
                                {t("config.account.retrySignIn")}
                            </Button>
                        </div>
                    )}
                />
            ) : null}
            {snapshot ? (
                <div className="flex flex-wrap gap-2">
                    <Button icon={<RefreshCw className="size-4" />} loading={account.state === "loading"} onClick={() => void refresh()}>{t("config.account.refresh")}</Button>
                    <Button icon={<ExternalLink className="size-4" />} onClick={() => void openAccountPage()}>{t("config.account.manage")}</Button>
                    <Button danger icon={<LogOut className="size-4" />} onClick={() => void signOut()}>{t("config.account.signOut")}</Button>
                </div>
            ) : null}
        </section>
    );
}
