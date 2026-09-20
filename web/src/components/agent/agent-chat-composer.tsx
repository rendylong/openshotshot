import { useRef, useState, type ReactNode, type Ref } from "react";
import { Dropdown, Tooltip } from "antd";
import { ArrowUp, Box, Check, ChevronUp, FileText, Gauge, Hand, ImagePlus, Loader2, Plus, RefreshCw, ShieldAlert, ShieldCheck, ShieldOff, Sparkles, Square, Video, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CanvasFloatingPanel } from "@/components/canvas/canvas-floating-panel";
import { ModelPicker } from "@/components/model-picker";
import { IconButton } from "@/components/ui/icon-button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import type { AgentApprovalMode } from "@/lib/agent/pi-agent-types";
import type { AgentModel, AgentPermissionMode, AgentReasoningEffort } from "@/stores/use-agent-store";
import type { AgentChatAttachment } from "./agent-chat-message";
import { AgentChatPromptInput, type AgentChatPromptInputHandle } from "./agent-chat-prompt-input";

export function AgentChatComposer({
    prompt,
    attachments = [],
    disabled,
    sending,
    placeholder,
    theme,
    onPromptChange,
    onSubmit,
    onStop,
    onAddFiles,
    onRemoveAttachment,
    confirmTools,
    onConfirmToolsChange,
    approvalMode,
    onApprovalModeChange,
    permissionMode,
    onPermissionModeChange,
    models,
    model,
    reasoningEffort,
    onModelChange,
    onReasoningEffortChange,
    left,
    inputRef,
    skillMenuPlacement,
}: {
    prompt: string;
    attachments?: AgentChatAttachment[];
    disabled?: boolean;
    sending?: boolean;
    placeholder: string;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onPromptChange: (value: string) => void;
    onSubmit: () => void;
    onStop?: () => void;
    onAddFiles?: (files: FileList | File[] | null) => void | Promise<void>;
    onRemoveAttachment?: (id: string) => void;
    confirmTools?: boolean;
    onConfirmToolsChange?: (confirmTools: boolean) => void;
    approvalMode?: AgentApprovalMode;
    onApprovalModeChange?: (approvalMode: AgentApprovalMode) => void;
    permissionMode?: AgentPermissionMode;
    onPermissionModeChange?: (permissionMode: AgentPermissionMode) => void;
    models?: AgentModel[];
    model?: string;
    reasoningEffort?: AgentReasoningEffort | "";
    onModelChange?: (model: string) => void;
    onReasoningEffortChange?: (effort: AgentReasoningEffort) => void;
    left?: ReactNode;
    inputRef?: Ref<AgentChatPromptInputHandle>;
    /** Skill/引用候选菜单展开方向：topLeft=输入卡上方（默认），bottomLeft=输入卡下方（首页）。 */
    skillMenuPlacement?: "topLeft" | "bottomLeft";
}) {
    const { t } = useTranslation();
    const config = useEffectiveConfig();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const plusRef = useRef<HTMLDivElement>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [skillMenuRequest, setSkillMenuRequest] = useState(0);

    const canSubmit = !disabled && !sending && Boolean(prompt.trim() || attachments.length);
    const showModelPicker = Boolean(models?.length && model && onModelChange);
    const showPlus = Boolean(onAddFiles);

    const openPicker = () => {
        fileInputRef.current?.click();
        setMenuOpen(false);
    };

    return (
        <div className="px-2 pb-2 pt-2" onWheelCapture={(event) => event.stopPropagation()}>
            <div ref={cardRef} className="rounded-[24px] border px-3 pb-3 pt-3 shadow-lg" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke }}>
                {attachments.length ? (
                    <div className="thin-scrollbar mb-2 flex gap-2 overflow-x-auto pb-1">
                        {attachments.map((item) => (
                            <div key={item.id} className="group relative size-14 shrink-0 overflow-hidden rounded-xl border" style={{ borderColor: theme.node.stroke }} title={item.name}>
                                {item.kind === "image" || (!item.kind && item.url) ? <img src={item.url} alt={item.name} className="size-full object-cover" /> : <span className="grid size-full place-items-center" style={{ color: theme.node.muted }}>{item.kind === "video" ? <Video className="size-5" /> : item.kind === "glb" ? <Box className="size-5" /> : <FileText className="size-5" />}</span>}
                                {onRemoveAttachment ? (
                                    <button type="button" className="absolute right-1 top-1 grid size-5 place-items-center rounded-full border opacity-0 shadow-sm transition group-hover:opacity-100" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }} onClick={() => onRemoveAttachment(item.id)} aria-label={t("agent.composer.removeAttachment")}>
                                        <X className="size-3" />
                                    </button>
                                ) : null}
                            </div>
                        ))}
                    </div>
                ) : null}

                <AgentChatPromptInput value={prompt} disabled={disabled || sending} placeholder={placeholder} theme={theme} onChange={onPromptChange} onSubmit={() => { if (canSubmit) void onSubmit(); }} onAddFiles={onAddFiles} skillMenuRequest={skillMenuRequest} inputRef={inputRef} menuPlacement={skillMenuPlacement} menuAnchorRef={cardRef} />

                <div className="@container mt-2 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1">
                        <Tooltip title={t("agent.composer.skills.select")} placement="top">
                            <IconButton size="lg" icon={Sparkles} label={t("agent.composer.skills.select")} className="shrink-0" style={{ color: theme.node.muted }} onClick={() => setSkillMenuRequest((request) => request + 1)} />
                        </Tooltip>
                        {showPlus ? (
                            <div className="shrink-0" ref={plusRef}>
                                <IconButton size="lg" icon={Plus} label={t("agent.composer.addAttachment")} style={{ color: theme.node.muted }} onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-haspopup="menu" />
                                <CanvasFloatingPanel open={menuOpen} anchorRef={plusRef} placement="topLeft" width={256} padding={4} variant="page" ariaLabel={t("agent.composer.addAttachment")} onOpenChange={setMenuOpen}>
                                    {onAddFiles ? (
                                        <div role="menu">
                                            <button type="button" role="menuitem" className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition hover:bg-accent" onClick={openPicker}>
                                                <span className="grid size-8 shrink-0 place-items-center rounded-lg" style={{ background: theme.toolbar.itemHover, color: theme.node.text }}>
                                                    <ImagePlus className="size-4" />
                                                </span>
                                                <span className="truncate">{t("agent.composer.addAttachment")}</span>
                                            </button>
                                        </div>
                                    ) : null}
                                </CanvasFloatingPanel>
                            </div>
                        ) : null}

                        {showModelPicker ? (
                            <ModelPicker purpose="agent" config={config} value={model} onChange={(next) => onModelChange?.(next)} className="h-8 min-w-0 max-w-[200px] rounded-full" />
                        ) : null}

                        {onConfirmToolsChange ? <ToolConfirmationMenu confirmTools={Boolean(confirmTools)} theme={theme} onChange={onConfirmToolsChange} /> : null}
                        {approvalMode && onApprovalModeChange ? <ApprovalModeMenu approvalMode={approvalMode} theme={theme} onChange={onApprovalModeChange} /> : null}
                        {permissionMode && onPermissionModeChange ? <PermissionModeMenu permissionMode={permissionMode} theme={theme} onChange={onPermissionModeChange} /> : null}
                        {models?.length && model && reasoningEffort && onReasoningEffortChange ? <ReasoningControl models={models} model={model} reasoningEffort={reasoningEffort} onReasoningEffortChange={onReasoningEffortChange} /> : null}
                        {left}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        {sending && onStop ? (
                            <Tooltip title={t("agent.composer.stop")} placement="top">
                                <button type="button" className="grid size-9 place-items-center rounded-full transition hover:opacity-90" style={{ background: theme.node.text, color: theme.node.panel }} onClick={() => void onStop()} aria-label={t("agent.composer.stop")}>
                                    <Square className="size-3.5" fill="currentColor" strokeWidth={0} />
                                </button>
                            </Tooltip>
                        ) : (
                            <Tooltip title={t("agent.composer.send")} placement="top">
                                <button type="button" className="grid size-9 place-items-center rounded-full transition disabled:cursor-not-allowed" style={{ background: canSubmit ? theme.node.text : theme.toolbar.itemHover, color: canSubmit ? theme.node.panel : theme.node.muted }} disabled={!canSubmit} onClick={() => void onSubmit()} aria-label={t("agent.composer.send")}>
                                    {sending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
                                </button>
                            </Tooltip>
                        )}
                    </div>
                </div>
            </div>
            <input ref={fileInputRef} hidden type="file" accept="image/*,video/*,application/pdf,.glb,.gltf" multiple aria-label={t("agent.composer.addAttachment")} onChange={(event) => { void onAddFiles?.(event.target.files); event.target.value = ""; }} />
        </div>
    );
}

