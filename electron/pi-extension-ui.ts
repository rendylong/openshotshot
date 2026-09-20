import { randomUUID } from "node:crypto";

import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";

import type { AgentUserFormAnswer, AgentUserFormQuestion, AgentUserInputRequest, AgentUserInputResponse, PiSessionEnvelope } from "@/lib/agent/pi-agent-types";

/** Electron 宿主在标准对话框之外额外暴露的完整表单通道（ask_user_question 使用）。 */
export type AgentUserFormUI = {
    form: (
        title: string | undefined,
        description: string | undefined,
        questions: AgentUserFormQuestion[],
        dialogOptions?: ExtensionUIDialogOptions,
    ) => Promise<AgentUserFormAnswer[] | undefined>;
};

export type ShotshotExtensionUIContext = ExtensionUIContext & AgentUserFormUI;

type PendingRequest = {
    sessionId: string;
    request: AgentUserInputRequest;
    finish: (response?: AgentUserInputResponse) => void;
};

type RequestWithoutId = AgentUserInputRequest extends infer Request
    ? Request extends AgentUserInputRequest ? Omit<Request, "requestId"> : never
    : never;

type BrokerOptions = {
    send: (envelope: PiSessionEnvelope) => void;
    onWaitingChange?: (sessionId: string, waiting: boolean) => void;
    createRequestId?: () => string;
};

export type PiExtensionUIBroker = {
    createContext: (getSessionId: () => string) => ShotshotExtensionUIContext;
    respond: (sessionId: string, requestId: string, response: AgentUserInputResponse) => { ok: true } | { ok: false; error: string };
    disposeSession: (sessionId: string) => void;
    dispose: () => void;
};

function requestKey(sessionId: string, requestId: string): string {
    return `${sessionId}:${requestId}`;
}

