import { Alert, App, Button, Checkbox, Input, InputNumber, Modal, Select, Switch, Tabs, theme } from "antd";
import { RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { getFalProfile } from "@/lib/models/fal/profiles";
import { builtinFalEntry, getFalModelAvailability, invalidateFalSchemaCache, refreshFalSchemaCompatibility } from "@/services/api/fal-catalog";
import { AUTODL_WORKFLOWS, getAutodlWorkflow } from "@/lib/models/autodl-workflows";
import { isAutodlChannel, resolveModel } from "@/lib/models/model-resolver";
import { fetchChannelModels } from "@/services/api/image";
import { MODAL_WIDTH } from "@/lib/design/modal";
import type { CatalogCategory, CatalogEntry, CatalogMetadata } from "@/lib/models/model-catalog-types";
import { useChannelModelCatalog } from "./use-channel-model-catalog";
import type { ModelChannel } from "@/stores/use-config-store";

export function ModelInferenceSummary({ channel, modelName, metadata }: { metadata?: CatalogMetadata; channel: Pick<ModelChannel, "provider" | "baseUrl" | "apiFormat">; modelName: string }) {
    const { t } = useTranslation();
    const { token } = theme.useToken();
    const resolved = resolveModel({ provider: channel.provider, baseUrl: channel.baseUrl, apiFormat: channel.apiFormat, model: modelName });
    const adapterKey = resolved.adapterId || "unsupported";

    if (channel.provider === "fal") {
        const state = getFalModelAvailability(modelName, metadata);
        return <span className="block text-xs leading-5 text-muted-foreground">{t(`config.modelInference.modality.${resolved.modality}`)} · {t(`fal.catalog.${state.availability}`)}</span>;
    }

    if (metadata?.version === 1 || channel.provider === "openrouter") {
        const capabilities = metadata?.version === 1 ? metadata : undefined;
        return <span className="block text-xs leading-5" style={{ color: token.colorTextSecondary }}>
            {capabilities?.outputModalities?.includes("text") ? <span>{t("config.modelInference.modality.text")} · </span> : null}
            {capabilities?.inputModalities?.includes("image") ? <span>{t("config.catalog.vision")} · </span> : null}
            <span>{t(capabilities?.supportsTools === true ? "config.catalog.tools" : capabilities?.supportsTools === false ? "config.catalog.noTools" : "config.catalog.toolsUnknown")}</span>
        </span>;
    }

    return (
        <span className="block text-xs leading-5" style={{ color: token.colorTextSecondary }}>
            {t("config.modelInference.summary", {
                modality: t(`config.modelInference.modality.${resolved.modality}`),
                execution: t(`config.modelInference.execution.${resolved.execution}`),
                protocol: t(`config.modelInference.adapter.${adapterKey}`),
            })}
        </span>
    );
}

// Channel model selector: fetch upstream models or add them manually, then include checked models in the channel list.
export function ModelSelectModal({ open, channel, selectedNames, onConfirm, onClose }: { open: boolean; channel: ModelChannel | null; selectedNames: string[]; onConfirm: (names: string[], entries: CatalogEntry[]) => void; onClose: () => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const isAutodl = Boolean(channel && isAutodlChannel(channel));
    const isFal = channel?.provider === "fal";
    const isCatalog = channel?.provider === "openrouter" || isFal;
    const [category, setCategory] = useState<CatalogCategory | undefined>();
    const [detailId, setDetailId] = useState<string | null>(null);
    const [detailRevision, setDetailRevision] = useState(0);
    const [detailState, setDetailState] = useState<"loading" | "ready" | "failed">("ready");
    const [detailCacheUnavailable, setDetailCacheUnavailable] = useState(false);
    const [submittedSearch, setSubmittedSearch] = useState("");
    const [catalogEnabled, setCatalogEnabled] = useState(false);
    const [descriptors, setDescriptors] = useState<Map<string, CatalogEntry>>(new Map());
    const catalog = useChannelModelCatalog(channel, { q: submittedSearch, category: isFal ? category : "text" }, open && isCatalog && catalogEnabled);
    const catalogEntries = useMemo(() => catalog.data?.pages.flatMap(page => page.entries) ?? [], [catalog.data]);
    const [existing, setExisting] = useState<string[]>([]);
    const [fetched, setFetched] = useState<string[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [activeTab, setActiveTab] = useState("new");
    const [search, setSearch] = useState("");
    const [manual, setManual] = useState("");
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!isFal || !detailId) return;
        let active = true;
        setDetailState("loading");
        setDetailCacheUnavailable(false);
        void refreshFalSchemaCompatibility(detailId).then(result => {
            if (!active) return;
            setDetailState("ready");
            setDetailCacheUnavailable(result.cacheUnavailable);
            setDescriptors(current => {
                const next = new Map(current);
                const old = next.get(detailId);
                const profile = getFalProfile(detailId);
                const savedMetadata = old?.metadata ?? channel?.models.find(model => model.name === detailId)?.catalog;
                if (profile) next.set(detailId, {
                    id: detailId, displayName: old?.displayName ?? detailId, provider: "fal",
                    category: old?.category ?? `${profile.media.length ? "image" : "text"}-to-${profile.modality}`,
                    metadata: { ...savedMetadata, ...result.metadata, providerStatus: result.metadata.providerStatus === "unknown" ? savedMetadata?.providerStatus ?? "unknown" : result.metadata.providerStatus },
                    availability: result.availability,
                });
                return next;
            });
        }).catch(() => { if (active) setDetailState("failed"); });
        return () => { active = false; };
    }, [isFal, detailId, detailRevision]);
    const detailProfile = detailId ? getFalProfile(detailId) : undefined;

    const selectedNamesKey = JSON.stringify(selectedNames);
    useEffect(() => {
        if (!open) return;
        const names = JSON.parse(selectedNamesKey) as string[];
        setExisting(names);
        setSubmittedSearch("");
        setCatalogEnabled(false);
        setDescriptors(new Map());
        setDetailId(null);
        setCategory(undefined);
        setFetched(isAutodl ? AUTODL_WORKFLOWS.map(({ id }) => id) : []);
        setSelected(new Set(names));
        setActiveTab(names.length ? "existing" : "new");
        setSearch("");
        setManual("");
    }, [open, selectedNamesKey, isAutodl, channel?.id, channel?.baseUrl]);

    useEffect(() => {
        if (!open || !isCatalog || !catalogEnabled) return;
        setDescriptors(current => {
            const next = new Map(current);
            catalogEntries.forEach(entry => {
                const old = next.get(entry.id)?.metadata ?? channel?.models.find(model => model.name === entry.id)?.catalog;
                next.set(entry.id, { ...entry, metadata: { ...entry.metadata, ...(!entry.metadata.falSchema && old?.falSchema ? { falSchema: old.falSchema } : {}) } });
            });
            return next;
        });
    }, [open, isCatalog, catalogEnabled, catalogEntries]);

    const fetchedNames = isCatalog ? [...new Set([...fetched, ...catalogEntries.map(entry => entry.id)])] : fetched;
    const currentList = activeTab === "new" ? fetchedNames : existing;
    const visibleList = useMemo(() => {
        const keyword = (isCatalog ? submittedSearch : search).trim().toLowerCase();
        return keyword ? currentList.filter((name) => name.toLowerCase().includes(keyword) || (isCatalog && descriptors.get(name)?.displayName.toLowerCase().includes(keyword)) || (isAutodl && Boolean(getAutodlWorkflow(name)) && t(getAutodlWorkflow(name)!.labelKey).toLowerCase().includes(keyword))) : currentList;
    }, [currentList, search, submittedSearch, isCatalog, descriptors, isAutodl, t]);
    const visibleSelectedCount = visibleList.filter((name) => selected.has(name)).length;

    const toggle = (name: string, checked: boolean) => {
        if (isFal && checked) setDetailId(name);
        setSelected((current) => {
            const next = new Set(current);
            if (checked) next.add(name);
            else next.delete(name);
            return next;
        });
    };

    const isUnavailable = (name: string) => isFal && getFalModelAvailability(name, descriptors.get(name)?.metadata ?? channel?.models.find(model => model.name === name)?.catalog).availability !== "ready";

    const selectVisible = (checked: boolean) =>
        setSelected((current) => {
            const next = new Set(current);
            visibleList.forEach((name) => { if (!checked) next.delete(name); else if (!isUnavailable(name)) next.add(name); });
            return next;
        });

    const addManual = () => {
        const name = manual.trim();
        if (!name) return;
        if (!fetched.includes(name) && !existing.includes(name)) setFetched((current) => [name, ...current]);
        if (!isUnavailable(name)) setSelected((current) => new Set(current).add(name));
        setManual("");
        setActiveTab("new");
        if (isFal) {
            const entry = builtinFalEntry(name);
            if (entry) {
                setDescriptors(current => current.has(name) ? current : new Map(current).set(name, { ...entry, metadata: { ...entry.metadata, ...channel?.models.find(model => model.name === name)?.catalog } }));
                setDetailId(name);
            }
        }
    };

    const fetchModels = async () => {
        if (!channel) return;
        if (isCatalog) {
            setActiveTab("new");
            const nextSearch = search.trim();
            if (catalogEnabled && nextSearch === submittedSearch) await catalog.refetch();
            else { setSubmittedSearch(nextSearch); setCatalogEnabled(true); }
            return;
        }
        if (!channel.baseUrl.trim() || !channel.apiKey.trim()) {
            message.error(t("config.modelSelect.missingConfig"));
            return;
        }
        setLoading(true);
        try {
            const models = await fetchChannelModels(channel);
            setFetched(models);
            setActiveTab("new");
            message.success(t("config.modelSelect.fetched", { count: models.length }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.modelSelect.fetchFailed"));
        } finally {
            setLoading(false);
        }
    };

    const confirm = () => {
        const ordered = [...existing, ...fetched, ...descriptors.keys()].filter((name, index, list) => list.indexOf(name) === index).filter((name) => selected.has(name));
        onConfirm(ordered, isCatalog ? ordered.flatMap(id => descriptors.has(id) ? [descriptors.get(id)!] : []) : []);
        onClose();
    };

    return (
        <Modal
            open={open}
            width={MODAL_WIDTH.lg}
            centered
            destroyOnHidden
            // 与渠道编辑抽屉同理：内联渲染保持在设置弹窗子树内，避免 Radix 焦点陷阱与外点关闭误伤
            getContainer={false}
            onCancel={onClose}
            title={
                <span>
                    {t("config.modelSelect.title")} <span className="ml-2 text-xs font-normal text-stone-500">{t("config.modelSelect.selected", { selected: selected.size, total: new Set([...existing, ...fetchedNames, ...selected]).size })}</span>
                </span>
            }
            styles={{ body: { maxHeight: "62vh", overflowY: "auto" } }}
            footer={[
                <Button key="cancel" onClick={onClose}>
                    {t("common.cancel")}
                </Button>,
                <Button key="confirm" type="primary" onClick={confirm}>
                    {t("config.modelSelect.confirm")}
                </Button>,
            ]}
        >
            <div className="flex flex-wrap items-center gap-3">
                <Input className="min-w-[200px] flex-1" value={search} onChange={(event) => setSearch(event.target.value)} onPressEnter={isCatalog ? () => void fetchModels() : undefined} placeholder={t("config.modelSelect.search")} prefix={<Search className="size-4 text-stone-400" />} allowClear />
                {!isAutodl ? (
                    <>
                        <Input className="min-w-[180px] flex-1" value={manual} onChange={(event) => setManual(event.target.value)} onPressEnter={addManual} placeholder={t("config.modelSelect.modelName")} />
                        <Button onClick={addManual}>{t("config.modelSelect.add")}</Button>
                        <Button icon={<RefreshCw className="size-4" />} loading={isCatalog ? catalog.isFetching : loading} onClick={() => void fetchModels()}>
                            {t("config.modelSelect.fetch")}
                        </Button>
                        {isCatalog ? <Button onClick={() => void fetchModels()}>{t("config.catalog.search")}</Button> : null}
                    </>
                ) : null}
            </div>
            {isFal ? <Select className="mt-3 min-w-[180px]" aria-label={t("fal.catalog.category")} allowClear placeholder={t("fal.catalog.category")} value={category} onChange={setCategory} options={["text-to-image", "image-to-image", "text-to-video", "image-to-video"].map(value => ({ value, label: t(`fal.catalog.categories.${value}`) }))} /> : null}
            <div className="mt-2 text-xs text-stone-500">{t(isAutodl ? "autodl.catalogHint" : isFal ? "fal.catalog.description" : isCatalog ? "config.catalog.description" : "config.modelSelect.description")}</div>

            {isCatalog && catalogEnabled ? <div className="mt-3 space-y-2" aria-live="polite">
                {catalog.data?.pages.some(page => page.source === "builtin") ? <Alert type="warning" title={t("fal.catalog.builtin")} /> : null}
                {catalog.isError ? <Alert type="warning" title={t("config.catalog.refreshFailed")} /> : null}
                {catalog.data?.pages.some(page => page.source === "cache") ? <Alert type="warning" title={t("config.catalog.cached")} /> : null}
                {catalog.data?.pages.some(page => page.cacheUnavailable) ? <Alert type="warning" title={t("config.catalog.cacheUnavailable")} /> : null}
            </div> : null}

            <Tabs
                className="mt-3"
                activeKey={activeTab}
                onChange={setActiveTab}
                items={[
                    { key: "new", label: t(isAutodl ? "autodl.builtinTab" : "config.modelSelect.fetchedTab", { count: fetchedNames.length }) },
                    { key: "existing", label: t("config.modelSelect.existingTab", { count: existing.length }) },
                ]}
            />

            <div className="mb-3 flex items-center justify-between gap-2">
                <span className="text-xs text-stone-500">{t("config.modelSelect.visibleSelected", { selected: visibleSelectedCount, total: visibleList.length })}</span>
                <div className="flex gap-2">
                    <Button size="small" disabled={!visibleList.length} onClick={() => selectVisible(true)}>
                        {t("config.modelSelect.selectVisible")}
                    </Button>
                    <Button size="small" disabled={!visibleSelectedCount} onClick={() => selectVisible(false)}>
                        {t("config.modelSelect.clearVisible")}
                    </Button>
                </div>
            </div>

            {visibleList.length ? (
                <div className="grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2">
                    {visibleList.map((name) => (
                        <div key={name}><Checkbox disabled={isUnavailable(name) && !selected.has(name)} aria-label={name} checked={selected.has(name)} onChange={(event) => toggle(name, event.target.checked)}>
                            <span className="block min-w-0" title={name}>
                                {isAutodl && getAutodlWorkflow(name) ? <span className="block">{t(getAutodlWorkflow(name)!.labelKey)}</span> : null}
                                <span className="block truncate">{isCatalog ? descriptors.get(name)?.displayName || name : name}</span>
                                {isCatalog && descriptors.has(name) && descriptors.get(name)?.displayName !== name ? <span className="block break-all text-xs text-muted-foreground">{name}</span> : null}
                                {channel ? <ModelInferenceSummary channel={channel} modelName={name} metadata={descriptors.get(name)?.metadata ?? channel.models.find(model => model.name === name)?.catalog} /> : null}
                            </span>
                        </Checkbox>
                        {isFal && getFalProfile(name) ? <Button size="small" type="text" onClick={() => setDetailId(name)}>{t("fal.catalog.details")}</Button> : null}
                        </div>
                    ))}
                </div>
            ) : (
                <div className="py-8 text-center text-sm text-stone-500">{t(activeTab === "new" ? "config.modelSelect.fetchedEmpty" : "config.modelSelect.existingEmpty")}</div>
            )}
            {isFal && detailProfile ? <section className="mt-4 space-y-3" aria-label={t("fal.catalog.details")}>
                <div className="break-all text-sm font-medium">{detailProfile.endpointId}</div>
                <div className="text-xs text-muted-foreground">{t("fal.catalog.parameters")}</div>
                {detailState === "loading" ? <div role="status">{t("fal.catalog.checking")}</div> : null}
                {detailState === "failed" ? <Alert type="warning" title={t("fal.catalog.schemaFailed")} /> : null}
                {detailCacheUnavailable ? <Alert type="warning" title={t("config.catalog.cacheUnavailable")} /> : null}
                {getFalModelAvailability(detailProfile.endpointId, descriptors.get(detailProfile.endpointId)?.metadata).availability === "schema-incompatible" ? <Alert type="error" title={t("fal.catalog.schema-incompatible")} description={getFalModelAvailability(detailProfile.endpointId, descriptors.get(detailProfile.endpointId)?.metadata).diagnostics.join("; ")} /> : null}
                <div className="grid gap-3 md:grid-cols-2">{detailProfile.fields.map(field => <label key={field.name} className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {t(field.labelKey)}
                    {field.kind === "boolean" ? <Switch className="self-start" disabled checked={Boolean(detailProfile.defaults[field.name])} /> : field.kind === "enum" ? <Select disabled value={detailProfile.defaults[field.name] as string | number | undefined} options={field.options?.map(value => ({ value: value as string, label: String(value) }))} /> : field.kind === "number" ? <InputNumber disabled value={detailProfile.defaults[field.name] as number | undefined} /> : <Input disabled value={String(detailProfile.defaults[field.name] ?? "")} />}
                </label>)}</div>
                <Button size="small" onClick={() => { invalidateFalSchemaCache(detailProfile.endpointId); setDetailRevision(value => value + 1); }}>{t("fal.catalog.refreshSchema")}</Button>
            </section> : null}
            {isCatalog && catalog.hasNextPage ? <Button className="mt-3" loading={catalog.isFetchingNextPage} onClick={() => void catalog.fetchNextPage()}>{t("config.catalog.loadMore")}</Button> : null}
        </Modal>
    );
}
