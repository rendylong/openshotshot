import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type Canvas = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

export type Project = {
    id: string;
    title: string;
    category: string;
    icon: string;
    color: string;
    createdAt: string;
    updatedAt: string;
    canvases: Canvas[];
    /** 项目工作区目录（本机绝对路径）；undefined = 尚未创建。 */
    workspacePath?: string;
};
