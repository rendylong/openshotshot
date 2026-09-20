import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { ProjectIconBadge } from "@/components/canvas/project-icon-badge";
import { resolveCanvasAssetUrl } from "@/services/project-asset-storage";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";
import type { Project } from "@/stores/canvas/use-project-store";
import { CanvasNodeType } from "@/types/canvas";

import "./canvas-project-card.css";

type ProjectArtifact = {
    id: string;
    title: string;
    content: string;
    storageKey?: string;
    assetRef?: CanvasAssetRef;
};

function recentProjectArtifacts(project: Project): ProjectArtifact[] {
    return [...project.canvases]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .flatMap((canvas) =>
            [...canvas.nodes].reverse().flatMap((node) => {
                if (node.type !== CanvasNodeType.Image) return [];
                const images = node.metadata?.images || [];
                const primaryImage = images.find((image) => image.id === node.metadata?.primaryImageId) || images[0];
                const content = primaryImage?.content || node.metadata?.content || "";
                const storageKey = primaryImage?.storageKey || node.metadata?.storageKey;
                const assetRef = primaryImage?.assetRef || node.metadata?.assetRef || (storageKey ? { backend: "indexeddb" as const, storageKey } : undefined);
                return content || storageKey || assetRef ? [{ id: `${canvas.id}:${node.id}`, title: node.title, content, storageKey, assetRef }] : [];
            }),
        )
        .slice(0, 2)
        .reverse();
}

export function CanvasProjectCard({ project }: { project: Project }) {
    const { i18n, t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const artifacts = useMemo(() => recentProjectArtifacts(project), [project]);
    const [artifactUrls, setArtifactUrls] = useState(() => artifacts.map((artifact) => artifact.content));

    useEffect(() => {
        let active = true;
        setArtifactUrls(artifacts.map((artifact) => artifact.content));
        void Promise.all(artifacts.map((artifact) => resolveCanvasAssetUrl(artifact.assetRef, artifact.content))).then((urls) => {
            if (active) setArtifactUrls(urls);
        });
        return () => {
            active = false;
        };
    }, [artifacts]);

    const open = () => {
        navigate(`/projects/${project.id}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`);
    };

    const folderStyle = { "--project-color": project.color } as CSSProperties;

    return (
        <button type="button" className="canvas-project-card w-full cursor-pointer text-left" style={folderStyle} onClick={open}>
            <span className="canvas-project-card__artifacts" aria-hidden="true">
                {artifacts.length ? (
                    artifacts.map((artifact, index) =>
                        artifactUrls[index] ? (
                            <span key={artifact.id} className="canvas-project-card__artifact">
                                <img src={artifactUrls[index]} alt="" draggable={false} />
                            </span>
                        ) : null,
                    )
                ) : (
                    <>
                        <span className="canvas-project-card__artifact canvas-project-card__artifact--placeholder" />
                        <span className="canvas-project-card__artifact canvas-project-card__artifact--placeholder" />
                    </>
                )}
            </span>

            <span className="canvas-project-card__folder">
                <span className="flex min-w-0 items-center gap-2.5">
                    <ProjectIconBadge icon={project.icon} color={project.color} size={30} />
                    <span className="min-w-0">
                        <span className="block truncate text-base font-semibold tracking-[-0.012em]">{project.title}</span>
                        <span className="mt-0.5 block text-[11px] text-stone-500 dark:text-stone-400">{t("canvas.project.canvasCount", { count: project.canvases.length })}</span>
                    </span>
                </span>
                <span className="mt-auto block text-[11px] text-stone-500 dark:text-stone-400">
                    {t("canvas.project.updated", { date: new Date(project.updatedAt).toLocaleString(i18n.resolvedLanguage, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) })}
                </span>
            </span>
        </button>
    );
}
