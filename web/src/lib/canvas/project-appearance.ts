// Preset appearance options for a project: a small icon key plus an accent color.
// Stored as plain strings on the Project so they persist as JSON.

export const PROJECT_ICONS = [
    "folder",
    "image",
    "video",
    "music",
    "pen",
    "sparkles",
    "film",
    "palette",
    "book",
    "star",
    "briefcase",
    "globe",
    "camera",
    "layers",
    "rocket",
    "bot",
] as const;

export type ProjectIcon = (typeof PROJECT_ICONS)[number];

export const PROJECT_COLORS = [
    "#6366f1",
    "#8b5cf6",
    "#0ea5e9",
    "#10b981",
    "#f59e0b",
    "#ef4444",
    "#ec4899",
    "#14b8a6",
    "#f97316",
    "#a855f7",
] as const;

export const DEFAULT_PROJECT_ICON: ProjectIcon = "folder";
export const DEFAULT_PROJECT_COLOR: string = PROJECT_COLORS[0];
