import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App } from "antd";
import { AlertTriangle, ArrowUpRight, PanelsTopLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AgentChatComposer } from "@/components/agent/agent-chat-composer";
import type { AgentChatPromptInputHandle } from "@/components/agent/agent-chat-prompt-input";
import { resolvePiModelConfig } from "@/components/agent/use-pi-agent";
import { canvasThemes } from "@/lib/canvas-theme";
import { canvasTitleFromPrompt } from "@/lib/canvas/canvas-title";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { useConfigStore, credentialModeFor } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useAiSourceStore } from "@/stores/use-ai-source-store";
import { useChatGptStore } from "@/stores/use-chatgpt-store";
import { useHomeComposerStore } from "@/stores/use-home-composer-store";
import { useManagedCatalog } from "@/lib/desktop/use-managed-catalog";
import { readHomeAttachments } from "@/pages/home/home-attachments";
import { HomeProjectPicker } from "@/pages/home/home-project-picker";
import { HomeCreationGuide } from "@/pages/home/home-creation-guide";
import type { HomeSceneId } from "@/pages/home/home-inspirations";

export default function IndexPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const draft = useHomeComposerStore();
    const [selectedScene, setSelectedScene] = useState<HomeSceneId | null>("model");
    const [focusRequest, setFocusRequest] = useState(0);
    const inputRef = useRef<AgentChatPromptInputHandle>(null);
    const actionInFlight = useRef(false);
    const [busy, setBusy] = useState(false);
    const projectReady = useProjectStore((state) => state.hydrated && state.hydrationStatus === "success");
    const projectHydrationStatus = useProjectStore((state) => state.hydrationStatus);
    const config = useConfigStore((state) => state.config);
    const sources = useAiSourceStore();
    useChatGptStore();
    const managedMode = credentialModeFor(config, "agent") === "shotshot";
    const catalog = useManagedCatalog(managedMode);
    const isAiConfigReady = Boolean(resolvePiModelConfig(config));
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    // 目录未就绪（加载中）时保持安静，消除启动期的"未配置"假警报；
    // 判定完成后才可能提示：拉取失败、或确实解析不出可用模型。
    let modelWarning: "configBlocked" | "fetchFailed" | null = null;
    if (!isAiConfigReady) {
        if (managedMode) {
            if (sources.status !== "loading" && catalog) modelWarning = catalog.status === "error" ? "fetchFailed" : "configBlocked";
        } else {
            modelWarning = "configBlocked";
        }
    }

    useLayoutEffect(() => { if (focusRequest) inputRef.current?.focus(); }, [focusRequest]);

    const chooseInspiration = (prompt: string) => {
        draft.setPrompt(prompt);
        setFocusRequest((value) => value + 1);
    };

    const onAddFiles = useCallback(async (input: FileList | File[] | null) => {
        const { draftId } = useHomeComposerStore.getState();
        try {
            const next = await readHomeAttachments(Array.from(input || []));
            useHomeComposerStore.getState().appendAttachments(draftId, next);
        } catch {
            if (useHomeComposerStore.getState().draftId === draftId) void message.error(t("composer.errors.fileRead"));
        }
    }, [message, t]);

    const startBlankCanvas = async () => {
        if (actionInFlight.current) return;
        actionInFlight.current = true;
        setBusy(true);
        try {
            const result = useProjectStore.getState().createHomeCanvas(draft.projectTarget);
            if (!result.ok) {
                void message.error(t(result.reason === "project-missing" ? "composer.errors.projectMissing" : "composer.errors.notReady"));
                actionInFlight.current = false;
                setBusy(false);
                return;
            }
            await navigate(`/canvas/${result.projectId}/${result.canvasId}`);
        } catch {
            void message.error(t("composer.errors.create"));
            actionInFlight.current = false;
            setBusy(false);
        }
    };

    const handleSubmit = async () => {
        const current = useHomeComposerStore.getState();
        const text = current.prompt.trim();
        if (actionInFlight.current || (!text && !current.attachments.length)) return;
        if (!projectReady) { void message.error(t("composer.errors.notReady")); return; }
        const target = current.projectTarget;
        if (target && !useProjectStore.getState().projects.some((project) => project.id === target.projectId)) {
            void message.error(t("composer.errors.projectMissing"));
            return;
        }
        actionInFlight.current = true;
        setBusy(true);
        const previousPending = useProjectStore.getState();
        const previousAttachments = useAgentStore.getState().pendingAttachments;
        let ids: { projectId: string; canvasId: string } | null = null;
        let installedPrompt: string | null = null;
        try {
            const submittedText = text || t("agent.eventMore.attachmentPrompt");
            const title = canvasTitleFromPrompt(text, current.attachments[0]?.name || "");
            ids = useProjectStore.getState().submitPendingPrompt(submittedText, title, target || undefined);
            if (!ids) throw new Error("home submission unavailable");
            installedPrompt = submittedText;
            useAgentStore.getState().setAgentState({ pendingAttachments: current.attachments });
            await navigate(`/canvas/${ids.projectId}/${ids.canvasId}`);
            if (useHomeComposerStore.getState().draftId === current.draftId) useHomeComposerStore.getState().resetDraft();
        } catch {
            const latest = useProjectStore.getState();
            if (ids && latest.pendingProjectId === ids.projectId && latest.pendingCanvasId === ids.canvasId && latest.pendingPrompt === installedPrompt) {
                useProjectStore.setState({ pendingPrompt: previousPending.pendingPrompt, pendingProjectId: previousPending.pendingProjectId, pendingCanvasId: previousPending.pendingCanvasId });
                if (useAgentStore.getState().pendingAttachments === current.attachments) useAgentStore.getState().setAgentState({ pendingAttachments: previousAttachments });
            }
            void message.error(t("composer.errors.submit"));
            actionInFlight.current = false;
            setBusy(false);
        }
    };

    return (
        <main className="relative h-full overflow-y-auto bg-background bg-[radial-gradient(rgba(68,64,60,.28)_1px,transparent_1px)] [background-size:16px_16px] text-stone-950 dark:bg-[radial-gradient(rgba(245,245,244,.24)_1px,transparent_1px)] dark:text-stone-100">
            <section className="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-start px-6 pt-24 pb-16">
                <h1 className="ai-title-aurora max-w-2xl text-balance text-center text-4xl font-semibold tracking-normal sm:text-5xl">{t("composer.title")}</h1>
                <p className="mt-5 max-w-xl text-balance text-center text-base leading-7 text-stone-500 dark:text-stone-400">{t("composer.subtitle")}</p>

                {modelWarning ? (
                    <div className="mt-10 flex items-center justify-center gap-3 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
                            <AlertTriangle className="size-4 shrink-0" />
                            <span>{t(modelWarning === "fetchFailed" ? "config.managed.fetchFailed" : "composer.configBlocked")}</span>
                            <button
                                type="button"
                                className="rounded-md px-1.5 py-0.5 font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current/30"
                                onClick={() => openConfigDialog(false)}
                            >
                                {t("composer.openSettings")}
                            </button>
                    </div>
                ) : null}
                {projectHydrationStatus === "degraded" || projectHydrationStatus === "error" ? (
                    <p className="mt-4 text-center text-sm text-danger">{t("composer.errors.notReady")}</p>
                ) : null}
                <div className={modelWarning ? "mt-4 w-full" : "mt-8 w-full"}>
                    <div className="flex justify-end px-2">
                        <button type="button" disabled={!projectReady || busy} onClick={() => void startBlankCanvas()} className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
                            <PanelsTopLeft size={16} aria-hidden="true" />{t("composer.startCanvas")}<ArrowUpRight size={14} aria-hidden="true" />
                        </button>
                    </div>
                    <AgentChatComposer prompt={draft.prompt} attachments={draft.attachments} onPromptChange={draft.setPrompt} inputRef={inputRef} onSubmit={() => void handleSubmit()} onAddFiles={onAddFiles} onRemoveAttachment={draft.removeAttachment} disabled={busy} placeholder={t("composer.placeholder")} theme={theme} skillMenuPlacement="bottomLeft" left={<HomeProjectPicker value={draft.projectTarget} onChange={draft.setProjectTarget} />} />
                    <div className="[&>section]:mt-4">
                    <HomeCreationGuide selectedScene={selectedScene} onSceneChange={setSelectedScene} onChoose={chooseInspiration} />
                    </div>
                </div>
            </section>
        </main>
    );
}
