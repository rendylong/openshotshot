import type { PiAgentPromptFile, PiAgentPromptInput } from "@/lib/agent/pi-agent-types";
import { normalizeSkillCommand } from "@/lib/skills/skill-format";
import type { SkillRuntime } from "./skill-runtime";

const DEFAULT_SYSTEM_PROMPT =
    "你是 shotshot 画布 agent。可以用画布工具新建/修改节点、发起生成、读写画布状态。先读状态再操作，操作后用中文简要说明做了什么。用户消息里的 Attached project files 列出本轮附件的项目相对路径（基于工作区解析）：文本与代码可直接 read，图片可在需要时用 read 查看像素，PDF、PPTX、XLSX、GLB 等按类型交给对应 Skill 或工具处理，没有合适工具时明确说明能力不足。需要处理本地文件夹路径时调用 local_folder_list，再按需读取并调用 canvas_import_attachment 导入白板。用户选中的附件应对应白板节点。" +
    "Config 节点仅供用户手动使用，Agent 不得创建或触发 Config。普通生成使用 canvas_generate_node；脚本分镜关键帧必须使用 canvas_script_generate_storyboards，由该工具解析镜头实体并携带已有资产引用，不得用普通生图工具代替。引用 3D 资产生成时使用 reference3dSelections: [{\"nodeId\":\"3d-node-id\",\"view\":\"all\"}]，为每个 3D 节点传一项 { nodeId, view }；view 只能是一个枚举字符串，all 已表示 primary/left/right/top 四视角，禁止传数组或使用 item 键；reference3dViews 是画布持久化 metadata/旧历史字段，不是当前工具参数。用户未明确指定模型时省略 model，让工具按参考输入自动选择兼容默认模型；用户明确指定模型时先调用 models_list 验证输入契约。需要观察 3D 视图时用 view_image 并传对应 imageId。创建生成节点（image/video/audio/text 等）后，不得自动触发生成；必须等用户明确许可后再用 canvas_run_generation / canvas_create_config_node(autoRun=true) / canvas_create_generation_flow(autoRun=true) 等方式触发。autoRun 与 generate 参数默认全部置为 false/不触发。生成工具只在用户明确要求生成对应内容时调用。" +
    "生成任务状态为 failed/timed_out 时，不得重跑也不得删除对应节点（系统会直接拒绝）：timed_out 只是本地停止跟踪，远端可能仍在执行或结果待交付，重跑会产生新的付费提交、删除节点会丢失「重新获取结果」的恢复入口。正确做法是保留节点并告知用户在节点上点击「重新获取结果」恢复原任务拉取产物；也不要新建节点重跑同一内容，远端确认失败后由用户手动决定是否重试或删除。";

/**
 * Build the "Available tools" section for the system prompt. The SDK's
 * `buildSystemPrompt` skips its own version when a customPrompt is supplied
 * (see @earendil-works/pi-coding-agent/core/system-prompt.js: when
 * `if (customPrompt)` is true, the tool list is never appended), so the
 * agent has no idea what tools exist and hallucinates (e.g. calls a generic
 * "read" tool that does not exist). List each tool by name with its
 * one-line promptSnippet so the model knows what it can call.
 */
function buildAvailableToolsBlock(tools: { name: string; label: string; promptSnippet?: string }[]): string {
    if (tools.length === 0) return "";
    const lines = ["Available tools (use exactly these names):"];
    for (const tool of tools) {
        const desc = tool.promptSnippet?.trim() || tool.label;
        lines.push(`- ${tool.name}: ${desc}`);
    }
    return lines.join("\n");
}

function buildRuntimeCapabilityBlock(tools: { name: string }[]): string {
    if (!tools.some((tool) => tool.name === "view_image")) return "";
    return "当前运行时能力高于对话历史中的旧结论：view_image 已激活。用户要求查看、读取或分析画布图片时，必须先获取准确 nodeId，再调用 view_image 读取真实像素；画布 blob URL 由该工具内部解析，禁止改用 read、local_file_read、导出文件或要求用户重新上传。";
}

