import type { CSSProperties } from "react";
import { BookOpenText } from "lucide-react";
import { Tag, theme as antdTheme } from "antd";
import { useTranslation } from "react-i18next";

import type { LocalSkillSummary } from "@/lib/skills/skill-types";
import { SkillStatusTag } from "./skill-status-tag";

export function SkillGalleryCard({ skill, onOpen }: { skill: LocalSkillSummary; onOpen: () => void }) {
    const { t } = useTranslation();
    const { token } = antdTheme.useToken();
    const status = !skill.valid ? "invalid" : skill.manualOnly ? "manual" : "available";
    const cardStyle = {
        borderColor: token.colorBorderSecondary,
        backgroundColor: token.colorBgContainer,
        outlineColor: token.colorPrimary,
        "--skill-card-hover": token.colorFillQuaternary,
    } as CSSProperties;

    return (
        <button
            type="button"
            className="group flex min-h-36 w-full flex-col rounded-xl border p-3.5 text-left transition-[border-color,background-color,transform] hover:-translate-y-px hover:bg-[var(--skill-card-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={cardStyle}
            aria-label={t("skills.gallery.openDetail", { name: skill.displayName || skill.name })}
            onClick={onOpen}
        >
            <div className="flex w-full items-start gap-2.5">
                <BookOpenText className="mt-0.5 size-4 shrink-0" style={{ color: token.colorTextSecondary }} />
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium" style={{ color: token.colorText }}>{skill.displayName || skill.name}</div>
                    <div className="mt-0.5 truncate font-mono text-[10px]" style={{ color: token.colorTextTertiary }}>{skill.name}</div>
                </div>
            </div>
            <p className="mt-3 line-clamp-2 text-xs leading-5" style={{ color: token.colorTextSecondary }}>
                {skill.shortDescription || skill.description || t("skills.gallery.noDescription")}
            </p>
            <div className="mt-auto flex w-full items-center justify-between gap-2 pt-3">
                <Tag bordered={false} className="!m-0 max-w-[65%] truncate !text-[10px]">{t(`skills.sources.${skill.source}`)}</Tag>
                <SkillStatusTag status={status} label={t(`skills.status.${status}`)} className="!m-0 !text-[10px]" />
            </div>
        </button>
    );
}
