import { javascript } from "@codemirror/lang-javascript";
import CodeMirror from "@uiw/react-codemirror";
import { App, Button, Drawer, Form, Select, Space, Tabs, theme } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { getRemoteTaskPluginVariables } from "@/services/api/model-plugin";
import { getRemoteTaskTemplates } from "@/services/api/remote-media-task";
import { DEFAULT_REMOTE_TASK_TIMEOUT_MINUTES, type RemoteTaskConfig } from "@/stores/use-config-store";
import type { RemoteMediaCapability } from "@/types/remote-media-task";

function isDarkMode() {
    return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

export function RemoteTaskScriptEditor({ open, capability, modelName, value, onSave, onClose }: { open: boolean; capability: RemoteMediaCapability; modelName: string; value: RemoteTaskConfig; onSave: (value: RemoteTaskConfig) => void; onClose: () => void }) {
    const { t } = useTranslation();
    const { modal } = App.useApp();
    const { token } = theme.useToken();
    const [submitScript, setSubmitScript] = useState(value.submitScript);
    const [queryScript, setQueryScript] = useState(value.queryScript);
    const [preset, setPreset] = useState("custom");
    const templates = useMemo(() => getRemoteTaskTemplates()[capability], [capability]);

    useEffect(() => {
        if (!open) return;
        setSubmitScript(value.submitScript);
        setQueryScript(value.queryScript);
        setPreset("custom");
    }, [open, value]);

    const submitVariables = getRemoteTaskPluginVariables("submit", capability);
    const queryVariables = getRemoteTaskPluginVariables("query", capability);
    const selectPreset = (next: string) => {
        if (next === "custom") {
            setPreset(next);
            return;
        }
        const template = templates[Number(next.slice("template:".length))];
        if (!template) return;
        const replacesExisting = Boolean((submitScript.trim() || queryScript.trim()) && (submitScript !== template.submitScript || queryScript !== template.queryScript));
        const apply = () => {
            setSubmitScript(template.submitScript);
            setQueryScript(template.queryScript);
            setPreset(next);
        };
        if (replacesExisting) {
            modal.confirm({
                title: t("config.remoteTaskEditor.replaceTitle"),
                content: t("config.remoteTaskEditor.replaceConfirm"),
                okText: t("config.remoteTaskEditor.replace"),
                cancelText: t("common.cancel"),
                onOk: apply,
            });
            return;
        }
        apply();
    };
    const presetOptions = [
        { label: t("config.remoteTaskEditor.custom"), value: "custom" },
        ...templates.map((template, index) => ({ label: template.label, value: `template:${index}` })),
    ];

    const scriptPane = (phase: "submit" | "query") => {
        const draft = phase === "submit" ? submitScript : queryScript;
        const setDraft = phase === "submit" ? setSubmitScript : setQueryScript;
        const phaseVariables = phase === "query" ? queryVariables : submitVariables;
        return (
            <div className="grid min-h-[460px] grid-cols-[260px_minmax(0,1fr)] overflow-hidden" style={{ border: `1px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadiusLG }}>
                <aside className="overflow-y-auto p-4" style={{ borderInlineEnd: `1px solid ${token.colorSplit}` }}>
                    <div className="text-xs font-semibold">{t("config.remoteTaskEditor.returnContract")}</div>
                    <div className="mt-2 whitespace-pre-line font-mono text-xs leading-6" style={{ color: token.colorTextSecondary }}>
                        {t(`config.remoteTaskEditor.contracts.${phase}`)}
                    </div>
                    <div className="mb-2 mt-5 text-xs font-semibold">{t("config.scriptEditor.variables")}</div>
                    <div className="space-y-1">
                        {phaseVariables.map((variable) => (
                            <button
                                key={variable.name}
                                type="button"
                                aria-label={variable.name}
                                className="block w-full px-1 py-1.5 text-left"
                                style={{ borderRadius: token.borderRadiusSM }}
                                onClick={() => {
                                    setDraft((current) => (current ? `${current}\n${variable.name}` : variable.name));
                                    setPreset("custom");
                                }}
                            >
                                <span className="font-mono text-xs font-medium">{variable.name}</span>
                                <span className="ml-1 font-mono text-[10px]" style={{ color: token.colorTextQuaternary }}>{variable.type}</span>
                                <span className="mt-0.5 block text-xs leading-5" style={{ color: token.colorTextSecondary }}>{variable.desc}</span>
                            </button>
                        ))}
                    </div>
                </aside>
                <div className="min-w-0 overflow-hidden" style={{ background: token.colorBgContainer }}>
                    <CodeMirror
                        aria-label={t(`config.remoteTaskEditor.${phase}Script`)}
                        value={draft}
                        onChange={(next) => {
                            setDraft(next);
                            setPreset("custom");
                        }}
                        height="460px"
                        theme={isDarkMode() ? "dark" : "light"}
                        extensions={[javascript()]}
                        placeholder={t(`config.remoteTaskEditor.${phase}Placeholder`)}
                        style={{ fontSize: 14 }}
                        className="h-full [&_.cm-editor]:h-full [&_.cm-gutters]:border-none [&_.cm-scroller]:overflow-auto"
                    />
                </div>
            </div>
        );
    };

    return (
        <Drawer
            open={open}
            size={920}
            title={
                <div>
                    <div>{t("config.remoteTaskEditor.title", { model: modelName })}</div>
                    <div className="mt-1 text-xs font-normal" style={{ color: token.colorTextSecondary }}>{t("config.remoteTaskEditor.description")}</div>
                </div>
            }
            onClose={onClose}
            extra={
                <Space>
                    <Button aria-label={t("common.cancel")} onClick={onClose}>{t("common.cancel")}</Button>
                    <Button aria-label={t("common.save")} type="primary" onClick={() => { onSave({ ...value, timeoutMinutes: DEFAULT_REMOTE_TASK_TIMEOUT_MINUTES, submitScript: submitScript.trim(), queryScript: queryScript.trim() }); onClose(); }}>{t("common.save")}</Button>
                </Space>
            }
        >
            <Form layout="vertical" requiredMark={false}>
                <Form.Item label={t("config.remoteTaskEditor.preset")} extra={capability === "image" ? t("config.remoteTaskEditor.presetDescription") : t("config.remoteTaskEditor.customDescription")}>
                    <Select aria-label={t("config.remoteTaskEditor.preset")} value={preset} options={presetOptions} onChange={selectPreset} popupMatchSelectWidth={false} style={{ width: 240 }} />
                </Form.Item>
            </Form>
            <Tabs
                items={[
                    { key: "submit", label: t("config.remoteTaskEditor.submit"), children: scriptPane("submit") },
                    { key: "query", label: t("config.remoteTaskEditor.query"), children: scriptPane("query") },
                ]}
            />
        </Drawer>
    );
}
