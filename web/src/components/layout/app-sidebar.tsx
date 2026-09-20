import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { App, Dropdown } from "antd";
import type { MenuProps } from "antd";
import { Ellipsis, FolderInput, FolderKanban, Frame, PanelLeftClose, PanelLeftOpen, Plus, Sparkles, Trash2 } from "lucide-react";

import { ProjectIconBadge } from "@/components/canvas/project-icon-badge";
import { SettingsPopover } from "@/components/layout/settings-popover";
import { Spinner } from "@/components/ui/spinner";
import { UNCATEGORIZED_PROJECT_ID } from "@/lib/canvas/category";
import { compareCanvasByActivity } from "@/lib/canvas/project-model";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import { ACTIVE_SESSION_STATUSES, useAgentSessionStore } from "@/stores/use-agent-session-store";
import { useProjectStore } from "@/stores/canvas/use-project-store";

// antd App 注入的 unlayered 重置 `:where(.css-*) a { background-color: transparent; color: … }`
// 会压过 @layer utilities（CSS Cascade 5），因此锚点行的背景与文字色（含 hover）都需要 ! 才能生效
// （同下方 !bg-primary CTA）。非锚点元素不受该重置影响，保持原样不加 !。
const TOP_ACTIVE_ROW = "!bg-sidebar-accent font-normal !text-stone-950 dark:!text-stone-50";
const IDLE_ROW = "!text-stone-600 hover:!bg-foreground/5 hover:!text-stone-950 dark:!text-stone-400 dark:hover:!bg-foreground/10 dark:hover:!text-stone-100";

// hover 移出后延迟收起的宽限期：桌面端标题栏拖拽条（user-layout 的 native-titlebar-drag-region）
// 不向页面投递鼠标事件，指针从面板内部上移去点钉住按钮、一进顶部 28px 条就会触发 aside 的
// mouseleave；延迟收起给指针时间穿越死区抵达按钮（系统菜单/VS Code 浮层的通行宽限值）。
const COLLAPSE_GRACE_MS = 300;

