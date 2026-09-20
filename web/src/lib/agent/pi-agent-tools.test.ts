import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { registerBuiltinNodes } from "@/components/canvas/nodes/builtin-nodes";
import { getFalProfile } from "@/lib/models/fal/profiles";
import { patchProviderParams } from "@/lib/models/provider-options";
import { applyCanvasAgentOps } from "@/lib/canvas/canvas-agent-ops";
import { annotateCanvasAgentNodes } from "@/lib/canvas/canvas-agent-snapshot";
import type { CanvasAgentOp, CanvasOpReceipt } from "@/lib/canvas/canvas-agent-op-types";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { SCRIPT_NODE_TYPE, createEmptyScriptData } from "@/types/script-node";

import type { AgentFileContent } from "@/lib/agent/pi-agent-types";
import { buildCanvasTools, type CanvasToolContext } from "./pi-agent-tools";

const falTestConfig: AiConfig = { ...defaultConfig, channels: [{ id: "channel", name: "fal.ai", provider: "fal", baseUrl: "https://queue.fal.run", apiKey: "private-key", apiFormat: "openai", models: [{ name: "fal-ai/flux-2-pro", capability: "image" }] }] };

// 1x1 transparent PNG, base64 (no data URL prefix). 68 bytes decoded.
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function makeImageFile(): AgentFileContent {
    return {
        handle: "img-handle",
        name: "coffee.png",
        kind: "image",
        mimeType: "image/png",
        size: 68,
        dataUrl: `data:image/png;base64,${TINY_PNG_BASE64}`,
    };
}

function makePdfFile(): AgentFileContent {
    return {
        handle: "pdf-handle",
        name: "brief.pdf",
        kind: "pdf",
        mimeType: "application/pdf",
        size: 16,
        dataUrl: "data:application/pdf;base64,JVBERi0xLjQgZml4dHVyZQ==",
    };
}

function makeContext(files: AgentFileContent[]): { ctx: CanvasToolContext; calls: { handle: string }[] } {
    const calls: { handle: string }[] = [];
    const ctx: CanvasToolContext = {
        getSnapshot: () => ({ projectId: "p", canvasId: "c", title: "t", nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } }),
        emitOps: () => {},
        readAttachment: async (handle) => {
            calls.push({ handle });
            const file = files.find((item) => item.handle === handle);
            return file ? { ok: true, file } : { ok: false, error: `句柄不存在：${handle}` };
        },
        listFolder: async () => ({ ok: true, files: [] }),
    };
    return { ctx, calls };
}

function findTool(tools: ReturnType<typeof buildCanvasTools>, name: string) {
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) throw new Error(`tool not found: ${name}`);
    return tool;
}

describe("generation submission and polling", () => {
    it.each([
        ["canvas_generate_node", { prompt: "image", mode: "image" }],
        ["canvas_run_generation", { nodeId: "existing", mode: "image" }],
    ])("%s returns the exact generation target with serialized wait guidance", async (name, params) => {
        const { ctx } = makeContext([]);
        const ops: import("@/lib/canvas/canvas-agent-op-types").CanvasAgentOp[] = [];
        ctx.emitOps = (batch) => { ops.push(...batch); };
        if (name === "canvas_run_generation") {
            // 新实现校验节点存在性（Task 8）且拒绝 config 节点：提供一个存在的 image 节点
            (ctx as { getSnapshot: unknown }).getSnapshot = () => ({ projectId: "p", canvasId: "c", title: "t", nodes: [{ id: "existing", type: "image", title: "i", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: {} }], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } } as never);
        }
        const result = await findTool(buildCanvasTools(ctx), name as string).execute("submit", params);
        const targets = ops.filter((op) => op.type === "run_generation");
        expect(targets).toHaveLength(1);
        const text = JSON.stringify(result.content);
        expect(text).toContain(targets[0]!.nodeId);
        expect(text).toContain("nodeIds");
        expect(text).toContain("seconds=120");
        expect(text).toContain("不能把 wait 和 generation_get_status");
    });

    it("canvas_generate_node chooses a text-capable image model when the image default requires a reference", async () => {
        const { ctx } = makeContext([]);
        const ops: CanvasAgentOp[] = [];
        ctx.emitOps = (batch) => { ops.push(...batch); };
        ctx.listModels = async () => ({ ok: true, models: [
            { id: "managed-edit", name: "Edit", capability: "image", channelName: "ShotShot", isDefault: true, inputMode: "image", requiresReference: true },
            { id: "managed-generate", name: "Generate", capability: "image", channelName: "ShotShot", isDefault: false, inputMode: "text", requiresReference: false },
        ] });

        await findTool(buildCanvasTools(ctx), "canvas_generate_node").execute("generate", { prompt: "cat", mode: "image" });

        const generated = ops.find((op) => op.type === "add_node" && op.metadata?.model);
        expect(generated?.type === "add_node" ? generated.metadata?.model : undefined).toBe("managed-generate");
    });

    it("rejects an image-only model before emitting a prompt-only generation", async () => {
        const { ctx } = makeContext([]);
        const ops: CanvasAgentOp[] = [];
        ctx.emitOps = (batch) => { ops.push(...batch); };
        ctx.listModels = async () => ({ ok: true, models: [
            { id: "managed-edit", name: "Edit", capability: "image", channelName: "ShotShot", isDefault: true, inputMode: "image", requiresReference: true },
        ] });

        const result = await findTool(buildCanvasTools(ctx), "canvas_generate_node").execute("generate", { prompt: "cat", mode: "image", model: "managed-edit" });

        expect(ops).toEqual([]);
        expect((result.content[0] as { text: string }).text).toContain("参考图");
    });

    it("keeps batched filters and terminal task results intact", async () => {
        const { ctx } = makeContext([]);
        const tasks = [
            { nodeId: "done", source: "remote_media" as const, status: "succeeded" as const, projectId: "p", canvasId: "c", updatedAt: "test" },
            { nodeId: "failed", source: "remote_media" as const, status: "failed" as const, projectId: "p", canvasId: "c", error: "provider failed", updatedAt: "test" },
        ];
        ctx.getGenerationStatus = async (filter) => {
            expect(filter).toEqual({ nodeIds: ["done", "failed"], limit: 20 });
            return { ok: true, tasks };
        };
        const tool = findTool(buildCanvasTools(ctx), "generation_get_status");
        const result = await tool.execute("status", { nodeIds: ["done", "failed"] });
        const text = result.content[0] as { text: string };
        expect(JSON.parse(text.text)).toEqual({ tasks });
        expect(tool.description).toContain("停止轮询");
        expect(tool.description).toContain("禁止重跑");
    });

    it("generation_get_status resolves derived tasks by config id via sourceNodeId (provider e2e shape)", async () => {
        const { ctx } = makeContext([]);
        // 模拟主进程 provider 过滤后的缓存形状：store 按 nodeId 存派生任务，sourceNodeId 指回配置节点。
        ctx.getGenerationStatus = async (filter) => {
            expect(filter).toEqual({ nodeIds: ["config-1"], limit: 20 });
            return {
                ok: true as const,
                tasks: [
                    { nodeId: "image-a", sourceNodeId: "config-1", source: "remote_media" as const, status: "pending" as const, projectId: "p", canvasId: "c", updatedAt: "t2" },
                ],
            };
        };
        const tool = findTool(buildCanvasTools(ctx), "generation_get_status");
        const result = await tool.execute("status", { nodeIds: ["config-1"] });
        const parsed = JSON.parse((result.content[0] as { text: string }).text) as { tasks: Array<Record<string, unknown>> };
        expect(parsed.tasks).toHaveLength(1);
        expect(parsed.tasks[0]).toMatchObject({ nodeId: "image-a", sourceNodeId: "config-1", status: "pending" });
    });

    it("canvas_run_generation 支持 force 参数并校验节点存在", async () => {
        const { ctx } = makeContext([]);
        const emitted: CanvasAgentOp[][] = [];
        (ctx as { emitOps: unknown }).emitOps = (ops: CanvasAgentOp[]) => { emitted.push(ops); };
        (ctx as { getSnapshot: unknown }).getSnapshot = () => ({ projectId: "p", canvasId: "c", title: "t", nodes: [{ id: "img-1", type: "image", title: "i", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: {} }], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } } as never);
        const tool = findTool(buildCanvasTools(ctx), "canvas_run_generation");
        await tool.execute("call", { nodeId: "img-1", mode: "image", force: true }, undefined, undefined);
        expect(emitted[0]).toEqual([{ type: "run_generation", nodeId: "img-1", mode: "image", prompt: undefined, force: true }]);
        const missing = await tool.execute("call", { nodeId: "ghost" }, undefined, undefined);
        expect((missing as { content: Array<{ text: string }> }).content[0].text).toContain("节点不存在：ghost");
        expect(emitted).toHaveLength(1);
    });
});

describe("Agent config-node boundary", () => {
    it("does not expose config construction tools", () => {
        const names = buildCanvasTools(makeContext([]).ctx).map((tool) => tool.name);
        expect(names).not.toContain("canvas_create_config_node");
        expect(names).not.toContain("canvas_create_generation_flow");
    });

    it("rejects config creation through generic node and raw-op escape hatches", async () => {
        const { ctx } = makeContext([]);
        const ops: CanvasAgentOp[] = [];
        ctx.emitOps = (batch) => { ops.push(...batch); };
        const tools = buildCanvasTools(ctx);

        const generic = await findTool(tools, "canvas_create_node").execute("create", { nodeType: "config" });
        const raw = await findTool(tools, "canvas_apply_ops").execute("apply", { ops: [{ type: "add_node", nodeType: "config" }] });

        expect(ops).toEqual([]);
        expect(JSON.stringify(generic.content)).toContain("Agent 不支持创建 Config");
        expect(JSON.stringify(raw.content)).toContain("Agent 不支持创建 Config");
    });

    it("does not let Agent trigger a user-created config node", async () => {
        const { ctx } = makeContext([]);
        const ops: CanvasAgentOp[] = [];
        ctx.getSnapshot = () => ({
            projectId: "p", canvasId: "c", title: "t",
            nodes: [{ id: "config-user", type: "config", title: "用户配置", position: { x: 0, y: 0 }, width: 340, height: 240, metadata: { generationMode: "image", prompt: "cat" } }],
            connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 },
        });
        ctx.emitOps = (batch) => { ops.push(...batch); };

        const tools = buildCanvasTools(ctx);
        const result = await findTool(tools, "canvas_run_generation").execute("run", { nodeId: "config-user" });
        const raw = await findTool(tools, "canvas_apply_ops").execute("raw-run", { ops: [{ type: "run_generation", nodeId: "config-user" }] });

        expect(ops).toEqual([]);
        expect(JSON.stringify(result.content)).toContain("Agent 不支持触发 Config");
        expect(JSON.stringify(raw.content)).toContain("Agent 不支持触发 Config");
    });
});

