import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button, Dropdown, Input, Modal, Tabs, Tooltip } from "antd";
import { ArrowLeft, Plus, Trash2, Pencil, Check, X, Ellipsis } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { ProjectIconBadge, resolveProjectIcon } from "@/components/canvas/project-icon-badge";
import { MemoryProjectSettings, type MemoryProjectGuard } from "@/components/memory/memory-project-settings";
import { PROJECT_COLORS, PROJECT_ICONS } from "@/lib/canvas/project-appearance";
import { compareCanvasByActivity } from "@/lib/canvas/project-model";
import { MODAL_WIDTH } from "@/lib/design/modal";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import type { Project } from "@/types/project";

export function CanvasListView({ project }: { project: Project }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { message } = App.useApp();
    const createCanvas = useProjectStore((s) => s.createCanvas);
    const renameCanvas = useProjectStore((s) => s.renameCanvas);
    const deleteCanvas = useProjectStore((s) => s.deleteCanvas);
    const updateProjectAppearance = useProjectStore((s) => s.updateProjectAppearance);
    const setDeleteProjectIds = useCanvasUiStore((s) => s.setDeleteProjectIds);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [newTitle, setNewTitle] = useState("");
    const [editProjectOpen, setEditProjectOpen] = useState(false);
    const [projectTitle, setProjectTitle] = useState(project.title);
    const [projectIcon, setProjectIcon] = useState(project.icon);
    const [projectColor, setProjectColor] = useState(project.color);
    const lastCanvas = project.canvases.length <= 1;

    const add = () => {
        const canvasId = createCanvas(project.id, newTitle.trim() || t("canvas.canvas.untitled"));
        if (canvasId) { setNewTitle(""); navigate(`/canvas/${project.id}/${canvasId}`); }
    };
    const openProjectEditor = () => {
        setProjectTitle(project.title);
        setProjectIcon(project.icon);
        setProjectColor(project.color);
        setEditProjectOpen(true);
    };
    // 记忆 tab 未挂载时 guardRef.current 为 null，直接放行关闭
    const memoryGuardRef = useRef<MemoryProjectGuard | null>(null);
    const requestCloseProjectSettings = () => {
        memoryGuardRef.current?.confirmLeave(() => setEditProjectOpen(false));
        if (!memoryGuardRef.current?.dirty) setEditProjectOpen(false);
    };
    const saveProject = () => {
        updateProjectAppearance(project.id, { title: projectTitle, icon: projectIcon, color: projectColor });
        requestCloseProjectSettings();
    };

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto w-full max-w-4xl px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <Button type="text" className="!-ml-2 !mb-4 !h-9 !rounded-lg !px-2" icon={<ArrowLeft className="size-4" />} onClick={() => navigate("/projects")}>
                            {t("common.back")}
                        </Button>
                        <div className="flex items-center gap-3">
                            <ProjectIconBadge icon={project.icon} color={project.color} size={40} />
                            <h1 className="min-w-0 truncate text-3xl font-semibold">{project.title}</h1>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Input className="w-48" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={t("canvas.canvas.newName")} onPressEnter={add} />
                        <Button type="primary" icon={<Plus className="size-4" />} onClick={add}>{t("canvas.canvas.create")}</Button>
                        <Dropdown
                            trigger={["click"]}
                            menu={{
                                items: [
                                    { key: "edit", icon: <Pencil className="size-4" />, label: t("projects.settings"), onClick: openProjectEditor },
                                    { key: "delete", danger: true, icon: <Trash2 className="size-4" />, label: t("projects.delete"), onClick: () => setDeleteProjectIds([project.id]) },
                                ],
                            }}
                        >
                            <Button type="text" shape="circle" icon={<Ellipsis className="size-5" />} aria-label={t("projects.more")} />
                        </Dropdown>
                    </div>
                </header>
                <div className="mt-6 grid gap-4 sm:grid-cols-2">
                    {/* 与侧栏同口径：按「最后活跃」（updatedAt = max(最后编辑, 最后对话)）倒序 */}
                    {[...project.canvases].sort(compareCanvasByActivity).map((canvas) => (
                        <article key={canvas.id} className="group flex items-center justify-between rounded-xl border border-stone-200 p-4 dark:border-stone-800">
                            {editingId === canvas.id ? (
                                <Input value={draft} onChange={(e) => setDraft(e.target.value)} onPressEnter={() => { renameCanvas(project.id, canvas.id, draft); setEditingId(null); }} autoFocus />
                            ) : (
                                <button type="button" className="min-w-0 text-left" onClick={() => navigate(`/canvas/${project.id}/${canvas.id}`)}>
                                    <h2 className="truncate text-lg font-medium">{canvas.title}</h2>
                                    <p className="mt-1 text-xs text-stone-500">{t("canvas.canvas.stats", { nodes: canvas.nodes.length, connections: canvas.connections.length })}</p>
                                </button>
                            )}
                            <div className={cn("flex items-center gap-1", editingId !== canvas.id ? "pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100" : "")} onClick={(e) => e.stopPropagation()}>
                                {editingId === canvas.id ? (
                                    <>
                                        <Button type="text" size="small" shape="circle" icon={<Check className="size-4" />} onClick={() => { renameCanvas(project.id, canvas.id, draft); setEditingId(null); }} />
                                        <Button type="text" size="small" shape="circle" icon={<X className="size-4" />} onClick={() => setEditingId(null)} />
                                    </>
                                ) : (
                                    <>
                                        <Button type="text" size="small" shape="circle" icon={<Pencil className="size-4" />} aria-label={t("common.edit")} onClick={() => { setEditingId(canvas.id); setDraft(canvas.title); }} />
                                        <Tooltip title={lastCanvas ? t("canvas.canvas.lastCanvasHint") : undefined}>
                                            <Button type="text" size="small" shape="circle" icon={<Trash2 className="size-4" />} aria-label={t("common.delete")} disabled={lastCanvas} onClick={() => { deleteCanvas(project.id, canvas.id); message.success(t("canvas.canvas.deleted")); }} />
                                        </Tooltip>
                                    </>
                                )}
                            </div>
                        </article>
                    ))}
                </div>
            </div>

            <Modal title={t("projects.settings")} open={editProjectOpen} centered destroyOnHidden onCancel={requestCloseProjectSettings} footer={null} width={MODAL_WIDTH.sm}>
                <Tabs
                    defaultActiveKey="appearance"
                    items={[
                        {
                            key: "appearance",
                            label: t("projects.settingsTabAppearance"),
                            children: (
                                <div className="flex flex-col gap-5 pt-2">
                                    <label className="flex flex-col gap-2">
                                        <span className="text-xs font-medium text-stone-500 dark:text-stone-400">{t("projects.namePlaceholder")}</span>
                                        <Input value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} onPressEnter={saveProject} autoFocus placeholder={t("projects.namePlaceholder")} />
                                    </label>
                                    <div className="flex flex-col gap-2">
                                        <span className="text-xs font-medium text-stone-500 dark:text-stone-400">{t("projects.iconLabel")}</span>
                                        <div className="grid grid-cols-8 gap-1.5">
                                            {PROJECT_ICONS.map((key) => {
                                                const Icon = resolveProjectIcon(key);
                                                const active = key === projectIcon;
                                                return (
                                                    <button
                                                        key={key}
                                                        type="button"
                                                        onClick={() => setProjectIcon(key)}
                                                        aria-label={key}
                                                        className={cn("grid size-9 place-items-center rounded-lg border transition", active ? "border-current" : "border-transparent text-stone-500 hover:bg-black/5 hover:text-stone-950 dark:text-stone-400 dark:hover:bg-white/10 dark:hover:text-stone-100")}
                                                        style={active ? { borderColor: projectColor, background: `${projectColor}1f`, color: projectColor } : undefined}
                                                    >
                                                        <Icon className="size-4" />
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                    <div className="flex flex-col gap-2">
                                        <span className="text-xs font-medium text-stone-500 dark:text-stone-400">{t("projects.colorLabel")}</span>
                                        <div className="flex flex-wrap gap-2">
                                            {PROJECT_COLORS.map((color) => {
                                                const active = color === projectColor;
                                                return (
                                                    <button key={color} type="button" onClick={() => setProjectColor(color)} aria-label={color} className={cn("grid size-7 place-items-center rounded-full border-2 transition", active ? "border-stone-950 dark:border-stone-100" : "border-transparent")} style={{ background: color }}>
                                                        {active ? <Check className="size-3.5 text-white" /> : null}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                    <div className="flex justify-end gap-2 pt-1">
                                        <Button onClick={requestCloseProjectSettings}>{t("common.cancel")}</Button>
                                        <Button type="primary" onClick={saveProject}>{t("common.save")}</Button>
                                    </div>
                                </div>
                            ),
                        },
                        {
                            key: "memory",
                            label: t("agent.memory.project"),
                            children: <MemoryProjectSettings workspacePath={project.workspacePath} guardRef={memoryGuardRef} />,
                        },
                    ]}
                />
            </Modal>
            <CanvasDeleteProjectsDialog onDeleted={(ids) => ids.includes(project.id) && navigate("/projects")} />
        </main>
    );
}
