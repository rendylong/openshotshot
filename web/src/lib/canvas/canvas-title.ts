import { requestAgentTextCompletion } from "@/services/api/agent-text";

const TITLE_MAX_LENGTH = 30;

// 首条提问派生画布标题：保留前 40 字符（超长加省略号），无文本时回退附件名。
// 作为 AI 标题生成失败时的回退，也是首页提交时的占位命名。
export function canvasTitleFromPrompt(text: string, fallback = ""): string {
    const trimmed = text.trim();
    if (!trimmed) return fallback;
    return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed;
}

// 用画布文本模型为首次发问生成简短标题；失败返回 null，由调用方回退到原文截断。
// 仅支持 BYOK 渠道：经 requestAgentTextCompletion 走一次性文本问答，
// 其余来源由其抛出 AgentTitleUnsupportedSourceError 触发回退。
export async function generateCanvasTitle(question: string, signal?: AbortSignal): Promise<string | null> {
    const text = question.trim();
    if (!text) return null;
    const instruction = [
        "为下面的创作请求起一个画布标题。",
        "要求：使用与请求相同的语言；不超过 12 个字；直接输出标题本身，不要引号、句号、前缀或任何解释。",
        `创作请求：${text}`,
    ].join("\n");
    try {
        return sanitizeGeneratedTitle(await requestAgentTextCompletion([{ role: "user", content: instruction }], { signal }));
    } catch {
        return null;
    }
}

export function sanitizeGeneratedTitle(answer: string): string | null {
    const firstLine = answer.replace(/<think>[\s\S]*?<\/think>/gi, "").split("\n").find((line) => line.trim()) || "";
    const title = firstLine
        .replace(/^\s*(标题|画布标题|Title)\s*[:：]\s*/i, "")
        .replace(/^[\s「『"'“”*·•-]+/, "")
        .replace(/[\s」』"'“”*。．.,，、;；:：-]+$/, "")
        .trim()
        .replace(/\s+/g, " ");
    if (!title) return null;
    return title.length > TITLE_MAX_LENGTH ? `${title.slice(0, TITLE_MAX_LENGTH)}…` : title;
}
