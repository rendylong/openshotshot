import { useRef, useState } from "react";
import { Popover } from "antd";
import { BookOpen, Languages, Moon, Settings2, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DOCS_URL } from "@/constant/env";
import { changeAppLocale, type AppLocale } from "@/i18n";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { cn } from "@/lib/utils";

// collapsed = 侧栏折叠态：触发器收成 40px 图标按钮（仅齿轮），浮层内容不变。
export function SettingsPopover({ onOpenChange, collapsed = false }: { onOpenChange?: (open: boolean) => void; collapsed?: boolean }) {
    const { i18n, t } = useTranslation();
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const locale = i18n.resolvedLanguage as AppLocale;
    const nextLocale = locale === "zh-CN" ? "en-US" : "zh-CN";

    const updateOpen = (next: boolean) => {
        setOpen(next);
        onOpenChange?.(next);
    };
    const close = () => updateOpen(false);
    const itemClass =
        "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground transition hover:bg-accent hover:text-foreground";

    const content = (
        <div className="w-56 py-1">
            <button
                type="button"
                className={itemClass}
                onClick={() => {
                    openConfigDialog(false);
                    close();
                }}
            >
                <Settings2 className="size-4" />
                {t("sidebar.settings.config")}
            </button>
            <button
                type="button"
                className={itemClass}
                onClick={() => {
                    setTheme(theme === "dark" ? "light" : "dark");
                    close();
                }}
            >
                {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
                {t(theme === "dark" ? "sidebar.settings.lightTheme" : "sidebar.settings.darkTheme")}
            </button>
            <button
                type="button"
                className={itemClass}
                onClick={() => {
                    void changeAppLocale(nextLocale);
                    close();
                }}
            >
                <Languages className="size-4" />
                {t("sidebar.settings.language", { language: t(nextLocale === "zh-CN" ? "locale.zhCN" : "locale.enUS") })}
            </button>
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className={itemClass} onClick={close}>
                <BookOpen className="size-4" />
                {t("sidebar.settings.docs")}
            </a>
        </div>
    );

    return (
        <Popover
            open={open}
            onOpenChange={updateOpen}
            trigger="click"
            placement="top"
            content={content}
            afterOpenChange={(visible) => {
                if (!visible) triggerRef.current?.focus();
            }}
        >
            <button
                ref={triggerRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t("sidebar.settings.label")}
                className={cn(
                    "flex h-10 items-center rounded-lg text-sm leading-6 text-muted-foreground transition hover:bg-accent hover:text-foreground",
                    collapsed ? "w-10 shrink-0 justify-center" : "w-full gap-3 px-3",
                )}
            >
                <Settings2 className="size-4 shrink-0" strokeWidth={1.5} />
                {!collapsed && <span className="truncate">{t("sidebar.settings.label")}</span>}
            </button>
        </Popover>
    );
}