function buildWorkspaceBlock(workspacePath?: string): string {
    if (!workspacePath) return "";
    return `工作区目录：${workspacePath}。bash 在此目录执行；read/edit/write 的相对路径基于它解析。涉及该目录的操作优先使用相对路径。`;
}

export type AgentPromptController<TInput extends PiAgentPromptInput | string = string> = {
    prompt(input: TInput, options?: { explicitSkillName?: string }): Promise<void>;
    waitForIdle(): Promise<void>;
};

type AgentToolSummary = { name: string; label: string; promptSnippet?: string };

type DispatchAgentPromptInput = {
    input?: PiAgentPromptInput | string;
    text?: string;
    skillRuntime: SkillRuntime;
    tools: AgentToolSummary[];
    workspacePath?: string;
    memoryBlock?: string;
    getController: () => AgentPromptController<PiAgentPromptInput | string> | null;
    setSystemPrompt: (systemPrompt: string) => void;
};

export function buildAgentSystemPrompt(
    skillSummaryBlock: string,
    tools: { name: string; label: string; promptSnippet?: string }[] = [],
    workspacePath?: string,
    memoryBlock?: string,
): string {
    return [
        DEFAULT_SYSTEM_PROMPT,
        buildRuntimeCapabilityBlock(tools),
        buildWorkspaceBlock(workspacePath),
        ...(memoryBlock ? [memoryBlock] : []),
        buildAvailableToolsBlock(tools),
        "任务明确指定 /name 或匹配某个 Skill 时，先用 read 工具按 available_skills 中给出的 location 路径读取 SKILL.md 完整指令；不要根据摘要猜测指令内容。",
        "使用 /skill-creator 时，完成需求澄清后把最终 SKILL.md 作为单个 markdown 代码块输出；应用会弹出确认保存窗口，不要尝试直接写入或打包本地文件。",
        skillSummaryBlock,
    ].filter(Boolean).join("\n\n");
}

/** 有界文件清单：每行一个相对路径 + 类型元数据，绝不内联文件字节。 */
export function buildAttachmentFileBlock(files?: PiAgentPromptFile[]): string {
    return files?.length
        ? ["Attached project files:", ...files.map(file => `- ${file.relativePath} (${file.kind}, ${file.mimeType}, ${file.size} bytes)`)].join("\n")
        : "";
}

export async function dispatchAgentPrompt(input: DispatchAgentPromptInput): Promise<{ ok: true } | { ok: false; error: string }> {
    const rawInput = input.input ?? input.text ?? "";
    const prompt = typeof rawInput === "string" ? { text: rawInput } : rawInput;
    const command = normalizeSkillCommand(prompt.text);
    const skills = await input.skillRuntime.agentSnapshot();
    input.setSystemPrompt(buildAgentSystemPrompt(skills.ok ? skills.systemPromptBlock : "", input.tools, input.workspacePath, input.memoryBlock));

    if (command.skillName) {
        if (!skills.ok) return { ok: false, error: skills.error };
        if (!skills.availableSkillNames.includes(command.skillName)) {
            return { ok: false, error: `找不到可用 Skill：${command.skillName}` };
        }
    }

    const controller = input.getController();
    if (!controller) return { ok: false, error: "模型未配置：请先调用 setModelConfig" };
    // 运行时 cwd 即项目工作区：内建 read/edit/write 与 Skill 工具可直接使用相对路径。
    const text = [command.text, buildAttachmentFileBlock(prompt.files)].filter(Boolean).join("\n\n");
    const agentInput = prompt.images?.length || prompt.files?.length || prompt.fileHandles?.length ? { ...prompt, text } : text;
    await controller.prompt(agentInput, { explicitSkillName: command.skillName });
    await controller.waitForIdle();
    return { ok: true };
}
