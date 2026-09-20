import { useEffect, useState } from "react";
import { Button, Input, Modal } from "antd";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";

import { resolveProjectIcon } from "@/components/canvas/project-icon-badge";
import { DEFAULT_PROJECT_COLOR, DEFAULT_PROJECT_ICON, PROJECT_COLORS, PROJECT_ICONS, type ProjectIcon } from "@/lib/canvas/project-appearance";
import { MODAL_WIDTH } from "@/lib/design/modal";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/stores/canvas/use-project-store";

export function NewProjectDialog({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (title: string, icon: string, color: string) => void }) {
    const { t } = useTranslation();
    const projects = useProjectStore((state) => state.projects);
    const [title, setTitle] = useState("");
    const [icon, setIcon] = useState<ProjectIcon>(DEFAULT_PROJECT_ICON);
    const [color, setColor] = useState<string>(DEFAULT_PROJECT_COLOR);

    useEffect(() => {
        if (!open) return;
        setTitle(t("canvas.defaultTitle", { count: projects.length + 1 }));
        setIcon(DEFAULT_PROJECT_ICON);
        setColor(DEFAULT_PROJECT_COLOR);
    }, [open, projects.length, t]);

    const submit = () => {
        onCreate(title.trim() || t("canvas.defaultTitle", { count: projects.length + 1 }), icon, color);
    };

    return (
        <Modal title={t("projects.create")} open={open} centered onCancel={onClose} footer={null} width={MODAL_WIDTH.sm} destroyOnHidden>
            <div className="flex flex-col gap-5 pt-2">
                <label className="flex flex-col gap-2">
                    <span className="text-xs font-medium text-stone-500 dark:text-stone-400">{t("projects.namePlaceholder")}</span>
                    <Input value={title} onChange={(event) => setTitle(event.target.value)} onPressEnter={submit} autoFocus placeholder={t("projects.namePlaceholder")} />
                </label>

                <div className="flex flex-col gap-2">
                    <span className="text-xs font-medium text-stone-500 dark:text-stone-400">{t("projects.iconLabel")}</span>
                    <div className="grid grid-cols-8 gap-1.5">
                        {PROJECT_ICONS.map((key) => {
                            const Icon = resolveProjectIcon(key);
                            const active = key === icon;
                            return (
                                <button
                                    key={key}
                                    type="button"
                                    onClick={() => setIcon(key)}
                                    aria-label={key}
                                    className={cn(
                                        "grid size-9 place-items-center rounded-lg border transition",
                                        active ? "border-stone-950 bg-stone-950 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-950" : "border-transparent text-stone-500 hover:bg-black/5 hover:text-stone-950 dark:text-stone-400 dark:hover:bg-white/10 dark:hover:text-stone-100",
                                    )}
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
                        {PROJECT_COLORS.map((c) => {
                            const active = c === color;
                            return (
                                <button key={c} type="button" onClick={() => setColor(c)} aria-label={c} className={cn("grid size-7 place-items-center rounded-full border-2 transition", active ? "border-stone-950 dark:border-stone-100" : "border-transparent")} style={{ background: c }}>
                                    {active ? <Check className="size-3.5 text-white" /> : null}
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div className="flex justify-end gap-2 pt-1">
                    <Button onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="primary" onClick={submit}>{t("projects.confirm")}</Button>
                </div>
            </div>
        </Modal>
    );
}
