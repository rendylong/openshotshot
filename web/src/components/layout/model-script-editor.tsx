import { javascript } from "@codemirror/lang-javascript";
import CodeMirror from "@uiw/react-codemirror";
import { Button, Modal, theme } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getPluginReturn, getPluginTemplates, getPluginVariables } from "@/services/api/model-plugin";
import type { ModelCapability } from "@/stores/use-config-store";

function isDarkMode() {
    return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

export function ModelScriptEditor({ open, capability, modelName, value, onSave, onClose }: { open: boolean; capability: ModelCapability; modelName: string; value: string; onSave: (script: string) => void; onClose: () => void }) {
    const { t } = useTranslation();
    const { token } = theme.useToken();
    const [draft, setDraft] = useState(value);
    useEffect(() => {
        if (open) setDraft(value);
    }, [open, value]);

    const variables = getPluginVariables().filter((variable) => !variable.capabilities || variable.capabilities.includes(capability));
    const templates = getPluginTemplates()[capability];

    return (
        <Modal
            open={open}
            title={
                <div>
                    <div className="text-base font-semibold">
                        {t(`config.channelEditor.capabilities.${capability}`)}
                        {modelName ? ` - ${modelName}` : ""}
                    </div>
                    <div className="mt-1 text-xs font-normal" style={{ color: token.colorTextSecondary }}>{t("config.scriptEditor.description")}</div>
                </div>
            }
            width={1080}
            centered
            onCancel={onClose}
            styles={{ body: { padding: 0 } }}
            footer={
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                        {templates.map((template) => (
                            <Button key={template.label} size="small" onClick={() => setDraft(template.script)}>
                                {t("config.scriptEditor.insertTemplate", { name: template.label })}
                            </Button>
                        ))}
                        <Button size="small" danger onClick={() => setDraft("")}>
                            {t("config.scriptEditor.restoreDefault")}
                        </Button>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button onClick={onClose}>{t("common.cancel")}</Button>
                        <Button
                            type="primary"
                            onClick={() => {
                                onSave(draft.trim());
                                onClose();
                            }}
                        >
                            {t("common.save")}
                        </Button>
                    </div>
                </div>
            }
        >
            <div className="flex h-[60vh] min-h-[420px]" style={{ borderTop: `1px solid ${token.colorSplit}` }}>
                <aside className="flex w-[320px] shrink-0 flex-col overflow-y-auto" style={{ borderInlineEnd: `1px solid ${token.colorSplit}` }}>
                    <div className="px-4 py-3" style={{ borderBottom: `1px solid ${token.colorSplit}` }}>
                        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: token.colorTextQuaternary }}>{t("config.scriptEditor.returnRequirements")}</div>
                        <div className="text-xs leading-6" style={{ color: token.colorTextSecondary }}>{getPluginReturn(capability)}</div>
                    </div>
                    <div className="px-4 py-3">
                        <div className="mb-2.5 flex items-center justify-between">
                            <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: token.colorTextQuaternary }}>{t("config.scriptEditor.variables")}</span>
                            <span className="text-[10px]" style={{ color: token.colorTextQuaternary }}>{t("config.scriptEditor.insert")}</span>
                        </div>
                        <div className="space-y-1.5">
                            {variables.map((variable) => (
                                <button
                                    key={variable.name}
                                    type="button"
                                    onClick={() => setDraft((current) => (current ? `${current}\n${variable.name}` : variable.name))}
                                    className="block w-full px-2.5 py-2 text-left"
                                    style={{ borderRadius: token.borderRadiusSM }}
                                >
                                    <div className="flex flex-wrap items-baseline gap-1.5">
                                        <code className="px-1.5 py-0.5 font-mono text-[11px] font-semibold" style={{ borderRadius: token.borderRadiusSM, background: token.colorFillSecondary, color: token.colorText }}>
                                            {variable.name}
                                        </code>
                                        <span className="font-mono text-[10px]" style={{ color: token.colorTextQuaternary }}>{variable.type}</span>
                                    </div>
                                    <div className="mt-1 text-xs leading-5" style={{ color: token.colorTextSecondary }}>{variable.desc}</div>
                                </button>
                            ))}
                        </div>
                    </div>
                </aside>
                <div className="min-w-0 flex-1 overflow-hidden" style={{ background: token.colorBgContainer }}>
                    <CodeMirror
                        value={draft}
                        onChange={setDraft}
                        height="100%"
                        theme={isDarkMode() ? "dark" : "light"}
                        extensions={[javascript()]}
                        placeholder={t("config.scriptEditor.placeholder")}
                        style={{ height: "100%", fontSize: 14 }}
                        className="h-full [&_.cm-editor]:h-full [&_.cm-gutters]:border-none [&_.cm-scroller]:overflow-auto"
                    />
                </div>
            </div>
        </Modal>
    );
}
