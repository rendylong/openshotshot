import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button, Image, Modal, Popover } from "antd";
import { CirclePlus, FileDiff, FileInput, FilePlus2, FileSearch, FolderSearch, Activity, FolderOpen, Globe, ImagePlus, Images, Image as ImageIcon, MessageCircleQuestion, PanelsTopLeft, Sparkles, Lightbulb, Box, CheckCircle2, ChevronDown, ChevronRight, Circle, CircleAlert, Copy, ExternalLink, File, FileAudio, FilePenLine, FileSpreadsheet, FileText, FileVideo, ListChecks, LoaderCircle, Presentation, Search, ShieldAlert, TerminalSquare, Wrench, XCircle } from "lucide-react";
import { Streamdown, type LinkSafetyModalProps } from "streamdown";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { useCopyText } from "@/hooks/use-copy-text";
import { useProjectAssetUrl } from "@/hooks/use-project-asset-url";
import { MODAL_WIDTH } from "@/lib/design/modal";
import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";
import { useAgentStore, type AgentCanvasReference, type AgentPendingApproval } from "@/stores/use-agent-store";
import type { AgentAttachmentKind } from "@/lib/agent/agent-attachments";
import { formatBytes, toolName } from "./agent-event-formatters";
import { AgentCanvasReferencePreview, canvasReferenceIcon, canvasReferenceKindLabel } from "./agent-canvas-reference-preview";
import { agentInlineTokenClass, agentInlineTokenIconClass, agentInlineTokenMediaClass, agentReferenceMarker, parseAgentInlineTokens } from "./agent-chat-inline-tokens";
import "./agent-aicss.css";

const streamdownProps = () => ({
    className: "agent-streamdown",
    controls: { code: { copy: true, download: false }, table: { copy: true, download: false, fullscreen: false } },
    linkSafety: { enabled: true, renderModal: (props: LinkSafetyModalProps) => <AgentLinkModal {...props} /> },
    lineNumbers: false,
    translations: {
        close: tr("close"), copied: tr("copied"), copyCode: tr("copyCode"), copyLink: tr("copyLink"), externalLinkWarning: tr("externalWarning"), openExternalLink: tr("openExternal"), openLink: tr("continueOpen"),
    },
} as const);
const streamdownAnimation = { duration: 20, stagger: 0, sep: "word" } as const;

function AgentLinkModal({ isOpen, onClose, onConfirm, url }: LinkSafetyModalProps) {
    const { t } = useTranslation();
    const copyText = useCopyText();
    return (
        <Modal open={isOpen} onCancel={onClose} footer={null} centered width={MODAL_WIDTH.sm} title={t("agent.message.openExternal")}>
            <div className="text-sm text-black/55 dark:text-white/55">
                {t("agent.message.externalDescription")}
            </div>
            <div className="mt-4 max-h-32 overflow-auto break-all rounded-lg bg-black/[.035] px-3 py-2.5 font-mono text-xs leading-5 dark:bg-white/[.06]">{url}</div>
            <div className="mt-5 flex justify-end gap-2">
                <Button type="text" icon={<Copy className="size-4" />} onClick={() => copyText(url, t("agent.message.linkCopied"))}>
                    {t("agent.message.copyLink")}
                </Button>
                <Button type="text" icon={<ExternalLink className="size-4" />} onClick={onConfirm}>
                    {t("agent.message.continueOpen")}
                </Button>
            </div>
        </Modal>
    );
}

export type AgentChatAttachment = { id: string; name: string; url: string; kind?: AgentAttachmentKind; mimeType?: string; size?: number; dataUrl?: string; handle?: string; assetRef?: CanvasAssetRef; relativePath?: string };
export type AgentChatMessageItem = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error" | "compaction";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    attachments?: AgentChatAttachment[];
    canvasReferences?: AgentCanvasReference[];
    /** Present while the message is actively streaming; cleared on completion. */
    streamId?: string;
};

