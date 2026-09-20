import { Button, Modal } from "antd";
import { Copy, Gift, Link2 } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useCopyText } from "@/hooks/use-copy-text";
import type { ReferralInfo } from "@/lib/desktop/account-bridge";

// 邀请好友独立弹窗（账号菜单入口，数据同设置→账户区块）。
// 石色方案：奖励区与统计卡复用 stone 中性灰，数值用 foreground 强调，不引入新色相。
export function ReferralModal({ open, info, reload, onClose }: { open: boolean; info: ReferralInfo; reload: () => void; onClose: () => void }) {
    const { t } = useTranslation();
    const copyText = useCopyText();

    useEffect(() => {
        if (open) reload();
    }, [open, reload]);

    return (
        <Modal
            open={open}
            onCancel={onClose}
            footer={null}
            width={420}
            centered
            zIndex={1900}
            title={
                <div className="flex items-center gap-2.5">
                    <span className="grid size-[34px] place-items-center rounded-[10px] border border-stone-200 bg-stone-100 text-foreground dark:border-stone-700 dark:bg-stone-800">
                        <Gift className="size-4" strokeWidth={1.5} />
                    </span>
                    <span className="text-[15px] font-semibold">{t("config.account.referral.title")}</span>
                </div>
            }
        >
            <div className="pt-1">
                <p className="text-xs leading-6 text-stone-500">{t("config.account.referral.description")}</p>
                <div className="mt-3.5 rounded-xl border border-stone-200 px-3.5 py-3 dark:border-stone-800">
                    <p className="text-center text-xs text-stone-500">{t("config.account.referral.bannerCap")}</p>
                    <div className="mt-2.5 grid grid-cols-2">
                        <div className="text-center">
                            <div className="text-[11px] text-stone-500">{t("config.account.referral.rewardYou")}</div>
                            <div className="mt-0.5 text-xl font-bold tabular-nums">
                                {info.referrerRewardCredits.toLocaleString()}
                                <span className="ml-0.5 text-xs font-semibold">{t("config.account.referral.creditUnit")}</span>
                            </div>
                        </div>
                        <div className="border-l border-stone-200 text-center dark:border-stone-800">
                            <div className="text-[11px] text-stone-500">{t("config.account.referral.rewardFriend")}</div>
                            <div className="mt-0.5 text-xl font-bold tabular-nums">
                                {info.refereeBonusCredits.toLocaleString()}
                                <span className="ml-0.5 text-xs font-semibold">{t("config.account.referral.creditUnit")}</span>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="mt-3.5 text-xs text-stone-500">{t("config.account.referral.shareLabel")}</div>
                <div className="mt-1.5 flex items-center gap-2">
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-stone-50 px-2.5 py-2 text-xs text-stone-500 dark:bg-stone-900/70">
                        <Link2 className="size-3.5 shrink-0 text-stone-400" strokeWidth={1.5} />
                        <code className="truncate">{info.shareUrl}</code>
                    </span>
                    <Button type="primary" icon={<Copy className="size-3.5" strokeWidth={1.5} />} onClick={() => copyText(info.shareUrl)}>
                        {t("config.account.referral.copyLink")}
                    </Button>
                </div>
                <div className="mt-3.5 grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-stone-50 p-2.5 dark:bg-stone-900/70">
                        <div className="text-xs text-stone-500">{t("config.account.referral.statInvited")}</div>
                        <div className="mt-0.5 text-lg font-semibold tabular-nums">
                            {t("config.account.referral.statInvitedValue", { n: info.invitedCount.toLocaleString() })}
                        </div>
                    </div>
                    <div className="rounded-lg bg-stone-50 p-2.5 dark:bg-stone-900/70">
                        <div className="text-xs text-stone-500">{t("config.account.referral.statEarned")}</div>
                        <div className="mt-0.5 text-lg font-semibold tabular-nums">{info.earnedCreditsTotal.toLocaleString()}</div>
                    </div>
                </div>
                <p className="mt-3.5 text-center text-[11px] text-stone-400">{t("config.account.referral.footnote")}</p>
            </div>
        </Modal>
    );
}
