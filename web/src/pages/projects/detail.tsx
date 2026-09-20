import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { CanvasListView } from "@/components/canvas/canvas-list-view";

export default function ProjectDetailPage() {
    const { projectId = "" } = useParams();
    const { t } = useTranslation();
    const project = useProjectStore((state) => state.projects.find((p) => p.id === projectId));
    if (!project) return <main className="flex h-full items-center justify-center text-stone-500">{t("projects.notFound")}</main>;
    return <CanvasListView project={project} />;
}
