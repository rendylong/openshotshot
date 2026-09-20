import type { Project } from "@/types/project";

export type CanvasExportFile = {
    app: "shotshot";
    version: 3;
    exportedAt: string;
    projects: CanvasProjectExportItem[];
};

export type CanvasProjectExportItem = {
    project: Project;
    files: CanvasExportAsset[];
};

export type CanvasExportAsset = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};
