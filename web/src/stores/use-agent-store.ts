import { create } from "zustand";
import i18n from "@/i18n";

import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasOpReceipt } from "@/lib/canvas/canvas-agent-op-types";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { CanvasNodeData } from "@/types/canvas";
import type { AgentApprovalDecision, AgentApprovalMode, AgentFileContent } from "@/lib/agent/pi-agent-types";
import type { AgentAttachmentKind } from "@/lib/agent/agent-attachments";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";

export type AgentChatRole = "user" | "assistant" | "system" | "tool" | "error" | "compaction";
// assetRef/relativePath 是发送时写入项目资产后的持久身份；旧历史没有这两个字段也能照常加载。
export type AgentAttachment = { id: string; handle?: string; name: string; type?: string; kind?: AgentAttachmentKind; mimeType?: string; size: number; width?: number; height?: number; url: string; dataUrl: string; sourcePath?: string; assetRef?: CanvasAssetRef; relativePath?: string };
export type AgentMessageAttachment = Pick<AgentAttachment, "id" | "name" | "url"> & Partial<Pick<AgentAttachment, "handle" | "type" | "kind" | "mimeType" | "size" | "width" | "height" | "dataUrl" | "assetRef" | "relativePath">>;
export type AgentCanvasReference = Pick<CanvasResourceReference, "nodeId" | "label" | "title" | "kind" | "previewUrl" | "text">;
export type AgentChatItem = { id: string; itemId?: string; clientMessageId?: string; threadId?: string; turnId?: string; role: AgentChatRole; title?: string; text: string; meta?: string; detail?: unknown; attachments?: AgentMessageAttachment[]; canvasReferences?: AgentCanvasReference[]; streamId?: string; activityItems?: Record<string, string>; startedAt?: number; completedAt?: number; durationMs?: number };
export type AgentCompactionDetail = {
    kind: "compaction";
    status: "running" | "completed" | "failed" | "aborted";
    reason: "manual" | "threshold" | "overflow";
    summary: string;
    tokensBefore: number;
    tokensAfter?: number;
    range?: { fromEntryId: string; toEntryId: string };
    error?: string;
};
export type AgentEventLog = { id: string; time: string; title: string; text: string; raw?: unknown };
export type AgentPendingToolCall = { requestId: string; name: string; input?: { ops?: CanvasAgentOp[]; path?: string } & Record<string, unknown> };
export type AgentPermissionMode = "request" | "automatic" | "full";
export type AgentReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type AgentModel = {
    id: string;
    model: string;
    displayName: string;
    defaultReasoningEffort: AgentReasoningEffort;
    supportedReasoningEfforts: Array<{ reasoningEffort: AgentReasoningEffort; description?: string }>;
    isDefault?: boolean;
};
export type { AgentApprovalDecision } from "@/lib/agent/pi-agent-types";
export type AgentPendingApproval = { requestId: string; method: string; threadId?: string; turnId?: string; itemId?: string; reason?: string; command?: unknown; cwd?: string; grantRoot?: string; networkApprovalContext?: unknown; permissions?: unknown; deciding?: AgentApprovalDecision };
export type AgentCanvasContext = { snapshot: CanvasAgentSnapshot; applyOps: (ops?: CanvasAgentOp[]) => Promise<CanvasAgentSnapshot & { receipts: CanvasOpReceipt[] }>; undoOps: () => CanvasAgentSnapshot | null; canUndo: boolean; importAttachment?: (attachment: AgentFileContent) => Promise<CanvasNodeData | null> };
export type AgentTokenUsage = { input: number; cached: number; output: number };
export type PiAgentLifecycle = { completedAssistantKey: string; historyRestoreRevision: number };

type AgentStore = {
    width: number;
    panelOpen: boolean;
    panelMounted: boolean;
    panelClosing: boolean;
    /** True while the header grip is held, lifting the panel off the canvas. */
    panelGrabbed: boolean;
    canvasContext: AgentCanvasContext | null;
    prompt: string;
    pendingAttachments: AgentAttachment[];
    canvasReferences: CanvasResourceReference[];
    submitRequest: { nonce: number } | null;
    sending: boolean;
    waiting: boolean;
    messages: AgentChatItem[];
    piLifecycle: PiAgentLifecycle;
    tokenUsage: AgentTokenUsage | null;
    eventLogs: AgentEventLog[];
    activity: string;
    connectError: string;
    /** codex 式审批模式：confirm_changes 下 bash/edit/write 逐次确认，full_access 直接放行。 */
    approvalMode: AgentApprovalMode;
    setAgentState: (patch: Partial<Omit<AgentStore, "setAgentState" | "addEventLog" | "clearEventLogs" | "openPanel" | "closePanel" | "togglePanel" | "setCanvasContext" | "submitPrompt">>) => void;
    openPanel: () => void;
    closePanel: () => void;
    togglePanel: () => void;
    submitPrompt: (text: string, attachments?: AgentAttachment[]) => void;
    setCanvasContext: (context: AgentCanvasContext | null) => void;
    addEventLog: (item: AgentEventLog) => void;
    clearEventLogs: () => void;
};

export const CANVAS_AGENT_PANEL_MOTION_MS = 500;

export const useAgentStore = create<AgentStore>((set, get) => ({
    width: typeof window === "undefined" ? 440 : Number(localStorage.getItem("canvas-agent-panel-width")) || 440,
    panelOpen: true,
    panelMounted: true,
    panelClosing: false,
    panelGrabbed: false,
    canvasContext: null,
    prompt: "",
    pendingAttachments: [],
    canvasReferences: [],
    submitRequest: null,
    sending: false,
    waiting: false,
    messages: [],
    piLifecycle: { completedAssistantKey: "", historyRestoreRevision: 0 },
    tokenUsage: null,
    eventLogs: [],
    activity: i18n.t("agent.state.ready"),
    connectError: "",
    approvalMode: "confirm_changes",
    setAgentState: (patch) => set(patch),
    openPanel: () => set({ panelOpen: true, panelMounted: true, panelClosing: false }),
    closePanel: () => {
        if (!get().panelMounted || get().panelClosing) return;
        set({ panelOpen: false, panelClosing: true });
        setTimeout(() => {
            if (get().panelClosing) set({ panelClosing: false });
        }, CANVAS_AGENT_PANEL_MOTION_MS);
    },
    togglePanel: () => (get().panelOpen ? get().closePanel() : get().openPanel()),
    submitPrompt: (text, pendingAttachments = []) => set({ prompt: text, pendingAttachments, panelOpen: true, panelMounted: true, panelClosing: false, submitRequest: { nonce: Date.now() + Math.random() } }),
    setCanvasContext: (canvasContext) => set({ canvasContext }),
    addEventLog: (item) => set((state) => ({ eventLogs: [...state.eventLogs.slice(-160), item] })),
    clearEventLogs: () => set({ eventLogs: [] }),
}));
