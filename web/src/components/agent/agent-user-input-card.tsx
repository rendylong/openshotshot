import { useEffect, useState } from "react";
import { Check, CornerDownLeft, MessageCircleQuestion } from "lucide-react";
import { Button } from "antd";
import { useTranslation } from "react-i18next";

import type {
    AgentUserFormAnswer,
    AgentUserFormQuestion,
    AgentUserInputRequest,
    AgentUserInputResponse,
} from "@/lib/agent/pi-agent-types";

type FormDraft = { selected: string[]; custom: boolean; customText: string; text: string; comment: string };

const inputClass =
    "block w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm leading-5 text-card-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-45 disabled:cursor-default";

function draftFromQuestion(question: AgentUserFormQuestion): FormDraft {
    const draft: FormDraft = { selected: [], custom: false, customText: "", text: "", comment: "" };
    if (question.type === "text" && typeof question.default === "string") draft.text = question.default;
    if (question.type === "checkbox" && Array.isArray(question.default)) draft.selected = [...question.default];
    if (question.type === "radio" && typeof question.default === "string" && question.options.some((option) => option.value === question.default)) {
        draft.selected = [question.default];
    }
    return draft;
}

function seedDrafts(questions: AgentUserFormQuestion[]): Record<string, FormDraft> {
    return Object.fromEntries(questions.map((question) => [question.id, draftFromQuestion(question)]));
}

export function AgentUserInputCard({
    request,
    onRespond,
}: {
    request: AgentUserInputRequest;
    onRespond: (response: AgentUserInputResponse) => void | Promise<void>;
}) {
    const { t } = useTranslation();
    const [value, setValue] = useState("");
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        setValue("");
        setSubmitting(false);
    }, [request.requestId]);

    const submit = async (response: AgentUserInputResponse) => {
        if (submitting) return;
        setSubmitting(true);
        try {
            await onRespond(response);
        } catch {
            setSubmitting(false);
        }
    };

    const canContinue = request.method !== "select" || Boolean(value);
    const headingId = `question-${request.requestId}`;
    const headingText = request.method === "form" ? request.title || t("agent.userInput.formTitle") : request.title;
    return (
        <section
            className="min-w-0 overflow-hidden rounded-xl border border-border bg-card text-card-foreground"
            aria-labelledby={headingId}
        >
            <header className="flex min-h-11 items-center gap-2 px-3.5">
                <MessageCircleQuestion size={15} strokeWidth={1.9} className="flex-none text-muted-foreground" aria-hidden />
                <span id={headingId} className="min-w-0 text-sm font-semibold leading-5">{headingText}</span>
            </header>

            {request.method === "select" ? (
                <div className="grid gap-1.5 px-3 pb-3" role="radiogroup" aria-label={request.title}>
                    {request.options.map((option, index) => (
                        <QuestionOption
                            key={option}
                            multi={false}
                            letter={String.fromCharCode(65 + index)}
                            label={option}
                            selected={value === option}
                            disabled={submitting}
                            onClick={() => setValue(option)}
                        />
                    ))}
                </div>
            ) : request.method === "input" ? (
                <div className="px-3 pb-3">
                    <textarea
                        className={inputClass}
                        value={value}
                        placeholder={request.placeholder}
                        onChange={(event) => setValue(event.target.value)}
                        disabled={submitting}
                        rows={3}
                        autoFocus
                    />
                </div>
            ) : request.method === "form" ? (
                <AgentUserForm key={request.requestId} request={request} submitting={submitting} onSubmit={(response) => void submit(response)} />
            ) : (
                <p className="px-3.5 pb-3 text-sm leading-5 text-muted-foreground">{request.message}</p>
            )}

            {request.method !== "form" ? (
                <footer className="flex justify-end gap-1.5 border-t border-border px-3 py-2.5">
                    <Button type="text" className="h-8" disabled={submitting} onClick={() => void submit({ cancelled: true })}>
                        {t("agent.userInput.skip")}
                    </Button>
                    {request.method === "confirm" ? (
                        <Button type="primary" className="h-8" disabled={submitting} onClick={() => void submit({ confirmed: true })}>
                            {t("agent.userInput.confirm")}
                            <CornerDownLeft size={12} aria-hidden />
                        </Button>
                    ) : (
                        <Button type="primary" className="h-8" disabled={submitting || !canContinue} onClick={() => void submit({ value })}>
                            {t("agent.userInput.continue")}
                            <CornerDownLeft size={12} aria-hidden />
                        </Button>
                    )}
                </footer>
            ) : null}
        </section>
    );
}

