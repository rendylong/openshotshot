import { useEffect, useRef } from "react";
import { Modal, Tag, Timeline } from "antd";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useVersionCheck } from "@/hooks/use-version-check";
import { APP_VERSION } from "@/constant/env";
import { MODAL_WIDTH } from "@/lib/design/modal";
import { useAppReleaseStore } from "@/stores/use-app-release-store";

function getTagColor(type: string) {
    if (type === "新增" || type === "Added") return "green";
    if (type === "修复" || type === "Fixed") return "red";
    if (type === "调整" || type === "Changed") return "blue";
    if (type === "文档" || type === "Docs") return "purple";
    return "default";
}

function releaseTypeLabel(type: string, t: TFunction) {
    const key = ({ 新增: "added", 修复: "fixed", 调整: "changed", 优化: "optimized", 文档: "docs" } as Record<string, string>)[type];
    return key ? t(`version.types.${key}`) : type;
}

// 纯弹窗（无触发按钮）：开关在 use-app-release-store，入口为侧栏顶部「新版本」提醒与设置菜单。
export function VersionReleaseModal() {
    const { t } = useTranslation();
    const { latestVersion, releases, checking, hasNewVersion, checkLatestRelease, notes, canDownload, latestVersionFromPolicy } = useVersionCheck();
    const open = useAppReleaseStore((s) => s.releaseModalOpen);
    const setReleaseModalOpen = useAppReleaseStore((s) => s.setReleaseModalOpen);

    // 打开时刷新一次（与旧触发按钮行为一致：打开即检查）
    const openedRef = useRef(false);
    useEffect(() => {
        if (open && !openedRef.current) {
            openedRef.current = true;
            void checkLatestRelease();
        }
        if (!open) openedRef.current = false;
    });

    return (
        <Modal title={t("version.title")} open={open} width={MODAL_WIDTH.md} centered footer={null} onCancel={() => setReleaseModalOpen(false)}>
                <div className="mb-5 grid grid-cols-2 gap-3">
                    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="text-xs text-stone-500 dark:text-stone-400">{t("version.currentVersion")}</div>
                        <div className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100">{APP_VERSION}</div>
                    </div>
                    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="flex items-center justify-between gap-3">
                            <div className="text-xs text-stone-500 dark:text-stone-400">{t("version.latestVersion")}</div>
                            <button
                                type="button"
                                className="cursor-pointer bg-transparent p-0 text-[11px] font-normal text-stone-400 underline-offset-2 transition hover:text-stone-700 hover:underline dark:text-stone-500 dark:hover:text-stone-300"
                                onClick={() => void checkLatestRelease(true)}
                            >
                                {t(checking ? "version.checking" : "version.checkUpdates")}
                            </button>
                        </div>
                        <div className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100">{latestVersionFromPolicy || latestVersion}</div>
                        {hasNewVersion && canDownload ? (
                            <button
                                type="button"
                                className="mt-2 cursor-pointer rounded-md bg-stone-900 px-3 py-1 text-xs font-medium text-white transition hover:bg-stone-700 dark:bg-white dark:text-stone-950 dark:hover:bg-stone-200"
                                onClick={() => void window.shotshot?.appRelease?.openDownload()}
                            >
                                {t("version.downloadLatest")}
                            </button>
                        ) : null}
                    </div>
                </div>
                {notes ? (
                    <div className="mb-4 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="text-xs text-stone-500 dark:text-stone-400">{t("version.notesLabel")}</div>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-stone-700 dark:text-stone-300">{notes}</p>
                    </div>
                ) : null}
                <div className="max-h-[56vh] overflow-y-auto pr-2">
                    <Timeline
                        items={releases.map((release) => ({
                            content: (
                                <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-sm font-semibold text-stone-950 dark:text-stone-100">{release.version === "Unreleased" ? t("version.unreleased") : release.version}</span>
                                        <span className="text-xs text-stone-500 dark:text-stone-400">{release.date}</span>
                                        <div className="flex min-w-0 items-center gap-1.5">
                                            {release.version === latestVersion ? <Tag color="green">{t("version.latest")}</Tag> : null}
                                            {release.version === APP_VERSION ? <Tag>{t("version.current")}</Tag> : null}
                                        </div>
                                    </div>
                                    <div className="mt-2 space-y-1.5">
                                        {release.items.map((item, index) => (
                                            <div key={`${release.version}-${index}`} className="flex items-start gap-2 text-sm leading-6 text-stone-700 dark:text-stone-300">
                                                <Tag color={getTagColor(item.type)} className="m-0 mt-0.5 shrink-0 whitespace-nowrap">
                                                    {releaseTypeLabel(item.type, t)}
                                                </Tag>
                                                <span className="min-w-0 flex-1">{item.content}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ),
                        }))}
                    />
                </div>
        </Modal>
    );
}
