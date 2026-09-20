import { useCallback, useEffect, useState } from "react";
import type { ReferralInfo } from "@/lib/desktop/account-bridge";
import { useUserStore } from "@/stores/use-user-store";

// 桌面端邀请活动信息（getReferralInfo），账号菜单入口与设置→账户区块共用。
// 登录快照就绪（ready/stale）后拉取；拉取失败或活动关闭视为不可用（入口整体隐藏）。
// reload 供弹窗打开时刷新统计，刷新失败保留旧数据不隐藏入口。
export function useReferralInfo() {
    const desktop = typeof window !== "undefined" && Boolean(window.shotshot?.account);
    const accountState = useUserStore((state) => state.account.state);
    const [info, setInfo] = useState<ReferralInfo | null>(null);
    const [disabled, setDisabled] = useState(false);

    const load = useCallback(
        async (isReload = false) => {
            if (!desktop) return;
            try {
                const value = await window.shotshot!.account!.getReferralInfo();
                setDisabled(!value.enabled);
                setInfo(value.enabled ? value : null);
            } catch {
                if (!isReload) {
                    setDisabled(true);
                    setInfo(null);
                }
            }
        },
        [desktop],
    );

    useEffect(() => {
        if (accountState === "ready" || accountState === "stale") void load();
    }, [accountState, load]);

    return { info, disabled, reload: () => load(true) };
}
