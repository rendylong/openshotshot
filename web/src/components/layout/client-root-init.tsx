import { watchChatGptStatus } from "@/stores/use-chatgpt-store";
import { useAiSourceStore } from "@/stores/use-ai-source-store";
import { useUserStore } from "@/stores/use-user-store";
import { clearManagedCatalogRecord } from "@/lib/desktop/managed-catalog-store";
import { resetManagedCatalogRuntime } from "@/lib/desktop/managed-catalog-cache";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { RemoteMediaTaskRuntime } from "@/components/layout/remote-media-task-runtime";
import { createModelChannel, useConfigStore } from "@/stores/use-config-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const handledConfigParams = useRef(false);
    useEffect(() => { void useAiSourceStore.getState().hydrate().catch(() => undefined); return watchChatGptStatus(); }, []);
    // 登出即清托管目录的内存快照与本地记录，避免换账号误用上一账号的目录。
    useEffect(() => {
        return useUserStore.subscribe((state, prev) => {
            if (prev.account.state === "signed-out" || state.account.state !== "signed-out") return;
            resetManagedCatalogRuntime();
            void clearManagedCatalogRecord().catch(() => undefined);
        });
    }, []);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const config = useConfigStore((state) => state.config);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    useEffect(() => {
        if (handledConfigParams.current) return;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        if (!baseUrl && !apiKey) return;
        handledConfigParams.current = true;
        searchParams.delete("baseUrl");
        searchParams.delete("baseurl");
        searchParams.delete("apiKey");
        searchParams.delete("apikey");
        window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
        const firstChannel = config.channels[0];
        updateConfig(
            "channels",
            firstChannel
                ? config.channels.map((channel, index) =>
                      index === 0
                          ? {
                                ...channel,
                                ...(baseUrl ? { baseUrl } : {}),
                                ...(apiKey ? { apiKey } : {}),
                            }
                          : channel,
                  )
                : [createModelChannel({ id: "default", name: t("config.channels.defaultName"), baseUrl: baseUrl || undefined, apiKey: apiKey || "" })],
        );
        if (baseUrl) updateConfig("baseUrl", baseUrl);
        if (apiKey) updateConfig("apiKey", apiKey);
        openConfigDialog(false);
        message.success(t("config.importedDirectConfig"));
    }, [config.channels, message, openConfigDialog, t, updateConfig]);

    return (
        <>
            <RemoteMediaTaskRuntime />
            {children}
        </>
    );
}
