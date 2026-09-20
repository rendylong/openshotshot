import { BookOpen, Bot, Briefcase, Camera, Film, Folder, Globe, Image as ImageIcon, Layers, Music, Palette, PenLine, Rocket, Sparkles, Star, Video, type LucideIcon } from "lucide-react";

import { DEFAULT_PROJECT_ICON, type ProjectIcon } from "@/lib/canvas/project-appearance";
import { cn } from "@/lib/utils";

const ICON_COMPONENTS: Record<ProjectIcon, LucideIcon> = {
    folder: Folder,
    image: ImageIcon,
    video: Video,
    music: Music,
    pen: PenLine,
    sparkles: Sparkles,
    film: Film,
    palette: Palette,
    book: BookOpen,
    star: Star,
    briefcase: Briefcase,
    globe: Globe,
    camera: Camera,
    layers: Layers,
    rocket: Rocket,
    bot: Bot,
};

export function resolveProjectIcon(icon: string): LucideIcon {
    return ICON_COMPONENTS[icon as ProjectIcon] ?? ICON_COMPONENTS[DEFAULT_PROJECT_ICON];
}

export function ProjectIconBadge({ icon, color, size = 22, className }: { icon: string; color: string; size?: number; className?: string }) {
    const Icon = resolveProjectIcon(icon);
    return (
        <span className={cn("grid shrink-0 place-items-center rounded-md", className)} style={{ width: size, height: size, background: `${color}1f`, color }}>
            <Icon style={{ width: Math.round(size * 0.62), height: Math.round(size * 0.62) }} />
        </span>
    );
}
