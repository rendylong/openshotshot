// electron/pi-agent-memory.ts
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { MEMORY_APPEND_LIMIT, MEMORY_REPLACE_LIMIT, memoryRoot, writeProjectMemory, writeUserMemory } from "./agent-memory";

export const MEMORY_TOOL_NAME = "memory_write";

export const MEMORY_TOOL_SUMMARY = {
    name: MEMORY_TOOL_NAME,
    label: "Memory Write",
    promptSnippet: "用户表达稳定的偏好、约定或项目背景时，把要点保存到长期记忆（level=user 跨项目生效 / level=project 保存到当前项目工作区，仅该项目生效）；保存的内容下次会话生效，禁止保存 API Key、令牌等敏感信息。",
};

export type MemoryExtensionOptions = {
    /** 取当前会话绑定的项目工作区；undefined = 无工作区（project 级写入返回错误文本）。 */
    getWorkspacePath: () => string | undefined;
    /** 仅测试注入；默认 ~/.shotshot/agent/memory（用户记忆目录）。 */
    root?: string;
};

function reply(text: string) {
    return { content: [{ type: "text", text }], details: { text } };
}

export function createShotshotMemoryExtension(options: MemoryExtensionOptions): ExtensionFactory {
    const root = options.root ?? memoryRoot();
    return (pi: ExtensionAPI) => {
        pi.registerTool({
            name: MEMORY_TOOL_NAME,
            label: "Memory Write",
            description: "保存用户偏好或项目背景到长期记忆。level=user 跨项目生效；level=project 保存到当前项目工作区、仅该项目生效。mode=append 追加一条；mode=replace 用 content 整体替换该级记忆（整理去重时用）。保存的内容从下次会话开始生效。",
            promptGuidelines: [MEMORY_TOOL_SUMMARY.promptSnippet],
            parameters: Type.Object({
                level: Type.Union([Type.Literal("user"), Type.Literal("project")]),
                mode: Type.Union([Type.Literal("append"), Type.Literal("replace")]),
                content: Type.String(),
            }),
            async execute(_toolCallId, raw) {
                const params = raw as { level: "user" | "project"; mode: "append" | "replace"; content: string };
                const content = (params.content ?? "").trim();
                if (!content) return reply("错误：content 不能为空。");
                if (params.mode === "append" && content.length > MEMORY_APPEND_LIMIT) {
                    return reply(`错误：append 单次最多 ${MEMORY_APPEND_LIMIT} 字符，请精简后重试，或用 replace 整理。`);
                }
                if (params.mode === "replace" && content.length > MEMORY_REPLACE_LIMIT) {
                    return reply(`错误：replace 最多 ${MEMORY_REPLACE_LIMIT} 字符。`);
                }
                try {
                    if (params.level === "project") {
                        await writeProjectMemory(options.getWorkspacePath() ?? "", { mode: params.mode, content });
                    } else {
                        await writeUserMemory(root, { mode: params.mode, content });
                    }
                } catch (error) {
                    return reply(`错误：${error instanceof Error ? error.message : String(error)}`);
                }
                return reply(`已保存${params.level === "project" ? "项目" : "用户"}记忆（mode=${params.mode}），下次会话生效。内容：\n${content}`);
            },
        } as ToolDefinition<any>);
    };
}