function ReasoningControl({ models, model, reasoningEffort, onReasoningEffortChange }: { models: AgentModel[]; model: string; reasoningEffort: AgentReasoningEffort; onReasoningEffortChange: (effort: AgentReasoningEffort) => void }) {
    const { t } = useTranslation();
    const current = models.find((item) => item.model === model) || models[0];
    const effortLabel = (effort: AgentReasoningEffort) => t(`agent.composer.effort.${effort}`);
    const [open, setOpen] = useState(false);
    return (
        <Tooltip title={t("agent.composer.reasoning", { effort: effortLabel(reasoningEffort) })} placement="top" open={open ? false : undefined}>
            <span className="inline-flex shrink-0">
                <Select value={reasoningEffort} open={open} onOpenChange={setOpen} onValueChange={(value) => onReasoningEffortChange(value as AgentReasoningEffort)}>
                    <SelectTrigger hideChevron className="h-9 w-9 min-w-9 justify-center gap-0 rounded-full border-0 bg-transparent px-0 text-xs font-medium shadow-none hover:bg-black/5 focus:ring-0 @min-[660px]:w-auto @min-[660px]:min-w-[4.5rem] @min-[660px]:justify-start @min-[660px]:gap-1.5 @min-[660px]:px-2.5 dark:bg-transparent dark:hover:bg-white/10" aria-label={t("agent.composer.selectReasoning", { effort: effortLabel(reasoningEffort) })}>
                        <Gauge className="size-3.5 opacity-70" />
                        <span className="hidden @min-[660px]:inline">{effortLabel(reasoningEffort)}</span>
                        <ChevronUp className="hidden size-3 opacity-50 @min-[660px]:block" />
                    </SelectTrigger>
                    <SelectContent data-canvas-no-zoom position="popper" side="top" align="start" sideOffset={6} className="z-[2100] min-w-32 rounded-xl border border-border/70 bg-popover p-1 shadow-xl">
                        {current.supportedReasoningEfforts.map((item) => <SelectItem key={item.reasoningEffort} value={item.reasoningEffort}>{effortLabel(item.reasoningEffort)}</SelectItem>)}
                    </SelectContent>
                </Select>
            </span>
        </Tooltip>
    );
}