/** 表单分支：key=requestId 挂在调用处，默认值只在请求更换时播种一次。 */
function AgentUserForm({
    request,
    submitting,
    onSubmit,
}: {
    request: Extract<AgentUserInputRequest, { method: "form" }>;
    submitting: boolean;
    onSubmit: (response: AgentUserInputResponse) => void;
}) {
    const { t } = useTranslation();
    const [drafts, setDrafts] = useState<Record<string, FormDraft>>(() => seedDrafts(request.questions));

    const updateDraft = (questionId: string, patch: Partial<FormDraft> | ((draft: FormDraft) => Partial<FormDraft>)) =>
        setDrafts((current) => {
            const draft = current[questionId] ?? { selected: [], custom: false, customText: "", text: "", comment: "" };
            const resolved = typeof patch === "function" ? patch(draft) : patch;
            return { ...current, [questionId]: { ...draft, ...resolved } };
        });

    // 必填门控与上游一致：勾选「其他」即视为作答（空白提交 = 请求换问法的逃生通道），不强制文本非空。
    const ready = request.questions.every((question) => {
        if (!question.required) return true;
        const draft = drafts[question.id];
        if (!draft) return false;
        if (question.type === "text") return Boolean(draft.text.trim());
        return draft.selected.length > 0 || draft.custom;
    });

    const submitForm = () => {
        const answers: AgentUserFormAnswer[] = request.questions.map((question) => {
            const draft = drafts[question.id] ?? { selected: [], custom: false, customText: "", text: "", comment: "" };
            if (question.type === "text") {
                const text = draft.text.trim();
                return { questionId: question.id, values: text ? [text] : [] };
            }
            return {
                questionId: question.id,
                values: draft.selected,
                ...(draft.custom ? { customText: draft.customText } : {}),
                ...(draft.comment.trim() ? { comment: draft.comment.trim() } : {}),
            };
        });
        onSubmit({ answers });
    };

    return (
        <>
            {request.description ? <p className="-mt-1 px-3.5 pb-2 text-xs leading-4 text-muted-foreground">{request.description}</p> : null}
            <div className="flex flex-col gap-3 px-3 pb-3">
                {request.questions.map((question) => (
                    <FormQuestion
                        key={question.id}
                        question={question}
                        draft={drafts[question.id] ?? { selected: [], custom: false, customText: "", text: "", comment: "" }}
                        disabled={submitting}
                        onChange={(patch) => updateDraft(question.id, patch)}
                    />
                ))}
            </div>
            <footer className="flex justify-end gap-1.5 border-t border-border px-3 py-2.5">
                <Button type="text" className="h-8" disabled={submitting} onClick={() => onSubmit({ cancelled: true })}>
                    {t("agent.userInput.skip")}
                </Button>
                <Button type="primary" className="h-8" disabled={submitting || !ready} onClick={submitForm}>
                    {t("agent.userInput.continue")}
                    <CornerDownLeft size={12} aria-hidden />
                </Button>
            </footer>
        </>
    );
}