describe("Agent 3D reference view selection", () => {
    const model3d = { id: "model-3d", type: "3d", title: "产品模型", position: { x: 0, y: 0 }, width: 640, height: 480, metadata: {}, referenceKind: "image", referenceCount: 4 } as never;
    const spare3d = { id: "spare-3d", type: "3d", title: "备用模型", position: { x: 0, y: 0 }, width: 640, height: 480, metadata: {}, referenceKind: "image", referenceCount: 4 } as never;
    const imageRef = { id: "image-a", type: "image", title: "产品图", position: { x: 0, y: 0 }, width: 250, height: 170, metadata: {} } as never;

    it("exposes reference3dSelections on both generation tools without the legacy record schema", () => {
        const tools = buildCanvasTools(makeContext([]).ctx);
        const generateNodeTool = findTool(tools, "canvas_generate_node");
        const storyboardTool = findTool(tools, "canvas_script_generate_storyboards");
        expect(JSON.stringify(generateNodeTool.parameters)).toContain("reference3dSelections");
        expect(JSON.stringify(storyboardTool.parameters)).toContain("reference3dSelections");
        expect(JSON.stringify(generateNodeTool.parameters)).not.toContain("patternProperties");
        expect(JSON.stringify(storyboardTool.parameters)).not.toContain("patternProperties");
        expect(JSON.stringify(generateNodeTool.parameters)).not.toContain("reference3dViews");
        expect(JSON.stringify(storyboardTool.parameters)).not.toContain("reference3dViews");
    });

    it("rejects a 3D generation reference until the Agent explicitly chooses one view or all", async () => {
        const { ctx } = makeContext([]);
        const ops: CanvasAgentOp[] = [];
        ctx.getSnapshot = () => ({ projectId: "p", canvasId: "c", title: "t", nodes: [model3d], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } });
        ctx.emitOps = (batch) => { ops.push(...batch); };

        const result = await findTool(buildCanvasTools(ctx), "canvas_generate_node").execute("generate", { mode: "image", prompt: "产品图", referenceNodeIds: ["model-3d"] });

        expect(ops).toEqual([]);
        expect(JSON.stringify(result.content)).toContain("缺少视角选择");
        expect(JSON.stringify(result.content)).toContain("model-3d");
    });

    it.each(["left", "all"] as const)("stores the explicit %s selection on the generated target", async selection => {
        const { ctx } = makeContext([]);
        const ops: CanvasAgentOp[] = [];
        ctx.getSnapshot = () => ({ projectId: "p", canvasId: "c", title: "t", nodes: [model3d], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } });
        ctx.emitOps = (batch) => { ops.push(...batch); };

        await findTool(buildCanvasTools(ctx), "canvas_generate_node").execute("generate", {
            mode: "image", prompt: "产品图", referenceNodeIds: ["model-3d"], reference3dSelections: [{ nodeId: "model-3d", view: selection }],
        });

        expect(ops.find((op) => op.type === "add_node")).toMatchObject({ metadata: { reference3dViews: { "model-3d": selection } } });
    });

    it.each([
        { name: "重复 nodeId", nodes: [model3d], referenceNodeIds: ["model-3d"], selections: [{ nodeId: "model-3d", view: "left" }, { nodeId: "model-3d", view: "right" }], message: "存在重复 nodeId" },
        { name: "缺失 selection", nodes: [model3d], referenceNodeIds: ["model-3d"], selections: [] as Array<{ nodeId: string; view: string }>, message: "缺少视角选择" },
        { name: "多余 selection", nodes: [model3d, spare3d], referenceNodeIds: ["model-3d"], selections: [{ nodeId: "spare-3d", view: "all" }], message: "只能包含 referenceNodeIds 中实际引用的 3D 节点" },
        { name: "非 3D selection", nodes: [model3d, imageRef], referenceNodeIds: ["model-3d", "image-a"], selections: [{ nodeId: "image-a", view: "all" }], message: "只能包含 referenceNodeIds 中实际引用的 3D 节点" },
    ])("rejects $name without emitting ops", async ({ nodes, referenceNodeIds, selections, message }) => {
        const { ctx } = makeContext([]);
        const ops: CanvasAgentOp[] = [];
        ctx.getSnapshot = () => ({ projectId: "p", canvasId: "c", title: "t", nodes, connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } });
        ctx.emitOps = (batch) => { ops.push(...batch); };

        const result = await findTool(buildCanvasTools(ctx), "canvas_generate_node").execute("generate", { mode: "image", prompt: "产品图", referenceNodeIds, reference3dSelections: selections });

        expect(ops).toEqual([]);
        expect(JSON.stringify(result.content)).toContain(message);
    });

    it("does not let the Agent bypass view selection by running a 3D node directly", async () => {
        const { ctx } = makeContext([]);
        const ops: CanvasAgentOp[] = [];
        ctx.getSnapshot = () => ({ projectId: "p", canvasId: "c", title: "t", nodes: [model3d], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } });
        ctx.emitOps = (batch) => { ops.push(...batch); };

        const result = await findTool(buildCanvasTools(ctx), "canvas_run_generation").execute("run", { nodeId: "model-3d" });
        const raw = await findTool(buildCanvasTools(ctx), "canvas_apply_ops").execute("raw-run", { ops: [{ type: "run_generation", nodeId: "model-3d" }] });

        expect(ops).toEqual([]);
        expect(JSON.stringify(result.content)).toContain("canvas_generate_node");
        expect(JSON.stringify(result.content)).toContain("reference3dSelections");
        expect(JSON.stringify(raw.content)).toContain("reference3dSelections");
    });
});

describe("canvas_generate_text", () => {
    it("places an empty text node without generation when prompt is omitted", async () => {
        const { ctx } = makeContext([]);
        const ops: import("@/lib/canvas/canvas-agent-op-types").CanvasAgentOp[] = [];
        ctx.emitOps = (batch) => { ops.push(...batch); };
        const result = await findTool(buildCanvasTools(ctx), "canvas_generate_text").execute("create", { title: "备注" });

        expect(ops).toHaveLength(1);
        const addNode = ops[0] as { type: string; nodeType: string; title?: string; metadata?: unknown };
        expect(addNode.type).toBe("add_node");
        expect(addNode.nodeType).toBe("text");
        expect(addNode.title).toBe("备注");
        expect(addNode.metadata).toBeUndefined();
        expect(JSON.stringify(result.content)).toContain("canvas_update_node_text");
    });

    it("keeps the generation flow when prompt is provided", async () => {
        const { ctx } = makeContext([]);
        const ops: import("@/lib/canvas/canvas-agent-op-types").CanvasAgentOp[] = [];
        ctx.emitOps = (batch) => { ops.push(...batch); };
        await findTool(buildCanvasTools(ctx), "canvas_generate_text").execute("create", { prompt: "  写一首诗  ", referenceNodeIds: ["img-1"], textCount: 3 });

        const addNode = ops.find((op) => op.type === "add_node") as { id: string; metadata: { prompt: string; generationMode: string; textCount?: number } };
        expect(addNode.metadata).toEqual({ prompt: "写一首诗", generationMode: "text", textCount: 3 });
        expect(ops).toContainEqual({ type: "connect_nodes", fromNodeId: "img-1", toNodeId: addNode.id });
        const run = ops[ops.length - 1] as { type: string; mode: string; prompt: string };
        expect(run).toMatchObject({ type: "run_generation", mode: "text", prompt: "写一首诗" });
    });
});

describe("local_file_read", () => {
    it("image + view returns a typed image block instead of base64 in text", async () => {
        const { ctx } = makeContext([makeImageFile()]);
        const tool = findTool(buildCanvasTools(ctx), "local_file_read");
        const result = await tool.execute("call-1", { handle: "img-handle", mode: "view" });

        expect(result.content).toHaveLength(2);
        expect(result.content[0]).toMatchObject({ type: "text" });
        expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
        // Guard: the text block must never carry raw base64 (the prior bug).
        const textBlock = result.content[0] as { type: "text"; text: string };
        expect(textBlock.text).not.toContain(TINY_PNG_BASE64);
        expect(textBlock.text).not.toContain("base64,");
        expect(textBlock.text).toMatch(/coffee\.png/);
        // Image block carries the base64 bytes (typed), not as text.
        const imageBlock = result.content[1] as { type: "image"; data: string };
        expect(imageBlock.data).toBe(TINY_PNG_BASE64);
        expect(JSON.stringify(result.details)).not.toContain(TINY_PNG_BASE64);
        expect(JSON.stringify(result.details)).not.toContain("data:image/");
    });

    it("image + meta returns text only and never carries image bytes", async () => {
        const { ctx } = makeContext([makeImageFile()]);
        const tool = findTool(buildCanvasTools(ctx), "local_file_read");
        const result = await tool.execute("call-1", { handle: "img-handle", mode: "meta" });

        expect(result.content).toHaveLength(1);
        expect(result.content[0]).toMatchObject({ type: "text" });
        const textBlock = result.content[0] as { type: "text"; text: string };
        expect(textBlock.text).toMatch(/coffee\.png/);
        expect(textBlock.text).not.toContain(TINY_PNG_BASE64);
        expect(textBlock.text).not.toContain("base64,");
    });

    it("non-image kinds (pdf) return metadata-only text and never carry image blocks", async () => {
        const { ctx } = makeContext([makePdfFile()]);
        const tool = findTool(buildCanvasTools(ctx), "local_file_read");
        const result = await tool.execute("call-1", { handle: "pdf-handle", mode: "view" });

        expect(result.content).toHaveLength(1);
        expect(result.content[0]).toMatchObject({ type: "text" });
        const textBlock = result.content[0] as { type: "text"; text: string };
        expect(textBlock.text).toContain("brief.pdf");
        expect(textBlock.text).toContain("pdf");
        expect(textBlock.text).not.toContain("base64,");
    });

    it("missing handle returns a text-only error so the model can recover", async () => {
        const { ctx } = makeContext([]);
        const tool = findTool(buildCanvasTools(ctx), "local_file_read");
        const result = await tool.execute("call-1", { handle: "ghost", mode: "view" });

        expect(result.content).toHaveLength(1);
        const textBlock = result.content[0] as { type: "text"; text: string };
        expect(textBlock.text).toMatch(/句柄不存在/);
    });

    it("no tool result embeds a long base64 string in a text block (transcript bloat guard)", async () => {
        // Even when the underlying attachment is large, text blocks must stay short.
        const big: AgentFileContent = {
            ...makeImageFile(),
            size: 5 * 1024 * 1024,
            dataUrl: `data:image/png;base64,${"A".repeat(5_000_000)}`,
        };
        const { ctx } = makeContext([big]);
        const tool = findTool(buildCanvasTools(ctx), "local_file_read");
        const result = await tool.execute("call-1", { handle: "img-handle", mode: "meta" });
        const textBlock = result.content[0] as { type: "text"; text: string };
        // Meta path must never inline data URL or base64.
        expect(textBlock.text.length).toBeLessThan(512);
        expect(textBlock.text).not.toContain("AAAA");
    });
});

