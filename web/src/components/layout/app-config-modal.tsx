import { ChatGptConnection } from "./chatgpt-connection";
import { useAiSourceStore } from "@/stores/use-ai-source-store";
import { useChatGptStore } from "@/stores/use-chatgpt-store";
import { recoverConfigImport } from "@/services/config-file";
import { App as AntApp, Switch } from "antd";
import type { TFunction } from "i18next";
import { BrainCircuit, Cloud, Database, Download, KeyRound, Pencil, Plug, Plus, RefreshCw, SlidersHorizontal, Trash2, Upload, Wifi } from "lucide-react";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { isAutodlChannel } from "@/lib/models/model-resolver";
import { ModelPicker } from "@/components/model-picker";
import { ChannelEditorDrawer } from "@/components/layout/channel-editor-drawer";
import { ConfigLocalStorage } from "@/components/layout/config-local-storage";
import { MemorySettingsSection, type MemoryGuardRef } from "@/components/memory/memory-settings-section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SettingRow } from "@/components/ui/settings-controls";
import { Textarea } from "@/components/ui/textarea";
import type { AppLocale } from "@/i18n";
import { exportAppConfig, importAppConfig } from "@/services/config-file";
import { syncAppDataToWebdav, type AppSyncDomainKey, type AppSyncProgressEvent } from "@/services/app-sync";
import { testWebdavConnection, WEBDAV_MANIFEST_FILE_NAME } from "@/services/webdav-sync";
import { audioFormatOptions, audioVoiceOptions, normalizeAudioSpeedValue } from "@/lib/audio-generation";
import { createModelChannel, modelOptionsFromChannels, normalizeChatPanelSide, normalizeModelOptionValue, selectableModelsByCapability, useConfigStore, type AgentApiMode, type AiConfig, type ApiCallFormat, type ChannelProvider, type ConfigTabKey, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";

type ModelGroup = {
    capability: ModelCapability;
    modelKey: "imageModel" | "videoModel" | "textModel" | "audioModel";
    labelKey: string;
};

type WebdavDomainProgress = {
    stage: string;
    current?: number;
    total?: number;
    status?: "active" | "success" | "exception";
};

type SettingsNavItem = {
    key: ConfigTabKey;
    icon: ComponentType<React.SVGProps<SVGSVGElement>>;
    labelKey: string;
    label?: string;
};

const settingsNavItems: SettingsNavItem[] = [
    { key: "channels", icon: Plug, labelKey: "aiSources.services" },
    { key: "ai-sources", icon: KeyRound, labelKey: "config.tabs.aiSources" },
    { key: "preferences", icon: SlidersHorizontal, labelKey: "config.tabs.preferences" },
    { key: "webdav", icon: Cloud, labelKey: "", label: "WebDAV" },
    { key: "local-storage", icon: Database, labelKey: "config.tabs.localStorage" },
    { key: "memory", icon: BrainCircuit, labelKey: "settings.memory.nav" },
];

const modelGroups: ModelGroup[] = [
    { capability: "image", modelKey: "imageModel", labelKey: "config.preferences.defaultImageModel" },
    { capability: "video", modelKey: "videoModel", labelKey: "config.preferences.defaultVideoModel" },
    { capability: "text", modelKey: "textModel", labelKey: "config.preferences.defaultTextModel" },
    { capability: "audio", modelKey: "audioModel", labelKey: "config.preferences.defaultAudioModel" },
];

const webdavDomainKeys: AppSyncDomainKey[] = ["canvas", "assets", "image-workbench", "video-workbench"];
function createWebdavDomainProgress(): Record<AppSyncDomainKey, WebdavDomainProgress> {
    return webdavDomainKeys.reduce(
        (progress, key) => ({
            ...progress,
            [key]: { stage: "等待同步" },
        }),
        {} as Record<AppSyncDomainKey, WebdavDomainProgress>,
    );
}

function navItemLabel(item: SettingsNavItem, t: TFunction) {
    return item.label || t(item.labelKey);
}

export function AppConfigPanel({ initialTab = "channels", memoryGuardRef }: { initialTab?: ConfigTabKey; memoryGuardRef?: MemoryGuardRef }) {
    const { message } = AntApp.useApp();
    const { i18n, t } = useTranslation();
    const configInputRef = useRef<HTMLInputElement>(null);
    const [activeTab, setActiveTab] = useState<ConfigTabKey>(initialTab);
    const [editingChannelId, setEditingChannelId] = useState("");
    const [testingWebdav, setTestingWebdav] = useState(false);
    const [syncingWebdav, setSyncingWebdav] = useState(false);
    const [webdavSyncStatus, setWebdavSyncStatus] = useState("");
    const [webdavDomainProgress, setWebdavDomainProgress] = useState(createWebdavDomainProgress);
    const config = useConfigStore((state) => state.config);
    const sources = useAiSourceStore();
    const connection = useChatGptStore();
    const managed = sources.preferences.selections.agent;
    const chatgptOptions = connection.models.map((model, index) => ({ value: `chatgpt-option-${index}`, label: `${t("aiSources.chatgpt")} · ${model.name}`, modelId: model.id }));
    const selectedChatgpt = managed?.source === "chatgpt" ? chatgptOptions.find(option => option.modelId === managed.modelId) : undefined;
    useEffect(() => { void sources.hydrate().catch(() => undefined); }, [sources.hydrate]);
    const changeAgentModel = async (value: string) => {
        try {
            const option = chatgptOptions.find(option => option.value === value);
            await sources.select("agent", option ? { source: "chatgpt", modelId: option.modelId } : null);
            if (!option) updateConfig("agentModel", value);
        } catch { void message.error(t("aiSources.preferencesFailed")); }
    };
    const webdav = useConfigStore((state) => state.webdav);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const updateWebdavConfig = useConfigStore((state) => state.updateWebdavConfig);
    const webdavReady = Boolean(webdav.url.trim());
    const editingChannel = config.channels.find((channel) => channel.id === editingChannelId) || null;
    const locale = i18n.resolvedLanguage as AppLocale;
    useEffect(() => setActiveTab(initialTab), [initialTab]);

    const saveConfig = (nextConfig: AiConfig) => {
        (Object.keys(nextConfig) as Array<keyof AiConfig>).forEach((key) => updateConfig(key, nextConfig[key]));
    };

    const loadConfigFile = async (file: File) => {
        try {
            await importAppConfig(file);
            message.success(t("config.imported"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.importFailed"));
        } finally {
            if (configInputRef.current) configInputRef.current.value = "";
        }
    };

    const updateChannels = (channels: ModelChannel[]) => saveConfig(withChannels(config, channels));

    const addChannel = (provider: ChannelProvider) => {
        const channel = createModelChannel({ provider, ...(provider === "custom" ? { name: t("config.channels.numberedName", { count: config.channels.length + 1 }) } : {}) });
        updateChannels([...config.channels, channel]);
        setEditingChannelId(channel.id);
    };
    const channelPresetItems = [
        { key: "minimax-cn", label: t("config.channels.presets.minimaxCn") },
        { key: "minimax-global", label: t("config.channels.presets.minimaxGlobal") },
        { key: "deepseek", label: t("config.channels.presets.deepseek") },
        { key: "moonshot", label: t("config.channels.presets.moonshot") },
        { key: "zhipu", label: t("config.channels.presets.zhipu") },
        { key: "fal", label: t("config.channels.presets.fal") },
        { key: "openrouter", label: t("config.channels.presets.openrouter") },
        { key: "autodl", label: t("config.channels.presets.autodl") },
        { key: "hiapi", label: t("config.channels.presets.hiapi") },
        { type: "divider" as const },
        { key: "custom", label: t("config.channels.presets.custom") },
    ];

    const deleteChannel = (id: string) => {
        if (config.channels.length <= 1) {
            message.warning(t("config.channels.keepOne"));
            return;
        }
        updateChannels(config.channels.filter((channel) => channel.id !== id));
    };

    const saveChannel = (channel: ModelChannel) => {
        updateChannels(config.channels.map((item) => (item.id === channel.id ? channel : item)));
    };

    const testWebdav = async () => {
        if (!webdavReady) {
            message.error(t("config.webdav.missingUrl"));
            return;
        }
        setTestingWebdav(true);
        try {
            await testWebdavConnection(webdav);
            message.success(t("config.webdav.available"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.webdav.testFailed"));
        } finally {
            setTestingWebdav(false);
        }
    };

    const updateWebdavProgress = (event: AppSyncProgressEvent) => {
        setWebdavSyncStatus(event.stage);
        if (!event.domain) return;
        setWebdavDomainProgress((current) => ({
            ...current,
            [event.domain as AppSyncDomainKey]: {
                stage: event.stage,
                current: event.current,
                total: event.total,
                status: event.status,
            },
        }));
    };

    const syncWebdav = async () => {
        if (!webdavReady) {
            message.error(t("config.webdav.missingUrl"));
            return;
        }
        setSyncingWebdav(true);
        setWebdavDomainProgress(createWebdavDomainProgress());
        setWebdavSyncStatus(t("config.webdav.preparing"));
        try {
            const result = await syncAppDataToWebdav(webdav, updateWebdavProgress);
            updateWebdavConfig("lastSyncedAt", result.syncedAt);
            message.success(t("config.webdav.completed", { projects: result.projects, assets: result.assets, records: result.imageLogs + result.videoLogs, files: result.uploadedFiles, bytes: formatBytes(result.uploadedBytes) }));
        } catch (error) {
            setWebdavSyncStatus(error instanceof Error ? error.message : t("config.webdav.failed"));
            message.error(error instanceof Error ? error.message : t("config.webdav.failed"));
        } finally {
            setSyncingWebdav(false);
        }
    };

    const activeNavItem = settingsNavItems.find((item) => item.key === activeTab) || settingsNavItems[1];

    const sectionContent: Record<ConfigTabKey, ReactNode> = {
        "ai-sources": (
            <div className="space-y-6">
                <section>
                    <h3 className="mb-3 text-sm font-semibold">{t("aiSources.chatgpt")}</h3>
                    <ChatGptConnection />
                </section>
            </div>
        ),
        channels: (
            <div>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="text-xs text-stone-500">{t("config.channels.description")}</div>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button size="sm">
                                <Plus className="size-4" />
                                {t("config.channels.add")}
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            {channelPresetItems.map((item, index) =>
                                "type" in item && item.type === "divider" ? (
                                    <DropdownMenuSeparator key={`divider-${index}`} />
                                ) : (
                                    <DropdownMenuItem key={item.key!} onSelect={() => addChannel(item.key as ChannelProvider)}>
                                        {item.label}
                                    </DropdownMenuItem>
                                ),
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
                <div className="space-y-2">
                    {config.channels.map((channel) => (
                        <div key={channel.id} className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 px-4 py-3 dark:border-stone-800">
                            <div className="min-w-0">
                                <div className="truncate text-sm font-semibold">{channel.name || t("config.channels.unnamed")}</div>
                                <div className="mt-1 truncate text-xs text-stone-500">
                                    {channel.provider === "fal" ? t("fal.catalog.protocol") : channel.provider === "openrouter" ? t("config.catalog.protocol") : isAutodlChannel(channel) ? "AutoDL ComfyUI" : apiFormatLabel(channel.apiFormat)} · {t("config.channels.modelCount", { count: channel.models.length })} · {channel.baseUrl || t("config.channels.missingUrl")}
                                </div>
                            </div>
                            <div className="flex shrink-0 gap-2">
                                <Button variant="outline" size="sm" onClick={() => setEditingChannelId(channel.id)}>
                                    <Pencil className="size-3.5" />
                                    {t("common.edit")}
                                </Button>
                                <Button variant="destructive" size="icon-sm" aria-label={t("common.delete")} onClick={() => deleteChannel(channel.id)}>
                                    <Trash2 className="size-3.5" />
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        ),
        preferences: (
            <div>
                <div className="mb-2 text-sm font-semibold">{t("config.preferences.agent")}</div>
                <div className="mb-6 grid gap-5 md:grid-cols-2">
                    <SettingRow label={t("config.preferences.agentModel")}>
                        <ModelPicker config={config} className="rounded-lg shadow-none dark:bg-input/30 dark:hover:bg-input/50" value={managed ? selectedChatgpt?.value || "managed-unavailable" : config.agentModel} currentLabel={managed ? selectedChatgpt?.label || `${t(managed.source === "chatgpt" ? "aiSources.chatgpt" : "aiSources.platform")} · ${managed.modelId} (${t("aiSources.unavailable")})` : undefined} extraOptions={chatgptOptions} disabled={sources.status !== "ready" || sources.applying} onChange={value => void changeAgentModel(value)} capability="text" purpose="agent" fullWidth />
                        {managed && <Button variant="link" size="sm" className="mt-1 h-auto px-0" onClick={() => void changeAgentModel(config.agentModel)}>{t("aiSources.useByok")}</Button>}
                    </SettingRow>
                    {!managed && (
                        <SettingRow label={t("config.preferences.agentApi")} hint={t("config.preferences.agentApiDescription")}>
                            <Select value={config.agentApiMode} onValueChange={(value) => updateConfig("agentApiMode", value as AgentApiMode)}>
                                <SelectTrigger className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="responses">Responses API</SelectItem>
                                    <SelectItem value="chat_completions">Chat Completions</SelectItem>
                                </SelectContent>
                            </Select>
                        </SettingRow>
                    )}
                </div>
                <div className="mb-2 text-sm font-semibold">{t("config.preferences.interface")}</div>
                <div className="mb-6 grid gap-5 md:grid-cols-2">
                    <SettingRow label={t("config.preferences.chatPanelSide")} hint={t("config.preferences.chatPanelSideDescription")}>
                        <RadioGroup
                            className="flex gap-2"
                            value={config.chatPanelSide}
                            onValueChange={(value) => updateConfig("chatPanelSide", normalizeChatPanelSide(value))}
                        >
                            <Label className="flex cursor-pointer items-center gap-2 rounded-md border border-stone-200 px-3 py-1.5 text-sm font-normal dark:border-stone-800">
                                <RadioGroupItem value="left" />
                                {t("common.left")}
                            </Label>
                            <Label className="flex cursor-pointer items-center gap-2 rounded-md border border-stone-200 px-3 py-1.5 text-sm font-normal dark:border-stone-800">
                                <RadioGroupItem value="right" />
                                {t("common.right")}
                            </Label>
                        </RadioGroup>
                    </SettingRow>
                </div>
                <div className="mb-2 text-sm font-semibold">{t("config.preferences.defaultModels")}</div>
                <div className="mb-6 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
                    {modelGroups.map((group) => (
                        <SettingRow key={group.modelKey} label={t(group.labelKey)}>
                            <ModelPicker config={config} className="rounded-lg shadow-none dark:bg-input/30 dark:hover:bg-input/50" value={config[group.modelKey]} currentLabel={sources.preferences.selections[group.capability] ? `${t("aiSources.platform")} · ${t("aiSources.unavailable")}` : undefined} disabled={sources.status !== "ready" || sources.applying} onChange={(model) => { void sources.select(group.capability, null).then(() => updateConfig(group.modelKey, model)).catch(() => message.error(t("aiSources.preferencesFailed"))); }} capability={group.capability} fullWidth />
                        </SettingRow>
                    ))}
                </div>
                <div className="mb-2 text-sm font-semibold">{t("config.preferences.generation")}</div>
                <div className="mb-5 flex items-start justify-between gap-6">
                    <SettingRow label={t("config.preferences.compressReferenceImages")} hint={t("config.preferences.compressReferenceImagesDescription")}>
                        <span className="sr-only">{t("config.preferences.compressReferenceImages")}</span>
                    </SettingRow>
                    <Switch className="mt-1 shrink-0" aria-label={t("config.preferences.compressReferenceImages")} checked={config.compressReferenceImages} onChange={(value) => updateConfig("compressReferenceImages", value)} />
                </div>
                <div className="mb-5 grid gap-5 md:grid-cols-4">
                    <SettingRow label={t("config.preferences.canvasImageCount")} hint={t("config.preferences.canvasImageCountDescription")}>
                        <Input
                            type="number"
                            min={1}
                            max={15}
                            value={config.canvasImageCount}
                            onChange={(event) => updateConfig("canvasImageCount", event.target.value)}
                            onBlur={(event) => updateConfig("canvasImageCount", normalizeImageCount(event.target.value))}
                        />
                    </SettingRow>
                    <SettingRow label={t("config.preferences.audioVoice")}>
                        <Select value={config.audioVoice} onValueChange={(value) => updateConfig("audioVoice", value)}>
                            <SelectTrigger className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {audioVoiceOptions.map((option) => (
                                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </SettingRow>
                    <SettingRow label={t("config.preferences.audioFormat")}>
                        <Select value={config.audioFormat} onValueChange={(value) => updateConfig("audioFormat", value)}>
                            <SelectTrigger className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {audioFormatOptions.map((option) => (
                                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </SettingRow>
                    <SettingRow label={t("config.preferences.audioSpeed")}>
                        <Input
                            type="number"
                            min={0.25}
                            max={4}
                            step={0.05}
                            value={config.audioSpeed}
                            onChange={(event) => updateConfig("audioSpeed", event.target.value)}
                            onBlur={(event) => updateConfig("audioSpeed", normalizeAudioSpeedValue(event.target.value))}
                        />
                    </SettingRow>
                </div>
                <div className="mb-5">
                    <SettingRow label={t("config.preferences.audioInstructions")}>
                        <Textarea rows={2} value={config.audioInstructions} placeholder={t("config.preferences.audioInstructionsPlaceholder")} onChange={(event) => updateConfig("audioInstructions", event.target.value)} />
                    </SettingRow>
                </div>
                <SettingRow label={t("config.preferences.systemPrompt")}>
                    <Textarea rows={4} value={config.systemPrompt} placeholder={t("config.preferences.systemPromptPlaceholder")} onChange={(event) => updateConfig("systemPrompt", event.target.value)} />
                </SettingRow>
            </div>
        ),
        webdav: (
            <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            <Cloud className="size-4" />
                            {t("config.webdav.title")}
                        </div>
                        <div className="mt-1 text-xs text-stone-500">{t("config.webdav.description")}</div>
                    </div>
                    <div className="text-xs text-stone-500">{webdav.lastSyncedAt ? t("config.webdav.lastSynced", { time: formatWebdavTime(webdav.lastSyncedAt, locale) }) : t("config.webdav.neverSynced")}</div>
                </div>
                <div className="grid gap-5 md:grid-cols-2">
                    <SettingRow label={t("config.webdav.url")}>
                        <Input value={webdav.url} placeholder="https://nas.example.com/webdav" onChange={(event) => updateWebdavConfig("url", event.target.value)} />
                    </SettingRow>
                    <SettingRow label={t("config.webdav.directory")} hint={t("config.webdav.directoryDescription", { manifest: WEBDAV_MANIFEST_FILE_NAME })}>
                        <Input value={webdav.directory} placeholder="shotshot" onChange={(event) => updateWebdavConfig("directory", event.target.value)} />
                    </SettingRow>
                    <SettingRow label={t("config.webdav.username")}>
                        <Input value={webdav.username} autoComplete="username" onChange={(event) => updateWebdavConfig("username", event.target.value)} />
                    </SettingRow>
                    <SettingRow label={t("config.webdav.password")}>
                        <Input type="password" value={webdav.password} autoComplete="current-password" onChange={(event) => updateWebdavConfig("password", event.target.value)} />
                    </SettingRow>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Button variant="outline" disabled={!webdavReady || syncingWebdav || testingWebdav} onClick={() => void testWebdav()}>
                        <Wifi className="size-4" />
                        {t("config.webdav.test")}
                    </Button>
                    <Button disabled={!webdavReady || testingWebdav || syncingWebdav} onClick={() => void syncWebdav()}>
                        <RefreshCw className="size-4" />
                        {t(syncingWebdav ? "config.webdav.syncing" : "config.webdav.syncNow")}
                    </Button>
                    {webdavSyncStatus ? <span className="text-xs text-stone-500">{syncStageLabel(webdavSyncStatus, t)}</span> : null}
                </div>
                {syncingWebdav || webdavSyncStatus ? <WebdavProgressGrid progress={webdavDomainProgress} t={t} /> : null}
            </section>
        ),
        "local-storage": <ConfigLocalStorage active={activeTab === "local-storage"} />,
        memory: null,
    };

    return (
        <>
            {sources.error && (
                <Alert variant="destructive" className="mb-4">
                    <AlertTitle>{t("aiSources.preferencesFailed")}</AlertTitle>
                    <AlertDescription className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => void sources.retry().catch(() => message.error(t("aiSources.preferencesFailed")))}>{t("aiSources.retry")}</Button>
                        <Button variant="outline" size="sm" onClick={() => void recoverConfigImport().catch(() => message.error(t("aiSources.preferencesFailed")))}>{t("aiSources.recover")}</Button>
                    </AlertDescription>
                </Alert>
            )}
            <div className="grid h-full grid-cols-[210px_1fr] grid-rows-[minmax(0,1fr)] overflow-hidden">
                <aside className="flex h-full flex-col gap-1 border-r border-stone-200/80 bg-black/[0.03] p-3 dark:border-stone-800 dark:bg-white/[0.03]">
                    <h2 className="px-2 pt-1 pb-3 text-sm font-semibold text-stone-900 dark:text-stone-100">{t("config.title")}</h2>
                    <nav className="flex min-h-0 flex-1 flex-col gap-0.5">
                        {settingsNavItems.map((item) => {
                            const Icon = item.icon;
                            const active = item.key === activeTab;
                            return (
                                <button
                                    key={item.key}
                                    type="button"
                                    onClick={() => {
                                        if (item.key === activeTab) return;
                                        if (activeTab === "memory" && memoryGuardRef?.current?.dirty) {
                                            memoryGuardRef.current.confirmLeave(() => setActiveTab(item.key));
                                            return;
                                        }
                                        setActiveTab(item.key);
                                    }}
                                    aria-current={active ? "page" : undefined}
                                    className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50 ${
                                        active
                                            ? "bg-black/[0.06] font-medium text-stone-950 dark:bg-white/10 dark:text-white"
                                            : "text-stone-600 hover:bg-black/[0.04] hover:text-stone-950 dark:text-stone-400 dark:hover:bg-white/5 dark:hover:text-stone-100"
                                    }`}
                                >
                                    <Icon className="size-4 shrink-0" strokeWidth={1.75} />
                                    <span className="truncate">{navItemLabel(item, t)}</span>
                                </button>
                            );
                        })}
                    </nav>
                    <div className="mt-2 flex flex-col gap-1 border-t border-stone-200 pt-3 dark:border-stone-800">
                        <div className="px-2 pb-1 text-[11px] text-stone-500">{t("config.fileSecurity")}</div>
                        <Button variant="ghost" size="sm" className="justify-start" onClick={() => configInputRef.current?.click()}>
                            <Upload className="size-4" />
                            {t("config.import")}
                        </Button>
                        <Button variant="ghost" size="sm" className="justify-start" onClick={() => void exportAppConfig().catch(() => message.error(t("aiSources.preferencesFailed")))}>
                            <Download className="size-4" />
                            {t("config.export")}
                        </Button>
                        <input ref={configInputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => event.target.files?.[0] && void loadConfigFile(event.target.files[0])} />
                    </div>
                </aside>
                <div className="flex h-full min-w-0 flex-col">
                    <div className="flex min-h-[57px] items-center justify-between gap-3 border-b border-stone-200 py-4 pr-12 pl-6 dark:border-stone-800">
                        <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">{navItemLabel(activeNavItem, t)}</h2>
                    </div>
                    <ScrollArea className="min-h-0 flex-1">
                        <div className="p-6">
                            {activeTab === "memory" ? null : sectionContent[activeTab]}
                            <MemorySettingsSection guardRef={memoryGuardRef} hidden={activeTab !== "memory"} />
                        </div>
                    </ScrollArea>
                </div>
            </div>
            <ChannelEditorDrawer open={Boolean(editingChannel)} channel={editingChannel} onSave={saveChannel} onClose={() => setEditingChannelId("")} />
        </>
    );
}

export function AppConfigModal() {
    const { t } = useTranslation();
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const contentRef = useRef<HTMLDivElement>(null);
    const memoryGuardRef = useRef<MemoryGuardRef["current"]>(null);
    return (
        <Dialog open={isConfigOpen} onOpenChange={(open) => {
            if (!open && memoryGuardRef.current?.dirty) {
                memoryGuardRef.current.confirmLeave(() => setConfigDialogOpen(false));
                return;
            }
            if (!open) setConfigDialogOpen(false);
        }}>
            <DialogContent
                className="top-1/2 left-1/2 grid h-[min(640px,80vh)] w-full max-w-[calc(100%-2rem)] grid-rows-[minmax(0,1fr)] -translate-x-1/2 -translate-y-1/2 gap-0 overflow-hidden rounded-xl p-0 sm:max-w-[980px]"
                onOpenAutoFocus={(event) => {
                    event.preventDefault();
                    contentRef.current?.focus();
                }}
            >
                <DialogTitle className="sr-only">{t("config.title")}</DialogTitle>
                <DialogDescription className="sr-only">{t("config.modalDescription")}</DialogDescription>
                <div ref={contentRef} tabIndex={-1} className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)] outline-none">
                    <AntApp className="h-full">
                        <AppConfigPanel memoryGuardRef={memoryGuardRef} />
                    </AntApp>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function withChannels(config: AiConfig, channels: ModelChannel[]): AiConfig {
    const next: AiConfig = {
        ...config,
        channels,
        models: modelOptionsFromChannels(channels),
        baseUrl: channels[0]?.baseUrl || config.baseUrl,
        apiKey: channels[0]?.apiKey || config.apiKey,
        apiFormat: channels[0]?.apiFormat || config.apiFormat,
    };
    return {
        ...next,
        imageModel: pickDefaultModel(next, "image", config.imageModel),
        videoModel: pickDefaultModel(next, "video", config.videoModel),
        textModel: pickDefaultModel(next, "text", config.textModel),
        agentModel: pickDefaultModel(next, "text", config.agentModel),
        audioModel: pickDefaultModel(next, "audio", config.audioModel),
    };
}

function pickDefaultModel(config: AiConfig, capability: ModelCapability, current: string) {
    const options = selectableModelsByCapability(config, capability);
    const normalized = normalizeModelOptionValue(current, config.channels);
    return options.includes(normalized) ? normalized : options[0] || "";
}

function normalizeImageCount(value: string) {
    return String(Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 3))));
}

function apiFormatLabel(apiFormat: ApiCallFormat) {
    if (apiFormat === "gemini") return "Gemini";
    return "OpenAI";
}

function formatWebdavTime(value: string, locale: AppLocale) {
    return new Date(value).toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function WebdavProgressGrid({ progress, t }: { progress: Record<AppSyncDomainKey, WebdavDomainProgress>; t: TFunction }) {
    return (
        <div className="mt-3 grid gap-2">
            {webdavDomainKeys.map((key) => {
                const item = progress[key];
                const count = item.total ? `${item.current || 0}/${item.total}` : "";
                return (
                    <div key={key} className="rounded-md border border-stone-200 px-3 py-2 dark:border-stone-800">
                        <div className="mb-1 flex min-w-0 items-center justify-between gap-3 text-xs">
                            <span className="shrink-0 font-medium text-stone-700 dark:text-stone-200">{t(`config.webdav.domains.${domainTranslationKey(key)}`)}</span>
                            <span className="min-w-0 truncate text-right text-stone-500">
                                {syncStageLabel(item.stage, t)}
                                {count ? ` · ${count}` : ""}
                            </span>
                        </div>
                        <Progress value={getWebdavProgressPercent(item)} className={item.status === "exception" ? "text-destructive" : undefined} />
                    </div>
                );
            })}
        </div>
    );
}

function domainTranslationKey(domain: AppSyncDomainKey) {
    if (domain === "image-workbench") return "imageWorkbench";
    if (domain === "video-workbench") return "videoWorkbench";
    return domain;
}

function syncStageLabel(stage: string, t: TFunction) {
    if (stage === "等待本地数据加载") return t("config.webdav.stages.localWaiting");
    if (stage === "同步完成") return t("config.webdav.stages.syncComplete");
    if (stage === "等待同步") return t("config.webdav.stages.waiting");
    if (stage === "读取远端清单") return t("config.webdav.stages.remoteManifest");
    if (stage === "读取本地数据") return t("config.webdav.stages.localData");
    if (stage === "下载缺失媒体") return t("config.webdav.stages.downloadMedia");
    if (stage === "写入本地合并结果") return t("config.webdav.stages.writeMerge");
    if (stage === "上传新增媒体") return t("config.webdav.stages.uploadMedia");
    if (stage === "媒体已齐全") return t("config.webdav.stages.mediaReady");
    if (stage === "媒体无需上传") return t("config.webdav.stages.mediaSkipped");
    if (stage === "检查缺失媒体") return t("config.webdav.stages.checkMissingMedia");
    if (stage === "下载媒体") return t("config.webdav.stages.downloadMediaFile");
    if (stage === "检查本地媒体") return t("config.webdav.stages.checkLocalMedia");
    if (stage.startsWith("上传媒体 ")) return t("config.webdav.stages.uploadMediaFile", { size: stage.slice(5) });
    if (stage === "完成") return t("config.webdav.stages.complete");
    if (stage.startsWith("上传清单 ")) return t("config.webdav.stages.uploadManifest", { size: stage.slice(5) });
    return stage;
}

function getWebdavProgressPercent(item: WebdavDomainProgress) {
    if (item.status === "success") return 100;
    if (item.total) return Math.min(100, Math.round(((item.current || 0) / item.total) * 100));
    if (item.status === "exception") return 100;
    if (item.stage === "等待同步") return 0;
    if (item.stage === "读取远端清单") return 12;
    if (item.stage === "读取本地数据") return 24;
    if (item.stage === "下载缺失媒体") return 36;
    if (item.stage === "写入本地合并结果") return 58;
    if (item.stage === "上传新增媒体") return 66;
    if (item.stage === "媒体已齐全" || item.stage === "媒体无需上传") return 74;
    if (item.stage.startsWith("上传清单")) return 90;
    return item.status === "active" ? 30 : 0;
}

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
