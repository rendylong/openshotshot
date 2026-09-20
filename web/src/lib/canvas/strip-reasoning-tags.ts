// 画布文本生成边界专用：移除模型输出的 <think>…</think> 推理段（可靠性 spec §6）。
// Agent 对话链路不使用此函数。
export function stripReasoningTags(input: string): string {
    if (!input.includes("<think>")) return input;
    const withoutClosed = input.replace(/<think>[\s\S]*?<\/think>/g, "");
    const openIndex = withoutClosed.indexOf("<think>");
    let result: string;
    if (openIndex < 0) {
        result = withoutClosed;
    } else {
        const afterOpen = withoutClosed.slice(openIndex + "<think>".length);
        // 未闭合且其后有正文（换行后仍有内容，无法判定推理边界）：保守保留原文；其后无正文（同行尾巴视为推理）：整段移除。
        result = afterOpen.includes("\n") ? input : withoutClosed.slice(0, openIndex);
    }
    return result.trim() ? result : input;
}