function FormQuestion({
    question,
    draft,
    disabled,
    onChange,
}: {
    question: AgentUserFormQuestion;
    draft: FormDraft;
    disabled: boolean;
    onChange: (patch: Partial<FormDraft> | ((draft: FormDraft) => Partial<FormDraft>)) => void;
}) {
    const { t } = useTranslation();
    return (
        <div className="min-w-0">
            <div className="mb-1.5 flex items-baseline gap-1 text-sm leading-5">
                <span className="min-w-0 break-words">{question.prompt}</span>
                {question.required ? (
                    <span className="flex-none text-danger" title={t("agent.userInput.required")}>*</span>
                ) : null}
            </div>

            {question.type === "text" ? (
                <textarea
                    className={inputClass}
                    value={draft.text}
                    placeholder={question.placeholder}
                    onChange={(event) => onChange({ text: event.target.value })}
                    disabled={disabled}
                    rows={3}
                />
            ) : (
                <div
                    role={question.type === "radio" ? "radiogroup" : "group"}
                    aria-label={question.prompt}
                    className="grid gap-1.5"
                >
                    {question.options.map((option, index) => {
                        const selected = draft.selected.includes(option.value);
                        return (
                            <QuestionOption
                                key={option.value}
                                multi={question.type === "checkbox"}
                                letter={String.fromCharCode(65 + index)}
                                label={option.label}
                                description={option.description}
                                selected={selected}
                                disabled={disabled}
                                onClick={() => {
                                    if (question.type === "radio") {
                                        onChange({ selected: [option.value], custom: false });
                                    } else {
                                        onChange((draft) => ({
                                            selected: draft.selected.includes(option.value)
                                                ? draft.selected.filter((value) => value !== option.value)
                                                : [...draft.selected, option.value],
                                        }));
                                    }
                                }}
                            />
                        );
                    })}
                    {question.allowOther ? (
                        <>
                            <QuestionOption
                                multi={question.type === "checkbox"}
                                letter={String.fromCharCode(65 + question.options.length)}
                                label={t("agent.userInput.other")}
                                selected={draft.custom}
                                disabled={disabled}
                                onClick={() => {
                                    if (question.type === "radio") onChange((draft) => ({ selected: [], custom: !draft.custom }));
                                    else onChange((draft) => ({ custom: !draft.custom }));
                                }}
                            />
                            {draft.custom ? (
                                <textarea
                                    className={inputClass}
                                    value={draft.customText}
                                    placeholder={t("agent.userInput.otherPlaceholder")}
                                    onChange={(event) => onChange({ customText: event.target.value })}
                                    disabled={disabled}
                                    rows={2}
                                    autoFocus
                                />
                            ) : null}
                        </>
                    ) : null}
                </div>
            )}

            {question.allowComment ? (
                <textarea
                    className={`${inputClass} mt-1.5`}
                    value={draft.comment}
                    placeholder={t("agent.userInput.commentPlaceholder")}
                    aria-label={t("agent.userInput.comment")}
                    onChange={(event) => onChange({ comment: event.target.value })}
                    disabled={disabled}
                    rows={2}
                />
            ) : null}
        </div>
    );
}

function QuestionOption({
    multi,
    letter,
    label,
    description,
    selected,
    disabled,
    onClick,
}: {
    multi: boolean;
    letter: string;
    label: string;
    description?: string;
    selected: boolean;
    disabled: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            role={multi ? "checkbox" : "radio"}
            aria-checked={selected}
            onClick={onClick}
            disabled={disabled}
            className={`flex min-h-9 w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors disabled:cursor-default disabled:opacity-45 ${
                selected ? "border-foreground bg-foreground text-background" : "border-border hover:bg-accent"
            }`}
        >
            <span
                aria-hidden
                className={`grid size-5 flex-none place-items-center rounded-md text-[10px] ${
                    selected ? "bg-background/20 text-background" : "bg-muted text-muted-foreground"
                }`}
            >
                {multi && selected ? <Check className="size-3" /> : letter}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block leading-5">{label}</span>
                {description ? (
                    <span className={`mt-0.5 block text-xs leading-4 ${selected ? "text-background/70" : "text-muted-foreground"}`}>{description}</span>
                ) : null}
            </span>
        </button>
    );
}