describe("view_image", () => {
    function imageContext(): CanvasToolContext {
        return {
            ...makeContext([]).ctx,
            readCanvasImage: async ({ nodeId, imageId }) => ({
                ok: true,
                image: {
                    nodeId,
                    ...(imageId ? { imageId } : {}),
                    title: "Reference",
                    dataUrl: `data:image/png;base64,${TINY_PNG_BASE64}`,
                    mimeType: "image/png",
                    width: 1,
                    height: 1,
                    sizeBytes: 68,
                },
            }),
        };
    }

    it("is registered only when the active model has a canvas image reader", () => {
        expect(buildCanvasTools(makeContext([]).ctx).some((tool) => tool.name === "view_image")).toBe(false);
        expect(buildCanvasTools(imageContext()).some((tool) => tool.name === "view_image")).toBe(true);
    });

    it("returns a typed image and keeps encoded bytes out of text and details", async () => {
        const tool = findTool(buildCanvasTools(imageContext()), "view_image");
        const result = await tool.execute("call-view", { nodeId: "node-1", imageId: "image-2" });

        expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("node-1") });
        expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Reference") });
        expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("68 B") });
        expect(result.content[1]).toEqual({ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
        expect(JSON.stringify(result.content[0])).not.toContain(TINY_PNG_BASE64);
        expect(JSON.stringify(result.details)).not.toContain(TINY_PNG_BASE64);
        expect(JSON.stringify(result.details)).not.toContain("data:image/");
        expect(result.details).toMatchObject({ nodeId: "node-1", imageId: "image-2", detail: "high" });
    });

    it("returns a text-only error when the renderer cannot resolve the image", async () => {
        const ctx: CanvasToolContext = { ...makeContext([]).ctx, readCanvasImage: async () => ({ ok: false, error: "image missing" }) };
        const result = await findTool(buildCanvasTools(ctx), "view_image").execute("call-view", { nodeId: "missing" });

        expect(result.content).toEqual([{ type: "text", text: "image missing" }]);
    });
});

describe("agent node placement", () => {
    it("canvas_generate_node 不再算坐标：无参考时 add_node 不带 position/anchorNodeIds（renderer 依选区放置）", async () => {
        const emitted: unknown[] = [];
        const ctx: CanvasToolContext = {
            getSnapshot: () => ({
                projectId: "p",
                canvasId: "c",
                title: "t",
                nodes: [{ id: "selected", type: "image", title: "Selected", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: {} }],
                connections: [],
                selectedNodeIds: ["selected"],
                viewport: { x: 600, y: 300, k: 1 },
                viewportSize: { width: 1200, height: 720 },
            }),
            emitOps: (ops) => { emitted.push(...ops); },
        };
        const tool = findTool(buildCanvasTools(ctx), "canvas_generate_node");
        await tool.execute("call-1", { prompt: "a red apple", mode: "image" });

        const addNode = emitted.find((op) => (op as { type?: string }).type === "add_node") as { position?: { x: number; y: number }; anchorNodeIds?: string[] };
        expect(addNode.position).toBeUndefined();
        expect(addNode.anchorNodeIds).toBeUndefined();
    });

    it("generate_node carries video and audio parameters into node metadata", async () => {
        const emitted: unknown[] = [];
        const ctx: CanvasToolContext = {
            getSnapshot: () => ({
                projectId: "p", canvasId: "c", title: "t",
                nodes: [], connections: [], selectedNodeIds: [],
                viewport: { x: 0, y: 0, k: 1 }, viewportSize: { width: 1200, height: 720 },
            }),
            emitOps: (ops) => { emitted.push(...ops); },
        };
        const tool = findTool(buildCanvasTools(ctx), "canvas_generate_node");
        await tool.execute("call-1", {
            prompt: "一段产品视频", mode: "video",
            seconds: "10", vquality: "768p横", generateAudio: "true", watermark: "false",
            audioVoice: "alloy", audioFormat: "mp3", audioSpeed: "1.1", audioInstructions: "热情一点",
        });

        const addNode = emitted.find((op) => (op as { type?: string }).type === "add_node") as { metadata?: Record<string, unknown> };
        expect(addNode.metadata).toMatchObject({
            generationMode: "video",
            seconds: "10",
            vquality: "768p横",
            generateAudio: "true",
            watermark: "false",
            voice: "alloy",
            audioFormat: "mp3",
            audioSpeed: "1.1",
            audioInstructions: "热情一点",
        });
    });

    it("update_node moves nodes relatively via dx/dy with dx taking precedence over position", async () => {
        const emitted: unknown[] = [];
        const ctx: CanvasToolContext = {
            getSnapshot: () => ({
                projectId: "p", canvasId: "c", title: "t",
                nodes: [{ id: "n1", type: "text", title: "N1", position: { x: 100, y: 200 }, width: 200, height: 120, metadata: {} }],
                connections: [], selectedNodeIds: [],
                viewport: { x: 0, y: 0, k: 1 }, viewportSize: { width: 1200, height: 720 },
            }),
            emitOps: (ops) => { emitted.push(...ops); },
        };
        const tool = findTool(buildCanvasTools(ctx), "canvas_update_node");

        await tool.execute("call-1", { id: "n1", patch: { dx: 50, dy: -30 } });
        await tool.execute("call-2", { id: "n1", patch: { dx: 10, position: { x: 999, y: 999 } } });

        const moved = emitted[0] as { patch?: { position?: { x: number; y: number }; dx?: number; dy?: number } };
        expect(moved.patch?.position).toEqual({ x: 150, y: 170 });
        expect(moved.patch?.dx).toBeUndefined();
        expect(moved.patch?.dy).toBeUndefined();
        // dx 与 position 同传：x 轴 dx 优先，y 轴无 dy 时回落 position.y（逐轴独立，继承原 move_nodes 语义）
        const mixed = emitted[1] as { patch?: { position?: { x: number; y: number } } };
        expect(mixed.patch?.position).toEqual({ x: 110, y: 999 });
    });

    it("generate_text 无 prompt 且无 x/y 时 add_node 不带坐标（renderer 自行放置）", async () => {
        const emitted: unknown[] = [];
        const ctx: CanvasToolContext = {
            getSnapshot: () => ({
                projectId: "p",
                canvasId: "c",
                title: "t",
                nodes: [],
                connections: [],
                selectedNodeIds: [],
                viewport: { x: 600, y: 300, k: 2 },
                viewportSize: { width: 1200, height: 720 },
            }),
            emitOps: (ops) => { emitted.push(...ops); },
        };
        const tool = findTool(buildCanvasTools(ctx), "canvas_generate_text");

        await tool.execute("call-1", {});

        const addNode = emitted[0] as { position?: { x: number; y: number }; metadata?: { prompt?: string } };
        expect(addNode.position).toBeUndefined();
        expect(addNode.metadata?.prompt).toBeUndefined();
    });


    it("批量文本节点收敛为单个 add_text_nodes op（含 direction/gap，无坐标）", async () => {
        const emitted: unknown[] = [];
        const ctx: CanvasToolContext = {
            getSnapshot: () => ({
                projectId: "p",
                canvasId: "c",
                title: "t",
                nodes: [{ id: "selected", type: "image", title: "Selected", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: {} }],
                connections: [],
                selectedNodeIds: ["selected"],
                viewport: { x: 0, y: 0, k: 1 },
                viewportSize: { width: 1200, height: 720 },
            }),
            emitOps: (ops) => { emitted.push(...ops); },
        };
        const tool = findTool(buildCanvasTools(ctx), "canvas_create_text_nodes");

        await tool.execute("call-1", { items: [{ text: "1" }, { text: "2" }, { text: "3" }], direction: "column", gap: 24 });

        expect(emitted).toEqual([
            { type: "add_text_nodes", items: [{ text: "1" }, { text: "2" }, { text: "3" }], direction: "column", gap: 24 },
        ]);
    });

    it("canvas_create_text_nodes 发单个 add_text_nodes op（主进程不再算坐标）", async () => {
        const { ctx } = makeContext([]);
        const emitted: CanvasAgentOp[][] = [];
        (ctx as { emitOps: unknown }).emitOps = (ops: CanvasAgentOp[]) => { emitted.push(ops); };
        const tool = findTool(buildCanvasTools(ctx), "canvas_create_text_nodes");
        await tool.execute("call", { items: [{ text: "a" }, { text: "b" }], direction: "row" }, undefined, undefined);
        expect(emitted[0]).toEqual([{ type: "add_text_nodes", items: [{ text: "a" }, { text: "b" }], direction: "row" }]);
    });

    it("canvas_generate_node 的 add_node 不带 position，带 anchorNodeIds", async () => {
        const { ctx } = makeContext([]);
        (ctx as { getSnapshot: unknown }).getSnapshot = () => ({ projectId: "p", canvasId: "c", title: "t", nodes: [{ id: "ref1", type: "image", title: "r", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: {} }], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } } as never);
        const emitted: CanvasAgentOp[][] = [];
        (ctx as { emitOps: unknown }).emitOps = (ops: CanvasAgentOp[]) => { emitted.push(ops); };
        const tool = findTool(buildCanvasTools(ctx), "canvas_generate_node");
        await tool.execute("call", { prompt: "p", mode: "image", referenceNodeIds: ["ref1"] }, undefined, undefined);
        const addNode = emitted[0].find((op) => op.type === "add_node") as { position?: unknown; anchorNodeIds?: string[] };
        expect(addNode.position).toBeUndefined();
        expect(addNode.anchorNodeIds).toEqual(["ref1"]);
    });


});