export function AgentChatMessage({ item, theme, onRejectTool, onApproveTool }: { item: AgentChatMessageItem; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onRejectTool?: (id: string) => void; onApproveTool?: (id: string) => void }) {
    const isUser = item.role === "user";
    const isSystem = item.role === "system";
    const color = item.role === "error" ? theme.node.muted : item.role === "tool" ? "var(--info)" : theme.node.text;
    if (isSystem) {
        return (
            <div className="flex justify-center text-xs">
                <div className="max-w-[88%] px-3 py-1.5 text-center" style={{ color: theme.node.muted }}>
                    {item.text}
                    {item.meta ? <span className="ml-2 opacity-60">{item.meta}</span> : null}
                </div>
            </div>
        );
    }
    if (item.role === "tool") {
        if (objectField(item.detail, "status") === "pending") return <AgentPendingToolCard summary={item.text} detail={item.detail} theme={theme} onReject={() => onRejectTool?.(item.id)} onApprove={() => onApproveTool?.(item.id)} />;
        return <AgentToolCard title={item.title || tr("toolCall")} text={item.text} detail={item.detail} theme={theme} />;
    }
    return (
        <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
            <div
                className={isUser ? "min-w-0 max-w-[82%] py-1 text-right text-sm leading-6" : "min-w-0 w-full text-left text-sm leading-6"}
                style={{ color }}
            >
                {isUser ? (
                    <AgentUserMessageContent text={item.text} references={item.canvasReferences || []} theme={theme} />
                ) : (
                    <div className="aicss-prose">
                        <Streamdown {...streamdownProps()} animated={streamdownAnimation} isAnimating={!!item.streamId}>{item.text}</Streamdown>
                        {item.streamId ? <span className="aicss-caret" aria-hidden="true" /> : null}
                    </div>
                )}
                {item.attachments?.length ? <AgentMessageAttachments attachments={item.attachments} alignRight={isUser} /> : null}
                {item.meta ? <div className={`mt-1 text-[11px] tabular-nums opacity-55 ${isUser ? "text-right" : ""}`}>{item.meta}</div> : null}
            </div>
        </div>
    );
}

function AgentUserMessageContent({ text, references, theme }: { text: string; references: AgentCanvasReference[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const tokens = parseAgentInlineTokens(text, references);
    return (
        <div className="whitespace-pre-wrap break-words">
            {tokens.map((token, index) => token.type === "text"
                ? token.value
                : token.type === "reference"
                    ? <AgentCanvasMention key={`${token.reference.nodeId}:${index}`} reference={token.reference} theme={theme} />
                    : <span key={`${token.name}:${index}`} className={agentInlineTokenClass} style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }}>/{token.name}</span>)}
        </div>
    );
}

function AgentCanvasMention({ reference, theme }: { reference: AgentCanvasReference; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const node = useAgentStore((state) => state.canvasContext?.snapshot.nodes.find((item) => item.id === reference.nodeId));
    const previewUrl = reference.previewUrl || node?.metadata?.content || "";
    const previewText = reference.text || node?.metadata?.content || node?.metadata?.prompt;
    const Icon = canvasReferenceIcon(reference.kind);
    return (
        <Popover
            trigger={["hover", "focus"]}
            placement="top"
            mouseEnterDelay={0.15}
            content={<AgentCanvasReferencePreview reference={reference} previewUrl={previewUrl} previewText={previewText} theme={theme} />}
        >
            <span
                tabIndex={0}
                className={`${agentInlineTokenClass} max-w-56 cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/10 dark:focus-visible:ring-white/15`}
                style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }}
                aria-label={i18n.t("agent.composer.mentions.referenceLabel", { kind: canvasReferenceKindLabel(reference.kind), title: reference.title })}
            >
                {reference.kind === "image" && previewUrl
                    ? <img src={previewUrl} alt="" className={agentInlineTokenMediaClass} />
                    : <Icon className={agentInlineTokenIconClass} />}
                <span>{agentReferenceMarker(reference)}</span>
            </span>
        </Popover>
    );
}

export function AgentPendingToolCard({ summary, detail, theme, onReject, onApprove }: { summary: string; detail?: unknown; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onReject?: () => void; onApprove?: () => void }) {
    const { t } = useTranslation();
    const view = userDetail(detail);
    return (
        <div className="min-w-0 rounded-xl border px-3 py-3" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <details className="group">
                <summary className={`list-none ${view ? "cursor-pointer" : "cursor-default"}`} onClick={(event) => { if (!view) event.preventDefault(); }}>
                    <div className="flex min-w-0 items-center gap-2 text-sm font-medium leading-5">
                        <CircleAlert className="size-4 shrink-0" style={{ color: theme.node.muted }} />
                        <span className="min-w-0 flex-1">{t("agent.message.awaitingConfirmation")}</span>
                        {view ? <ChevronDown className="size-3.5 shrink-0 transition-transform group-open:rotate-180" style={{ color: theme.node.muted }} /> : null}
                    </div>
                    <div className="mt-1 pl-6 text-sm leading-5" style={{ color: theme.node.muted }}>{summary}</div>
                </summary>
                {view ? <div className="ml-6"><AgentDetailBlock detail={view} theme={theme} /></div> : null}
            </details>
            {onReject || onApprove ? (
                <div className="mt-3 flex justify-end gap-2 border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                    <Button danger type="text" className="!h-8" icon={<XCircle className="size-3.5" />} onClick={() => onReject?.()}>
                        {t("agent.message.reject")}
                    </Button>
                    <Button type="text" className="!h-8" icon={<CheckCircle2 className="size-3.5" />} style={{ color: "var(--success)" }} onClick={() => onApprove?.()}>
                        {t("agent.message.approve")}
                    </Button>
                </div>
            ) : null}
        </div>
    );
}

