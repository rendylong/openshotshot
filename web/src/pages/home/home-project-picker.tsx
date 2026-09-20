import { useEffect, useRef, useState } from "react";
import { Check, ChevronUp, FolderKanban, FolderPlus, Search, Unlink } from "lucide-react";
import { useTranslation } from "react-i18next";

import "./home-project.css";
import { ProjectIconBadge } from "@/components/canvas/project-icon-badge";
import { NewProjectDialog } from "@/components/new-project-dialog";
import { UNCATEGORIZED_PROJECT_ID } from "@/lib/canvas/category";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import type { HomeCanvasTarget } from "@/stores/canvas/use-project-store";

export type HomeProjectTarget = HomeCanvasTarget;

export function HomeProjectPicker({ value, onChange }: { value: HomeProjectTarget; onChange: (value: HomeProjectTarget) => void }) {
    const { t } = useTranslation();
    const projects = useProjectStore((state) => state.projects);
    const hydrated = useProjectStore((state) => state.hydrated);
    const createProject = useProjectStore((state) => state.createProject);
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const [open, setOpen] = useState(false);
    const [createOpen, setCreateOpen] = useState(false);
    const [query, setQuery] = useState("");
    const regularProjects = projects.filter((project) => project.id !== UNCATEGORIZED_PROJECT_ID);
    const selectedProject = regularProjects.find((project) => project.id === value?.projectId);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const filteredProjects = normalizedQuery
        ? regularProjects.filter((project) => project.title.toLocaleLowerCase().includes(normalizedQuery))
        : regularProjects;

    useEffect(() => {
        if (!open) return;
        const frame = requestAnimationFrame(() => searchRef.current?.focus());
        const closeMenu = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            setOpen(false);
            triggerRef.current?.focus();
        };
        document.addEventListener("pointerdown", closeMenu);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            cancelAnimationFrame(frame);
            document.removeEventListener("pointerdown", closeMenu);
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, [open]);

    const selectTarget = (target: HomeProjectTarget) => {
        onChange(target);
        setOpen(false);
        setQuery("");
    };
    const createAndSelect = (title: string, icon: string, color: string) => {
        selectTarget(createProject(title, { icon, color }));
        setCreateOpen(false);
    };
    const closeCreate = () => {
        setCreateOpen(false);
        requestAnimationFrame(() => triggerRef.current?.focus());
    };
    const content = open ? (
        <div className="home-projectMenu" role="menu">
            <label className="home-projectSearch">
                <Search className="size-4 shrink-0" />
                <input
                    ref={searchRef}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t("composer.project.search")}
                />
            </label>
            <button type="button" role="menuitem" className="home-projectItem" onClick={() => { setOpen(false); setCreateOpen(true); }}>
                <span className="home-projectItemIcon"><FolderPlus size={18} /></span>
                <span className="home-projectItemLabel is-strong">{t("composer.project.create")}</span>
            </button>
            {value ? (
                <button type="button" role="menuitem" className="home-projectItem" onClick={() => selectTarget(null)}>
                    <span className="home-projectItemIcon is-muted"><Unlink size={16} /></span>
                    <span className="home-projectItemLabel">{t("composer.project.none")}</span>
                </button>
            ) : null}
            <div className="home-projectDivider" />
            <div className="home-projectList thin-scrollbar">
                {filteredProjects.map((project) => {
                    const selected = project.id === selectedProject?.id;
                    return (
                        <button key={project.id} type="button" role="menuitemradio" aria-checked={selected} className={cn("home-projectItem", selected && "is-selected")} onClick={() => selectTarget({ projectId: project.id })} aria-label={project.title}>
                            <ProjectIconBadge icon={project.icon} color={project.color} size={28} />
                            <span className="home-projectItemLabel">{project.title}</span>
                            {selected ? <Check size={15} className="shrink-0" /> : null}
                        </button>
                    );
                })}
                {!filteredProjects.length ? <p className="home-projectEmpty">{t("composer.project.empty")}</p> : null}
            </div>
        </div>
    ) : null;

    const label = selectedProject?.title || t("composer.project.label");
    const ariaLabel = selectedProject ? t("composer.project.current", { name: selectedProject.title }) : t("composer.project.select");

    return (
        <>
            <div ref={rootRef} className="home-projectPicker">
                <button
                    ref={triggerRef}
                    type="button"
                    disabled={!hydrated}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    aria-label={ariaLabel}
                    className="home-projectTrigger"
                    data-open={open || undefined}
                    onClick={() => { setOpen((current) => !current); setQuery(""); }}
                >
                    {selectedProject ? <ProjectIconBadge icon={selectedProject.icon} color={selectedProject.color} size={16} /> : <FolderKanban className="size-4 shrink-0" />}
                    <span className="truncate">{label}</span>
                    <ChevronUp className="size-3 shrink-0 opacity-50" />
                </button>
                {content}
            </div>
            <NewProjectDialog open={createOpen} onClose={closeCreate} onCreate={createAndSelect} />
        </>
    );
}
