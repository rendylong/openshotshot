import { useQueryClient } from "@tanstack/react-query";
import { App, Button, Drawer, Form, Input, Select, Space, Switch, Tag, theme } from "antd";
import { ListPlus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { mergeCatalogSelection } from "@/lib/models/channel-model-metadata";
import type { CatalogEntry } from "@/lib/models/model-catalog-types";
import { getAutodlWorkflow } from "@/lib/models/autodl-workflows";
import { isAutodlChannel } from "@/lib/models/model-resolver";
import { fetchHiapiCatalog, getHiapiCatalogMirror } from "@/services/api/media-adapters/hiapi-catalog";
import { defaultBaseUrlForApiFormat, guessCapability, inferImageInputSupport, type ApiCallFormat, type ChannelModel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { ModelInferenceSummary, ModelSelectModal } from "./model-select-modal";

const CAPABILITY_ORDER: ModelCapability[] = ["image", "video", "audio", "text"];

function copyChannel(channel: ModelChannel): ModelChannel {
    return {
        ...channel,
        models: channel.models.map((model) => ({
            ...model,
            ...(model.remoteTask ? { remoteTask: { ...model.remoteTask } } : {}),
        })),
    };
}

function hasLegacyProtocol(model: ChannelModel) {
    return Boolean(model.script?.trim() || model.remoteTask?.submitScript?.trim() || model.remoteTask?.queryScript?.trim());
}

export function ChannelEditorDrawer({ open, channel, onSave, onClose }: { open: boolean; channel: ModelChannel | null; onSave: (channel: ModelChannel) => void; onClose: () => void }) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const { token } = theme.useToken();
    const { message } = App.useApp();
    const [draft, setDraft] = useState<ModelChannel | null>(() => (channel ? copyChannel(channel) : null));
    const [selectOpen, setSelectOpen] = useState(false);
    const [catalogLoading, setCatalogLoading] = useState(false);
    const previousCredentials = useRef({ id: draft?.id, apiKey: draft?.apiKey });
    useEffect(() => {
        if (draft?.provider === "openrouter" && previousCredentials.current.id === draft.id && previousCredentials.current.apiKey !== draft.apiKey) {
            void queryClient.cancelQueries({ queryKey: ["channel-catalog", draft.id] }).then(() => queryClient.invalidateQueries({ queryKey: ["channel-catalog", draft.id] }));
        }
        previousCredentials.current = { id: draft?.id, apiKey: draft?.apiKey };
    }, [draft?.id, draft?.provider, draft?.apiKey, queryClient]);
    const isAutodl = Boolean(draft && isAutodlChannel(draft));
    const isHiapi = draft?.provider === "hiapi" || /hiapi\.ai/i.test(draft?.baseUrl ?? "");
    const catalogLoaded = Boolean(getHiapiCatalogMirror());

    const refreshCatalog = async () => {
        if (catalogLoading) return;
        setCatalogLoading(true);
        try {
            const result = await fetchHiapiCatalog({ force: true });
            if (result) message.success(t("config.channelEditor.catalogRefreshed"));
            else message.warning(t("config.channelEditor.catalogFailed"));
        } finally {
            setCatalogLoading(false);
        }
    };

    useEffect(() => {
        if (!open) return;
        if (!isHiapi) return;
        if (getHiapiCatalogMirror()) return;
        void fetchHiapiCatalog();
    }, [open, isHiapi]);
    const apiFormatOptions: Array<{ label: string; value: ApiCallFormat }> = [
        { label: "OpenAI", value: "openai" },
        { label: "Gemini", value: "gemini" },
    ];

    useEffect(() => {
        if (open && channel) setDraft(copyChannel(channel));
    }, [open, channel]);

    // 抽屉内联渲染在设置弹窗子树里；Esc 需在 window 捕获阶段拦截，
    // 避免Radix Dialog 的 document 捕获监听把整个设置弹窗一起关掉。
    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.stopPropagation();
            event.preventDefault();
            if (selectOpen) setSelectOpen(false);
            else onClose();
        };
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [open, selectOpen, onClose]);

    if (!draft) return null;

    const patch = (value: Partial<ModelChannel>) => setDraft((current) => (current ? { ...current, ...value } : current));
    const setModels = (models: ChannelModel[]) => patch({ models });

    const changeApiFormat = (apiFormat: ApiCallFormat) => {
        const baseUrl = !draft.baseUrl.trim() || draft.baseUrl.trim() === defaultBaseUrlForApiFormat(draft.apiFormat) ? defaultBaseUrlForApiFormat(apiFormat) : draft.baseUrl;
        patch({ apiFormat, baseUrl });
    };

    const applySelection = (names: string[], entries: CatalogEntry[]) => {
        if (draft.provider === "openrouter" || draft.provider === "fal") {
            setModels(mergeCatalogSelection(draft, names, entries));
            return;
        }
        const existing = new Map(draft.models.map((model) => [model.name, model]));
        setModels(names.map((name) => existing.get(name) || { name, capability: guessCapability(name, draft) }));
    };

    const removeModel = (name: string) => setModels(draft.models.filter((model) => model.name !== name));

    const save = () => {
        onSave({ ...draft, name: draft.name.trim() || t("config.channels.unnamed") });
        onClose();
    };

    return (
        <Drawer
            open={open}
            size={720}
            // 内联渲染：让抽屉 DOM 留在设置弹窗（Radix Dialog）的子树内，
            // 否则焦点陷阱会把输入框焦点拉回弹窗，外点关闭也会连带关掉设置弹窗。
            getContainer={false}
            title={t("config.channelEditor.title")}
            onClose={onClose}
            styles={{ body: { paddingTop: token.padding } }}
            extra={
                <Space>
                    <Button aria-label={t("common.cancel")} onClick={onClose}>
                        {t("common.cancel")}
                    </Button>
                    <Button aria-label={t("common.save")} type="primary" onClick={save}>
                        {t("common.save")}
                    </Button>
                </Space>
            }
        >
            <Form layout="vertical" requiredMark={false}>
                <div className="grid gap-x-4 md:grid-cols-2">
                    <Form.Item label={t("config.channelEditor.name")}>
                        <Input aria-label={t("config.channelEditor.name")} value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
                    </Form.Item>
                    <Form.Item label={t("config.channelEditor.protocol")}>
                        {draft.provider === "fal" ? <div className="py-1 text-sm">{t("fal.catalog.protocol")}</div> : draft.provider === "openrouter" ? <div className="py-1 text-sm">{t("config.catalog.protocol")}</div> : isAutodl ? <div className="py-1 text-sm">{t("autodl.protocol")}</div> : <Select aria-label={t("config.channelEditor.protocol")} value={draft.apiFormat} options={apiFormatOptions} onChange={changeApiFormat} getPopupContainer={(trigger) => trigger.parentElement} />}
                    </Form.Item>
                    <Form.Item className="md:col-span-2" label={t("config.channelEditor.baseUrl")}>
                        <Input aria-label={t("config.channelEditor.baseUrl")} value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} placeholder="https://api.example.com" />
                    </Form.Item>
                    <Form.Item className="md:col-span-2" label="API Key" extra={isAutodl ? t("autodl.tokenHint") : undefined}>
                        <Input.Password aria-label="API Key" value={draft.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} placeholder="sk-..." />
                    </Form.Item>
                </div>
            </Form>

            <div className="mb-3 mt-2 flex flex-wrap items-end justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold">{t("config.channelEditor.models")}</div>
                    <div className="mt-0.5 text-xs" style={{ color: token.colorTextSecondary }}>
                        {t("config.channelEditor.modelDescription", { count: draft.models.length })}
                    </div>
                    <div className="mt-1 text-xs" style={{ color: token.colorTextSecondary }}>
                        {t("config.modelInference.automatic")}
                    </div>
                </div>
                <Space>
                    {isHiapi ? (
                        <Button type="text" icon={<RefreshCw className={catalogLoading ? "size-4 animate-spin" : "size-4"} />} loading={catalogLoading} onClick={() => void refreshCatalog()}>
                            {catalogLoaded ? t("config.channelEditor.refreshCatalog") : t("config.channelEditor.loadCatalog")}
                        </Button>
                    ) : null}
                    <Button type="text" icon={<ListPlus className="size-4" />} onClick={() => setSelectOpen(true)}>
                        {t("config.channelEditor.selectModels")}
                    </Button>
                </Space>
            </div>

            {draft.models.length ? (
                <div className="space-y-5">
                    {CAPABILITY_ORDER.map((capability) => {
                        const models = draft.models.filter((model) => model.capability === capability);
                        if (!models.length) return null;
                        return (
                            <section key={capability} aria-labelledby={`model-group-${capability}`}>
                                <div className="mb-2 flex items-center gap-2">
                                    <h3 id={`model-group-${capability}`} className="text-xs font-semibold" style={{ color: token.colorTextSecondary }}>
                                        {t(`config.channelEditor.groups.${capability}`)}
                                    </h3>
                                    <span className="text-xs" style={{ color: token.colorTextQuaternary }}>
                                        {models.length}
                                    </span>
                                </div>
                                <div className="space-y-2">
                                    {models.map((model) => (
                                        <article key={model.name} className="p-3" style={{ border: `1px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadiusLG }}>
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex items-center gap-2">
                                                        <div className="truncate text-sm font-medium" title={model.name}>
                                                            {isAutodl && getAutodlWorkflow(model.name) ? `${t(getAutodlWorkflow(model.name)!.labelKey)} · ${model.name}` : model.name}
                                                        </div>
                                                        <Select<ModelCapability>
                                                            size="small"
                                                            disabled={draft.provider === "fal"}
                                                            aria-label={t("config.channelEditor.capabilityFor", { name: model.name })}
                                                            value={model.capability}
                                                            style={{ minWidth: 92 }}
                                                            options={CAPABILITY_ORDER.map((value) => ({ value, label: t(`config.channelEditor.capabilities.${value}`) }))}
                                                            onChange={(capability) => setModels(draft.models.map((entry) => (entry.name === model.name ? { ...entry, capability } : entry)))}
                                                            getPopupContainer={(trigger) => trigger.parentElement}
                                                        />
                                                    </div>
                                                    <div className="mt-1 flex flex-wrap items-center gap-2">
                                                        <ModelInferenceSummary channel={draft} modelName={model.name} metadata={model.catalog} />
                                                        {model.capability === "text" ? (
                                                            <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: token.colorTextSecondary }}>
                                                                <Switch
                                                                    size="small"
                                                                    aria-label={t("config.channelEditor.imageInputFor", { name: model.name })}
                                                                    checked={model.supportsImageInput ?? inferImageInputSupport(model.name, draft) ?? false}
                                                                    onChange={(supportsImageInput) => setModels(draft.models.map((entry) => (entry.name === model.name ? { ...entry, supportsImageInput } : entry)))}
                                                                />
                                                                {t("config.channelEditor.imageInput")}
                                                            </span>
                                                        ) : null}
                                                        {model.capability === "text" ? (
                                                            <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: token.colorTextSecondary }}>
                                                                <Switch
                                                                    size="small"
                                                                    aria-label={t("config.channelEditor.reasoningFor", { name: model.name })}
                                                                    checked={model.supportsReasoning ?? false}
                                                                    onChange={(supportsReasoning) => setModels(draft.models.map((entry) => (entry.name === model.name ? { ...entry, supportsReasoning } : entry)))}
                                                                />
                                                                {t("config.channelEditor.reasoning")}
                                                            </span>
                                                        ) : null}
                                                        {hasLegacyProtocol(model) ? (
                                                            <Tag color="warning" variant="filled">
                                                                {t("config.modelInference.legacy")}
                                                            </Tag>
                                                        ) : null}
                                                    </div>
                                                </div>
                                                <Button aria-label={t("config.channelEditor.deleteModel", { name: model.name })} size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => removeModel(model.name)} />
                                            </div>
                                        </article>
                                    ))}
                                </div>
                            </section>
                        );
                    })}
                </div>
            ) : (
                <div className="py-10 text-center text-sm" style={{ color: token.colorTextSecondary }}>
                    {t("config.channelEditor.empty")}
                </div>
            )}

            <ModelSelectModal open={selectOpen} channel={draft} selectedNames={draft.models.map((model) => model.name)} onConfirm={applySelection} onClose={() => setSelectOpen(false)} />
        </Drawer>
    );
}
