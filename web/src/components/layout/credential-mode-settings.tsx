import { KeyRound, Sparkles } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AccountState } from "@/lib/desktop/auth-types";
import { cn } from "@/lib/utils";
import { useConfigStore, credentialModeFor, type CredentialMode, type CredentialModeKey } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { useAiSourceStore } from "@/stores/use-ai-source-store";

export function canSelectShotshotMode(account: AccountState, desktop: boolean): boolean {
    return desktop && account.state === "ready";
}

export function CredentialModeSettings() {
    const { t } = useTranslation();
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const account = useUserStore((state) => state.account);
    const signIn = useUserStore((state) => state.signIn);
    const refresh = useUserStore((state) => state.refresh);
    const openAccountPage = useUserStore((state) => state.openAccountPage);
    const [catalogIssue, setCatalogIssue] = useState<"empty" | "unavailable" | null>(null);
    const [loadingCatalog, setLoadingCatalog] = useState(false);
    const desktop = typeof window !== "undefined" && Boolean(window.shotshot?.account && window.shotshot?.managedModels);
    const available = canSelectShotshotMode(account, desktop);

    const setModes = (key: CredentialModeKey | "all", next: CredentialMode) => {
        const keys: CredentialModeKey[] = ["agent", "text", "image", "video", "audio"];
        const credentialModes = { ...config.credentialModes };
        for (const item of key === "all" ? keys : [key]) credentialModes[item] = next;
        updateConfig("credentialModes", credentialModes);
        if (key === "all" || key === "agent") updateConfig("credentialMode", next);
    };

    const select = async (next: CredentialMode, key: CredentialModeKey | "all" = "all") => {
        if (next === "byok") {
            if (key === "all" || key === "agent") {
                try { await useAiSourceStore.getState().select("agent", null); }
                catch { return; }
            }
            setModes(key, "byok");
            return;
        }
        if (available) {
            setCatalogIssue(null);
            setLoadingCatalog(true);
            try {
                const models = await window.shotshot!.managedModels!.listModels();
                if (!models.length) {
                    setCatalogIssue("empty");
                    return;
                }
                const current = useConfigStore.getState().config.managedModels;
                const nextModels = { ...current };
                const capabilities = key === "all" || key === "agent" ? ["text", "image", "video", "audio"] as const : [key] as const;
                for (const capability of capabilities) {
                    const availableModels = models.filter((model) => model.capability === capability);
                    if (!availableModels.some((model) => model.id === current[capability])) nextModels[capability] = availableModels[0]?.id ?? "";
                }
                if (key === "all" || key === "agent") await useAiSourceStore.getState().select("agent", null);
                updateConfig("managedModels", nextModels);
                setModes(key, "shotshot");
            } catch {
                setCatalogIssue("unavailable");
            } finally {
                setLoadingCatalog(false);
            }
            return;
        }
        if (account.state === "signed-out" || account.state === "error") void signIn();
        else if (account.state === "ready") void openAccountPage();
        else void refresh();
    };

    const options = [
        { mode: "shotshot" as const, icon: Sparkles, title: t("config.credentialMode.shotshot"), description: t("config.credentialMode.shotshotDescription"), available },
        { mode: "byok" as const, icon: KeyRound, title: t("config.credentialMode.byok"), description: t("config.credentialMode.byokDescription"), available: true },
    ];
    return (
        <section className="mb-5" aria-label={t("config.credentialMode.title")}>
            <div className="mb-2 text-sm font-semibold">{t("config.credentialMode.title")}</div>
            <div className="grid gap-2 sm:grid-cols-2">
                {options.map((option) => {
                    const Icon = option.icon;
                    const selected = config.credentialMode === option.mode;
                    return (
                        <button
                            key={option.mode}
                            type="button"
                            aria-pressed={selected}
                            disabled={option.mode === "shotshot" && loadingCatalog}
                            onClick={() => void select(option.mode)}
                            className={cn(
                                "flex items-start gap-3 rounded-xl border p-3 text-left transition",
                                selected ? "border-foreground bg-accent" : "border-stone-200 hover:border-stone-400 dark:border-stone-800 dark:hover:border-stone-600",
                            )}
                        >
                            <Icon className="mt-0.5 size-4 shrink-0" />
                            <span className="min-w-0">
                                <span className="block text-sm font-medium">{option.title}</span>
                                <span className="mt-0.5 block text-xs text-stone-500">{option.description}</span>
                                {option.mode === "shotshot" && !option.available ? <span className="mt-1 block text-xs text-amber-600 dark:text-amber-400">{t(desktop ? "config.credentialMode.accountRequired" : "config.credentialMode.desktopOnly")}</span> : null}
                            </span>
                        </button>
                    );
                })}
            </div>
            {catalogIssue ? (
                <div role="alert" className={cn("mt-2 text-xs", catalogIssue === "empty" ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400")}>
                    {t(catalogIssue === "empty" ? "config.credentialMode.catalogEmpty" : "config.credentialMode.catalogUnavailable")}
                </div>
            ) : null}
            <div className="mt-4 space-y-2">
                <div className="text-xs font-medium text-stone-500">{t("config.credentialMode.perCapability")}</div>
                {(["agent", "text", "image", "video", "audio"] as const).map((key) => (
                    <div key={key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-800">
                        <span className="text-sm">{t(`config.credentialMode.capabilities.${key}`)}</span>
                        <div className="flex gap-1">
                            {options.map((option) => (
                                <button
                                    key={option.mode}
                                    type="button"
                                    aria-label={`${key}:${option.mode}`}
                                    aria-pressed={credentialModeFor(config, key) === option.mode}
                                    disabled={option.mode === "shotshot" && loadingCatalog}
                                    onClick={() => void select(option.mode, key)}
                                    className={cn("rounded-md px-2 py-1 text-xs", credentialModeFor(config, key) === option.mode ? "bg-accent text-accent-foreground" : "text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800")}
                                >{option.title}</button>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