describe("canvas_set_3d_camera", () => {
    const modelNode = { id: "model-1", type: "3d", title: "Model", position: { x: 0, y: 0 }, width: 640, height: 480, metadata: { model3d: { name: "model.glb" } } };

    it("emits an explicit camera operation from a semantic preset with custom overrides", async () => {
        const emitted: unknown[] = [];
        const ctx: CanvasToolContext = {
            getSnapshot: () => ({ projectId: "p", canvasId: "c", title: "t", nodes: [modelNode], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } }),
            emitOps: (ops) => { emitted.push(...ops); },
        };
        const tool = findTool(buildCanvasTools(ctx), "canvas_set_3d_camera");
        await tool.execute("call-camera", { nodeId: "model-1", preset: "isometric", elevation: 30, distanceRatio: 3 });
        expect(emitted).toEqual([{ type: "set_3d_camera", nodeId: "model-1", camera: { azimuth: 45, elevation: 30, distanceRatio: 3 } }]);
    });

    it("does not emit when the target is missing or is not a 3D node", async () => {
        const emitted: unknown[] = [];
        const ctx: CanvasToolContext = {
            getSnapshot: () => ({ projectId: "p", canvasId: "c", title: "t", nodes: [{ ...modelNode, id: "image-1", type: "image" }], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } }),
            emitOps: (ops) => { emitted.push(...ops); },
        };
        const tool = findTool(buildCanvasTools(ctx), "canvas_set_3d_camera");
        const missing = await tool.execute("call-missing", { nodeId: "missing", preset: "front" });
        const wrongType = await tool.execute("call-wrong", { nodeId: "image-1", preset: "front" });
        expect(emitted).toEqual([]);
        expect((missing.content[0] as { text: string }).text).toContain("不存在");
        expect((wrongType.content[0] as { text: string }).text).toContain("3D");
    });

    it("rejects non-finite angles and non-positive distance", async () => {
        const emitted: unknown[] = [];
        const ctx: CanvasToolContext = {
            getSnapshot: () => ({ projectId: "p", canvasId: "c", title: "t", nodes: [modelNode], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } }),
            emitOps: (ops) => { emitted.push(...ops); },
        };
        const tool = findTool(buildCanvasTools(ctx), "canvas_set_3d_camera");
        const invalidAngle = await tool.execute("call-angle", { nodeId: "model-1", azimuth: Number.POSITIVE_INFINITY });
        const invalidDistance = await tool.execute("call-distance", { nodeId: "model-1", distanceRatio: 0 });
        expect(emitted).toEqual([]);
        expect((invalidAngle.content[0] as { text: string }).text).toContain("有限数字");
        expect((invalidDistance.content[0] as { text: string }).text).toContain("大于 0");
    });
});