export function AgentApprovalCard({ approval, theme, onDecision }: { approval: AgentPendingApproval; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onDecision: (decision: "accept" | "acceptForSession" | "decline") => void }) {
    const { t } = useTranslation();
    const isFile = approval.method === "item/fileChange/requestApproval";
    const isNetwork = Boolean(approval.networkApprovalContext);
    // command 恒非空（gate 与 contract 双重保证），target 的 `|| cwd` 回退不可达，cwd 以次行独立展示。
    const isCommand = !isNetwork && !isFile && approval.method !== "item/permissions/requestApproval";
    const title = t(isNetwork ? "agent.message.networkApproval" : isFile ? "agent.message.fileApproval" : approval.method === "item/permissions/requestApproval" ? "agent.message.permissionApproval" : "agent.message.commandApproval");
    const target = isNetwork ? approvalTarget(approval.networkApprovalContext) : isFile ? approval.grantRoot || approval.cwd : commandText(approval.command) || approval.cwd;
    return (
        <div className="min-w-0 rounded-xl border px-3 py-3" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <div className="flex items-start gap-2.5">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" style={{ color: theme.node.muted }} />
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{title}</div>
                    {approval.reason ? <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>{approval.reason}</div> : null}
                    {target ? <div className="mt-1.5 break-all rounded-lg px-2.5 py-2 font-mono text-[11px] leading-4" style={{ background: theme.toolbar.panel, color: theme.node.text }}>{target}</div> : null}
                    {isCommand && approval.cwd ? <div className="mt-1 break-all text-[11px] leading-4" style={{ color: theme.node.muted }}>{t("agent.message.commandCwd", { cwd: approval.cwd })}</div> : null}
                </div>
            </div>
            <div className="mt-3 flex flex-wrap justify-end gap-1.5 border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                <Button danger type="text" className="!h-8" disabled={Boolean(approval.deciding)} loading={approval.deciding === "decline"} onClick={() => onDecision("decline")}>{t("agent.message.decline")}</Button>
                <Button type="text" className="!h-8" disabled={Boolean(approval.deciding)} loading={approval.deciding === "accept"} onClick={() => onDecision("accept")}>{t("agent.message.allowOnce")}</Button>
                <Button type="text" className="!h-8" disabled={Boolean(approval.deciding)} loading={approval.deciding === "acceptForSession"} onClick={() => onDecision("acceptForSession")}>{t("agent.message.allowSession")}</Button>
            </div>
        </div>
    );
}

