import type { ReactNode } from "react";
import { useEffect } from "react";
import { StyleProvider } from "@ant-design/cssinjs";
import { ProConfigProvider } from "@ant-design/pro-components";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider } from "antd";
import enUS from "antd/es/locale/en_US";
import zhCN from "antd/es/locale/zh_CN";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { useTranslation } from "react-i18next";

import { ClientRootInit } from "@/components/layout/client-root-init";
import type { AppLocale } from "@/i18n";
import { getAntThemeConfig } from "@/lib/app-theme";
import { useThemeStore } from "@/stores/use-theme-store";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 30_000,
            retry: false,
            refetchOnWindowFocus: false,
        },
    },
});

export function AppProviders({ children }: { children: ReactNode }) {
    const { i18n, t } = useTranslation();
    const theme = useThemeStore((state) => state.theme);
    const dark = theme === "dark";
    const locale = i18n.resolvedLanguage as AppLocale;

    useEffect(() => {
        const root = document.documentElement;
        root.classList.add("theme-transitioning");
        root.classList.toggle("dark", dark);
        root.style.colorScheme = theme;
        requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-transitioning")));
    }, [dark, theme]);

    useEffect(() => {
        document.documentElement.lang = locale;
        document.title = "";
        document.querySelector('meta[name="description"]')?.setAttribute("content", t("meta.description"));
        dayjs.locale(locale === "zh-CN" ? "zh-cn" : "en");
    }, [locale, t]);

    return (
        <StyleProvider layer>
            <ConfigProvider locale={locale === "zh-CN" ? zhCN : enUS} theme={getAntThemeConfig(dark)}>
                <ProConfigProvider dark={dark}>
                    <App>
                        <QueryClientProvider client={queryClient}>
                            <ClientRootInit>{children}</ClientRootInit>
                        </QueryClientProvider>
                    </App>
                </ProConfigProvider>
            </ConfigProvider>
        </StyleProvider>
    );
}
