import { useTranslation } from "react-i18next";
import { useAppReleaseStore } from "@/stores/use-app-release-store";

// 侧栏顶部「新版本」提醒：仅桌面端（Web 无升级语义），软提醒或强制升级时显示，点击打开版本弹窗。
export function AppReleaseIndicator({ className }: { className?: string }) {
    const { t } = useTranslation();
    const status = useAppReleaseStore((s) => s.state.status);
    const setReleaseModalOpen = useAppReleaseStore((s) => s.setReleaseModalOpen);
    if (!window.shotshot?.appRelease) return null;
    if (status !== "soft_update" && status !== "force_update") return null;
    return (
        <button
            type="button"
            className={className}
            onClick={() => setReleaseModalOpen(true)}
        >
            {t("version.newVersionPill")}
        </button>
    );
}
