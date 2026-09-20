import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Popover, Select, Tooltip } from "antd";
import { AlertTriangle, ChevronDown, FolderInput, MonitorX, RefreshCw, Search, Settings, Sparkles, SquarePen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { SkillDetailModal } from "@/components/skills/skill-detail-modal";
import { SkillGalleryCard } from "@/components/skills/skill-gallery-card";
import { SkillImportDialog } from "@/components/skills/skill-import-dialog";
import { SkillSourceCard } from "@/components/skills/skill-source-card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import { canvasTitleFromPrompt } from "@/lib/canvas/canvas-title";
import type { LocalSkillSummary, SkillSourceKey, SkillSourceStatus } from "@/lib/skills/skill-types";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { useLocalSkillStore } from "@/stores/use-local-skill-store";

const SOURCE_KEYS: SkillSourceKey[] = ["app", "piGlobal", "agentsGlobal", "piProject", "agentsProject"];

function fallbackSource(key: SkillSourceKey): SkillSourceStatus {
    return { key, enabled: key === "app", readonly: key !== "app", paths: [], exists: false, skillCount: 0, diagnostics: [] };
}

export default function SkillsPage() {
    const { t } = useTranslation();
    const skills = useLocalSkillStore((state) => state.skills);
    const desktop = useLocalSkillStore((state) => state.desktop);
    const loading = useLocalSkillStore((state) => state.loading);
    const loaded = useLocalSkillStore((state) => state.loaded);
    const errors = useLocalSkillStore((state) => state.errors);
    const sources = useLocalSkillStore((state) => state.sources);
    const sourcePreferences = useLocalSkillStore((state) => state.sourcePreferences);
    const scanSkills = useLocalSkillStore((state) => state.scanSkills);
    const setSourceEnabled = useLocalSkillStore((state) => state.setSourceEnabled);
    const navigate = useNavigate();
    const [handoffBusy, setHandoffBusy] = useState(false);
    const [importOpen, setImportOpen] = useState(false);
    const [selectedSkill, setSelectedSkill] = useState<LocalSkillSummary | null>(null);
    const [query, setQuery] = useState("");
    const [sourceFilter, setSourceFilter] = useState<"all" | SkillSourceKey>("all");
    const [statusFilter, setStatusFilter] = useState<"all" | "available" | "manual" | "invalid">("all");
    const detailsRef = useRef<HTMLDetailsElement>(null);

    useEffect(() => { void scanSkills(); }, [scanSkills]);

    // eng review P1：导航完成前禁用重复提交——快速双击会覆盖 pending 键、留下一块无对话的空白画布。
    const startSkillConversation = (text: string) => {
        if (handoffBusy) return;
        setHandoffBusy(true);
        const ids = useProjectStore.getState().submitPendingPrompt(text, canvasTitleFromPrompt(text));
        if (!ids) {
            setHandoffBusy(false);
            return;
        }
        navigate(`/canvas/${ids.projectId}/${ids.canvasId}`);
    };

    const sourceStatuses = useMemo(() => new Map(sources.map((source) => [source.key, source])), [sources]);
    const filteredSkills = useMemo(() => {
        const normalizedQuery = query.trim().toLocaleLowerCase();
        return skills.filter((skill) => {
            const matchesQuery = !normalizedQuery || [skill.name, skill.displayName, skill.description, skill.shortDescription]
                .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
            const matchesSource = sourceFilter === "all" || skill.source === sourceFilter;
            const status = !skill.valid ? "invalid" : skill.manualOnly ? "manual" : "available";
            return matchesQuery && matchesSource && (statusFilter === "all" || status === statusFilter);
        });
    }, [query, skills, sourceFilter, statusFilter]);

    const hasFilters = Boolean(query.trim()) || sourceFilter !== "all" || statusFilter !== "all";

    const parsedErrors = useMemo(() => errors.map((raw) => {
        const match = /^([a-z]+)\/([^:]+):\s*(.+)$/i.exec(raw);
        if (!match) return { raw, message: raw, sourceKey: undefined as SkillSourceKey | undefined, skillName: undefined as string | undefined, skill: undefined as LocalSkillSummary | undefined };
        const [, sourceKey, skillName, message] = match;
        if (!SOURCE_KEYS.includes(sourceKey as SkillSourceKey)) return { raw, message: raw, sourceKey: undefined, skillName: undefined, skill: undefined };
        const skill = skills.find((item) => item.source === sourceKey && item.name === skillName);
        return { raw, message, sourceKey: sourceKey as SkillSourceKey, skillName, skill };
    }), [errors, skills]);

    const locateSkill = (skill: LocalSkillSummary) => {
        setQuery(skill.displayName || skill.name);
        setSourceFilter("all");
        setStatusFilter("all");
        if (detailsRef.current) detailsRef.current.open = false;
    };

    return (
        <>
            <main className="h-full overflow-auto bg-background text-foreground">
                <div className="mx-auto w-full max-w-6xl px-5 py-7 sm:px-7 sm:py-9">
                    <PageHeader
                        title={t("skills.title")}
                        description={t("skills.subtitle")}
                        className="px-0 py-0"
                        actions={
                            <>
                                <Button type="primary" icon={<SquarePen className="size-4" />} disabled={!desktop} onClick={() => startSkillConversation("/skill-creator")}>{t("agent.skillManager.createSkill")}</Button>
                                <Tooltip title={t("skills.list.import")}><Button type="text" shape="circle" disabled={!desktop} aria-label={t("skills.list.import")} icon={<FolderInput className="size-4" />} onClick={() => setImportOpen(true)} /></Tooltip>
                                <Tooltip title={t("skills.list.refresh")}><Button type="text" shape="circle" disabled={!desktop} loading={loading} aria-label={t("skills.list.refresh")} icon={<RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />} onClick={() => void scanSkills(true)} /></Tooltip>
                                <Popover
                                    trigger="click"
                                    placement="bottomRight"
                                    title={t("skills.sources.title")}
                                    content={
                                        <div className="w-[min(28rem,calc(100vw-2rem))] space-y-2">
                                            <p className="text-xs text-muted-foreground">{t("skills.sources.description")}</p>
                                            {SOURCE_KEYS.map((key) => {
                                                const source = sourceStatuses.get(key) ?? fallbackSource(key);
                                                const checked = key === "app" || sourcePreferences[key];
                                                return <SkillSourceCard key={key} source={source} label={t(`skills.sources.${key}`)} checked={checked} onChange={key === "app" ? undefined : (enabled) => void setSourceEnabled(key, enabled)} />;
                                            })}
                                        </div>
                                    }
                                >
                                    <Tooltip title={t("skills.sources.settings")}><Button type="text" shape="circle" disabled={!desktop} aria-label={t("skills.sources.settings")} icon={<Settings className="size-4" />} /></Tooltip>
                                </Popover>
                            </>
                        }
                    />

                    {!desktop ? (
                        <div className="flex min-h-[320px] items-center justify-center">
                            <EmptyState icon={MonitorX} title={t("skills.desktopOnly.title")} description={t("skills.desktopOnly.hint")} />
                        </div>
                    ) : loading && !loaded ? (
                        <div className="flex min-h-80 items-center justify-center gap-2 text-sm text-muted-foreground">
                            <Spinner />
                            <span>{t("agent.skills.loading")}</span>
                        </div>
                    ) : (
                        <>
                            {errors.length ? (
                                <details ref={detailsRef} className="group mt-4 border-y border-border py-2 text-[11px] leading-5 text-muted-foreground">
                                    <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium">
                                        <AlertTriangle className="size-3.5" />{t("skills.list.invalid", { count: errors.length })}
                                        <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
                                    </summary>
                                    <div className="mt-1.5 space-y-1 pl-5">
                                        {parsedErrors.map((parsed) => {
                                            const subject = parsed.sourceKey
                                                ? `${t(`skills.sources.${parsed.sourceKey}`)} · ${parsed.skill ? parsed.skill.displayName || parsed.skill.name : parsed.skillName}：${parsed.message}`
                                                : parsed.raw;
                                            return parsed.skill ? (
                                                <button
                                                    key={parsed.raw}
                                                    type="button"
                                                    className="block w-full break-words text-left hover:underline"
                                                    title={parsed.raw}
                                                    onClick={() => locateSkill(parsed.skill!)}
                                                >
                                                    {subject}
                                                </button>
                                            ) : (
                                                <div key={parsed.raw} className="break-words" title={parsed.sourceKey ? parsed.raw : undefined}>{subject}</div>
                                            );
                                        })}
                                    </div>
                                </details>
                            ) : null}

                            <section className="mt-8" aria-labelledby="skill-gallery-heading">
                                <div className="flex flex-wrap items-end justify-between gap-3">
                                    <div>
                                        <h2 id="skill-gallery-heading" className="text-sm font-medium">{t("skills.gallery.title")}</h2>
                                        <p className="mt-0.5 text-[11px] text-muted-foreground">{t("skills.gallery.count", { count: filteredSkills.length })}</p>
                                    </div>
                                    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                                        <div className="w-full sm:w-60 sm:flex-none">
                                            <Input
                                                allowClear
                                                className="w-full"
                                                prefix={<Search className="size-3.5" />}
                                                placeholder={t("skills.filters.search")}
                                                aria-label={t("skills.filters.search")}
                                                value={query}
                                                onChange={(event) => setQuery(event.target.value)}
                                            />
                                        </div>
                                        <Select
                                            className="w-36"
                                            aria-label={t("skills.filters.source")}
                                            value={sourceFilter}
                                            onChange={setSourceFilter}
                                            options={[
                                                { value: "all", label: t("skills.filters.allSources") },
                                                ...SOURCE_KEYS.map((key) => ({ value: key, label: t(`skills.sources.${key}`) })),
                                            ]}
                                        />
                                        <Select
                                            className="w-28"
                                            aria-label={t("skills.filters.status")}
                                            value={statusFilter}
                                            onChange={setStatusFilter}
                                            options={[
                                                { value: "all", label: t("skills.filters.allStatuses") },
                                                { value: "available", label: t("skills.status.available") },
                                                { value: "manual", label: t("skills.status.manual") },
                                                { value: "invalid", label: t("skills.status.invalid") },
                                            ]}
                                        />
                                    </div>
                                </div>

                                {filteredSkills.length ? (
                                    <div className="mt-3.5 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
                                        {filteredSkills.map((skill) => (
                                            <SkillGalleryCard key={`${skill.name}:${skill.path}`} skill={skill} onOpen={() => setSelectedSkill(skill)} />
                                        ))}
                                    </div>
                                ) : (
                                    <div className="flex min-h-[320px] items-center justify-center">
                                        <EmptyState
                                            icon={Sparkles}
                                            title={t(hasFilters ? "skills.gallery.noMatch" : "skills.list.empty")}
                                            description={t(hasFilters ? "skills.gallery.noMatchHint" : "skills.list.emptyHint")}
                                            action={
                                                hasFilters ? (
                                                    <Button type="link" size="small" onClick={() => { setQuery(""); setSourceFilter("all"); setStatusFilter("all"); }}>{t("skills.gallery.clearFilters")}</Button>
                                                ) : (
                                                    <Button type="link" size="small" icon={<FolderInput className="size-3.5" />} onClick={() => setImportOpen(true)}>{t("skills.list.import")}</Button>
                                                )
                                            }
                                        />
                                    </div>
                                )}
                            </section>
                        </>
                    )}
                </div>
            </main>
            <SkillDetailModal skill={selectedSkill} open={Boolean(selectedSkill)} onClose={() => setSelectedSkill(null)} />
            <SkillImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
        </>
    );
}
