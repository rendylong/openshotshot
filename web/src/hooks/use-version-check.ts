import { useCallback, useEffect, useMemo, useState } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";
import { APP_VERSION } from "@/constant/env";
import { parseChangelog, type ReleaseInfo } from "@/lib/release";
import { isNewerVersion } from "@/lib/version-compare";
import { useAppReleaseStore } from "@/stores/use-app-release-store";

const latestVersionUrl = "https://raw.githubusercontent.com/rendylong/shotshot/main/VERSION";
const latestChangelogUrl = "https://raw.githubusercontent.com/rendylong/shotshot/main/CHANGELOG.md";

function readLocalReleases(): ReleaseInfo[] {
    return __APP_RELEASES__ || [];
}

export function useVersionCheck() {
    const { t } = useTranslation();
    const currentVersion = APP_VERSION;
    const { message } = App.useApp();
    const localReleases = useMemo(readLocalReleases, []);
    const releaseBridge = useMemo(() => window.shotshot?.appRelease ?? null, []);
    const releaseState = useAppReleaseStore((s) => s.state);
    const releaseRefresh = useAppReleaseStore((s) => s.refresh);
    const [latestVersion, setLatestVersion] = useState(currentVersion);
    const [releases, setReleases] = useState<ReleaseInfo[]>(localReleases);
    const [checking, setChecking] = useState(false);
    const hasNewVersion = releaseBridge
        ? releaseState.status === "soft_update" || releaseState.status === "force_update"
        : isNewerVersion(latestVersion, currentVersion);
    const latestVersionFromPolicy = releaseBridge ? releaseState.policy?.latestVersion ?? "" : "";

    const checkLatestVersion = useCallback(async () => {
        try {
            const response = await fetch(latestVersionUrl);
            if (!response.ok) return false;
            const version = await response.text();
            setLatestVersion(version.trim() || currentVersion);
            return true;
        } catch {
            return false;
        }
    }, [currentVersion]);

    const checkLatestRelease = useCallback(
        async (showMessage = false) => {
            if (releaseBridge) {
                setChecking(true);
                try {
                    const ok = await releaseRefresh();
                    try {
                        const changelogResponse = await fetch(latestChangelogUrl);
                        if (changelogResponse.ok) {
                            const changelog = await changelogResponse.text();
                            if (changelog.trim()) setReleases(parseChangelog(changelog));
                        }
                    } catch { /* changelog 展示尽力而为 */ }
                    if (showMessage) {
                        if (ok) message.success(t("version.updated"));
                        else message.error(t("version.updateFailed"));
                    }
                    return ok;
                } finally {
                    setChecking(false);
                }
            }
            setChecking(true);
            try {
                const [versionResponse, changelogResponse] = await Promise.all([fetch(latestVersionUrl), fetch(latestChangelogUrl)]);
                if (!versionResponse.ok) throw new Error(t("version.readFailed"));
                if (!changelogResponse.ok) throw new Error(t("version.changelogFailed"));
                const [version, changelog] = await Promise.all([versionResponse.text(), changelogResponse.text()]);
                setLatestVersion(version.trim() || currentVersion);
                if (changelog.trim()) setReleases(parseChangelog(changelog));
                if (showMessage) message.success(t("version.updated"));
                return true;
            } catch {
                setLatestVersion(currentVersion);
                setReleases(localReleases);
                if (showMessage) message.error(t("version.updateFailed"));
                return false;
            } finally {
                setChecking(false);
            }
        },
        [currentVersion, localReleases, message, t, releaseBridge, releaseRefresh],
    );

    useEffect(() => {
        void checkLatestVersion();
    }, [checkLatestVersion]);

    // Electron 走云端策略；Web 下 latestVersionFromPolicy 恒为空字符串，组合值等于原 latestVersion
    const effectiveLatestVersion = latestVersionFromPolicy || latestVersion;

    return {
        latestVersion: effectiveLatestVersion,
        latestVersionFromPolicy,
        notes: releaseBridge ? releaseState.policy?.notes ?? "" : "",
        canDownload: Boolean(releaseBridge),
        releases,
        checking,
        hasNewVersion,
        checkLatestRelease,
    };
}
