import { useEffect, useState } from "react";
import { App, Button, Modal, Skeleton, Tag } from "antd";
import { AlertTriangle, FileText, Folder, Play, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { EmptyState } from "@/components/ui/empty-state";
import { canvasTitleFromPrompt } from "@/lib/canvas/canvas-title";
import { canvasThemes } from "@/lib/canvas-theme";
import type { LocalSkillDetail, LocalSkillSummary } from "@/lib/skills/skill-types";
import { removeLocalSkill } from "@/services/local-skill";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { SkillStatusTag } from "./skill-status-tag";
import { loadSkillDetail, useLocalSkillStore } from "@/stores/use-local-skill-store";
import { useThemeStore } from "@/stores/use-theme-store";

type FileNode = { name: string; path: string; children?: FileNode[] };

function buildFileTree(files: string[]): FileNode[] {
    const root: FileNode[] = [];
    for (const file of files) {
        const segments = file.split("/").filter(Boolean);
        let level = root;
        segments.forEach((name, index) => {
            let node = level.find((item) => item.name === name);
            if (!node) {
                node = { name, path: segments.slice(0, index + 1).join("/"), ...(index < segments.length - 1 ? { children: [] } : {}) };
                level.push(node);
            }
            if (node.children) level = node.children;
        });
    }
    return root;
}

function FileTree({ nodes, depth = 0 }: { nodes: FileNode[]; depth?: number }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <ul className="space-y-1">
            {nodes.map((node) => {
                const directory = Boolean(node.children);
                const Icon = directory ? Folder : FileText;
                return (
                    <li key={node.path}>
                        <div className="flex items-center gap-1.5 py-0.5 text-[11px]" style={{ paddingLeft: depth * 14, color: directory ? theme.node.text : theme.node.muted }}>
                            <Icon className="size-3 shrink-0" />
                            <span className="truncate font-mono">{node.name}</span>
                        </div>
                        {node.children?.length ? <FileTree nodes={node.children} depth={depth + 1} /> : null}
                    </li>
                );
            })}
        </ul>
    );
}

type Props = {
    skill: LocalSkillSummary | null;
    open: boolean;
    onClose: () => void;
};

