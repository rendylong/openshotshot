import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "antd";
import { FolderOpen, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "@/components/canvas/canvas-project-card";
import { NewProjectDialog } from "@/components/new-project-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { filterProjectsByCategory, UNCATEGORIZED, UNCATEGORIZED_PROJECT_ID } from "@/lib/canvas/category";

// Shared project library: renders all projects, or a single category when
// `category` is provided. Backs both /projects and /uncategorized.
export function ProjectsView({ category }: { category?: string }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const autoOpenRef = useRef(false);
    const hydrated = useProjectStore((state) => state.hydrated);
    const projects = useProjectStore((state) => state.projects);
    const createProject = useProjectStore((state) => state.createProject);

    const visibleProjects = (category ? filterProjectsByCategory(projects, category) : projects).filter((project) => project.id !== UNCATEGORIZED_PROJECT_ID);
    const isUncategorized = category === UNCATEGORIZED;
    const title = t(isUncategorized ? "uncategorized.title" : "projects.title");
    const subtitle = t(isUncategorized ? "uncategorized.subtitle" : "projects.subtitle");
    const emptyTitle = t(isUncategorized ? "uncategorized.emptyTitle" : "projects.emptyTitle");
    const emptyDescription = t(isUncategorized ? "uncategorized.emptyDescription" : "projects.emptyDescription");

    const mode = searchParams.get("mode");
    const agentMode = mode === "new" || mode === "recent" || mode === "choose";
    const agentQuery = agentMode ? `?${searchParams.toString()}` : "";
    const enterProject = (id: string) => {
        navigate(`/projects/${id}${agentQuery}`);
    };
    const [createOpen, setCreateOpen] = useState(false);
    const createAndEnter = (title: string, icon: string, color: string) => {
        const { projectId, canvasId } = createProject(title, { icon, color });
        navigate(`/canvas/${projectId}/${canvasId}${agentQuery}`);
    };

    useEffect(() => {
        if (!hydrated || autoOpenRef.current || (mode !== "new" && mode !== "recent")) return;
        autoOpenRef.current = true;
        if (mode === "new") {
            const { projectId, canvasId } = createProject(t("canvas.defaultTitle", { count: projects.length + 1 }));
            navigate(`/canvas/${projectId}/${canvasId}${agentQuery}`);
        } else {
            enterProject(projects[0]?.id || createProject(t("canvas.defaultTitle", { count: projects.length + 1 })).projectId);
        }
    }, [createProject, hydrated, mode, navigate, projects, t]);

    if (hydrated && (mode === "new" || mode === "recent")) return <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">{t("canvas.opening")}</main>;

    return (
        <main className="h-full overflow-auto bg-background text-foreground">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <PageHeader
                    title={title}
                    description={subtitle}
                    className="px-0 pb-6 pt-0"
                    actions={
                        <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
                            {t("projects.create")}
                        </Button>
                    }
                />

                {!hydrated ? (
                    <section className="flex min-h-[320px] items-center justify-center text-sm text-stone-500">{t("canvas.loading")}</section>
                ) : visibleProjects.length ? (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {visibleProjects.map((project) => (
                            <CanvasProjectCard key={project.id} project={project} />
                        ))}
                    </div>
                ) : (
                    <section className="flex min-h-[320px] items-center justify-center">
                        <EmptyState
                            icon={FolderOpen}
                            title={emptyTitle}
                            description={emptyDescription}
                            action={
                                <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
                                    {t("projects.create")}
                                </Button>
                            }
                        />
                    </section>
                )}
            </div>

            <NewProjectDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreate={createAndEnter} />
            <CanvasDeleteProjectsDialog />
        </main>
    );
}
