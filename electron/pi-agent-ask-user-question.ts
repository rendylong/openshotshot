import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import askUserQuestion from "pi-mono-ask-user-question/index";
import {
    customValue,
    normalize,
    type Answer,
    type AskUserQuestionInput,
    type FormResult,
    type NormalizedQuestion,
} from "pi-mono-ask-user-question/schema";
import { formatAnswer } from "pi-mono-ask-user-question/state";

import type { AgentUserFormAnswer } from "@/lib/agent/pi-agent-types";

import type { ShotshotExtensionUIContext } from "./pi-extension-ui";

/**
 * 把渲染端表单回答映射回上游 Answer 语义：
 * radio 命中选项存 option.value，未命中（含空白 Other）走 custom/rephrase；
 * checkbox 合并勾选项与自定义输入；comment 非空才附带。
 */
function toAnswers(questions: NormalizedQuestion[], raw: AgentUserFormAnswer[]): Answer[] {
    const byId = new Map(raw.map((item) => [item.questionId, item]));
    return questions.map((question) => {
        const item = byId.get(question.id);
        const comment = item?.comment?.trim();
        const withComment = <T extends Answer>(answer: T): T => (comment ? { ...answer, comment } : answer);

        if (question.type === "text") {
            return withComment({ id: question.id, type: "text", value: item?.values[0]?.trim() ?? "", wasCustom: true });
        }

        const custom = item?.customText !== undefined ? customValue(item.customText) : undefined;
        if (question.type === "radio") {
            const picked = item?.values[0];
            const option = picked !== undefined ? question.options.find((candidate) => candidate.value === picked) : undefined;
            if (option) return withComment({ id: question.id, type: "radio", value: option.value, wasCustom: false });
            if (custom) {
                return withComment({
                    id: question.id,
                    type: "radio",
                    value: custom.value,
                    wasCustom: true,
                    ...(custom.needsRephrase ? { needsRephrase: true } : {}),
                });
            }
            return withComment({ id: question.id, type: "radio", value: "", wasCustom: false });
        }

        const values = (item?.values ?? []).filter((value) => question.options.some((option) => option.value === value));
        if (custom) values.push(custom.value);
        return withComment({
            id: question.id,
            type: "checkbox",
            value: values,
            wasCustom: custom !== undefined,
            ...(custom?.needsRephrase ? { needsRephrase: true } : {}),
        });
    });
}

export const shotshotAskUserQuestion: ExtensionFactory = (pi) => {
    const registerTool = (tool: ToolDefinition<any>) => {
        if (tool.name !== "ask_user_question") {
            (pi.registerTool as (tool: ToolDefinition<any>) => void)(tool);
            return;
        }
        pi.registerTool({
            ...tool,
            async execute(toolCallId, raw, signal, onUpdate, ctx) {
                const form = (ctx.ui as Partial<ShotshotExtensionUIContext>).form;
                const input = raw as AskUserQuestionInput;
                // These paths never reach the UI; delegate so upstream error texts stay authoritative.
                if (!form || !ctx.hasUI || !input.questions.length || signal?.aborted) {
                    return tool.execute(toolCallId, raw, signal, onUpdate, ctx);
                }
                const questions = normalize(input.questions);
                const rawAnswers = await form(input.title, input.description, questions, signal ? { signal } : undefined);
                if (!rawAnswers) {
                    const result: FormResult = { title: input.title, questions, answers: [], cancelled: true };
                    return {
                        content: [{ type: "text", text: signal?.aborted ? "Form aborted" : "User cancelled the form" }],
                        details: result,
                    };
                }
                const answers = toAnswers(questions, rawAnswers);
                const lines = answers.map((answer) =>
                    formatAnswer(answer, questions.find((question) => question.id === answer.id)?.label || answer.id),
                );
                if (answers.some((answer) => answer.needsRephrase)) {
                    lines.push("", "Note: rephrase or split the flagged question(s) instead of asking again as written.");
                }
                const result: FormResult = { title: input.title, questions, answers, cancelled: false };
                return { content: [{ type: "text", text: lines.join("\n") }], details: result };
            },
        });
    };
    return askUserQuestion(new Proxy(pi, {
        get(target, property) {
            if (property === "registerTool") return registerTool;
            return Reflect.get(target, property);
        },
    }) as ExtensionAPI);
};