export function SkillDetailModal({ skill, open, onClose }: Props) {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const scanSkills = useLocalSkillStore((state) => state.scanSkills);
    const navigate = useNavigate();
    // eng review P1：导航完成前禁用重复提交——快速双击会覆盖 pending 键、留下一块无对话的空白画布。
    const [handoffBusy, setHandoffBusy] = useState(false);
    const [detail, setDetail] = useState<LocalSkillDetail | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!open || !skill) return;
        let active = true;
        setLoading(true);
        setError("");
        setDetail(null);
        void loadSkillDetail(skill.name)
            .then((result) => {
                if (!active) return;
                if (result) setDetail(result);
                else setError(t("skills.detail.notFound"));
            })
            .catch((reason) => {
                if (active) setError(reason instanceof Error ? reason.message : String(reason));
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => { active = false; };
    }, [open, skill, t]);

    const confirmDelete = () => {
        if (!skill || skill.source !== "app" || skill.readonly) return;
        modal.confirm({
            title: t("skills.detail.delete"),
            content: t("skills.list.deleteConfirm"),
            okText: t("skills.list.delete"),
            okType: "danger",
            cancelText: t("common.cancel"),
            onOk: async () => {
                const result = await removeLocalSkill(skill.name);
                if (!result.ok) {
                    message.error(t("skills.detail.deleteFailed"));
                    return;
                }
                onClose();
                await scanSkills();
            },
        });
    };

    const footer = skill ? (
        <div className="flex items-center justify-between gap-3">
            <div>
                {skill.source === "app" && !skill.readonly ? (
                    <Button danger type="text" icon={<Trash2 className="size-3.5" />} onClick={confirmDelete}>{t("skills.detail.delete")}</Button>
                ) : null}
            </div>
            <div className="flex items-center gap-2">
                <Button type="text" onClick={onClose}>{t("common.cancel")}</Button>
                <Button
                    type="primary"
                    disabled={!skill.valid}
                    icon={<Play className="size-3.5" />}
                    onClick={() => {
                        if (!skill || handoffBusy) return;
                        setHandoffBusy(true);
                        const ids = useProjectStore.getState().submitPendingPrompt(`/${skill.name}`, canvasTitleFromPrompt(`/${skill.name}`));
                        if (!ids) {
                            setHandoffBusy(false);
                            return;
                        }
                        onClose();
                        navigate(`/canvas/${ids.projectId}/${ids.canvasId}`);
                    }}
                >
                    {t("skills.detail.use")}
                </Button>
            </div>
        </div>
    ) : null;

    return (
        <Modal
            open={open}
            title={skill?.displayName || skill?.name || t("skills.detail.title")}
            centered
            width={760}
            footer={footer}
            destroyOnHidden
            styles={{ body: { maxHeight: "min(680px, calc(100vh - 220px))", overflowY: "auto" } }}
            onCancel={onClose}
        >
            {skill ? (
                <div className="space-y-5">
                    <div>
                        <div className="flex flex-wrap items-center gap-1.5">
                            <Tag bordered={false}>{t(`skills.sources.${skill.source}`)}</Tag>
                            <SkillStatusTag
                                status={!skill.valid ? "invalid" : skill.manualOnly ? "manual" : "available"}
                                label={t(!skill.valid ? "skills.status.invalid" : skill.manualOnly ? "skills.status.manual" : "skills.status.available")}
                            />
                        </div>
                        <p className="mt-3 text-sm leading-6" style={{ color: theme.node.muted }}>{skill.description}</p>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                        <section>
                            <div className="text-[11px] font-medium" style={{ color: theme.node.faint }}>{t("skills.detail.path")}</div>
                            <div className="mt-1 break-all font-mono text-xs leading-5" style={{ color: theme.node.text }}>{detail?.path || skill.path}</div>
                        </section>
                        <section>
                            <div className="text-[11px] font-medium" style={{ color: theme.node.faint }}>{t("skills.detail.command")}</div>
                            <div className="mt-1 font-mono text-xs leading-5" style={{ color: theme.node.text }}>/{skill.name}</div>
                        </section>
                    </div>

                    {skill.readonly ? (
                        <p className="border-l-2 pl-3 text-xs leading-5" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>{t("skills.detail.readonly")}</p>
                    ) : null}

                    {loading ? <Skeleton active paragraph={{ rows: 6 }} /> : error ? (
                        <EmptyState icon={AlertTriangle} description={error} />
                    ) : detail ? (
                        <div className="grid gap-5 md:grid-cols-[minmax(0,1.6fr)_minmax(180px,0.8fr)]">
                            <section className="min-w-0">
                                <div className="text-xs font-medium" style={{ color: theme.node.text }}>{t("skills.detail.instructions")}</div>
                                <pre
                                    className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3 font-mono text-[11px] leading-5"
                                    style={{ borderColor: theme.node.stroke, backgroundColor: theme.canvas.background, color: theme.node.muted }}
                                >
                                    {detail.instructions || t("skills.detail.noInstructions")}
                                </pre>
                            </section>
                            <section className="min-w-0">
                                <div className="text-xs font-medium" style={{ color: theme.node.text }}>{t("skills.detail.files")}</div>
                                <div className="mt-2 rounded-lg border p-3" style={{ borderColor: theme.node.stroke, backgroundColor: theme.canvas.background }}>
                                    {detail.files.length ? <FileTree nodes={buildFileTree(detail.files)} /> : <span className="text-[11px]" style={{ color: theme.node.faint }}>{t("skills.detail.noFiles")}</span>}
                                </div>
                            </section>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </Modal>
    );
}