function ApprovalModeMenu({ approvalMode, theme, onChange }: { approvalMode: AgentApprovalMode; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (approvalMode: AgentApprovalMode) => void }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const options: Array<{ key: AgentApprovalMode; title: string; description: string; icon: ReactNode }> = [
        { key: "confirm_changes", title: t("agent.approval.confirmChanges"), description: t("agent.approval.confirmChangesDescription"), icon: <ShieldAlert className="size-3.5" /> },
        { key: "full_access", title: t("agent.approval.fullAccess"), description: t("agent.approval.fullAccessDescription"), icon: <ShieldOff className="size-3.5" /> },
    ];
    const current = options.find((item) => item.key === approvalMode) || options[0];
    return (
        <Tooltip title={t("agent.approval.selectMode", { mode: current.title })} placement="top" open={open ? false : undefined}>
            <span className="inline-flex shrink-0">
                <Dropdown
                    trigger={["click"]}
                    placement="topLeft"
                    open={open}
                    onOpenChange={setOpen}
                    menu={{
                        items: options.map((item) => ({
                            key: item.key,
                            label: <ConfirmationOption icon={item.icon} title={item.title} description={item.description} selected={approvalMode === item.key} />,
                            onClick: () => onChange(item.key),
                        })),
                    }}
                >
                    <button type="button" className="flex h-9 w-9 min-w-9 shrink-0 items-center justify-center gap-0 rounded-full px-0 text-xs font-medium transition hover:bg-black/5 @min-[660px]:h-9 @min-[660px]:w-auto @min-[660px]:min-w-0 @min-[660px]:justify-start @min-[660px]:gap-1.5 @min-[660px]:px-2.5 dark:hover:bg-white/10" style={{ color: theme.node.text }} aria-label={t("agent.approval.selectMode", { mode: current.title })}>
                        {current.icon}
                        <span className="hidden @min-[660px]:inline">{current.title}</span>
                        <ChevronUp className="hidden size-3 opacity-50 @min-[660px]:block" />
                    </button>
                </Dropdown>
            </span>
        </Tooltip>
    );
}

