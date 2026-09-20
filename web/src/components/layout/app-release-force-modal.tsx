import { useEffect, useState } from "react";
import { Button, Modal } from "antd";
import { useTranslation } from "react-i18next";
import { APP_VERSION } from "@/constant/env";
import { appReleaseForceModalVisible, useAppReleaseStore } from "@/stores/use-app-release-store";

const SNOOZE_TICK_MS = 30_000;

export function AppReleaseForceModal() {
    const { t } = useTranslation();
    const state = useAppReleaseStore((s) => s.state);
    const snoozedUntil = useAppReleaseStore((s) => s.snoozedUntil);
    const snooze = useAppReleaseStore((s) => s.snooze);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), SNOOZE_TICK_MS);
        return () => clearInterval(timer);
    }, []);

    const open = appReleaseForceModalVisible(state, snoozedUntil, now);
    if (!open) return null;
    const policy = state.policy;

    return (
        <Modal
            open={open}
            title={t("version.forceTitle")}
            centered
            zIndex={1900}
            keyboard={false}
            maskClosable={false}
            closable={false}
            footer={null}
            width={420}
        >
            <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
                {t("version.forceBody", { local: APP_VERSION, min: policy?.minVersion ?? "", latest: policy?.latestVersion ?? "" })}
            </p>
            {policy?.notes ? (
                <p className="mt-2 rounded-lg border border-stone-200 p-2 text-xs text-stone-500 dark:border-stone-800 dark:text-stone-400">
                    {policy.notes}
                </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
                <Button onClick={snooze}>{t("version.snooze")}</Button>
                <Button type="primary" onClick={() => void window.shotshot?.appRelease?.openDownload()}>
                    {t("version.goDownload")}
                </Button>
            </div>
        </Modal>
    );
}