/** 与思考摘要同构的限高视口：内容超过 180px 时滚动，上下 16px 渐变遮罩按实际 overflow 出现；短内容不裁切、无遮罩。 */
function AgentCappedBody({ children, className, style, pinBottom = false }: { children: ReactNode; className?: string; style?: CSSProperties; pinBottom?: boolean }) {
    const [fade, setFade] = useState({ top: false, bottom: false });
    const viewportRef = useRef<HTMLDivElement>(null);

    const updateFade = () => {
        const el = viewportRef.current;
        if (!el) return;
        setFade((prev) => {
            const top = el.scrollTop > 1;
            const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
            return prev.top === top && prev.bottom === bottom ? prev : { top, bottom };
        });
    };

    // 每次渲染按真实几何重算（jsdom 无 ResizeObserver 时兜底）；details 展开由 ResizeObserver 补触发。
    useEffect(() => {
        const el = viewportRef.current;
        if (!el) return;
        if (pinBottom) el.scrollTop = el.scrollHeight;
        updateFade();
    });
    useEffect(() => {
        const el = viewportRef.current;
        if (!el || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(() => updateFade());
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const mask = `linear-gradient(to bottom, transparent 0, #000 ${fade.top ? 16 : 0}px, #000 calc(100% - ${fade.bottom ? 16 : 0}px), transparent 100%)`;

    return (
        <div
            ref={viewportRef}
            onScroll={updateFade}
            className={className}
            style={{
                ...style,
                maxHeight: 180,
                overflowY: "auto",
                ...(fade.top || fade.bottom ? { WebkitMaskImage: mask, maskImage: mask } : {}),
            }}
        >
            {children}
        </div>
    );
}

export function AgentToolCard({ title, text, detail, theme }: { title: string; text: string; detail?: unknown; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const plan = planDetail(detail);
    if (plan) return <AgentPlanCard title={title} plan={plan} theme={theme} />;
    const kind = String(objectField(detail, "kind") || "");
    if (kind === "reasoning") return <AgentReasoningSummary text={text} detail={detail} theme={theme} />;
    if (kind === "command") return <AgentCommandGroup items={[{ id: title, text, detail }]} theme={theme} />;
    const name = String(objectField(detail, "toolName") || title);
    const state = toolCardState(title, text, detail);
    const view = userDetail(detail);
    return (
        <details className="aicss-toolEntry min-w-0 text-left" style={{ color: theme.node.muted }}>
            <summary className="aicss-processRow">
                <span className="aicss-processIcon" aria-hidden="true">{toolIcon(name, kind)}</span>
                <span className="aicss-processLabel">
                    <span className="aicss-processTitle" title={title}>{toolName(name, title)}</span>
                    <ChevronRight className="aicss-processChevron" />
                </span>
                <span className="aicss-processStatus" style={{ color: "var(--aicss-muted)", fontWeight: state.isError ? 500 : undefined }}>{state.label}</span>
            </summary>
            <div className="aicss-processBody">
                {text && text !== view?.output ? <AgentCappedBody className="mt-1 whitespace-pre-wrap break-words pb-1 pr-2 text-xs leading-5">{text}</AgentCappedBody> : null}
                {view ? <AgentDetailBlock detail={view} theme={theme} /> : null}
            </div>
        </details>
    );
}

function AgentReasoningSummary({ text, detail, theme }: { text: string; detail?: unknown; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const { t } = useTranslation();
    const status = String(objectField(detail, "status") || "");
    const running = ["inProgress", "in_progress", "running", "started", "pending"].includes(status);
    const durationMs = Number(objectField(detail, "durationMs"));
    const thoughtLabel = Number.isFinite(durationMs)
        ? t("agent.message.thought", { seconds: Math.max(1, Math.round(durationMs / 1_000)) })
        : t("agent.events.reasoning");
    const [open, setOpen] = useState(false);

    return (
        <div className="aicss-thinking min-w-0 text-left">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
                className="aicss-processRow"
            >
                <Lightbulb className="aicss-processIcon" />
                <span className="aicss-processLabel">
                    <span className={`aicss-processTitle ${running ? "aicss-shimmer" : ""}`}>{running ? t("agent.message.thinking") : thoughtLabel}</span>
                    <ChevronRight className="aicss-processChevron" />
                </span>
            </button>
            {open ? (
                <AgentCappedBody
                    pinBottom={running}
                    className="aicss-thinkingBody aicss-processBody break-words pb-1 pr-2 text-xs leading-5 [&_code]:rounded [&_code]:px-1 [&_p]:my-1 [&_pre]:my-2"
                    style={{ color: theme.node.muted }}
                >
                    <Streamdown {...streamdownProps()} animated={streamdownAnimation} isAnimating={running}>{text}</Streamdown>
                </AgentCappedBody>
            ) : null}
        </div>
    );
}

type AgentCommandItem = Pick<AgentChatMessageItem, "id" | "text" | "detail">;

export function AgentCommandGroup({ items, theme }: { items: AgentCommandItem[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const { t } = useTranslation();
    const states = items.map((item) => commandViewState(item.detail));
    const running = states.some((state) => state.running);
    const failed = states.filter((state) => state.failed).length;
    const expandable = items.some((item) => Boolean(item.text.trim() || userDetail(item.detail)));
    const color = theme.node.muted;
    const label = running ? t(items.length > 1 ? "agent.message.commandsRunning" : "agent.message.commandRunning", { count: items.length }) : t("agent.message.commandsCompleted", { count: items.length, failed: failed ? t("agent.message.commandsFailed", { count: failed }) : "" });
    const header = (
        <div className="flex min-w-0 items-center gap-2 text-sm" style={{ color }}>
            {running ? <LoaderCircle className="size-4 shrink-0 animate-spin" /> : <TerminalSquare className="size-4 shrink-0" />}
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {expandable ? <ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" /> : null}
        </div>
    );
    if (!expandable) return <div className="min-w-0 py-1 text-left">{header}</div>;
    return (
        <details className="group min-w-0 text-left">
            <summary className="cursor-pointer list-none py-1">{header}</summary>
            {items.length === 1
                ? <AgentSingleCommand item={items[0]} theme={theme} />
                : <div className="ml-6 mt-1">{items.map((item, index) => <AgentCommandEntry key={item.id} item={item} index={index} theme={theme} />)}</div>
            }
        </details>
    );
}

function AgentSingleCommand({ item, theme }: { item: AgentCommandItem; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const view = userDetail(item.detail);
    return (
        <div className="ml-6 pb-1">
            {item.text ? <div className="mt-1.5 whitespace-pre-wrap break-all font-mono text-[11px] leading-5" style={{ color: theme.node.text }}>{item.text}</div> : null}
            {view ? <AgentDetailBlock detail={view} theme={theme} /> : null}
        </div>
    );
}

function AgentCommandEntry({ item, index, theme }: { item: AgentCommandItem; index: number; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const detailId = useId();
    const view = userDetail(item.detail);
    const state = commandViewState(item.detail);
    const status = t(state.failed ? "agent.message.failed" : state.running ? "agent.message.running" : "agent.message.completed");
    const content = (
        <>
            <span className="w-4 shrink-0 text-center text-[10px] tabular-nums opacity-50" style={{ color: theme.node.muted }}>{index + 1}</span>
            <code className="min-w-0 flex-1 truncate text-[11px] leading-5" style={{ color: theme.node.text }} title={item.text}>{item.text || t("agent.message.command")}</code>
            <span className="shrink-0" style={{ color: theme.node.muted }} title={status} aria-label={status}>
                {state.running ? <LoaderCircle className="size-3.5 animate-spin" /> : state.failed ? <XCircle className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
            </span>
            {view ? <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} style={{ color: theme.node.muted }} /> : null}
        </>
    );
    return (
        <div className={index ? "border-t" : ""} style={{ borderColor: theme.node.stroke }}>
            {view
                ? <button type="button" className="flex w-full min-w-0 items-center gap-2 py-2 text-left" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((value) => !value)}>{content}</button>
                : <div className="flex min-w-0 items-center gap-2 py-2 text-left">{content}</div>}
            {view && open ? <div id={detailId} className="pb-2 pl-6"><AgentDetailBlock detail={view} theme={theme} /></div> : null}
        </div>
    );
}

function commandViewState(detail: unknown) {
    const status = String(objectField(detail, "status") || "").toLowerCase();
    return {
        running: ["inprogress", "in_progress", "running", "started", "pending"].includes(status),
        failed: ["failed", "error"].includes(status),
    };
}

function AgentPlanCard({ title, plan, theme }: { title: string; plan: PlanDetail; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const [open, setOpen] = useState(true);
    const completed = plan.tasks.filter((item) => item.status === "completed").length;
    const state = planCardState(plan, completed, theme.node.muted);
    return (
        <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group min-w-0 flex-1 rounded-xl border px-3 py-2.5 text-left" style={{ borderColor: theme.node.stroke, background: "transparent", color: theme.node.text }}>
            <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2.5">
                <ListChecks className="size-4 shrink-0" style={{ color: state.color }} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
                <span className="shrink-0 text-[11px]" style={{ color: state.color }}>{state.label}</span>
                <span aria-live="polite" className="shrink-0 text-[11px] tabular-nums" style={{ color: theme.node.muted }}>{completed}/{plan.tasks.length}</span>
                <ChevronDown className="size-3.5 shrink-0 transition-transform group-open:rotate-180" style={{ color: theme.node.muted }} />
            </summary>
            {plan.explanation ? <div className="mt-1.5 text-xs leading-5" style={{ color: theme.node.muted }}>{plan.explanation}</div> : null}
            <div className="mt-2.5 space-y-2 border-t pt-2.5" style={{ borderColor: theme.node.stroke }}>
                {plan.tasks.map((item, index) => {
                    const task = planTaskState(item.status, theme.node.muted);
                    return (
                        <div key={`${index}-${item.step}`} className="flex items-start gap-2 text-sm leading-5">
                            <span className="mt-0.5 shrink-0" style={{ color: task.color }}>{task.icon}</span>
                            <span className={`min-w-0 flex-1 ${item.status === "completed" ? "opacity-55" : item.status === "inProgress" ? "font-medium" : ""}`} style={{ color: item.status === "inProgress" ? theme.node.text : theme.node.muted }}>{item.step}</span>
                            <span className="shrink-0 text-[11px]" style={{ color: task.color }}>{task.label}</span>
                        </div>
                    );
                })}
            </div>
        </details>
    );
}

export function AgentWorkingMessage({ text, detail, status = "running", mcpStatuses = [], activityKey, expectLongWait = false, theme }: { text: string; detail?: string; status?: "running" | "ready" | "error"; mcpStatuses?: Array<{ name: string; status: "running" | "ready" | "error"; detail: string }>; activityKey: string; expectLongWait?: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const { t } = useTranslation();
    const [elapsed, setElapsed] = useState(0);
    useEffect(() => {
        const startedAt = Date.now();
        setElapsed(0);
        const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
        return () => window.clearInterval(timer);
    }, [activityKey]);
    return (
        <div className="min-w-0 py-1" aria-live="polite">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" style={{ color: theme.node.muted }}>
                {status === "running" ? <span className="aicss-shimmer">{text}</span> : <>{status === "ready" ? <CheckCircle2 className="size-3.5 shrink-0" /> : <XCircle className="size-3.5 shrink-0" />}<span className="min-w-0">{text}</span></>}
            </div>
            {detail ? <div className="ml-5.5 mt-1 text-xs leading-5 opacity-65" style={{ color: theme.node.muted }}>{detail}</div> : null}
            {mcpStatuses.length ? (
                <div className="ml-5.5 mt-3 space-y-2">
                    {mcpStatuses.map((item) => (
                        <div key={item.name} className="flex min-w-0 items-start gap-2 text-xs leading-5" style={{ color: theme.node.muted }}>
                            {item.status === "running" ? <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin" /> : item.status === "ready" ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> : <XCircle className="mt-0.5 size-3.5 shrink-0" />}
                            <div className="min-w-0">
                                <div className="font-medium" style={{ color: theme.node.text }}>{item.name}</div>
                                <div className="opacity-65">{item.detail}</div>
                            </div>
                        </div>
                    ))}
                </div>
            ) : null}
            {status === "running" && !expectLongWait && elapsed >= 30 ? <div className="mt-1 text-xs leading-5 opacity-65" style={{ color: theme.node.muted }}>{t("agent.message.slowResponse")}</div> : null}
        </div>
    );
}

function commandText(value: unknown) {
    if (Array.isArray(value)) return value.map(String).join(" ");
    return typeof value === "string" ? value : "";
}

function approvalTarget(value: unknown) {
    const host = String(objectField(value, "host") || "");
    const protocol = String(objectField(value, "protocol") || "");
    const port = String(objectField(value, "port") || "");
    return host ? `${protocol ? `${protocol}://` : ""}${host}${port ? `:${port}` : ""}` : "";
}

type PlanTask = { step: string; status: string };
type PlanDetail = { status: string; tasks: PlanTask[]; explanation?: string };
type UserDetail = { kind?: string; status?: string; rows?: Array<{ label: string; value: string }>; input?: string; output?: string; files?: Array<{ path: string; action?: string }> };

function AgentDetailBlock({ detail, theme }: { detail: UserDetail; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const { t } = useTranslation();
    return (
        <div className="mt-3 space-y-2.5 border-t pt-3 text-xs" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
            {detail.rows?.length ? (
                <dl className="space-y-1.5">
                    {detail.rows.map((row) => (
                        <div key={`${row.label}-${row.value}`} className="grid grid-cols-[64px_minmax(0,1fr)] gap-2">
                            <dt className="opacity-60">{row.label}</dt>
                            <dd className="min-w-0 break-words" style={{ color: theme.node.text }}>{row.value}</dd>
                        </div>
                    ))}
                </dl>
            ) : null}
            {detail.files?.length ? (
                <div className="space-y-1.5">
                    <div className="opacity-60">{t("agent.message.files")}</div>
                    {detail.files.map((file) => (
                        <div key={`${file.action}-${file.path}`} className="flex items-start gap-2">
                            <FileText className="mt-0.5 size-3.5 shrink-0" />
                            <span className="min-w-0 flex-1 break-all" style={{ color: theme.node.text }}>{file.path}</span>
                            {file.action ? <span className="shrink-0 opacity-60">{file.action}</span> : null}
                        </div>
                    ))}
                </div>
            ) : null}
            {detail.input ? (
                <div className="space-y-1.5">
                    <div className="opacity-60">{t("agent.message.inputInfo")}</div>
                    <pre className="thin-scrollbar max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg px-3 py-2 font-mono text-[11px] leading-4" style={{ background: theme.toolbar.panel, color: theme.node.text }}>{detail.input}</pre>
                </div>
            ) : null}
            {detail.output ? (
                <div className="space-y-1.5">
                    <div className="opacity-60">{t(detail.status === "failed" || detail.status === "error" ? "agent.message.errorInfo" : "agent.message.output")}</div>
                    <AgentCappedBody className="thin-scrollbar whitespace-pre-wrap break-words rounded-lg px-3 py-2 font-mono text-[11px] leading-4" style={{ background: theme.toolbar.panel, color: theme.node.text }}>{detail.output}</AgentCappedBody>
                </div>
            ) : null}
        </div>
    );
}

const ATTACHMENT_FILE_ICONS: Record<string, typeof FileText> = {
    image: ImageIcon, video: FileVideo, audio: FileAudio, pdf: FileText, presentation: Presentation, spreadsheet: FileSpreadsheet, glb: Box, text: FileText, file: File,
};

function attachmentKindKey(kind?: string) {
    if (kind === "glb") return "model3d";
    if (kind && kind in ATTACHMENT_FILE_ICONS && kind !== "image") return kind;
    return "file";
}

function AgentAttachmentFileCard({ item }: { item: AgentChatAttachment }) {
    const { t } = useTranslation();
    const Icon = ATTACHMENT_FILE_ICONS[item.kind || "file"] || File;
    return (
        <div title={item.name} aria-label={item.name} className="flex max-w-56 items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] leading-4">
            <Icon className="size-4 shrink-0 opacity-70" />
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            <span className="shrink-0 opacity-60">{t(`agent.message.attachmentKind.${attachmentKindKey(item.kind)}`)}</span>
            {item.size ? <span className="shrink-0 tabular-nums opacity-60">{formatBytes(item.size)}</span> : null}
        </div>
    );
}

function AgentAttachmentImage({ item, onPreview }: { item: AgentChatAttachment; onPreview: (url: string) => void }) {
    const { t } = useTranslation();
    // 只有 kind === "image" 才渲染缩略图；历史消息没有运行时 URL 时从 assetRef 解析预览。
    const resolved = useProjectAssetUrl(item.assetRef, item.url);
    if (!resolved.url) return <AgentAttachmentFileCard item={item} />;
    return (
        <img
            src={resolved.url}
            alt={item.name}
            title={t("agent.message.viewLarge")}
            className="size-10 cursor-zoom-in rounded-lg object-cover"
            draggable={false}
            onClick={() => onPreview(resolved.url)}
        />
    );
}

function AgentMessageAttachments({ attachments, alignRight }: { attachments: AgentChatAttachment[]; alignRight?: boolean }) {
    const { t } = useTranslation();
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    return (
        <>
            <div className={`mt-1.5 flex flex-wrap gap-1.5 ${alignRight ? "justify-end" : "justify-start"}`}>
                {attachments.map((item) => item.kind === "image"
                    ? <AgentAttachmentImage key={item.id} item={item} onPreview={setPreviewUrl} />
                    : <AgentAttachmentFileCard key={item.id} item={item} />)}
            </div>
            {previewUrl ? (
                <div className="hidden">
                    <Image src={previewUrl} alt={t("agent.message.attachmentPreview")} preview={{ visible: true, src: previewUrl, onVisibleChange: (visible) => !visible && setPreviewUrl(null) }} />
                </div>
            ) : null}
        </>
    );
}

function toolCardState(title: string, text: string, detail?: unknown) {
    const raw = `${title} ${text} ${normalizeText(objectField(detail, "error"))}`;
    const lower = raw.toLowerCase();
    const status = String(objectField(detail, "status") || "").toLowerCase();
    // 状态一律哑灰呈现（色由 aicss-processRow 继承），仅以文案与 isError 字重区分。
    if (status === "noop" || /未生效|无需|没有找到|没有.*可|已存在/.test(raw)) return { label: tr("noEffect"), isError: false };
    if (["declined", "rejected", "cancelled", "canceled"].includes(status) || /拒绝|取消/.test(raw)) return { label: tr("canceled"), isError: true };
    if (["failed", "error"].includes(status) || /失败|错误/.test(raw) || lower.includes("failed") || lower.includes("error")) return { label: tr("failed"), isError: true };
    if (["inprogress", "in_progress", "running", "started", "pending"].includes(status)) return { label: tr("running"), isError: false };
    if (["completed", "succeeded", "success"].includes(status) || /完成|成功/.test(raw)) return { label: tr("completed"), isError: false };
    return { label: tr("recorded"), isError: false };
}

function toolIcon(name: string, kind: string | undefined) {
    const tool = name.split(/__|\./).at(-1) || name;
    // Canvas tools share one visual identity; state is shown separately on the right.
    if (tool.startsWith("canvas_") || tool === "view_image") return <PanelsTopLeft className="size-4" />;
    if (tool === "read") return <FileText className="size-4" />;
    if (tool === "local_file_read") return <FileInput className="size-4" />;
    if (["local_folder_list", "ls"].includes(tool)) return <FolderOpen className="size-4" />;
    if (["imagegen", "generate_chatgpt_image"].includes(tool)) return <ImagePlus className="size-4" />;
    if (["exec", "exec_command", "bash"].includes(tool)) return <TerminalSquare className="size-4" />;
    if (tool === "write") return <FilePlus2 className="size-4" />;
    if (tool === "apply_patch") return <FileDiff className="size-4" />;
    if (tool === "edit" || kind === "file") return <FilePenLine className="size-4" />;
    if (tool === "grep") return <FileSearch className="size-4" />;
    if (tool === "find") return <FolderSearch className="size-4" />;
    if (tool === "search" || kind === "search") return <Search className="size-4" />;
    if (name === "web__run" || tool === "web_search" || tool === "site_navigate") return <Globe className="size-4" />;
    if (tool === "skill_read") return <Sparkles className="size-4" />;
    if (tool === "ask_user_question") return <MessageCircleQuestion className="size-4" />;
    if (tool === "assets_list") return <Images className="size-4" />;
    if (tool === "assets_add") return <CirclePlus className="size-4" />;
    if (tool === "generation_get_status") return <Activity className="size-4" />;
    if (kind === "plan") return <ListChecks className="size-4" />;
    return <Wrench className="size-4" />;
}

function planCardState(plan: PlanDetail, completed: number, muted: string) {
    if (plan.status === "failed") return { label: tr("failed"), color: muted };
    if (["interrupted", "cancelled", "canceled"].includes(plan.status)) return { label: tr("stopped"), color: muted };
    if (completed === plan.tasks.length) return { label: tr("completed"), color: muted };
    if (plan.status === "finished") return { label: tr("finished"), color: muted };
    return { label: tr("running"), color: muted };
}

function planTaskState(status: string, muted: string) {
    if (status === "completed") return { label: tr("completed"), color: muted, icon: <CheckCircle2 className="size-3.5" /> };
    if (status === "inProgress") return { label: tr("running"), color: muted, icon: <LoaderCircle className="size-3.5 animate-spin" /> };
    return { label: tr("pending"), color: muted, icon: <Circle className="size-3.5" /> };
}

function planDetail(value: unknown): PlanDetail | null {
    if (!value || typeof value !== "object" || objectField(value, "kind") !== "todo") return null;
    const tasks = Array.isArray(objectField(value, "tasks"))
        ? (objectField(value, "tasks") as unknown[]).flatMap((item) => {
              const step = String(objectField(item, "step") || "").trim();
              return step ? [{ step, status: String(objectField(item, "status") || "pending") }] : [];
          })
        : [];
    if (!tasks.length) return null;
    const explanation = String(objectField(value, "explanation") || "").trim();
    return { status: String(objectField(value, "status") || "inProgress"), tasks, ...(explanation ? { explanation } : {}) };
}

function userDetail(value: unknown): UserDetail | null {
    if (!value || typeof value !== "object") return null;
    const detail = value as Record<string, unknown>;
    const rows = Array.isArray(detail.rows)
        ? detail.rows.flatMap((row) => {
              if (!row || typeof row !== "object") return [];
              const label = String((row as Record<string, unknown>).label || "");
              const value = String((row as Record<string, unknown>).value || "");
              return label && value ? [{ label, value }] : [];
          })
        : [];
    const files = Array.isArray(detail.files)
        ? detail.files.flatMap((file) => {
              if (!file || typeof file !== "object") return [];
              const path = String((file as Record<string, unknown>).path || "");
              return path ? [{ path, action: String((file as Record<string, unknown>).action || "") || undefined }] : [];
          })
        : [];
    const error = objectField(detail.error, "message");
    const input = typeof detail.input === "string" ? detail.input.trim() : "";
    const output = typeof detail.output === "string" ? detail.output.trim() : typeof error === "string" ? error : "";
    if (!rows.length && !files.length && !input && !output) return null;
    return { kind: typeof detail.kind === "string" ? detail.kind : undefined, status: typeof detail.status === "string" ? detail.status : undefined, rows, files, input, output };
}

function normalizeText(value: unknown) {
    if (typeof value === "string") return value.trim();
    if (value instanceof Error) return value.message;
    if (value == null) return "";
    return String(objectField(value, "message") || "");
}

function objectField(value: unknown, key: string) {
    return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function tr(key: string, options?: Record<string, unknown>) {
    return i18n.t(`agent.message.${key}`, options);
}
