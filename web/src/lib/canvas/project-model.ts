import { nanoid } from "nanoid";

import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { canonicalCategory, UNCATEGORIZED } from "@/lib/canvas/category";
import { DEFAULT_PROJECT_COLOR, DEFAULT_PROJECT_ICON } from "@/lib/canvas/project-appearance";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";
import type { Canvas, Project } from "@/types/project";

export type { Canvas, Project } from "@/types/project";

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };

export function createEmptyCanvas(title: string, now = new Date().toISOString()): Canvas {
    return {
        id: nanoid(), title, createdAt: now, updatedAt: now,
        nodes: [], connections: [], chatSessions: [], activeChatId: null,
        backgroundMode: "lines", showImageInfo: false, viewport: initialViewport,
    };
}

export function createProjectWithCanvas(title: string, now = new Date().toISOString(), appearance?: { icon?: string; color?: string }): Project {
    return {
        id: nanoid(),
        title,
        category: UNCATEGORIZED,
        icon: appearance?.icon || DEFAULT_PROJECT_ICON,
        color: appearance?.color || DEFAULT_PROJECT_COLOR,
        createdAt: now,
        updatedAt: now,
        canvases: [createEmptyCanvas(title, now)],
    };
}

export function addCanvasToProject(project: Project, title: string, now = new Date().toISOString()): Project {
    return { ...project, updatedAt: now, canvases: [...project.canvases, createEmptyCanvas(title, now)] };
}

export function removeCanvasFromProject(project: Project, canvasId: string, now = new Date().toISOString(), options?: { allowLast?: boolean }): Project {
    if (!options?.allowLast && project.canvases.length <= 1) return project;
    return { ...project, updatedAt: now, canvases: project.canvases.filter((c) => c.id !== canvasId) };
}

export function updateCanvasInProject(project: Project, canvasId: string, patch: Partial<Omit<Canvas, "id" | "createdAt">>, now = new Date().toISOString()): Project {
    return { ...project, updatedAt: now, canvases: project.canvases.map((c) => (c.id === canvasId ? { ...c, ...patch, updatedAt: now } : c)) };
}

/** 画布列表排序键：最后活跃（updatedAt = max(最后编辑, 最后对话)）倒序，编辑与 Agent 对话共同触碰。 */
export function compareCanvasByActivity(a: Pick<Canvas, "updatedAt">, b: Pick<Canvas, "updatedAt">): number {
    return b.updatedAt.localeCompare(a.updatedAt);
}

export function renameCanvasInProject(project: Project, canvasId: string, title: string, now = new Date().toISOString()): Project {
    return updateCanvasInProject(project, canvasId, { title: title.trim() || "Untitled" }, now);
}

export function findProject(projects: Project[], projectId: string): Project | null {
    return projects.find((p) => p.id === projectId) ?? null;
}

export function findCanvas(projects: Project[], canvasId: string): { project: Project; canvas: Canvas } | null {
    for (const project of projects) {
        const canvas = project.canvases.find((c) => c.id === canvasId);
        if (canvas) return { project, canvas };
    }
    return null;
}

export function migrateLegacyProject(legacy: unknown): Project | null {
    if (!legacy || typeof legacy !== "object") return null;
    const value = legacy as Record<string, unknown>;
    if (Array.isArray(value.canvases)) {
        const project = legacy as Project;
        if (project.icon && project.color) return project;
        return { ...project, icon: project.icon || DEFAULT_PROJECT_ICON, color: project.color || DEFAULT_PROJECT_COLOR };
    }
    if (!Array.isArray(value.nodes)) return null;
    const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString();
    const canvas: Canvas = {
        id: nanoid(),
        title: typeof value.title === "string" ? value.title : "",
        createdAt,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt,
        nodes: value.nodes as CanvasNodeData[],
        connections: (value.connections as CanvasConnection[]) || [],
        chatSessions: (value.chatSessions as CanvasAssistantSession[]) || [],
        activeChatId: (value.activeChatId as string | null) ?? null,
        backgroundMode: (value.backgroundMode as CanvasBackgroundMode) || "lines",
        showImageInfo: Boolean(value.showImageInfo),
        viewport: (value.viewport as ViewportTransform) || initialViewport,
    };
    return {
        id: typeof value.id === "string" ? value.id : nanoid(),
        title: typeof value.title === "string" ? value.title : "",
        category: canonicalCategory(value.category),
        icon: typeof value.icon === "string" ? value.icon : DEFAULT_PROJECT_ICON,
        color: typeof value.color === "string" ? value.color : DEFAULT_PROJECT_COLOR,
        createdAt,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt,
        canvases: [canvas],
    };
}

export function migrateLegacyProjects(raw: unknown): Project[] | null {
    if (!Array.isArray(raw)) return null;
    return raw.map(migrateLegacyProject).filter((p): p is Project => p !== null);
}
