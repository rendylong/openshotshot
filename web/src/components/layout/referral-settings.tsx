import { Button } from "antd";
import { Gift } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCopyText } from "@/hooks/use-copy-text";
import { useReferralInfo } from "@/components/layout/use-referral-info";
import { useUserStore } from "@/stores/use-user-store";

export function ReferralSettings() {
    const { t } = useTranslation();
    const copyText = useCopyText();
    const account = useUserStore((state) => state.account);
    const desktop = typeof window !== "undefined" && Boolean(window.shotshot?.account);
    const { info, disabled } = useReferralInfo();

    if (!desktop || disabled) return null;
    const ready = account.state === "ready" || account.state === "stale";
    if (!ready || !info) return null;

    return (
        <section className="space-y-4" aria-label={t("config.account.referral.title")}>
            <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                    <Gift className="size-4" />
                    {t("config.account.referral.title")}
                </h3>
                <p className="mt-1 text-xs text-stone-500">{t("config.account.referral.description")}</p>
            </div>
            <div className="rounded-xl border border-stone-200 p-4 dark:border-stone-800">
                <p className="text-xs text-stone-500">
                    {t("config.account.referral.rewardLine", { credits: info.referrerRewardCredits })}
                </p>
                <div className="mt-3 flex min-w-0 items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-lg bg-stone-50 px-3 py-2 text-xs dark:bg-stone-900/70">
                        {info.shareUrl}
                    </code>
                    <Button
                        size="small"
                        onClick={() => void copyText(info.shareUrl, t("common.copied"))}
                    >
                        {t("config.account.referral.copyLink")}
                    </Button>
                </div>
                <p className="mt-3 text-xs text-stone-500">
                    {t("config.account.referral.invitedCount", { count: info.invitedCount })}
                    {" · "}
                    {t("config.account.referral.earnedCredits", { credits: info.earnedCreditsTotal })}
                </p>
            </div>
        </section>
    );
}
