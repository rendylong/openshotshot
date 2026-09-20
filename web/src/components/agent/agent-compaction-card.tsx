import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Archive, ChevronDown, ChevronRight, Loader2 } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import type { PiSessionEntryRange, PiSessionEntrySnapshot } from "@/lib/agent/pi-agent-types";
import type { AgentChatItem, AgentCompactionDetail } from "@/stores/use-agent-store";

type ReadSessionEntries = (sessionId: string, range?: PiSessionEntryRange) => Promise<PiSessionEntrySnapshot[]>;

function detailOf(item: AgentChatItem): AgentCompactionDetail {
    const detail = item.detail;
    if (detail && typeof detail === "object" && (detail as { kind?: unknown }).kind === "compaction") return detail as AgentCompactionDetail;
    return { kind: "compaction", status: "completed", reason: "manual", summary: item.text, tokensBefore: 0 };
}

function entryRoleLabel(entry: PiSessionEntrySnapshot, t: (key: string, defaultValue: string) => string): string {
    if (entry.type === "compaction") return t("agent.compaction.roleSummary", "摘要");
    const raw = objectOf(entry.raw);
    const message = objectOf(raw.message);
    const evidence = `${entry.role || ""} ${entry.type} ${stringOf(raw.customType)} ${stringOf(message.role)} ${stringOf(objectOf(raw.data).kind)}`.toLowerCase();
    if (evidence.includes("approval")) return t("agent.compaction.roleApproval", "审批");
    if (entry.role === "error" || message.errorMessage || raw.error || entry.type === "error" || message.stopReason === "error") {
        return t("agent.compaction.roleError", "错误");
    }
    const role = entry.role || "";
    if (role === "user") return t("agent.compaction.roleUser", "用户");
    if (role === "assistant") return t("agent.compaction.roleAssistant", "助手");
    if (role === "toolResult") return t("agent.compaction.roleTool", "工具");
    if (role === "bashExecution") return t("agent.compaction.roleTool", "工具");
    return t("agent.compaction.roleUnknown", "记录");
}

function entryText(entry: PiSessionEntrySnapshot): string {
    if (entry.text) return entry.text;
    const raw = entry.raw;
    if (raw && typeof raw === "object") {
        const record = raw as Record<string, unknown>;
        const message = objectOf(record.message);
        if (message.errorMessage) return stringOf(message.errorMessage);
        const error = objectOf(record.error);
        if (error.message) return stringOf(error.message);
        const data = objectOf(record.data);
        const approvalText = [stringOf(data.text), stringOf(data.message), stringOf(data.decision)].filter(Boolean).join(" · ");
        if (approvalText) return approvalText;
        const content = message.content || record.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            return content.flatMap((part) => {
                const text = part && typeof part === "object" ? stringOf((part as { text?: unknown }).text) : "";
                return text ? [text] : [];
            }).join("\n");
        }
        if (record.label) return stringOf(record.label);
    }
    return "";
}

function objectOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOf(value: unknown): string {
    return typeof value === "string" ? value : "";
}

export function AgentCompactionCard({ item, readSessionEntries, theme = canvasThemes.light }: { item: AgentChatItem; readSessionEntries: ReadSessionEntries; theme?: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const { t } = useTranslation();
    const detail = detailOf(item);
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [entries, setEntries] = useState<PiSessionEntrySnapshot[]>([]);
    const requestSeqRef = useRef(0);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            requestSeqRef.current += 1;
        };
    }, []);

    const toggle = () => {
        if (open) {
            requestSeqRef.current += 1;
            setOpen(false);
            setLoading(false);
            return;
        }
        setOpen(true);
        if (entries.length) return;
        const request = ++requestSeqRef.current;
        setLoading(true);
        setError("");
        void readSessionEntries(item.threadId || "", detail.range)
            .then((result) => {
                if (!mountedRef.current || request !== requestSeqRef.current) return;
                setEntries(result);
                setError("");
            })
            .catch((cause: unknown) => {
                if (!mountedRef.current || request !== requestSeqRef.current) return;
                setError(cause instanceof Error ? cause.message : String(cause));
            })
            .finally(() => {
                if (!mountedRef.current || request !== requestSeqRef.current) return;
                setLoading(false);
            });
    };

    const reasonLabel = detail.reason === "threshold"
        ? t("agent.compaction.reasonThreshold", "自动压缩")
        : detail.reason === "overflow"
            ? t("agent.compaction.reasonOverflow", "溢出压缩")
            : t("agent.compaction.reasonManual", "手动压缩");
    const savedTokens = Math.max(0, detail.tokensBefore - (detail.tokensAfter ?? 0));
    const statusLabel = detail.status === "running"
        ? t("agent.compaction.running", "压缩中…")
        : detail.status === "failed"
            ? t("agent.compaction.failed", "压缩失败")
            : detail.status === "aborted"
                ? t("agent.compaction.aborted", "已中断")
                : reasonLabel;

    return (
        <div className="min-w-0 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel }}>
            <div className="flex min-w-0 flex-wrap items-center gap-2" style={{ color: theme.node.muted }}>
                <Archive className="size-3.5 shrink-0" />
                <span className="font-medium" style={{ color: theme.node.text }}>{t("agent.compaction.title", "对话已压缩")}</span>
                <span>{statusLabel}</span>
                {detail.status === "completed" ? <span className="rounded px-1.5 py-0.5" style={{ background: theme.node.fill, color: theme.node.text }}>{t("agent.compaction.included", "已纳入摘要")}</span> : null}
                {savedTokens > 0 ? <span className="tabular-nums">{t("agent.compaction.tokensSaved", "减少 {{count}} tokens").replace("{{count}}", savedTokens.toLocaleString())}</span> : null}
                <button
                    type="button"
                    onClick={toggle}
                    aria-expanded={open}
                    className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition hover:opacity-80"
                    style={{ color: theme.node.text }}
                >
                    {loading ? <Loader2 className="size-3.5 animate-spin" /> : open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    {open ? t("agent.compaction.hideOriginal", "收起原文") : t("agent.compaction.viewOriginal", "查看原文")}
                </button>
            </div>
            <p className="mt-1.5 whitespace-pre-wrap break-words" style={{ color: theme.node.text }}>{detail.summary || item.text}</p>
            {detail.error ? <p className="mt-1" style={{ color: theme.node.muted }}>{detail.error}</p> : null}
            {open ? (
                <div className="mt-2 flex flex-col gap-2 border-t pt-2" style={{ borderColor: theme.node.stroke }}>
                    {error ? <p style={{ color: theme.node.muted }}>{t("agent.compaction.readFailed", "原文读取失败：{{message}}").replace("{{message}}", error)}</p> : null}
                    {loading && !entries.length ? <p style={{ color: theme.node.muted }}>{t("agent.compaction.loading", "读取原文…")}</p> : null}
                    {entries.map((entry) => (
                        <div key={entry.id} className="min-w-0">
                            <div className="text-[11px] font-medium" style={{ color: theme.node.muted }}>{entryRoleLabel(entry, (key, defaultValue) => t(key, defaultValue))}</div>
                            <div className="whitespace-pre-wrap break-words" style={{ color: theme.node.text }}>{entryText(entry)}</div>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}