describe("script node tools", () => {
    function makeScriptContext(
        extraNodes: Array<import("@/lib/canvas/canvas-agent-op-types").CanvasAgentSnapshot["nodes"][number]> = [],
        scriptStatus: "idle" | "generating" = "idle",
        entityOpts: { entities?: Array<Record<string, unknown>>; entityChannel?: boolean } = {},
    ) {
        const ops: import("@/lib/canvas/canvas-agent-op-types").CanvasAgentOp[] = [];
        const ctx: CanvasToolContext = {
            getSnapshot: () => ({
                projectId: "p",
                canvasId: "c",
                title: "t",
                nodes: [
                    { id: "script-1", type: "script", title: "脚本", position: { x: 0, y: 0 }, width: 250, height: 170, metadata: { script: { schemaVersion: 1, instruction: "i", globalStyle: "", entityIds: [], output: { status: scriptStatus, shots: [{ shotId: "shot_a", no: 1, origin: "manual", shotSize: "中景", angle: "平视", movement: "固定", duration: 4, mood: "温暖", sfx: "", dialogue: "", descriptionRich: [], description: "d", entityRefs: [], composed: false }] } } } },
                    ...extraNodes,
                ],
                connections: [],
                selectedNodeIds: [],
                viewport: { x: 0, y: 0, k: 1 },
            }),
            emitOps: (batch) => { ops.push(...batch); },
            listScriptEntities: async () => (entityOpts.entityChannel === false
                ? { ok: false, error: "未同步" }
                : { ok: true, entities: (entityOpts.entities ?? []) as never }),
        };
        return { ctx, ops };
    }

    it("canvas_generate_script 只创建节点（generating 态）并返回创作任务书，不再发 run_generation", async () => {
        const { ctx, ops } = makeScriptContext();
        const result = await findTool(buildCanvasTools(ctx), "canvas_generate_script").execute("t", { instruction: "做菜短片", shotCount: 6, referenceNodeIds: ["img-9"] });
        const addOp = ops.find((op) => op.type === "add_node");
        expect(addOp).toMatchObject({ nodeType: "script", metadata: { script: { output: { status: "generating", shots: [] } } } });
        expect(ops).toContainEqual({ type: "connect_nodes", fromNodeId: "img-9", toNodeId: addOp!.id });
        expect(ops.some((op) => op.type === "run_generation")).toBe(false);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("canvas_script_asset");
        expect(text).toContain("canvas_script_replace_shots");
        expect(text).toContain(addOp!.id);
    });

    it("canvas_script_replace_shots entityRefs 全命中：resolve op 携带 entityIds", async () => {
        const entities = [{ id: "ent_1", projectId: "p", group: "item", name: "iPhone Fold", refs: [] }];
        const { ctx, ops } = makeScriptContext([], "idle", { entities });
        await findTool(buildCanvasTools(ctx), "canvas_script_replace_shots").execute("t", {
            nodeId: "script-1",
            shots: [{ description: "镜一", entityRefs: ["iPhone Fold"] }],
        });
        const resolveOp = ops.find((op) => op.type === "script_resolve_shot_refs") as { names: string[]; entityIds?: string[] };
        expect(resolveOp.entityIds).toEqual(["ent_1"]);
    });

    it("canvas_script_replace_shots entityRefs 未命中：整体报错、不发任何 op、列出可用实体", async () => {
        const entities = [{ id: "ent_1", projectId: "p", group: "item", name: "iPhone Fold", refs: [] }];
        const { ctx, ops } = makeScriptContext([], "idle", { entities });
        const result = await findTool(buildCanvasTools(ctx), "canvas_script_replace_shots").execute("t", {
            nodeId: "script-1",
            shots: [{ description: "镜一", entityRefs: ["image-123"] }],
        });
        expect(ops).toHaveLength(0);
        const text = JSON.stringify(result.content);
        expect(text).toContain("image-123");
        expect(text).toContain("iPhone Fold");
    });

    it("实体表不可用时降级：不带 entityIds 的 resolve op（现状行为）", async () => {
        const { ctx, ops } = makeScriptContext([], "idle", { entityChannel: false });
        await findTool(buildCanvasTools(ctx), "canvas_script_replace_shots").execute("t", {
            nodeId: "script-1",
            shots: [{ description: "镜一", entityRefs: ["任意名"] }],
        });
        const resolveOp = ops.find((op) => op.type === "script_resolve_shot_refs") as { entityIds?: string[] };
        expect(resolveOp).toBeDefined();
        expect(resolveOp.entityIds).toBeUndefined();
    });

    it("canvas_script_asset 新实体 + refNodeIds：绑定槽位、不建图节点、不生成", async () => {
        const imageNode = { id: "image-src", type: "image", title: "产品图", position: { x: 0, y: 0 }, width: 340, height: 240, metadata: {} } as never;
        const { ctx, ops } = makeScriptContext([imageNode]);
        await findTool(buildCanvasTools(ctx), "canvas_script_asset").execute("t", { scriptNodeId: "script-1", group: "scene", name: "晨间卧室", refNodeIds: ["image-src"] });
        expect(ops.find((op) => op.type === "add_node")).toBeUndefined();
        expect(ops.find((op) => op.type === "run_generation")).toBeUndefined();
        const entityOp = ops.find((op) => op.type === "script_entity_upsert") as { entity: { id: string; refs: Array<{ id: string; label: string; state: string }> } };
        expect(entityOp.entity.refs).toHaveLength(1);
        expect(entityOp.entity.refs[0]).toMatchObject({ label: "sheet", state: "empty" });
        expect(ops).toContainEqual({ type: "script_assign_entity_ref", entityId: entityOp.entity.id, refId: entityOp.entity.refs[0].id, nodeId: "image-src" });
    });

    it("canvas_script_asset accepts a 3d node declared as an image reference", async () => {
        const modelNode = { id: "shoe-3d", type: "3d", title: "鞋子", position: { x: 0, y: 0 }, width: 640, height: 480, metadata: {}, referenceKind: "image", referenceCount: 4 } as never;
        const { ctx, ops } = makeScriptContext([modelNode]);

        await findTool(buildCanvasTools(ctx), "canvas_script_asset").execute("bind", {
            scriptNodeId: "script-1", group: "item", name: "李宁跑鞋", refNodeIds: ["shoe-3d"],
        });

        const entityOp = ops.find((op) => op.type === "script_entity_upsert") as { entity: { id: string; refs: Array<{ id: string }> } };
        expect(ops).toContainEqual({ type: "script_assign_entity_ref", entityId: entityOp.entity.id, refId: entityOp.entity.refs[0].id, nodeId: "shoe-3d" });
        expect(ops.find((op) => op.type === "run_generation")).toBeUndefined();
    });

    it("canvas_script_generate_storyboards emits script-owned generation ops with script image settings", async () => {
        const { ctx, ops } = makeScriptContext();
        const snapshot = ctx.getSnapshot();
        const scriptNode = snapshot.nodes[0]!;
        scriptNode.metadata!.script!.output.shots[0]!.entityRefs = ["ent-ready"];
        snapshot.nodes.push({ id: "image-ready", type: "image", title: "参考图", position: { x: 300, y: 0 }, width: 250, height: 170, metadata: {} });
        scriptNode.metadata = {
            ...scriptNode.metadata,
            script: {
                ...scriptNode.metadata!.script!,
                template: { storyboardFirst: true, imageGen: { size: "16:9", quality: "high", count: 1 } },
            },
        };
        ctx.getSnapshot = () => snapshot;
        ctx.listScriptEntities = async () => ({ ok: true, entities: [{ id: "ent-ready", projectId: "p", group: "character", name: "主角", refs: [{ id: "ref-1", label: "sheet", state: "ready", source: "canvas", nodeId: "image-ready" }] }] });

        const result = await findTool(buildCanvasTools(ctx), "canvas_script_generate_storyboards").execute("storyboards", { scriptNodeId: "script-1" });

        expect(ops).toEqual([{
            type: "script_generate_storyboard",
            nodeId: "script-1",
            shotId: "shot_a",
            settings: { metadata: { size: "16:9", quality: "high", count: 1 } },
        }]);
        expect(JSON.stringify(result.content)).toContain("1 个镜头");
    });

    it("canvas_script_generate_storyboards replaces a stale text-only template model with a reference-capable managed model", async () => {
        const { ctx, ops } = makeScriptContext();
        const snapshot = ctx.getSnapshot();
        const scriptNode = snapshot.nodes[0]!;
        scriptNode.metadata!.script!.output.shots[0]!.entityRefs = ["ent-ready"];
        snapshot.nodes.push({ id: "image-ready", type: "image", title: "参考图", position: { x: 300, y: 0 }, width: 250, height: 170, metadata: {} });
        scriptNode.metadata = {
            ...scriptNode.metadata,
            script: {
                ...scriptNode.metadata!.script!,
                template: { storyboardFirst: true, imageGen: { model: "managed-text-only", size: "16:9" } },
            },
        };
        ctx.getSnapshot = () => snapshot;
        ctx.listScriptEntities = async () => ({ ok: true, entities: [{ id: "ent-ready", projectId: "p", group: "character", name: "主角", refs: [{ id: "ref-1", label: "sheet", state: "ready", source: "canvas", nodeId: "image-ready" }] }] });
        ctx.listModels = async () => ({ ok: true, models: [
            { id: "managed-text-only", name: "Text", capability: "image", channelName: "ShotShot", provider: "shotshot", inputMode: "text", requiresReference: false, isDefault: true },
            { id: "managed-edit", name: "Edit", capability: "image", channelName: "ShotShot", provider: "shotshot", inputMode: "text-and-image", requiresReference: false, isDefault: false },
        ] });

        await findTool(buildCanvasTools(ctx), "canvas_script_generate_storyboards").execute("storyboards", { scriptNodeId: "script-1" });

        expect(ops).toEqual([expect.objectContaining({
            type: "script_generate_storyboard",
            settings: { metadata: { model: "managed-edit", size: "16:9" }, managedImageModel: "managed-edit" },
        })]);
    });

    it("canvas_script_generate_storyboards refuses to generate a keyframe without ready referenced assets", async () => {
        const { ctx, ops } = makeScriptContext();
        const snapshot = ctx.getSnapshot();
        const scriptNode = snapshot.nodes[0]!;
        scriptNode.metadata = {
            ...scriptNode.metadata,
            script: { ...scriptNode.metadata!.script!, template: { storyboardFirst: true } },
        };
        ctx.getSnapshot = () => snapshot;

        const result = await findTool(buildCanvasTools(ctx), "canvas_script_generate_storyboards").execute("storyboards", { scriptNodeId: "script-1" });

        expect(ops).toEqual([]);
        expect(JSON.stringify(result.content)).toContain("就绪资产参考图");
    });

    it("canvas_script_generate_storyboards requires and forwards a view choice for every referenced 3D asset", async () => {
        const modelNode = { id: "shoe-3d", type: "3d", title: "鞋子", position: { x: 300, y: 0 }, width: 640, height: 480, metadata: {}, referenceKind: "image", referenceCount: 4 } as never;
        const entities = [{ id: "ent-shoe", projectId: "p", group: "item", name: "跑鞋", refs: [{ id: "ref-1", label: "sheet", state: "ready", source: "canvas", nodeId: "shoe-3d" }] }];
        const { ctx, ops } = makeScriptContext([modelNode], "idle", { entities });
        const snapshot = ctx.getSnapshot();
        const scriptNode = snapshot.nodes[0]!;
        scriptNode.metadata!.script!.output.shots[0]!.entityRefs = ["ent-shoe"];
        scriptNode.metadata = { ...scriptNode.metadata, script: { ...scriptNode.metadata!.script!, template: { storyboardFirst: true } } };
        ctx.getSnapshot = () => snapshot;

        const missing = await findTool(buildCanvasTools(ctx), "canvas_script_generate_storyboards").execute("missing", { scriptNodeId: "script-1" });
        expect(ops).toEqual([]);
        expect(JSON.stringify(missing.content)).toContain("shoe-3d");

        await findTool(buildCanvasTools(ctx), "canvas_script_generate_storyboards").execute("selected", {
            scriptNodeId: "script-1", reference3dSelections: [{ nodeId: "shoe-3d", view: "top" }],
        });
        expect(ops).toEqual([expect.objectContaining({
            type: "script_generate_storyboard",
            settings: { metadata: { reference3dViews: { "shoe-3d": "top" } } },
        })]);
    });

    it("canvas_script_asset 默认只建实体与槽位，不触发生成", async () => {
        const { ctx, ops } = makeScriptContext();
        await findTool(buildCanvasTools(ctx), "canvas_script_asset").execute("t", { scriptNodeId: "script-1", group: "scene", name: "木质工作台" });
        expect(ops.find((op) => op.type === "add_node")).toBeUndefined();
        expect(ops.find((op) => op.type === "run_generation")).toBeUndefined();
        expect(ops.find((op) => op.type === "script_entity_upsert")).toBeDefined();
        expect(ops.find((op) => op.type === "script_bind_entity")).toBeDefined();
    });

    it("canvas_script_asset 同名实体复用：更新既有 id、省略 refs、generate=true 但已有 ready 槽位时跳过生成", async () => {
        const existing = { id: "ent_exist", projectId: "p", group: "character", name: "晨间卧室", refs: [{ id: "ref_r1", label: "sheet", state: "ready", source: "canvas", nodeId: "image-src" }] };
        const { ctx, ops } = makeScriptContext([], "idle", { entities: [existing] });
        const result = await findTool(buildCanvasTools(ctx), "canvas_script_asset").execute("t", { scriptNodeId: "script-1", group: "scene", name: "晨间卧室", appearance: "新外观", generate: true });
        const entityOp = ops.find((op) => op.type === "script_entity_upsert") as { entity: { id: string; group: string; refs?: unknown } };
        expect(entityOp.entity.id).toBe("ent_exist");
        expect(entityOp.entity.group).toBe("scene");
        expect("refs" in entityOp.entity).toBe(false);
        expect(ops.find((op) => op.type === "run_generation")).toBeUndefined();
        expect(JSON.stringify(result.content)).toContain("已有参考图");
    });

    it("canvas_script_asset refNodeIds 含非法节点：整体报错不发 ops", async () => {
        const { ctx, ops } = makeScriptContext();
        const result = await findTool(buildCanvasTools(ctx), "canvas_script_asset").execute("t", { scriptNodeId: "script-1", group: "scene", name: "城市夜景", refNodeIds: ["image-ghost"] });
        expect(ops).toHaveLength(0);
        expect(JSON.stringify(result.content)).toContain("image-ghost");
    });

    it("canvas_script_asset generate=true（显式许可）emits entity_upsert + bind + image node with scriptEntityRef + run_generation(image)", async () => {
        const { ctx, ops } = makeScriptContext();
        await findTool(buildCanvasTools(ctx), "canvas_script_asset").execute("t", { scriptNodeId: "script-1", group: "character", name: "狸花猫大厨", imagePrompt: "tabby chef", generate: true });
        const entityOp = ops.find((op) => op.type === "script_entity_upsert");
        expect(entityOp).toMatchObject({ entity: { group: "character", name: "狸花猫大厨", projectId: "p" } });
        expect(ops).toContainEqual({ type: "script_bind_entity", nodeId: "script-1", entityId: (entityOp as { entity: { id: string } }).entity.id });
        const addOp = ops.find((op) => op.type === "add_node");
        const refOp = entityOp as { entity: { id: string; refs?: Array<{ id: string }> } };
        expect(entityOp).toMatchObject({ entity: { refs: [{ label: "sheet", state: "empty" }] } });
        expect(addOp).toMatchObject({ nodeType: "image", metadata: { prompt: "【角色：狸花猫大厨】\ntabby chef", scriptEntityRef: { entityId: refOp.entity.id, refId: refOp.entity.refs?.[0]?.id } } });
        expect(ops.find((op) => op.type === "run_generation")).toMatchObject({ mode: "image" });
    });

    it("canvas_script_asset 参考图提示词拼入全部设定（不再单字段回退丢 appearance/consistency）", async () => {
        const { ctx, ops } = makeScriptContext();
        await findTool(buildCanvasTools(ctx), "canvas_script_asset").execute("t", {
            scriptNodeId: "script-1", group: "character", name: "狸花猫大厨", role: "主角",
            appearance: "橘色虎斑猫，系白色围裙", consistency: "左耳缺口", imagePrompt: "tabby chef", generate: true,
        });
        const addOp = ops.find((op) => op.type === "add_node") as { metadata: { prompt: string } };
        expect(addOp.metadata.prompt).toBe("【角色：狸花猫大厨 · 主角】\ntabby chef\n定义：橘色虎斑猫，系白色围裙\n一致性：左耳缺口");
        expect(ops.find((op) => op.type === "run_generation")).toMatchObject({ prompt: addOp.metadata.prompt });
    });

    it("canvas_script_asset 生成路径的 bind 先于 run_generation（生成时实体→脚本反向索引依赖该顺序做资产溯源）", async () => {
        const { ctx, ops } = makeScriptContext();
        await findTool(buildCanvasTools(ctx), "canvas_script_asset").execute("t", { scriptNodeId: "script-1", group: "character", name: "狸花猫大厨", imagePrompt: "tabby chef", generate: true });
        const bindIndex = ops.findIndex((op) => op.type === "script_bind_entity");
        const generationIndex = ops.findIndex((op) => op.type === "run_generation");
        expect(bindIndex).toBeGreaterThanOrEqual(0);
        expect(generationIndex).toBeGreaterThan(bindIndex);
    });

    it("canvas_script_update_shot patches an existing shot via script_upsert_shot", async () => {
        const { ctx, ops } = makeScriptContext();
        await findTool(buildCanvasTools(ctx), "canvas_script_update_shot").execute("t", { nodeId: "script-1", shotId: "shot_a", shotSize: "特写" });
        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ type: "script_upsert_shot", nodeId: "script-1", shot: { shotId: "shot_a", shotSize: "特写" } });
    });

    it("canvas_script_compile_prompts 批量回写 finalPrompt（保留分镜字段，composed 重置为草稿）", async () => {
        const { ctx, ops } = makeScriptContext();
        const result = await findTool(buildCanvasTools(ctx), "canvas_script_compile_prompts").execute("t", {
            nodeId: "script-1",
            prompts: [{ shotId: "shot_a", finalPrompt: "[16:9 · 4s · 中景 · 固定]\n切开辣椒。<刀声>（无音乐）\n禁止：画面文字" }],
        });
        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({
            type: "script_upsert_shot",
            nodeId: "script-1",
            shot: { shotId: "shot_a", shotSize: "中景", mood: "温暖", composed: false, finalPrompt: expect.stringContaining("[16:9 · 4s · 中景 · 固定]") },
        });
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("已回写 1 条");
    });

    it("canvas_script_compile_prompts 跳过未知 shotId 与空 finalPrompt，不发 op", async () => {
        const { ctx, ops } = makeScriptContext();
        const result = await findTool(buildCanvasTools(ctx), "canvas_script_compile_prompts").execute("t", {
            nodeId: "script-1",
            prompts: [
                { shotId: "shot_missing", finalPrompt: "x" },
                { shotId: "shot_a", finalPrompt: "   " },
            ],
        });
        expect(ops).toHaveLength(0);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("已回写 0 条");
        expect(text).toContain("shot_missing");
        expect(text).toContain("finalPrompt 为空");
    });

    it("canvas_script_compile_prompts 拒绝非脚本节点", async () => {
        const { ctx } = makeScriptContext([
            { id: "img-1", type: "image", title: "图", position: { x: 0, y: 0 }, width: 250, height: 170, metadata: {} },
        ]);
        const result = await findTool(buildCanvasTools(ctx), "canvas_script_compile_prompts").execute("t", {
            nodeId: "img-1",
            prompts: [{ shotId: "s", finalPrompt: "x" }],
        });
        expect((result.content[0] as { text: string }).text).toContain("不是脚本节点");
    });

    it("canvas_script_add_shot 追加全字段镜头并在有 entityRefs 时 emit resolve op", async () => {
        const { ctx, ops } = makeScriptContext([], "idle", { entities: [{ id: "ent_chef", projectId: "p", group: "character", name: "狸花猫大厨", refs: [] }] });
        await findTool(buildCanvasTools(ctx), "canvas_script_add_shot").execute("t", {
            nodeId: "script-1", description: "特写：切辣椒", shotSize: "特写", angle: "俯拍", movement: "拉镜", duration: 3, mood: "冷峻赛博", sfx: "刀声", dialogue: "「好辣」", entityRefs: ["狸花猫大厨"],
        });
        const upsert = ops.find((op) => op.type === "script_upsert_shot");
        expect(upsert).toMatchObject({ nodeId: "script-1", shot: { shotSize: "特写", mood: "冷峻赛博", sfx: "刀声", dialogue: "「好辣」", origin: "manual" } });
        expect(ops).toContainEqual({ type: "script_resolve_shot_refs", nodeId: "script-1", shotId: (upsert as { shot: { shotId: string } }).shot.shotId, names: ["狸花猫大厨"], entityIds: ["ent_chef"] });
    });

    it("canvas_script_add_shot 缺省/空白参数落空值（不预填默认词）", async () => {
        const { ctx, ops } = makeScriptContext();
        await findTool(buildCanvasTools(ctx), "canvas_script_add_shot").execute("t", { nodeId: "script-1", description: "x", shotSize: "  " });
        const upsert = ops.find((op) => op.type === "script_upsert_shot") as { shot: Record<string, unknown> };
        expect(upsert.shot).toMatchObject({ shotSize: "", angle: "", movement: "", duration: 0, mood: "", sfx: "", dialogue: "", origin: "manual" });
    });

    it("canvas_script_update_shot 支持 entityRefs 名称列表", async () => {
        const { ctx, ops } = makeScriptContext([], "idle", { entities: [
            { id: "ent_chef", projectId: "p", group: "character", name: "狸花猫大厨", refs: [] },
            { id: "ent_space", projectId: "p", group: "scene", name: "太空餐厅", refs: [] },
        ] });
        await findTool(buildCanvasTools(ctx), "canvas_script_update_shot").execute("t", { nodeId: "script-1", shotId: "shot_a", mood: "忧伤黄昏", entityRefs: ["狸花猫大厨", "太空餐厅"] });
        expect(ops.find((op) => op.type === "script_upsert_shot")).toMatchObject({ shot: { shotId: "shot_a", mood: "忧伤黄昏" } });
        expect(ops).toContainEqual({ type: "script_resolve_shot_refs", nodeId: "script-1", shotId: "shot_a", names: ["狸花猫大厨", "太空餐厅"], entityIds: ["ent_chef", "ent_space"] });
    });

    it("canvas_script_add_shot 携带 sfxAudioNodeId → 组装音频快照", async () => {
        const { ctx, ops } = makeScriptContext([
            { id: "audio-1", type: "audio", title: "环境声", position: { x: 0, y: 0 }, width: 250, height: 170, metadata: { storageKey: "audio:k1", mimeType: "audio/mpeg", durationMs: 3000 } },
        ]);
        await findTool(buildCanvasTools(ctx), "canvas_script_add_shot").execute("t", { nodeId: "script-1", description: "x", sfxAudioNodeId: "audio-1" });
        expect(ops.find((op) => op.type === "script_upsert_shot")).toMatchObject({ shot: { sfxAudio: { audioNodeId: "audio-1", name: "环境声", storageKey: "audio:k1", mimeType: "audio/mpeg", durationMs: 3000 } } });
    });

    it("canvas_script_update_shot：非法/非 Audio 节点报错不写入；传空串清除", async () => {
        const { ctx, ops } = makeScriptContext([
            { id: "img-9", type: "image", title: "图", position: { x: 0, y: 0 }, width: 250, height: 170, metadata: {} },
        ]);
        const tool = findTool(buildCanvasTools(ctx), "canvas_script_update_shot");
        const bad = await tool.execute("t", { nodeId: "script-1", shotId: "shot_a", sfxAudioNodeId: "img-9" });
        expect(String((bad as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? JSON.stringify(bad))).toContain("不是音频节点");
        expect(ops).toHaveLength(0);
        await tool.execute("t", { nodeId: "script-1", shotId: "shot_a", sfxAudioNodeId: "" });
        const upsert = ops.find((op) => op.type === "script_upsert_shot") as { shot: Record<string, unknown> };
        expect(upsert.shot.sfxAudio).toBeUndefined();
    });

    it("canvas_script_replace_shots 一次性写入全部镜头并为含 entityRefs 的镜头 emit resolve op", async () => {
        const { ctx, ops } = makeScriptContext([], "idle", { entities: [{ id: "ent_chef", projectId: "p", group: "character", name: "狸花猫大厨", refs: [] }] });
        await findTool(buildCanvasTools(ctx), "canvas_script_replace_shots").execute("t", {
            nodeId: "script-1",
            shots: [
                { description: "开场：厨房全景", shotSize: "远景", angle: "平视", movement: "推镜", duration: 3.4, mood: "温暖", sfx: "锅铲声", entityRefs: ["狸花猫大厨"] },
                { description: "特写：切辣椒", dialogue: "「好辣」" },
            ],
        });
        const replaceOp = ops.find((op) => op.type === "script_replace_shots") as { nodeId: string; shots: Array<Record<string, unknown>> };
        expect(replaceOp.nodeId).toBe("script-1");
        expect(replaceOp.shots).toHaveLength(2);
        expect(replaceOp.shots[0]).toMatchObject({ no: 0, origin: "manual", duration: 3, descriptionRich: [{ t: "text", v: "开场：厨房全景" }] });
        expect(typeof replaceOp.shots[0].shotId).toBe("string");
        expect(ops.filter((op) => op.type === "script_resolve_shot_refs")).toEqual([
            { type: "script_resolve_shot_refs", nodeId: "script-1", shotId: replaceOp.shots[0].shotId, names: ["狸花猫大厨"], entityIds: ["ent_chef"] },
        ]);
    });

    it("canvas_script_replace_shots 校验：节点不存在/非脚本节点/超上限都报错且不 emit", async () => {
        const { ctx, ops } = makeScriptContext([
            { id: "img-2", type: "image", title: "图", position: { x: 0, y: 0 }, width: 250, height: 170, metadata: {} },
        ]);
        const tool = findTool(buildCanvasTools(ctx), "canvas_script_replace_shots");
        const resultText = (result: unknown) => String((result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? JSON.stringify(result));
        expect(resultText(await tool.execute("t", { nodeId: "nope", shots: [{ description: "x" }] }))).toContain("脚本节点 nope 不存在");
        expect(resultText(await tool.execute("t", { nodeId: "img-2", shots: [{ description: "x" }] }))).toContain("节点 img-2 不是脚本节点，无法写入分镜");
        expect(resultText(await tool.execute("t", { nodeId: "script-1", shots: Array.from({ length: 51 }, () => ({ description: "x" })) }))).toContain("镜头数量 51 超过上限 50");
        expect(ops).toHaveLength(0);
    });

    it("canvas_script_delete_shot / reorder emit their ops", async () => {
        const { ctx, ops } = makeScriptContext();
        await findTool(buildCanvasTools(ctx), "canvas_script_delete_shot").execute("t", { nodeId: "script-1", shotId: "shot_a" });
        await findTool(buildCanvasTools(ctx), "canvas_script_reorder_shots").execute("t", { nodeId: "script-1", shotIds: ["shot_a"] });
        expect(ops).toEqual([
            { type: "script_delete_shot", nodeId: "script-1", shotId: "shot_a" },
            { type: "script_reorder_shots", nodeId: "script-1", shotIds: ["shot_a"] },
        ]);
    });

    it("canvas_generate_script 复用已有脚本节点：只发 script_set_instruction（无 add_node），任务书提示整体替换", async () => {
        const { ctx, ops } = makeScriptContext();
        const result = await findTool(buildCanvasTools(ctx), "canvas_generate_script").execute("t", { nodeId: "script-1", instruction: "新的指令", globalStyle: "胶片感", shotCount: 5 });
        expect(ops).toEqual([{ type: "script_set_instruction", nodeId: "script-1", instruction: "新的指令", globalStyle: "胶片感" }]);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("整体替换");
        expect(text).toContain("数量参考 5");
        expect(text).toContain("canvas_script_replace_shots");
    });

    it("canvas_generate_script 复用分支 storyboardFirst=true：script_set_instruction 携带 template patch 落库模式开关", async () => {
        const { ctx, ops } = makeScriptContext();
        await findTool(buildCanvasTools(ctx), "canvas_generate_script").execute("t", { nodeId: "script-1", instruction: "新的指令", storyboardFirst: true });
        expect(ops).toEqual([{ type: "script_set_instruction", nodeId: "script-1", instruction: "新的指令", template: { storyboardFirst: true } }]);
    });

    it("canvas_generate_script 复用目标不存在/非脚本节点时报错且不 emit", async () => {
        const { ctx, ops } = makeScriptContext([
            { id: "img-2", type: "image", title: "图", position: { x: 0, y: 0 }, width: 250, height: 170, metadata: {} },
        ]);
        const tool = findTool(buildCanvasTools(ctx), "canvas_generate_script");
        const resultText = (result: unknown) => String((result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? JSON.stringify(result));
        expect(resultText(await tool.execute("t", { nodeId: "nope", instruction: "x" }))).toContain("脚本节点 nope 不存在");
        expect(resultText(await tool.execute("t", { nodeId: "img-2", instruction: "x" }))).toContain("节点 img-2 不是脚本节点，无法复用");
        expect(ops).toEqual([]);
    });

    it("canvas_script_replace_shots：generating 态空分镜被拒绝（ops 为空，不虚假成功）", async () => {
        const { ctx, ops } = makeScriptContext([], "generating");
        const result = await findTool(buildCanvasTools(ctx), "canvas_script_replace_shots").execute("t", { nodeId: "script-1", shots: [] });
        expect(ops).toEqual([]);
        expect((result.content[0] as { text: string }).text).toContain("生成中的脚本节点不接受空分镜");
    });

    it("canvas_script_replace_shots：shots 非数组（null）时防御性报错且不 emit", async () => {
        const { ctx, ops } = makeScriptContext();
        const result = await findTool(buildCanvasTools(ctx), "canvas_script_replace_shots").execute("t", { nodeId: "script-1", shots: null as unknown as [] });
        expect(ops).toEqual([]);
        expect((result.content[0] as { text: string }).text).toContain("shots 需为分镜数组");
    });

    it("canvas_script_replace_shots 透传 storyboardPrompt", async () => {
        const { ctx, ops } = makeScriptContext();
        await findTool(buildCanvasTools(ctx), "canvas_script_replace_shots").execute("t", { nodeId: "script-1", shots: [{ description: "d", storyboardPrompt: "静态帧：…" }] });
        expect(ops.find((op) => op.type === "script_replace_shots")).toMatchObject({ shots: [{ storyboardPrompt: "静态帧：…" }] });
    });

    it("canvas_script_replace_shots 同数同序按位沿用旧 shotId（分镜图/视频映射续接）", async () => {
        const { ctx, ops } = makeScriptContext();
        const result = await findTool(buildCanvasTools(ctx), "canvas_script_replace_shots").execute("t", {
            nodeId: "script-1",
            shots: [{ description: "优化后的描述" }],
        });
        const replaceOp = ops.find((op) => op.type === "script_replace_shots") as { shots: Array<{ shotId: string; description: string }> };
        expect(replaceOp.shots[0].shotId).toBe("shot_a");
        expect(replaceOp.shots[0].description).toBe("优化后的描述");
        expect((result.content[0] as { text: string }).text).toContain("沿用 1 条旧镜头身份");
    });

    it("canvas_script_replace_shots 数量不同时不按位沿用：全新 shotId", async () => {
        const { ctx, ops } = makeScriptContext();
        await findTool(buildCanvasTools(ctx), "canvas_script_replace_shots").execute("t", {
            nodeId: "script-1",
            shots: [{ description: "镜一" }, { description: "镜二" }],
        });
        const replaceOp = ops.find((op) => op.type === "script_replace_shots") as { shots: Array<{ shotId: string }> };
        expect(replaceOp.shots.map((s) => s.shotId)).not.toContain("shot_a");
        expect(new Set(replaceOp.shots.map((s) => s.shotId)).size).toBe(2);
    });

    it("canvas_script_replace_shots 显式 replacesShotId 命中：继承旧身份", async () => {
        const { ctx, ops } = makeScriptContext();
        const result = await findTool(buildCanvasTools(ctx), "canvas_script_replace_shots").execute("t", {
            nodeId: "script-1",
            shots: [{ description: "重写后的镜头", replacesShotId: "shot_a" }],
        });
        const replaceOp = ops.find((op) => op.type === "script_replace_shots") as { shots: Array<{ shotId: string }> };
        expect(replaceOp.shots[0].shotId).toBe("shot_a");
        expect((result.content[0] as { text: string }).text).toContain("沿用 1 条旧镜头身份");
    });

    it("canvas_script_replace_shots replacesShotId 不存在：报错且不发任何 op", async () => {
        const { ctx, ops } = makeScriptContext();
        const result = await findTool(buildCanvasTools(ctx), "canvas_script_replace_shots").execute("t", {
            nodeId: "script-1",
            shots: [{ description: "镜一", replacesShotId: "shot_missing" }],
        });
        expect(ops).toHaveLength(0);
        expect((result.content[0] as { text: string }).text).toContain("shot_missing");
    });

    it("canvas_script_replace_shots replacesShotId 重复使用：报错且不发任何 op", async () => {
        const { ctx, ops } = makeScriptContext();
        const result = await findTool(buildCanvasTools(ctx), "canvas_script_replace_shots").execute("t", {
            nodeId: "script-1",
            shots: [{ description: "镜一", replacesShotId: "shot_a" }, { description: "镜二", replacesShotId: "shot_a" }],
        });
        expect(ops).toHaveLength(0);
        expect((result.content[0] as { text: string }).text).toContain("重复");
    });

    it("canvas_script_update_shot 可单独更新 storyboardPrompt 且不失效 finalPrompt 之外的字段", async () => {
        const { ctx, ops } = makeScriptContext();
        await findTool(buildCanvasTools(ctx), "canvas_script_update_shot").execute("t", { nodeId: "script-1", shotId: "shot_a", storyboardPrompt: "静态帧" });
        expect(ops[0]).toMatchObject({ type: "script_upsert_shot", shot: { shotId: "shot_a", storyboardPrompt: "静态帧" } });
    });

    it("canvas_script_compile_prompts 双写 finalPrompt 与 storyboardPrompt", async () => {
        const { ctx, ops } = makeScriptContext();
        const result = await findTool(buildCanvasTools(ctx), "canvas_script_compile_prompts").execute("t", {
            nodeId: "script-1",
            prompts: [{ shotId: "shot_a", finalPrompt: "从首帧开始：…", storyboardPrompt: "静态帧：…" }],
        });
        expect(ops[0]).toMatchObject({ shot: { finalPrompt: "从首帧开始：…", storyboardPrompt: "静态帧：…", composed: false } });
        expect((result.content[0] as { text: string }).text).toContain("已回写 1 条");
    });

    it("canvas_generate_script storyboardFirst=true → 任务书声明双提示词 + template 落库", async () => {
        const { ctx, ops } = makeScriptContext();
        const result = await findTool(buildCanvasTools(ctx), "canvas_generate_script").execute("t", { instruction: "i", storyboardFirst: true });
        const addOp = ops.find((op) => op.type === "add_node") as { metadata: { script: { template: { storyboardFirst: boolean }; output: { shots: unknown[] } } } };
        expect(addOp.metadata.script.template.storyboardFirst).toBe(true);
        expect((result.content[0] as { text: string }).text).toContain("storyboardPrompt");
    });
});


describe("fal generation tools", () => {
    beforeAll(() => registerBuiltinNodes());
    const model = "channel::fal-ai/flux-2-pro";
    const options = () => patchProviderParams(undefined, model, getFalProfile("fal-ai/flux-2-pro")!, { seed: 7 });
    it("canvas_generate_node preserves options through tool, operation and snapshot", async () => {
        const { ctx } = makeContext([]);
        const ops: CanvasAgentOp[] = [];
        ctx.emitOps = batch => { ops.push(...batch); };
        const providerOptions = options();
        const tool = findTool(buildCanvasTools(ctx), "canvas_generate_node");
        expect(tool.parameters.properties).toHaveProperty("providerOptions");
        await tool.execute("fal", { prompt: "A product photo", model, providerOptions });
        const generationOp = ops.find(op => op.type === "add_node" && op.metadata?.model === model)!;
        expect(generationOp).toMatchObject({ metadata: { providerOptions } });
        const state = applyCanvasAgentOps(ctx.getSnapshot(), ops);
        const nodes = annotateCanvasAgentNodes(state.nodes, falTestConfig);
        expect(nodes.find(node => node.metadata?.model === model)).toMatchObject({ metadata: { providerOptions }, generationContract: { endpointId: "fal-ai/flux-2-pro", profileVersion: 1 } });
        expect(state.nodes.every(node => !("generationContract" in node))).toBe(true);
        ctx.getSnapshot = () => ({ ...state, nodes });
        const read = await findTool(buildCanvasTools(ctx), "canvas_get_state").execute("state", {});
        expect(JSON.parse((read.content[0] as { text: string }).text)).toEqual(ctx.getSnapshot());
    });
    it.each([
        { version: 99, models: {} },
        { ...options(), apiKey: "secret" },
        { version: 1, models: { [model]: { ...options().models[model], profileVersion: 99 } } },
        { version: 1, models: { [model]: { ...options().models[model], params: { seed: { apiKey: "secret" } } } } },
        { version: 1, models: { [model]: { ...options().models[model], params: { seed: () => 7 } } } },
        { version: 1, models: { [model]: { ...options().models[model], params: { baseUrl: "https://evil.invalid" } } } },
    ])("rejects unsafe or unknown options before emitting any operation", async providerOptions => {
        const { ctx } = makeContext([]);
        const ops: CanvasAgentOp[] = [];
        ctx.emitOps = batch => { ops.push(...batch); };
        for (const name of ["canvas_generate_node", "canvas_update_node"]) {
            await expect(findTool(buildCanvasTools(ctx), name).execute("fal", { id: "node", prompt: "photo", model, providerOptions, metadata: { providerOptions } })).rejects.toThrow();
        }
        expect(ops).toEqual([]);
    });
    it("updates provider options through canonical metadata", async () => {
        const { ctx } = makeContext([]);
        const ops: CanvasAgentOp[] = [];
        ctx.emitOps = batch => { ops.push(...batch); };
        const providerOptions = options();
        await findTool(buildCanvasTools(ctx), "canvas_update_node").execute("fal", { id: "node", providerOptions });
        expect(ops).toEqual([{ type: "update_node", id: "node", metadata: { providerOptions } }]);
    });
});


it("guards metadata-only, patch metadata and low-level operation provider options atomically", async () => {
    const { ctx } = makeContext([]);
    const ops: CanvasAgentOp[] = [];
    ctx.emitOps = batch => { ops.push(...batch); };
    const providerOptions = { version: 99, models: {} };
    const tools = buildCanvasTools(ctx);
    for (const payload of [{ metadata: { providerOptions } }, { patch: { metadata: { providerOptions } } }]) {
        await expect(findTool(tools, "canvas_update_node").execute("invalid", { id: "node", ...payload })).rejects.toThrow();
    }
    await expect(findTool(tools, "canvas_apply_ops").execute("invalid", { ops: [
        { type: "add_node", nodeType: "text" },
        { type: "update_node", id: "node", metadata: { providerOptions } },
    ] })).rejects.toThrow();
    expect(ops).toEqual([]);
});


it.each([undefined, null, "1", 99])("canvas_apply_ops rejects malformed profileVersion %s before emitting the batch", async profileVersion => {
    const { ctx } = makeContext([]);
    const ops: CanvasAgentOp[] = [];
    ctx.emitOps = batch => { ops.push(...batch); };
    const model = "channel::fal-ai/flux-2-pro";
    const providerOptions = { version: 1, models: { [model]: { provider: "fal", profileId: "fal-ai/flux-2-pro", ...(profileVersion === undefined ? {} : { profileVersion }), params: { seed: 7 } } } };
    await expect(findTool(buildCanvasTools(ctx), "canvas_apply_ops").execute("invalid-version", { ops: [
        { type: "add_node", nodeType: "text" },
        { type: "add_node", nodeType: "image", metadata: { model, providerOptions } },
    ] })).rejects.toThrow("fal_options_profile");
    expect(ops).toEqual([]);
});

const modelsCtx = (models: unknown[] | null) => {
    const base = makeContext([]).ctx;
    return { ...base, listModels: models ? async () => ({ ok: true as const, models: models as never }) : undefined };
};

describe("models_list", () => {
    const catalog = [
        { id: "ch::img-a", name: "img-a", capability: "image", channelName: "渠道A", isDefault: true },
        { id: "ch::vid-a", name: "vid-a", capability: "video", channelName: "渠道A", isDefault: false },
    ];

    it("按 capability/keyword 过滤并返回 JSON", async () => {
        const result = await findTool(buildCanvasTools(modelsCtx(catalog)), "models_list").execute("call", { capability: "image" });
        const payload = JSON.parse((result.content[0] as { text: string }).text);
        expect(payload.total).toBe(1);
        expect(payload.models[0].id).toBe("ch::img-a");
    });

    it("keyword 命中渠道名或模型名", async () => {
        const result = await findTool(buildCanvasTools(modelsCtx(catalog)), "models_list").execute("call", { keyword: "vid" });
        expect(JSON.parse((result.content[0] as { text: string }).text).total).toBe(1);
    });

    it("listModels 缺失时返回不支持提示", async () => {
        const result = await findTool(buildCanvasTools(modelsCtx(null)), "models_list").execute("call", {});
        expect((result.content[0] as { text: string }).text).toContain("不支持模型列表");
    });

    it("listModels 返回 ok:false（目录未推送）时同样按不支持提示", async () => {
        const ctx = { ...makeContext([]).ctx, listModels: async () => ({ ok: false as const, error: "模型目录尚未推送" }) };
        const result = await findTool(buildCanvasTools(ctx), "models_list").execute("call", {});
        expect((result.content[0] as { text: string }).text).toContain("不支持模型列表");
    });
});

describe("canvas_script_asset 直传生图参数", () => {
    const scriptNodes = [{ id: "s1", type: "script", title: "脚本", position: { x: 0, y: 0 }, width: 250, height: 170, metadata: { script: { schemaVersion: 1, instruction: "i", globalStyle: "", entityIds: [], output: { status: "done", shots: [] } } } }];
    const assetCtx = (models: unknown[] | null, emitted: unknown[][]) => ({
        ...modelsCtx(models),
        getSnapshot: () => ({ ...(makeContext([]).ctx.getSnapshot()), nodes: scriptNodes as never }),
        emitOps: (ops: unknown[]) => { emitted.push(ops); },
    });

    it("直传参数写入图片节点 metadata（count 钳制、空串剔除）", async () => {
        const emitted: unknown[][] = [];
        await findTool(buildCanvasTools(assetCtx(null, emitted)), "canvas_script_asset").execute("call", {
            scriptNodeId: "s1", group: "character", name: "阿黄", generate: true,
            model: " ch::img-a ", size: " 1:1 ", quality: "", background: "  ", count: 22,
        });
        const addNode = emitted[0].find((op) => (op as { type: string }).type === "add_node") as { metadata: Record<string, unknown> };
        expect(addNode.metadata).toMatchObject({ prompt: "【角色：阿黄】", model: "ch::img-a", size: "1:1", count: 15 });
        expect(addNode.metadata.quality).toBeUndefined();
        expect(addNode.metadata.background).toBeUndefined();
    });

    it("不传参数时 metadata 与现状一致（回归：仅 prompt + scriptEntityRef）", async () => {
        const emitted: unknown[][] = [];
        await findTool(buildCanvasTools(assetCtx(null, emitted)), "canvas_script_asset").execute("call", { scriptNodeId: "s1", group: "item", name: "道具", generate: true });
        const addNode = emitted[0].find((op) => (op as { type: string }).type === "add_node") as { metadata: Record<string, unknown> };
        expect(Object.keys(addNode.metadata).sort()).toEqual(["prompt", "scriptEntityRef"]);
    });

    it("model 未命中目录时报错且不发 ops；目录不可用时透传", async () => {
        const emitted: unknown[][] = [];
        const catalog = [{ id: "ch::img-a", name: "img-a", capability: "image", channelName: "渠道A", isDefault: true }];
        const bad = await findTool(buildCanvasTools(assetCtx(catalog, emitted)), "canvas_script_asset").execute("call", { scriptNodeId: "s1", group: "character", name: "阿黄", model: "ch::ghost" });
        expect((bad.content[0] as { text: string }).text).toContain("models_list");
        expect(emitted).toHaveLength(0);
        await findTool(buildCanvasTools(assetCtx(null, emitted)), "canvas_script_asset").execute("call", { scriptNodeId: "s1", group: "character", name: "阿黄", model: "any::thing", generate: true });
        expect(emitted).toHaveLength(1);
    });
});

describe("canvas_generate_script imageGen/videoGen", () => {
    const scriptNode = (template?: Record<string, unknown>) => ({ id: "s1", type: "script", title: "脚本", position: { x: 0, y: 0 }, width: 250, height: 170, metadata: { script: { schemaVersion: 1, instruction: "i", globalStyle: "", entityIds: [], ...(template ? { template } : {}), output: { status: "done", shots: [] } } } });
    const genCtx = (models: unknown[] | null, emitted: unknown[][], nodes: unknown[]) => ({
        ...modelsCtx(models),
        getSnapshot: () => ({ ...(makeContext([]).ctx.getSnapshot()), nodes: nodes as never }),
        emitOps: (ops: unknown[]) => { emitted.push(ops); },
    });
    const catalog = [
        { id: "ch::img-a", name: "img-a", capability: "image", channelName: "渠道A", isDefault: true },
        { id: "ch::vid-a", name: "vid-a", capability: "video", channelName: "渠道A", isDefault: true },
    ];

    it("创建分支：imageGen/videoGen 清洗后写入 template，任务书含摘要", async () => {
        const emitted: unknown[][] = [];
        const result = await findTool(buildCanvasTools(genCtx(null, emitted, [])), "canvas_generate_script").execute("call", {
            instruction: "美食短片",
            imageGen: { size: " 16:9 ", quality: "", count: 0, model: undefined },
            videoGen: { model: "ch::vid-a", vquality: "768p横", seconds: " " },
        });
        const addNode = emitted[0].find((op) => (op as { type: string }).type === "add_node") as { metadata: { script: { template: Record<string, unknown> } } };
        expect(addNode.metadata.script.template.imageGen).toEqual({ size: "16:9", count: 1 }); // count: 0 按钳制语义写入 1（progress.md 裁决，brief 原期望为作者笔误）
        expect(addNode.metadata.script.template.videoGen).toEqual({ model: "ch::vid-a", vquality: "768p横" });
        expect((result.content[0] as { text: string }).text).toContain("分镜图生图参数已设置");
        expect((result.content[0] as { text: string }).text).toContain("镜头视频参数已设置");
    });

    it("复用分支：经 script_set_instruction 落库；{}=清除；全非法字段视同未传", async () => {
        const emitted: unknown[][] = [];
        const tool = findTool(buildCanvasTools(genCtx(null, emitted, [scriptNode({ imageGen: { size: "1:1", count: 2 } })])), "canvas_generate_script");
        await tool.execute("call", { nodeId: "s1", instruction: "改指令", imageGen: { size: "16:9" }, videoGen: {} });
        const op = emitted[0].find((candidate) => (candidate as { type: string }).type === "script_set_instruction") as { template?: Record<string, unknown> };
        expect(op.template).toEqual({ imageGen: { size: "16:9" }, videoGen: {} });
        const ignored = emitted.length;
        await tool.execute("call", { nodeId: "s1", instruction: "再改", imageGen: { size: "   " } });
        const op2 = emitted[ignored].find((candidate) => (candidate as { type: string }).type === "script_set_instruction") as { template?: Record<string, unknown> };
        expect(op2.template).toBeUndefined(); // 全非法 → 视同未传，不动既有参数
    });

    it("参数块错型（\"\"/[]/null）视同未传：不误判为 {} 清除、不报错、不产生 template patch", async () => {
        const emitted: unknown[][] = [];
        const tool = findTool(buildCanvasTools(genCtx(null, emitted, [scriptNode({ imageGen: { size: "1:1" } })])), "canvas_generate_script");
        await tool.execute("call", { nodeId: "s1", instruction: "x", imageGen: "" });
        await tool.execute("call", { nodeId: "s1", instruction: "x", imageGen: [] });
        await tool.execute("call", { nodeId: "s1", instruction: "x", videoGen: null });
        expect(emitted).toHaveLength(3);
        for (const batch of emitted) {
            const op = batch.find((candidate) => (candidate as { type: string }).type === "script_set_instruction") as { template?: Record<string, unknown> };
            expect(op.template).toBeUndefined(); // 空 keys 不再落入「显式 {} 清除」，既有 imageGen 保留
        }
    });

    it("videoGen.model 未命中目录（capability=video）报错不发 op；imageGen.model 校验 capability=image", async () => {
        const emitted: unknown[][] = [];
        const tool = findTool(buildCanvasTools(genCtx(catalog, emitted, [])), "canvas_generate_script");
        const bad = await tool.execute("call", { instruction: "x", videoGen: { model: "ch::img-a" } });
        expect((bad.content[0] as { text: string }).text).toContain("不是 video 模型");
        expect(emitted).toHaveLength(0);
        const badImg = await tool.execute("call", { instruction: "x", imageGen: { model: "ch::vid-a" } });
        expect((badImg.content[0] as { text: string }).text).toContain("不是 image 模型");
        expect(emitted).toHaveLength(0);
    });
});

describe("tool copy based on receipts", () => {
    it("canvas_apply_ops：全 applied 维持文案；混合列出跳过原因；全未生效返回操作未生效", async () => {
        const outcomes: Array<CanvasOpReceipt[] | undefined> = [
            undefined,
            [
                { opIndex: 0, opType: "add_node", status: "applied" },
                { opIndex: 1, opType: "update_node", status: "skipped", reason: "节点不存在：ghost" },
            ],
            [{ opIndex: 0, opType: "update_node", status: "skipped", reason: "节点不存在：ghost" }],
        ];
        for (const receipts of outcomes) {
            const { ctx } = makeContext([]);
            (ctx as { emitOps: unknown }).emitOps = async () => receipts;
            const tool = findTool(buildCanvasTools(ctx), "canvas_delete_nodes");
            const result = await tool.execute("call", { ids: ["ghost"] }, undefined, undefined);
            const text = (result as { content: Array<{ text: string }> }).content[0].text;
            if (receipts === undefined) expect(text).toContain("已删除 1 个节点");
            else if (receipts.length === 2) expect(text).toContain("已应用 1 条；跳过 1 条：节点不存在：ghost");
            else expect(text).toContain("操作未生效：节点不存在：ghost");
        }
    });

    it("canvas_script_add_shot 对不存在节点/非脚本节点显式报错，不发 op", async () => {
        const scriptNode = { id: "s1", type: SCRIPT_NODE_TYPE, title: "s", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { script: createEmptyScriptData() } };
        const nodes = [{ id: "img1", type: "image", title: "i", position: { x: 0, y: 0 }, width: 10, height: 10, metadata: {} }, scriptNode];
        const { ctx } = makeContext([]);
        (ctx as { getSnapshot: unknown }).getSnapshot = () => ({ projectId: "p", canvasId: "c", title: "t", nodes, connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } } as never);
        const emitted: unknown[] = [];
        (ctx as { emitOps: unknown }).emitOps = (ops: unknown) => { emitted.push(ops); };
        const tool = findTool(buildCanvasTools(ctx), "canvas_script_add_shot");
        const missing = await tool.execute("call", { nodeId: "ghost", description: "x" }, undefined, undefined);
        expect((missing as { content: Array<{ text: string }> }).content[0].text).toContain("脚本节点 ghost 不存在");
        const notScript = await tool.execute("call", { nodeId: "img1", description: "x" }, undefined, undefined);
        expect((notScript as { content: Array<{ text: string }> }).content[0].text).toContain("不是脚本节点");
        expect(emitted).toHaveLength(0);
    });
});