export function createPiExtensionUIBroker(options: BrokerOptions): PiExtensionUIBroker {
    const pending = new Map<string, PendingRequest>();
    const createRequestId = options.createRequestId ?? randomUUID;

    const notifyWaiting = (sessionId: string) => {
        const waiting = [...pending.values()].some((entry) => entry.sessionId === sessionId);
        options.onWaitingChange?.(sessionId, waiting);
    };

    const openRequest = <T>(
        getSessionId: () => string,
        request: RequestWithoutId,
        dialogOptions: ExtensionUIDialogOptions | undefined,
        fallback: T,
        parse: (response: AgentUserInputResponse) => T,
    ): Promise<T> => {
        if (dialogOptions?.signal?.aborted) return Promise.resolve(fallback);
        const sessionId = getSessionId();
        const requestId = createRequestId();
        const fullRequest = { ...request, requestId } as AgentUserInputRequest;
        const key = requestKey(sessionId, requestId);

        return new Promise<T>((resolve) => {
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            const cleanup = () => {
                if (timeoutId) clearTimeout(timeoutId);
                dialogOptions?.signal?.removeEventListener("abort", onAbort);
                pending.delete(key);
                options.send({ sessionId, kind: "user_input", payload: { type: "resolved", requestId } });
                notifyWaiting(sessionId);
            };
            const finish = (response?: AgentUserInputResponse) => {
                if (!pending.has(key)) return;
                cleanup();
                resolve(response ? parse(response) : fallback);
            };
            const onAbort = () => finish();

            pending.set(key, { sessionId, request: fullRequest, finish });
            dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });
            if (dialogOptions?.timeout !== undefined && dialogOptions.timeout > 0) {
                timeoutId = setTimeout(onAbort, dialogOptions.timeout);
            }
            options.send({ sessionId, kind: "user_input", payload: { type: "request", request: fullRequest } });
            notifyWaiting(sessionId);
        });
    };

    const createContext = (getSessionId: () => string): ShotshotExtensionUIContext => {
        const context: ShotshotExtensionUIContext = {
            select: (title: string, values: string[], dialogOptions?: ExtensionUIDialogOptions) =>
                openRequest(getSessionId, { method: "select", title, options: values }, dialogOptions, undefined, (response) => "value" in response ? response.value : undefined),
            confirm: (title: string, message: string, dialogOptions?: ExtensionUIDialogOptions) =>
                openRequest(getSessionId, { method: "confirm", title, message }, dialogOptions, false, (response) => "confirmed" in response ? response.confirmed : false),
            input: (title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions) =>
                openRequest(getSessionId, { method: "input", title, ...(placeholder === undefined ? {} : { placeholder }) }, dialogOptions, undefined, (response) => "value" in response ? response.value : undefined),
            notify: () => undefined,
            onTerminalInput: () => () => undefined,
            setStatus: () => undefined,
            setWorkingMessage: () => undefined,
            setWorkingVisible: () => undefined,
            setWorkingIndicator: () => undefined,
            setHiddenThinkingLabel: () => undefined,
            setWidget: () => undefined,
            setFooter: () => undefined,
            setHeader: () => undefined,
            setTitle: () => undefined,
            custom: async <T>() => undefined as T,
            form: (title: string | undefined, description: string | undefined, questions: AgentUserFormQuestion[], dialogOptions?: ExtensionUIDialogOptions) =>
                openRequest(
                    getSessionId,
                    {
                        method: "form",
                        ...(title === undefined ? {} : { title }),
                        ...(description === undefined ? {} : { description }),
                        questions,
                    },
                    dialogOptions,
                    undefined,
                    (response) => ("answers" in response ? response.answers : undefined),
                ),
            pasteToEditor: () => undefined,
            setEditorText: () => undefined,
            getEditorText: () => "",
            editor: (title: string, prefill?: string): Promise<string | undefined> => context.input(title, prefill),
            addAutocompleteProvider: () => undefined,
            setEditorComponent: () => undefined,
            getEditorComponent: () => undefined,
            theme: {} as ExtensionUIContext["theme"],
            getAllThemes: () => [],
            getTheme: () => undefined,
            setTheme: () => ({ success: false, error: "Theme switching is unavailable in the Electron host" }),
            getToolsExpanded: () => false,
            setToolsExpanded: () => undefined,
        };
        return context;
    };

    type AgentUserFormAnswers = Extract<AgentUserInputResponse, { answers: AgentUserFormAnswer[] }>;

    /** form 回答校验：题目存在、值合法；radio/checkbox 的 values 必须是选项 value，text 只要求字符串。 */
    function isValidFormResponse(questions: AgentUserFormQuestion[], response: AgentUserInputResponse): response is AgentUserFormAnswers {
        if (!("answers" in response) || !Array.isArray(response.answers)) return false;
        const byId = new Map(questions.map((question) => [question.id, question]));
        return response.answers.every((answer) => {
            const question = byId.get(answer?.questionId);
            if (!question || !Array.isArray(answer.values)) return false;
            if (question.type === "radio" && answer.values.length > 1) return false;
            const knownValues = new Set(question.options.map((option) => option.value));
            if (!answer.values.every((value) => typeof value === "string" && (question.type === "text" || knownValues.has(value)))) return false;
            if (answer.customText !== undefined && typeof answer.customText !== "string") return false;
            if (answer.comment !== undefined && typeof answer.comment !== "string") return false;
            return true;
        });
    }

    const respond: PiExtensionUIBroker["respond"] = (sessionId, requestId, response) => {
        const entry = pending.get(requestKey(sessionId, requestId));
        if (!entry) return { ok: false, error: "用户输入请求不存在或已结束" };
        if ("cancelled" in response) {
            entry.finish(response);
            return { ok: true };
        }
        if (entry.request.method === "select") {
            if (!("value" in response) || !entry.request.options.includes(response.value)) return { ok: false, error: "非法用户选项" };
        } else if (entry.request.method === "input") {
            if (!("value" in response)) return { ok: false, error: "非法用户输入" };
        } else if (entry.request.method === "form") {
            if (!isValidFormResponse(entry.request.questions, response)) return { ok: false, error: "非法用户表单回答" };
        } else if (!("confirmed" in response)) {
            return { ok: false, error: "非法用户确认" };
        }
        entry.finish(response);
        return { ok: true };
    };

    const disposeSession = (sessionId: string) => {        [...pending.values()].filter((entry) => entry.sessionId === sessionId).forEach((entry) => entry.finish());
    };

    return {
        createContext,
        respond,
        disposeSession,
        dispose: () => [...pending.values()].forEach((entry) => entry.finish()),
    };
}
