import type { AgentApprovalEvent, AgentApprovalMode, AgentApprovalRequest, AgentUserFormOption, AgentUserFormQuestion, AgentUserInputEvent, AgentUserInputRequest, PiSessionEnvelope, PiSessionEntryRange, PiSessionScope, PiSessionStatus } from "./pi-agent-types";

/**
 * 跨 IPC 边界的 sessionId 契约 helper。
 *
 * 主进程 handler 消费 renderer 输入、renderer 消费主进程推送事件前，都必须先用这里的
 * parser 做结构校验；返回 `null` 一律视为非法输入，不做部分降级解析。
 */

/** 与 SDK `assertValidSessionId` 相同的规则：非空，`[A-Za-z0-9._-]`，首尾必须是字母或数字。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export const PI_SESSION_STATUSES: readonly PiSessionStatus[] = [
    "idle",
    "running",
    "queued",
    "waiting_approval",
    "waiting_input",
    "compacting",
    "interrupted",
    "error",
];

export const PI_SESSION_ENVELOPE_KINDS: readonly PiSessionEnvelope["kind"][] = [
    "agent",
    "ops",
    "attachment_import",
    "user_input",
    "approval_request",
    "session_compact_failed",
    "error",
];

const PI_SESSION_STATUS_SET: ReadonlySet<string> = new Set(PI_SESSION_STATUSES);

function isPiSessionEnvelopeKind(value: unknown): value is PiSessionEnvelope["kind"] {
    return typeof value === "string" && (PI_SESSION_ENVELOPE_KINDS as readonly string[]).includes(value);
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
    return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function isNonEmptyString(raw: unknown): raw is string {
    return typeof raw === "string" && raw.length > 0;
}

/** 校验 SDK 兼容的 sessionId（pi 使用 UUIDv7，这里只锁定字符集与首尾规则）。 */
export function isValidSessionId(value: unknown): value is string {
    return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export function isPiSessionStatus(value: unknown): value is PiSessionStatus {
    return typeof value === "string" && PI_SESSION_STATUS_SET.has(value);
}

const AGENT_USER_FORM_TYPES: ReadonlySet<string> = new Set(["radio", "checkbox", "text"]);

/** 校验单个表单选项；主进程发送前已经过 npm 扩展 normalize，必选字段恒在。 */
function parseAgentUserFormOption(raw: unknown): AgentUserFormOption | null {
    if (!isPlainObject(raw) || typeof raw.value !== "string" || typeof raw.label !== "string") return null;
    if (raw.description !== undefined && typeof raw.description !== "string") return null;
    return { value: raw.value, label: raw.label, ...(raw.description === undefined ? {} : { description: raw.description }) };
}

/** 校验单个表单题目：id/prompt/label、题目类型、选项与布尔开关齐全，placeholder/default 类型受限。 */
function parseAgentUserFormQuestion(raw: unknown): AgentUserFormQuestion | null {
    if (!isPlainObject(raw) || !isNonEmptyString(raw.id) || typeof raw.prompt !== "string" || typeof raw.label !== "string") return null;
    if (typeof raw.type !== "string" || !AGENT_USER_FORM_TYPES.has(raw.type)) return null;
    if (!Array.isArray(raw.options)) return null;
    const options: AgentUserFormOption[] = [];
    for (const option of raw.options) {
        const parsed = parseAgentUserFormOption(option);
        if (!parsed) return null;
        options.push(parsed);
    }
    if (typeof raw.allowOther !== "boolean" || typeof raw.allowComment !== "boolean" || typeof raw.required !== "boolean") return null;
    if (raw.placeholder !== undefined && typeof raw.placeholder !== "string") return null;
    const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
    const defaultValue = typeof raw.default === "string" || isStringArray(raw.default) ? raw.default : undefined;
    if (raw.default !== undefined && defaultValue === undefined) return null;
    return {
        id: raw.id,
        type: raw.type as AgentUserFormQuestion["type"],
        prompt: raw.prompt,
        label: raw.label,
        options,
        allowOther: raw.allowOther,
        allowComment: raw.allowComment,
        required: raw.required,
        ...(raw.placeholder === undefined ? {} : { placeholder: raw.placeholder }),
        ...(defaultValue === undefined ? {} : { default: defaultValue }),
    };
}

function parseAgentUserInputRequest(raw: unknown): AgentUserInputRequest | null {
    if (!isPlainObject(raw) || !isNonEmptyString(raw.requestId)) return null;
    if (raw.method === "form") {
        if ((raw.title !== undefined && !isNonEmptyString(raw.title)) || (raw.description !== undefined && !isNonEmptyString(raw.description))) return null;
        if (!Array.isArray(raw.questions) || !raw.questions.length) return null;
        const questions: AgentUserFormQuestion[] = [];
        for (const question of raw.questions) {
            const parsed = parseAgentUserFormQuestion(question);
            if (!parsed) return null;
            questions.push(parsed);
        }
        return {
            requestId: raw.requestId,
            method: "form",
            ...(raw.title === undefined ? {} : { title: raw.title }),
            ...(raw.description === undefined ? {} : { description: raw.description }),
            questions,
        };
    }
    if (!isNonEmptyString(raw.title)) return null;
    if (raw.method === "select") {
        if (!Array.isArray(raw.options) || !raw.options.every(isNonEmptyString)) return null;
        return { requestId: raw.requestId, method: "select", title: raw.title, options: [...raw.options] };
    }
    if (raw.method === "input") {
        if (raw.placeholder !== undefined && typeof raw.placeholder !== "string") return null;
        return { requestId: raw.requestId, method: "input", title: raw.title, ...(raw.placeholder === undefined ? {} : { placeholder: raw.placeholder }) };
    }
    if (raw.method === "confirm" && typeof raw.message === "string") {
        return { requestId: raw.requestId, method: "confirm", title: raw.title, message: raw.message };
    }
    return null;
}

export function parseAgentUserInputEvent(raw: unknown): AgentUserInputEvent | null {
    if (!isPlainObject(raw)) return null;
    if (raw.type === "resolved" && isNonEmptyString(raw.requestId)) return { type: "resolved", requestId: raw.requestId };
    if (raw.type !== "request") return null;
    const request = parseAgentUserInputRequest(raw.request);
    return request ? { type: "request", request } : null;
}

export function isAgentApprovalMode(value: unknown): value is AgentApprovalMode {
    return value === "confirm_changes" || value === "full_access";
}

export function parseAgentApprovalEvent(raw: unknown): AgentApprovalEvent | null {
    if (!isPlainObject(raw)) return null;
    if (raw.type === "resolved" && isNonEmptyString(raw.requestId)) return { type: "resolved", requestId: raw.requestId };
    if (raw.type !== "request" || !isNonEmptyString(raw.requestId) || !isPlainObject(raw.approval)) return null;
    const source = raw.approval;
    const reason = isNonEmptyString(source.reason) ? source.reason : undefined;
    if (source.method === "exec/command/requestApproval" && isNonEmptyString(source.command)) {
        // cwd 仅 bash 审批携带（工作目录），非空字符串才透传。
        const cwd = isNonEmptyString(source.cwd) ? source.cwd : undefined;
        const approval: Omit<AgentApprovalRequest, "requestId"> = {
            method: source.method,
            command: source.command,
            ...(cwd ? { cwd } : {}),
            ...(reason ? { reason } : {}),
        };
        return { type: "request", requestId: raw.requestId, approval };
    }
    if (source.method === "item/fileChange/requestApproval" && isNonEmptyString(source.path)) {
        const approval: Omit<AgentApprovalRequest, "requestId"> = {
            method: source.method,
            path: source.path,
            ...(reason ? { reason } : {}),
        };
        return { type: "request", requestId: raw.requestId, approval };
    }
    return null;
}

function hasQueueItems(payload: unknown): boolean | null {
    if (!isPlainObject(payload)) return null;
    const { followUp, steering } = payload;
    if (!Array.isArray(followUp) || !Array.isArray(steering)) return null;
    return followUp.length > 0 || steering.length > 0;
}

/**
 * Session runtime 与 renderer 共用的事件状态映射。
 *
 * `queue_update` 只有在两个队列都真实可读时才判定；malformed payload 返回 null，
 * 让调用方保留现有状态而不是猜测 idle/queued。
 */
export function sessionStatusFromAgentEvent(kind: PiSessionEnvelope["kind"], type: string, payload: unknown): PiSessionStatus | null {
    if (kind === "error" || kind === "session_compact_failed") return "error";
    if (kind !== "agent") return null;
    if (type === "agent_start" || type === "turn_start") return "running";
    if (type === "compaction_start") return "compacting";
    if (type === "compaction_end") return "idle";
    if (type === "agent_end") {
        return isPlainObject(payload) && payload.willRetry === true ? "running" : "idle";
    }
    if (type === "agent_settled") return "idle";
    if (type === "queue_update") {
        const queued = hasQueueItems(payload);
        return queued === null ? null : queued ? "queued" : "idle";
    }
    return null;
}

/** 校验 `PiSessionScope` 输入，返回只含 `projectId` / `canvasId` 的纯净投影。 */
export function parseSessionScope(raw: unknown): PiSessionScope | null {
    if (!isPlainObject(raw)) return null;
    const { projectId, canvasId } = raw;
    // 会话必须归属具体画布；skill 对话使用未分类画布（__uncategorized__），不允许空 scope。
    if (!isNonEmptyString(projectId) || !isNonEmptyString(canvasId)) return null;
    return { projectId, canvasId };
}

/** 校验 `readSessionEntries` 的可选 range 输入；`undefined` / 空对象为合法全量读取（`{}`）。 */
export function parseSessionEntryRange(raw: unknown): PiSessionEntryRange | null {
    if (raw === undefined) return {};
    if (!isPlainObject(raw)) return null;
    const { fromEntryId, toEntryId } = raw;
    if (fromEntryId !== undefined && !isNonEmptyString(fromEntryId)) return null;
    if (toEntryId !== undefined && !isNonEmptyString(toEntryId)) return null;
    return {
        ...(fromEntryId !== undefined ? { fromEntryId } : {}),
        ...(toEntryId !== undefined ? { toEntryId } : {}),
    };
}

/**
 * 校验主进程推送给 renderer 的事件 envelope。
 *
 * payload 只做「存在且非 null」的结构校验，按 kind 的深校验由各消费方
 * （Task 6 投影层）负责；这里不复制 SDK 事件 schema。
 */
export function parseSessionEnvelope(raw: unknown): PiSessionEnvelope | null {
    if (!isPlainObject(raw)) return null;
    const { sessionId, kind, payload } = raw;
    if (!isValidSessionId(sessionId)) return null;
    if (!isPiSessionEnvelopeKind(kind)) return null;
    if (payload === undefined || payload === null) return null;
    return { sessionId, kind, payload };
}
