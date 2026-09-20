import type { CSSProperties } from "react";
import { Checkbox, theme as antdTheme } from "antd";
import { CircleAlert, Folder, FolderCheck, FolderX } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { SkillSourceStatus } from "@/lib/skills/skill-types";

type Props = {
    source: SkillSourceStatus;
    label: string;
    checked: boolean;
    onChange?: (checked: boolean) => void;
};

export function SkillSourceCard({ source, label, checked, onChange }: Props) {
    const { t } = useTranslation();
    const { token } = antdTheme.useToken();
    const enabled = source.key === "app" || checked;
    const availability = source.error ? "error" : source.exists ? "ready" : "missing";
    const StatusIcon = availability === "error" ? CircleAlert : availability === "ready" ? FolderCheck : availability === "missing" ? FolderX : Folder;
    const checkboxId = `skill-source-checkbox-${source.key}`;
    const cardStyle = {
        borderColor: token.colorBorderSecondary,
        backgroundColor: token.colorBgContainer,
        "--skill-card-hover": token.colorFillQuaternary,
    } as CSSProperties;
    const heading = (
        <>
            <div className="truncate text-xs font-medium" style={{ color: token.colorText }}>{label}</div>
            <div className="mt-0.5 text-[11px]" style={{ color: token.colorTextTertiary }}>
                {t(`skills.sources.state.${enabled ? "enabled" : "disabled"}`)} · {t(`skills.sources.state.${availability}`)} · {t("skills.sources.skillCount", { count: source.skillCount })}
            </div>
        </>
    );

    return (
        <section
            className="min-w-0 rounded-xl border px-3.5 py-3 transition-colors hover:bg-[var(--skill-card-hover)]"
            style={cardStyle}
            aria-label={label}
        >
            <div className="flex items-start gap-2.5">
                <StatusIcon className="mt-0.5 size-4 shrink-0" style={{ color: availability === "error" ? token.colorError : token.colorTextSecondary }} />
                <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                        {source.key === "app" ? (
                            <div className="min-w-0">{heading}</div>
                        ) : (
                            <>
                                <label htmlFor={checkboxId} className="min-w-0 cursor-pointer">{heading}</label>
                                <Checkbox id={checkboxId} className="shrink-0" aria-label={label} checked={checked} onChange={(event) => onChange?.(event.target.checked)} />
                            </>
                        )}
                    </div>
                    <div className="mt-2 space-y-0.5">
                        {source.paths.length ? source.paths.map((path) => (
                            <div key={path} className="truncate font-mono text-[10px] leading-4" style={{ color: token.colorTextSecondary }} title={path}>{path}</div>
                        )) : (
                            <div className="text-[10px] leading-4" style={{ color: token.colorTextTertiary }}>{t("skills.sources.pathPending")}</div>
                        )}
                    </div>
                    {source.error ? <div className="mt-2 break-words text-[10px] leading-4" style={{ color: token.colorError }}>{source.error}</div> : null}
                    {source.diagnostics.length ? (
                        <details className="mt-2 text-[10px] leading-4" style={{ color: token.colorTextSecondary }}>
                            <summary className="cursor-pointer select-none">{t("skills.sources.diagnostics", { count: source.diagnostics.length })}</summary>
                            <div className="mt-1 space-y-1 border-l pl-2" style={{ borderColor: token.colorBorderSecondary }}>
                                {source.diagnostics.map((diagnostic, index) => <div key={`${index}:${diagnostic}`} className="break-words">{diagnostic}</div>)}
                            </div>
                        </details>
                    ) : null}
                </div>
            </div>
        </section>
    );
}