function PermissionModeMenu({ permissionMode, theme, onChange }: { permissionMode: AgentPermissionMode; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (permissionMode: AgentPermissionMode) => void }) {
    const { t } = useTranslation();
    const permissionOptions: Array<{ key: AgentPermissionMode; title: string; shortTitle: string; description: string; icon: ReactNode }> = [
        { key: "request", title: t("agent.composer.permission.request"), shortTitle: t("agent.composer.permission.request"), description: t("agent.composer.permission.requestDescription"), icon: <ShieldAlert className="size-3.5" /> },
        { key: "automatic", title: t("agent.composer.permission.automatic"), shortTitle: t("agent.composer.permission.automatic"), description: t("agent.composer.permission.automaticDescription"), icon: <ShieldCheck className="size-3.5" /> },
        { key: "full", title: t("agent.composer.permission.full"), shortTitle: t("agent.composer.permission.fullShort"), description: t("agent.composer.permission.fullDescription"), icon: <ShieldOff className="size-3.5" /> },
    ];
    const current = permissionOptions.find((item) => item.key === permissionMode) || permissionOptions[0];
    const [open, setOpen] = useState(false);
    return (
        <Tooltip title={t("agent.composer.permissionLabel", { mode: current.shortTitle })} placement="top" open={open ? false : undefined}>
            <span className="inline-flex shrink-0">
                <Dropdown
                    trigger={["click"]}
                    placement="topLeft"
                    open={open}
                    onOpenChange={setOpen}
                    menu={{
                        items: permissionOptions.map((item) => ({
                            key: item.key,
                            label: <ConfirmationOption icon={item.icon} title={item.title} description={item.description} selected={permissionMode === item.key} />,
                            onClick: () => onChange(item.key),
                        })),
                    }}
                >
                    <button type="button" className="flex h-9 w-9 min-w-9 shrink-0 items-center justify-center gap-0 rounded-full px-0 text-xs font-medium transition hover:bg-black/5 @min-[660px]:h-9 @min-[660px]:w-auto @min-[660px]:min-w-0 @min-[660px]:justify-start @min-[660px]:gap-1.5 @min-[660px]:px-2.5 dark:hover:bg-white/10" style={{ color: permissionMode === "full" ? "#ea580c" : theme.node.text }} aria-label={t("agent.composer.selectPermission", { mode: current.title })}>
                        {current.icon}
                        <span className="hidden @min-[660px]:inline">{current.shortTitle}</span>
                        <ChevronUp className="hidden size-3 opacity-50 @min-[660px]:block" />
                    </button>
                </Dropdown>
            </span>
        </Tooltip>
    );
}

function ToolConfirmationMenu({ confirmTools, theme, onChange }: { confirmTools: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (confirmTools: boolean) => void }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const mode = t(confirmTools ? "agent.composer.tools.manual" : "agent.composer.tools.automatic");
    return (
        <Tooltip title={t("agent.composer.tools.label", { mode })} placement="top" open={open ? false : undefined}>
            <span className="inline-flex shrink-0">
                <Dropdown
                    trigger={["click"]}
                    placement="topLeft"
                    open={open}
                    onOpenChange={setOpen}
                    menu={{
                        items: [
                            {
                                key: "manual",
                                label: <ConfirmationOption icon={<Hand className="size-4" />} title={t("agent.composer.tools.manual")} description={t("agent.composer.tools.manualDescription")} selected={confirmTools} />,
                                onClick: () => onChange(true),
                            },
                            {
                                key: "automatic",
                                label: <ConfirmationOption icon={<RefreshCw className="size-4" />} title={t("agent.composer.tools.automatic")} description={t("agent.composer.tools.automaticDescription")} selected={!confirmTools} />,
                                onClick: () => onChange(false),
                            },
                        ],
                    }}
                >
                    <button type="button" className="flex h-9 w-9 min-w-9 shrink-0 items-center justify-center gap-0 rounded-full px-0 text-xs font-medium transition hover:bg-black/5 @min-[660px]:w-auto @min-[660px]:min-w-0 @min-[660px]:justify-start @min-[660px]:gap-1.5 @min-[660px]:px-2.5 dark:hover:bg-white/10" style={{ color: theme.node.text }} aria-label={t("agent.composer.tools.select", { mode })}>
                        {confirmTools ? <Hand className="size-3.5" /> : <RefreshCw className="size-3.5" />}
                        <span className="hidden @min-[660px]:inline">{mode}</span>
                        <ChevronUp className="hidden size-3 opacity-50 @min-[660px]:block" />
                    </button>
                </Dropdown>
            </span>
        </Tooltip>
    );
}

function ConfirmationOption({ icon, title, description, selected }: { icon: ReactNode; title: string; description: string; selected: boolean }) {
    return (
        <div className="flex min-w-64 items-start gap-3 py-1">
            <span className="mt-0.5 shrink-0">{icon}</span>
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{title}</span>
                <span className="mt-0.5 block text-xs leading-5 opacity-60">{description}</span>
            </span>
            {selected ? <Check className="mt-0.5 size-4 shrink-0" /> : null}
        </div>
    );
}