export function AppSidebar() {
    const { t } = useTranslation();
    const { pathname } = useLocation();
    const projects = useProjectStore((state) => state.projects);
    const [pinned, setPinned] = useState(false);
    const [hovered, setHovered] = useState(false);
    const [overlayOpen, setOverlayOpen] = useState(false);
    const collapseTimerRef = useRef<number | undefined>(undefined);
    const clearCollapseTimer = () => {
        if (collapseTimerRef.current !== undefined) {
            window.clearTimeout(collapseTimerRef.current);
            collapseTimerRef.current = undefined;
        }
    };
    useEffect(() => clearCollapseTimer, []);
    const narrow = useMediaQuery("(max-width: 820px)");
    const isMacDesktop = window.shotshot?.platform === "darwin";
    const expanded = pinned || hovered || overlayOpen;
    const effectiveCollapsed = narrow || !expanded;
    const activePath = pathname; // 高亮精确匹配到画布路径
    const skillsActive = activePath === "/skills" || activePath.startsWith("/skills/");
    // Only the /projects routes light up the top-level "Projects" link; canvas
    // routes live in the project tree below, where they get their own highlight.
    const projectsActive = activePath === "/projects" || activePath.startsWith("/projects/");
    const regularProjects = projects.filter((p) => p.id !== UNCATEGORIZED_PROJECT_ID);
    // 运行中画布集合：Agent 会话按 scope.canvasId 归属，口径与后台任务 chip 一致（ACTIVE_SESSION_STATUSES）。
    const sessions = useAgentSessionStore((state) => state.sessions);
    const runningCanvasIds = useMemo(
        () => new Set(sessions.filter((item) => ACTIVE_SESSION_STATUSES.has(item.status)).map((item) => item.scope.canvasId)),
        [sessions],
    );
    // 未分类画布按「最后活跃」倒序（updatedAt = max(最后编辑, 最后对话)，对话受理即触碰）。
    const uncategorizedCanvases = [...(projects.find((p) => p.id === UNCATEGORIZED_PROJECT_ID)?.canvases ?? [])].sort(compareCanvasByActivity);

    const rowCls = (active: boolean) =>
        cn("flex h-11 items-center gap-3 rounded-xl px-3 text-sm leading-6 transition", active ? TOP_ACTIVE_ROW : IDLE_ROW);

    return (
        <aside
            onMouseEnter={() => {
                clearCollapseTimer();
                setHovered(true);
            }}
            onMouseLeave={() => {
                clearCollapseTimer();
                collapseTimerRef.current = window.setTimeout(() => {
                    collapseTimerRef.current = undefined;
                    setHovered(false);
                }, COLLAPSE_GRACE_MS);
            }}
            className={cn("relative flex h-full shrink-0 flex-col border-r border-stone-200 bg-background transition-[width] dark:border-stone-800", effectiveCollapsed ? "w-14" : "w-[240px]")}
        >
            <nav aria-label={t("sidebar.navLabel")} className={cn("flex min-h-0 flex-1 flex-col p-2", isMacDesktop && "pt-14")}>
                <Link
                    to="/"
                    aria-label={t("meta.title")}
                    className={cn(
                        "native-titlebar-no-drag relative z-50 mb-2 flex h-11 shrink-0 items-center gap-3 rounded-xl text-sm font-semibold leading-none tracking-tight !text-stone-950 transition hover:!bg-foreground/5 dark:!text-stone-100 dark:hover:!bg-foreground/10",
                        effectiveCollapsed ? "justify-center px-0" : "px-3",
                    )}
                >
                    <span className="size-6 shrink-0 bg-current" aria-hidden="true" style={{ mask: "url(./shotshot.png) center / contain no-repeat", WebkitMask: "url(./shotshot.png) center / contain no-repeat" }} />
                    {!effectiveCollapsed && <span className="text-base font-medium">{t("meta.title")}</span>}
                </Link>
                <ul className="shrink-0 space-y-1">
                    <li>
                        <Link to="/" aria-current={activePath === "/" ? "page" : undefined} aria-label={t("sidebar.start")} className="flex h-9 items-center justify-center gap-2 rounded-lg !bg-primary px-2.5 text-sm font-medium !text-primary-foreground transition hover:!bg-primary/90">
                            <Plus className="size-5 shrink-0" />
                            {!effectiveCollapsed && <span className="truncate">{t("sidebar.start")}</span>}
                        </Link>
                    </li>
                    <li>
                        <Link to="/skills" aria-current={skillsActive ? "page" : undefined} data-selected={skillsActive ? "true" : undefined} aria-label={t("sidebar.skills")} className={rowCls(skillsActive)}>
                            <Sparkles className="size-4 shrink-0" strokeWidth={1.5} />
                            {!effectiveCollapsed && <span className="truncate">{t("sidebar.skills")}</span>}
                        </Link>
                    </li>
                    <li>
                        <Link to="/projects" aria-current={projectsActive ? "page" : undefined} data-selected={projectsActive ? "true" : undefined} aria-label={t("sidebar.projects")} className={rowCls(projectsActive)}>
                            <FolderKanban className="size-4 shrink-0" strokeWidth={1.5} />
                            {!effectiveCollapsed && <span className="truncate">{t("sidebar.projects")}</span>}
                        </Link>
                    </li>
                </ul>

                {!effectiveCollapsed && (
                    <>
                        <div className="shrink-0 px-3 pb-1 pt-2 text-xs font-medium text-stone-500 dark:text-stone-400">{t("sidebar.treeHeading")}</div>
                        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto">
                            <ul className="space-y-1">
                                {regularProjects.map((project) => {
                                    const canvases = [...project.canvases].sort(compareCanvasByActivity);
                                    return (
                                        <ProjectTreeRow key={project.id} projectId={project.id} title={project.title} icon={project.icon} color={project.color} canvasIds={canvases.map((c) => c.id)} canvasTitles={canvases.map((c) => c.title)} runningCanvasIds={runningCanvasIds} activePath={activePath} allProjects={regularProjects} />
                                    );
                                })}
                            </ul>
                            {uncategorizedCanvases.length > 0 && (
                                <>
                                    <div className="px-3 pb-1 pt-3 text-xs font-medium text-stone-500 dark:text-stone-400">{t("sidebar.uncategorized")}</div>
                                    <ul className="space-y-1">
                                        {uncategorizedCanvases.map((canvas) => (
                                            <UncategorizedCanvasRow key={canvas.id} canvasId={canvas.id} title={canvas.title} running={runningCanvasIds.has(canvas.id)} activePath={activePath} allProjects={regularProjects} onMenuOpenChange={setOverlayOpen} />
                                        ))}
                                    </ul>
                                </>
                            )}
                        </div>
                    </>
                )}
            </nav>

            {/* 折叠/钉住按钮：与 macOS 红绿灯同行（用户指定位置），no-drag 保证可点击。
                放在 nav 之后以盖过同 z-50 的品牌行；折叠态整体隐藏，避免在 56px 宽度下与红绿灯打架。
                折叠态靠悬停展开，钉住需先悬停再点本按钮。
                p-2 -m-2 把 no-drag 热区扩到窗口角落（顶到 y=0、贴齐右缘），接近路径落在热区内，
                不必穿越标题栏 28px 拖拽死区；视觉位置不变。 */}
            {!effectiveCollapsed && (
                <div className="native-titlebar-no-drag absolute right-2 top-2 z-50 -m-2 flex items-center gap-1 p-2">
                    <button
                        type="button"
                        onClick={() => {
                            // 取消钉住是显式收起命令：立即收起，不等 hover 宽限期（钉住同理立即生效）
                            if (pinned) {
                                clearCollapseTimer();
                                setHovered(false);
                            }
                            setPinned(!pinned);
                        }}
                        className="grid size-7 place-items-center rounded-lg text-stone-500 transition hover:bg-foreground/5 hover:text-stone-950 dark:hover:bg-foreground/10 dark:hover:text-white"
                        aria-label={t("sidebar.collapse")}
                    >
                        {pinned ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
                    </button>
                </div>
            )}

            <div className="flex shrink-0 items-center border-t border-stone-200 p-2 dark:border-stone-800">
                <SettingsPopover onOpenChange={setOverlayOpen} collapsed={effectiveCollapsed} />
            </div>
        </aside>
    );
}

function UncategorizedCanvasRow({ canvasId, title, running, activePath, allProjects, onMenuOpenChange }: { canvasId: string; title: string; running: boolean; activePath: string; allProjects: { id: string; title: string }[]; onMenuOpenChange?: (open: boolean) => void }) {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const moveCanvasToProject = useProjectStore((state) => state.moveCanvasToProject);
    const deleteCanvas = useProjectStore((state) => state.deleteCanvas);
    const navigate = useNavigate();
    const path = `/canvas/${UNCATEGORIZED_PROJECT_ID}/${canvasId}`;
    const active = activePath === path;
    const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
    const updateActionsMenuOpen = (open: boolean) => {
        setActionsMenuOpen(open);
        onMenuOpenChange?.(open);
    };
    const menuItems: MenuProps["items"] = [
        ...(allProjects.length > 0
            ? [
                  { key: "move", icon: <FolderInput className="size-4" />, label: t("sidebar.moveToProject"), children: allProjects.map((p) => ({ key: p.id, label: p.title })) },
                  { type: "divider" } as const,
              ]
            : []),
        { key: "delete", icon: <Trash2 className="size-4" />, label: t("common.delete"), danger: true },
    ];
    return (
        <li className="group relative flex items-center">
            <Link
                to={path}
                aria-current={active ? "page" : undefined}
                className={cn("flex h-11 min-w-0 flex-1 items-center gap-3 rounded-xl pl-3 pr-9 text-sm transition", active ? TOP_ACTIVE_ROW : IDLE_ROW)}
            >
                <span className="grid size-[18px] shrink-0 place-items-center rounded-md bg-foreground/5 text-muted-foreground" aria-hidden="true">
                    {/* Agent 运行中：Frame 换成旋转 loader（同 size），结束恢复 */}
                    {running ? <Spinner className="size-[11px]" /> : <Frame className="size-[11px]" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{title}</span>
            </Link>
            <Dropdown
                menu={{
                    items: menuItems,
                    onClick: ({ key }) => {
                        if (key === "delete") {
                            updateActionsMenuOpen(false);
                            modal.confirm({
                                title: t("canvas.canvas.deleteConfirmTitle", { title }),
                                content: t("canvas.canvas.deleteConfirmDescription"),
                                okText: t("common.delete"),
                                okButtonProps: { danger: true },
                                cancelText: t("common.cancel"),
                                onOk: () => {
                                    // 未分类是伪项目，「项目至少保留一个画布」的护栏不适用
                                    deleteCanvas(UNCATEGORIZED_PROJECT_ID, canvasId, { allowLast: true });
                                    message.success(t("canvas.canvas.deleted"));
                                    // 删除当前打开的画布后路由已失效，回首页避免停留在已删画布上
                                    if (active) navigate("/");
                                },
                            });
                            return;
                        }
                        updateActionsMenuOpen(false);
                        moveCanvasToProject(UNCATEGORIZED_PROJECT_ID, canvasId, key);
                        navigate(`/canvas/${key}/${canvasId}`);
                    },
                }}
                open={actionsMenuOpen}
                onOpenChange={updateActionsMenuOpen}
                trigger={["click"]}
            >
                <button
                    type="button"
                    className="absolute right-1 grid size-7 place-items-center rounded-lg text-stone-400 opacity-0 transition hover:bg-foreground/5 hover:text-stone-700 group-hover:opacity-100 dark:hover:bg-foreground/10 dark:hover:text-stone-200"
                    aria-label={t("sidebar.rowActions")}
                >
                    <Ellipsis className="size-4" />
                </button>
            </Dropdown>
        </li>
    );
}

function ProjectTreeRow({ projectId, title, icon, color, canvasIds, canvasTitles, runningCanvasIds, activePath, allProjects }: { projectId: string; title: string; icon: string; color: string; canvasIds: string[]; canvasTitles: string[]; runningCanvasIds: Set<string>; activePath: string; allProjects: { id: string; title: string }[] }) {
    const { t } = useTranslation();
    const createCanvas = useProjectStore((state) => state.createCanvas);
    const navigate = useNavigate();
    const detailPath = `/projects/${projectId}`;
    const canvasActive = (id: string) => activePath === `/canvas/${projectId}/${id}`;
    const projectActive = activePath === detailPath;
    const hasActiveCanvas = canvasIds.some(canvasActive);
    const [open, setOpen] = useState(projectActive || hasActiveCanvas);

    useEffect(() => {
        if (projectActive || hasActiveCanvas) setOpen(true);
    }, [hasActiveCanvas, projectActive]);

    return (
        <li>
            <div className="group relative flex items-center">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                className={cn("flex h-11 min-w-0 flex-1 items-center gap-3 rounded-xl pl-3 pr-9 text-sm leading-6 transition", projectActive ? TOP_ACTIVE_ROW : IDLE_ROW)}
            >
                <ProjectIconBadge icon={icon} color={color} size={18} />
                <span className="min-w-0 flex-1 truncate text-left">{title}</span>
            </button>
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); const id = createCanvas(projectId); if (id) navigate(`/canvas/${projectId}/${id}`); }}
                className="absolute right-1 grid size-7 place-items-center rounded-lg text-stone-400 opacity-0 transition hover:bg-foreground/5 hover:text-stone-700 group-hover:opacity-100 dark:hover:bg-foreground/10 dark:hover:text-stone-200"
                aria-label={t("sidebar.addCanvas")}
            >
                <Plus className="size-4" />
            </button>
            </div>
            {open && (
                <ul className="space-y-1">
                    {canvasIds.map((id, i) => (
                        <li key={id}>
                            <Link
                                to={`/canvas/${projectId}/${id}`}
                                aria-current={canvasActive(id) ? "page" : undefined}
                                className={cn("relative flex h-11 w-full items-center rounded-xl pl-[42px] pr-3 text-sm transition", canvasActive(id) ? TOP_ACTIVE_ROW : "!text-stone-500 hover:!bg-foreground/5 hover:!text-stone-950 dark:!text-stone-400 dark:hover:!bg-foreground/10 dark:hover:!text-stone-100")}
                            >
                                {/* 该行平时无图标：仅 Agent 运行中时在缩进带（12~42px）内出现 spinner，文本缩进不动 */}
                                {runningCanvasIds.has(id) && <Spinner className="absolute left-[20px] top-1/2 size-3.5 -translate-y-1/2" />}
                                <span className="truncate">{canvasTitles[i] || id}</span>
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </li>
    );
}
