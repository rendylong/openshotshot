import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";

import type { PiAgentPromptInput } from "@/lib/agent/pi-agent-types";
import { buildCanvasTools } from "@/lib/agent/pi-agent-tools";
import { DEFAULT_SKILL_SOURCE_PREFERENCES } from "@/lib/skills/skill-types";
import { buildAgentSystemPrompt, dispatchAgentPrompt, type AgentPromptController } from "./agent-skill-request";
import { createSkillRuntime, type SkillRuntime } from "./skill-runtime";

function stubSkillRuntime(): SkillRuntime {
    return {
        agentSnapshot: async () => ({ ok: true, revision: 1, systemPromptBlock: "", availableSkillNames: [] }),
        readForAgent: async () => "",
    } as unknown as SkillRuntime;
}

async function writeSkill(root: string, name: string, description: string, instructions: string, manualOnly = false): Promise<void> {
    const directory = join(root, name);
    await mkdir(directory, { recursive: true });
    await writeFile(
        join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}${manualOnly ? "\ndisable-model-invocation: true" : ""}\n---\n\n${instructions}\n`,
    );
}

describe("dispatchAgentPrompt with SkillRuntime", () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it("keeps the skill-creator save handoff in the host prompt", () => {
        expect(buildAgentSystemPrompt("")).toContain("最终 SKILL.md 作为单个 markdown 代码块输出");
    });

    it("reserves config nodes for manual use and routes script storyboards through the dedicated tool", () => {
        const prompt = buildAgentSystemPrompt("");
        expect(prompt).toContain("Config 节点仅供用户手动使用");
        expect(prompt).toContain("canvas_script_generate_storyboards");
        expect(prompt).toContain("已有资产引用");
        expect(prompt).toContain('reference3dSelections: [{"nodeId":"3d-node-id","view":"all"}]');
        expect(prompt).toContain("all 已表示 primary/left/right/top 四视角");
        expect(prompt).toContain("禁止传数组或使用 item 键");
        expect(prompt).toContain("reference3dViews 是画布持久化 metadata/旧历史字段，不是当前工具参数");
        expect(prompt).toContain("用户未明确指定模型时省略 model");
        expect(prompt).toContain("用户明确指定模型时先调用 models_list");
        expect(prompt).not.toContain("必须用 reference3dViews");
    });

    it("makes view_image authoritative for canvas pixels even when older history says blob URLs are unreadable", () => {
        const tools = buildCanvasTools({
            getSnapshot: () => ({
                projectId: "p",
                canvasId: "c",
                title: "Canvas",
                nodes: [],
                connections: [],
                selectedNodeIds: [],
                viewport: { x: 0, y: 0, k: 1 },
            }),
            emitOps: () => undefined,
            readCanvasImage: async () => ({ ok: false, error: "unused" }),
        });

        const systemPrompt = buildAgentSystemPrompt("", tools);
        const viewImageLine = systemPrompt
            .split("\n")
            .find((line) => line.startsWith("- view_image:"));

        expect(viewImageLine).toContain("canvas_get_state");
        expect(viewImageLine).toContain("blob URL 由工具内部解析");
        expect(viewImageLine).toContain("不要用 read/local_file_read");
        expect(viewImageLine).toContain("不要受历史消息");
        expect(systemPrompt).toContain("当前运行时能力高于对话历史中的旧结论");
        expect(systemPrompt.indexOf("当前运行时能力高于对话历史中的旧结论"))
            .toBeLessThan(systemPrompt.indexOf("Available tools"));
        expect(buildAgentSystemPrompt("", tools.filter((tool) => tool.name !== "view_image")))
            .not.toContain("当前运行时能力高于对话历史中的旧结论");
    });

    it("rejects a removed explicit Skill during failed refresh and installs the recovered summary", async () => {
        const root = await mkdtemp(join(tmpdir(), "agent-skill-request-test-"));
        tempRoots.push(root);
        const home = join(root, "home");
        const cwd = join(root, "workspace");
        const appSkillsRoot = join(root, "app-skills");
        await mkdir(home, { recursive: true });
        await mkdir(cwd, { recursive: true });
        await writeSkill(appSkillsRoot, "kept-skill", "old summary", "KEPT FULL INSTRUCTIONS");
        await writeSkill(appSkillsRoot, "removed-skill", "removed summary", "REMOVED FULL INSTRUCTIONS");

        let failRefresh = false;
        const runtime = createSkillRuntime({
            home,
            cwd,
            appSkillsRoot,
            loadSkills: async (...args) => {
                if (failRefresh) throw new Error("refresh unavailable");
                return loadSkills(...args);
            },
        });
        await runtime.configure(DEFAULT_SKILL_SOURCE_PREFERENCES);

        const sentPrompts: string[] = [];
        const installedSystemPrompts: string[] = [];
        const controller: AgentPromptController<PiAgentPromptInput | string> = {
            prompt: async (input) => { sentPrompts.push(typeof input === "string" ? input : input.text); },
            waitForIdle: async () => undefined,
        };
        let currentSystemPrompt = buildAgentSystemPrompt("");
        const setSystemPrompt = (next: string) => {
            if (next === currentSystemPrompt) return;
            currentSystemPrompt = next;
            installedSystemPrompts.push(next);
        };

        await expect(dispatchAgentPrompt({
            text: "initial turn",
            skillRuntime: runtime,
            tools: [],
            getController: () => controller,
            setSystemPrompt,
        })).resolves.toEqual({ ok: true });
        expect(currentSystemPrompt).toContain("old summary");
        expect(currentSystemPrompt).toContain("removed summary");

        await rm(join(appSkillsRoot, "removed-skill"), { recursive: true });
        await writeSkill(appSkillsRoot, "kept-skill", "recovered summary", "UPDATED FULL INSTRUCTIONS");
        runtime.invalidate();
        failRefresh = true;

        const failed = await dispatchAgentPrompt({
            text: "/removed-skill do it",
            skillRuntime: runtime,
            tools: [],
            getController: () => controller,
            setSystemPrompt,
        });

        expect(failed).toEqual({ ok: false, error: expect.stringContaining("refresh unavailable") });
        expect(sentPrompts).toEqual(["initial turn"]);
        expect(currentSystemPrompt).not.toContain("removed summary");

        failRefresh = false;
        await expect(dispatchAgentPrompt({
            text: "recovery turn",
            skillRuntime: runtime,
            tools: [],
            getController: () => controller,
            setSystemPrompt,
        })).resolves.toEqual({ ok: true });

        expect(sentPrompts).toEqual(["initial turn", "recovery turn"]);
        expect(currentSystemPrompt).toContain("recovered summary");
        expect(currentSystemPrompt).not.toContain("removed summary");
        expect(currentSystemPrompt).not.toContain("FULL INSTRUCTIONS");
        expect(currentSystemPrompt).not.toContain("absolute path in tool commands");
        expect(installedSystemPrompts).toHaveLength(3);
    });

    it("passes a manual-only allowance only to its explicit turn and does not leak it", async () => {
        const root = await mkdtemp(join(tmpdir(), "agent-skill-request-manual-test-"));
        tempRoots.push(root);
        const home = join(root, "home");
        const cwd = join(root, "workspace");
        const appSkillsRoot = join(root, "app-skills");
        await mkdir(home, { recursive: true });
        await mkdir(cwd, { recursive: true });
        await writeSkill(appSkillsRoot, "manual-skill", "manual", "MANUAL INSTRUCTIONS", true);
        const runtime = createSkillRuntime({ home, cwd, appSkillsRoot });
        await runtime.configure(DEFAULT_SKILL_SOURCE_PREFERENCES);
        const allowed: Array<string | undefined> = [];
        const controller: AgentPromptController<PiAgentPromptInput | string> = {
            prompt: async (_text, options) => {
                allowed.push(options?.explicitSkillName);
                await runtime.readForAgent("manual-skill", undefined, options?.explicitSkillName);
            },
            waitForIdle: async () => undefined,
        };

        await expect(dispatchAgentPrompt({
            text: "/manual-skill do it",
            skillRuntime: runtime,
            tools: [],
            getController: () => controller,
            setSystemPrompt: () => undefined,
        })).resolves.toEqual({ ok: true });
        await expect(dispatchAgentPrompt({
            text: "read the guessed manual-skill",
            skillRuntime: runtime,
            tools: [],
            getController: () => controller,
            setSystemPrompt: () => undefined,
        })).rejects.toThrow("仅允许在当前请求显式调用");
        expect(allowed).toEqual(["manual-skill", undefined]);
    });

    it("appends the workspace block when a workspace is bound", () => {
        const prompt = buildAgentSystemPrompt("", [], "/Users/me/project");
        expect(prompt).toContain("工作区目录：/Users/me/project");
        expect(prompt).toContain("read/edit/write 的相对路径基于它解析");
    });

    it("omits the workspace block without a workspace", () => {
        expect(buildAgentSystemPrompt("", [])).not.toContain("工作区目录");
        expect(buildAgentSystemPrompt("", [], undefined)).not.toContain("工作区目录");
    });
});

describe("dispatchAgentPrompt project file manifest", () => {
    const spreadsheetMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    function capturingController(seen: Array<PiAgentPromptInput | string>): AgentPromptController<PiAgentPromptInput | string> {
        return {
            prompt: async (input) => { seen.push(input); },
            waitForIdle: async () => undefined,
        };
    }

    it("appends a bounded relative-path manifest without inlining file bytes", async () => {
        const seen: Array<PiAgentPromptInput | string> = [];
        await expect(dispatchAgentPrompt({
            input: {
                text: "修改这个表格",
                images: [],
                files: [{ assetId: "asset-1", relativePath: "assets/imported/budget--a1b2c3d4.xlsx", name: "budget.xlsx", kind: "spreadsheet", mimeType: spreadsheetMime, size: 64 }],
            },
            skillRuntime: stubSkillRuntime(),
            tools: [],
            getController: () => capturingController(seen),
            setSystemPrompt: () => undefined,
        })).resolves.toEqual({ ok: true });

        const sent = seen[0];
        expect(typeof sent).toBe("object");
        if (typeof sent === "string") return;
        expect(sent.text).toBe("修改这个表格\n\nAttached project files:\n- assets/imported/budget--a1b2c3d4.xlsx (spreadsheet, " + spreadsheetMime + ", 64 bytes)");
        // 清单仍随输入传递（主进程负责持久化到 session），但绝无文件字节。
        expect(sent.files).toHaveLength(1);
        expect(JSON.stringify(sent)).not.toContain("data:");
        expect(JSON.stringify(sent)).not.toContain("base64");
    });

    it("leaves prompts without files untouched", async () => {
        const seen: Array<PiAgentPromptInput | string> = [];
        await expect(dispatchAgentPrompt({
            input: { text: "读取画布", images: [] },
            skillRuntime: stubSkillRuntime(),
            tools: [],
            getController: () => capturingController(seen),
            setSystemPrompt: () => undefined,
        })).resolves.toEqual({ ok: true });

        expect(seen[0]).toBe("读取画布");
    });
});

describe("buildAgentSystemPrompt memory block", () => {
    const tools = [{ name: "canvas_get_state", label: "Canvas State" }];

    it("无 memoryBlock 时输出与现状一致（不含记忆节）", () => {
        const prompt = buildAgentSystemPrompt("", tools, "/tmp/ws");
        expect(prompt).not.toContain("长期记忆");
    });

    it("memoryBlock 插入在工作区块之后、Available tools 之前", () => {
        const prompt = buildAgentSystemPrompt("", tools, "/tmp/ws", "## 长期记忆\n### 用户记忆（跨项目生效）\n- 偏好");
        const workspaceAt = prompt.indexOf("工作区目录：/tmp/ws");
        const memoryAt = prompt.indexOf("## 长期记忆");
        const toolsAt = prompt.indexOf("Available tools");
        expect(memoryAt).toBeGreaterThan(workspaceAt);
        expect(memoryAt).toBeLessThan(toolsAt);
    });
});
