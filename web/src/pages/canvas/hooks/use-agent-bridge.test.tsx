import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { App as AntApp } from "antd";

import { registerBuiltinNodes } from "@/components/canvas/nodes/builtin-nodes";
import { useAgentBridge } from "./use-agent-bridge";
import { defaultConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { buildCanvasTools } from "@/lib/agent/pi-agent-tools";
import { getFalProfile } from "@/lib/models/fal/profiles";
import { patchProviderParams } from "@/lib/models/provider-options";
import { useAgentStore } from "@/stores/use-agent-store";
import { useScriptEntityStore, type ScriptEntity } from "@/stores/use-script-entity-store";
import { useRemoteMediaTaskStore } from "@/stores/use-remote-media-task-store";
import { SCRIPT_NODE_TYPE, createEmptyScriptData, type ScriptNodeData, type ScriptShot } from "@/types/script-node";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

/**
 * bridge 对 run_generation 的派发/拒绝行为与实体解析作用域：
 * - mode:"script"（旧管线脚本生成已移除）的幻觉 op 显式拒绝：不派发生成、不抛错，并触发用户可见提示；
 * - 其余模式统一派发 generateNodeRef；
 * - script_resolve_shot_refs 只在当前 projectId 的实体表内做名称解析。
 */

const generateNodeSpy = vi.fn(async (_nodeId: string, _mode: string, _prompt: string) => {});
const generateStoryboardSpy = vi.fn((_scriptNodeId: string, _shotId: string, _settings: { metadata: Record<string, unknown> }) => {});

const makeEntity = (id: string, projectId: string): ScriptEntity => ({
    id,
    projectId,
    group: "character",
    name: "狸花猫大厨",
    refs: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
});

const resolveTestShot: ScriptShot = {
    shotId: "shot-1",
    no: 1,
    origin: "manual",
    shotSize: "全景",
    angle: "平视",
    movement: "固定",
    duration: 3,
    mood: "平静",
    descriptionRich: [{ t: "text", v: "狸花猫大厨在厨房颠勺" }],
    description: "狸花猫大厨在厨房颠勺",
    entityRefs: [],
    composed: false,
};

beforeAll(() => {
    registerBuiltinNodes(); // add_node 按注册表校验类型；测试环境需显式注册内置节点
});

afterEach(() => {
    useConfigStore.setState({ config: defaultConfig });
    generateNodeSpy.mockClear();
    generateStoryboardSpy.mockClear();
    useScriptEntityStore.setState({ entities: [] });
    useRemoteMediaTaskStore.getState().resetForTests();
});

function Harness() {
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const nodesRef = useRef(nodes);
    const connectionsRef = useRef(connections);
    const generateNodeRef = useRef<((nodeId: string, mode: "text" | "image" | "video" | "audio", prompt: string) => Promise<void>) | null>(null);
    const generateStoryboardRef = useRef<((scriptNodeId: string, shotId: string, settings: { metadata: Record<string, unknown> }) => void) | null>(null);

    useAgentBridge({
        projectId: "p1",
        canvasId: "c1",
        title: "t",
        nodes,
        connections,
        selectedNodeIds: new Set<string>(),
        viewport: { x: 0, y: 0, k: 1 },
        viewportSize: { width: 1200, height: 800 },
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef: useRef(new Set<string>()) as MutableRefObject<Set<string>>,
        viewportRef: useRef({ x: 0, y: 0, k: 1 }) as MutableRefObject<{ x: number; y: number; k: number }>,
        generateNodeRef,
        generateStoryboardRef,
        setNodes: ((value: CanvasNodeData[]) => { nodesRef.current = value; setNodes(value); }) as never,
        setConnections: ((value: CanvasConnection[]) => { connectionsRef.current = value; setConnections(value); }) as never,
        setSelectedNodeIds: (() => {}) as never,
        setSelectedConnectionId: (() => {}) as never,
        setViewport: (() => {}) as never,
        setContextMenu: (() => {}) as never,
        importAttachment: undefined,
    });

    // project.tsx 的 handleGenerateNode 等价物：捕获派发，供断言“是否被调用”。
    useEffect(() => {
        generateNodeRef.current = generateNodeSpy;
        generateStoryboardRef.current = generateStoryboardSpy;
    }, []);

    return null;
}

function renderHarnessAndGetCtx() {
    render(
        <AntApp>
            <Harness />
        </AntApp>,
    );
    const ctx = useAgentStore.getState().canvasContext;
    expect(ctx?.applyOps).toBeTruthy();
    return ctx!;
}

describe("use-agent-bridge run_generation", () => {
    it("mode:'script' 显式拒绝：不派发生成、不抛错，并触发用户可见提示", async () => {
        const ctx = renderHarnessAndGetCtx();

        await act(async () => {
            expect(() => ctx.applyOps([{ type: "run_generation", nodeId: "script-1", mode: "script", prompt: "旧管线分镜生成" }] as never)).not.toThrow();
            await new Promise((r) => setTimeout(r, 100));
        });

        expect(generateNodeSpy).not.toHaveBeenCalled();
        // 用户可见提示：antd message 通知（文案含 canvas_script_replace_shots 指引，中英文均覆盖）
        const notices = Array.from(document.body.querySelectorAll(".ant-message-notice"));
        expect(notices.some((n) => n.textContent?.includes("canvas_script_replace_shots"))).toBe(true);
    });

    it("mode:'text' 统一派发 generateNodeRef", async () => {
        const ctx = renderHarnessAndGetCtx();

        await act(async () => {
            ctx.applyOps([{ type: "run_generation", nodeId: "n1", mode: "text", prompt: "写一句文案" }] as never);
            await new Promise((r) => setTimeout(r, 50));
        });

        expect(generateNodeSpy).toHaveBeenCalledTimes(1);
        expect(generateNodeSpy).toHaveBeenCalledWith("n1", "text", "写一句文案");
    });
});

describe("use-agent-bridge receipts", () => {
    it("applyAgentOps 返回逐条回执：ghost update_node skipped、合法 add_node applied、bridge 自消化 op 也 applied，opIndex 对应原始 ops 数组", async () => {
        const ctx = renderHarnessAndGetCtx();
        const result = await act(async () => await ctx.applyOps([
            { type: "update_node", id: "ghost", patch: { title: "x" } },
            { type: "add_node", id: "n-new", nodeType: "text", position: { x: 0, y: 0 } },
            { type: "script_entity_upsert", entity: { projectId: "p1", group: "character", name: "实体" } },
        ] as never));
        expect(result.receipts).toHaveLength(3);
        expect(result.receipts[0]).toMatchObject({ opIndex: 0, opType: "update_node", status: "skipped" });
        expect(result.receipts[1]).toMatchObject({ opIndex: 1, opType: "add_node", status: "applied", nodeIds: ["n-new"] });
        expect(result.receipts[2]).toMatchObject({ opIndex: 2, opType: "script_entity_upsert", status: "applied" });
    });
});

describe("use-agent-bridge script_resolve_shot_refs", () => {
    it("实体名称解析只匹配当前 projectId 的实体表", async () => {
        useScriptEntityStore.setState({ entities: [makeEntity("ent_p1", "p1"), makeEntity("ent_p2", "p2")] });
        const ctx = renderHarnessAndGetCtx();

        await act(async () => {
            ctx.applyOps([
                { type: "add_node", id: "script-1", nodeType: SCRIPT_NODE_TYPE, title: "脚本", position: { x: 0, y: 0 }, metadata: { script: { ...createEmptyScriptData(), output: { status: "done", shots: [resolveTestShot] } } } },
            ] as never);
            ctx.applyOps([{ type: "script_resolve_shot_refs", nodeId: "script-1", shotId: "shot-1", names: ["狸花猫大厨"] }] as never);
            await Promise.resolve();
            await new Promise((r) => setTimeout(r, 50));
        });

        const finalNode = (useAgentStore.getState().canvasContext?.snapshot.nodes as CanvasNodeData[]).find((n) => n.id === "script-1");
        const script: ScriptNodeData | undefined = finalNode?.metadata?.script;
        expect(script?.output.shots[0]?.entityRefs).toEqual(["ent_p1"]);
        expect(script?.output.shots[0]?.descriptionRich).toContainEqual({ t: "ref", entityId: "ent_p1" });
    });
});

describe("use-agent-bridge script_generate_storyboard", () => {
    it("dispatches the domain operation to the script storyboard handler", async () => {
        const ctx = renderHarnessAndGetCtx();

        await act(async () => {
            ctx.applyOps([{
                type: "script_generate_storyboard",
                nodeId: "script-1",
                shotId: "shot-1",
                settings: { metadata: { size: "16:9", quality: "high", count: 1 } },
            }] as never);
            await Promise.resolve();
            await new Promise((r) => setTimeout(r, 50));
        });

        expect(generateStoryboardSpy).toHaveBeenCalledWith("script-1", "shot-1", { metadata: { size: "16:9", quality: "high", count: 1 } });
    });
});


describe("fal generation bridge", () => {
    const kling = "fal-ai/kling-video/v3/pro/text-to-video";
    const veo = "fal-ai/veo3.1/first-last-frame-to-video";
    const config: AiConfig = { ...defaultConfig, videoModel: `channel::${kling}`, channels: [{ id: "channel", name: "fal.ai", provider: "fal", apiKey: "private-key", baseUrl: "https://queue.fal.run", apiFormat: "openai", models: [{ name: kling, capability: "video" }, { name: veo, capability: "video" }] }] };
    it("initializes manually-created config nodes with profile defaults and preserves explicit choices", async () => {
        useConfigStore.setState({ config });
        const ctx = renderHarnessAndGetCtx();
        await act(async () => {
            ctx.applyOps([
                { type: "add_node", id: "config-default", nodeType: "config", metadata: { generationMode: "video", prompt: "Product rotates" } },
                { type: "add_node", id: "config-explicit", nodeType: "config", metadata: { generationMode: "video", model: `channel::${kling}`, prompt: "Product rotates", seconds: "10", size: "9:16", generateAudio: "true" } },
                { type: "add_node", id: "config-empty", nodeType: "config", metadata: { generationMode: "video", model: `channel::${kling}`, prompt: "Product rotates", seconds: "", generateAudio: "false" } },
            ] as never);
        });
        const nodes = useAgentStore.getState().canvasContext!.snapshot.nodes;
        expect(nodes[0].metadata).toMatchObject({ model: `channel::${kling}`, seconds: "5", size: "16:9", generateAudio: "false" });
        expect(nodes[1].metadata).toMatchObject({ seconds: "10", size: "9:16", generateAudio: "true" });
        expect(nodes[2].metadata).toMatchObject({ seconds: "", generateAudio: "false" });
        expect(nodes[0].generationContract?.endpointId).toBe(kling);
        let persisted: Awaited<ReturnType<typeof ctx.applyOps>>;
        await act(async () => {
            persisted = await useAgentStore.getState().canvasContext!.applyOps([{ type: "update_node", id: nodes[1].id, metadata: { prompt: "Updated" } }]);
        });
        expect(persisted!.nodes.every(node => !("generationContract" in node))).toBe(true);
        expect(persisted!.nodes[1].metadata).toMatchObject({ seconds: "10", size: "9:16", generateAudio: "true" });
    });
    it("reacts to config-only provider changes and model edits without persisting contracts", async () => {
        useConfigStore.setState({ config });
        const ctx = renderHarnessAndGetCtx();
        await act(async () => { ctx.applyOps([{ type: "add_node", id: "fal", nodeType: "config", metadata: { model: `channel::${kling}`, generationMode: "video" } }]); });
        const current = () => useAgentStore.getState().canvasContext!;
        expect(current().snapshot.nodes[0].generationContract?.endpointId).toBe(kling);
        await act(async () => { useConfigStore.setState({ config: { ...config, channels: [{ ...config.channels[0], provider: "custom" }] } }); });
        expect(current().snapshot.nodes[0].generationContract).toBeUndefined();
        await act(async () => { useConfigStore.setState({ config }); });
        expect(current().snapshot.nodes[0].generationContract?.endpointId).toBe(kling);
        await act(async () => { current().applyOps([{ type: "update_node", id: "fal", metadata: { model: `channel::${veo}` } }]); });
        expect(current().snapshot.nodes[0].generationContract?.media.map(slot => slot.role)).toEqual(["first", "last"]);
        const providerOptions = patchProviderParams(undefined, `channel::${veo}`, getFalProfile(veo)!, { seed: 7 });
        providerOptions.models[`channel::${veo}`].profileVersion = 99;
        await act(async () => { current().applyOps([{ type: "update_node", id: "fal", metadata: { providerOptions } }]); });
        expect(current().snapshot.nodes[0].generationContract).toBeUndefined();
        expect(current().snapshot.nodes[0].metadata?.providerOptions).toEqual(providerOptions);
        expect(JSON.stringify(current().snapshot)).not.toMatch(/private-key|data:image|inputSchema|defaults/);
    });
});

describe("use-agent-bridge script entity push", () => {
    it("按当前 projectId 过滤推送实体摘要到 setScriptEntities", async () => {
        const setScriptEntities = vi.fn();
        (window as { shotshot?: unknown }).shotshot = { agent: { setScriptEntities } };
        const other: ScriptEntity = { ...makeEntity("ent_other", "p2"), name: "别的项目实体" };
        useScriptEntityStore.setState({ entities: [makeEntity("ent_p1", "p1"), other] });
        try {
            renderHarnessAndGetCtx();
            await act(async () => {
                await Promise.resolve();
                await new Promise((r) => setTimeout(r, 0));
            });
            expect(setScriptEntities).toHaveBeenCalled();
            const pushed = setScriptEntities.mock.calls.at(-1)![0] as Array<{ id: string }>;
            expect(pushed.map((e) => e.id)).toEqual(["ent_p1"]);
            expect(pushed[0]).toMatchObject({ projectId: "p1", name: "狸花猫大厨", group: "character", refs: [] });
        } finally {
            (window as { shotshot?: unknown }).shotshot = undefined;
        }
    });
});

describe("use-agent-bridge script_assign_entity_ref", () => {
    it("绑定画布节点为实体槽位（source=canvas，state=ready）", async () => {
        const entity = makeEntity("ent_p1", "p1");
        useScriptEntityStore.setState({ entities: [{ ...entity, refs: [{ id: "ref_1", label: "sheet", state: "empty" as const }] }] });
        const ctx = renderHarnessAndGetCtx();
        await act(async () => {
            ctx.applyOps([{ type: "script_assign_entity_ref", entityId: "ent_p1", refId: "ref_1", nodeId: "image-src" }] as never);
            await Promise.resolve();
            await new Promise((r) => setTimeout(r, 50));
        });
        const stored = useScriptEntityStore.getState().entities.find((e) => e.id === "ent_p1");
        expect(stored?.refs[0]).toMatchObject({ id: "ref_1", state: "ready", source: "canvas", nodeId: "image-src" });
    });
});

describe("use-agent-bridge resolve entityIds 直连", () => {
    it("带 entityIds 的 resolve op 跳过名称匹配（名字不匹配也按 id 生效）", async () => {
        const entity = { ...makeEntity("ent_p1", "p1"), name: "另一个名字" };
        useScriptEntityStore.setState({ entities: [entity] });
        const ctx = renderHarnessAndGetCtx();
        await act(async () => {
            ctx.applyOps([
                { type: "add_node", id: "script-2", nodeType: SCRIPT_NODE_TYPE, title: "脚本", position: { x: 0, y: 0 }, metadata: { script: { ...createEmptyScriptData(), output: { status: "done", shots: [resolveTestShot] } } } },
            ] as never);
            ctx.applyOps([{ type: "script_resolve_shot_refs", nodeId: "script-2", shotId: "shot-1", names: ["不存在名"], entityIds: ["ent_p1"] }] as never);
            await Promise.resolve();
            await new Promise((r) => setTimeout(r, 50));
        });
        const finalNode = (useAgentStore.getState().canvasContext?.snapshot.nodes as CanvasNodeData[]).find((n) => n.id === "script-2");
        expect(finalNode?.metadata?.script?.output.shots[0]?.entityRefs).toEqual(["ent_p1"]);
    });
});

describe("use-agent-bridge generation status push", () => {
    it("状态直传不归并：submission_unknown 原样推送并带 scope/时间/terminal/sourceNodeId", async () => {
        const setGenerationStatus = vi.fn();
        (window as { shotshot?: unknown }).shotshot = { agent: { setGenerationStatus } };
        try {
            renderHarnessAndGetCtx();
            const store = useRemoteMediaTaskStore.getState();
            const task = store.createTask({
                capability: "image",
                target: { projectId: "p1", canvasId: "c1", nodeId: "image-1", sourceNodeId: "config-1" },
                channelId: "channel-1",
                modelName: "image-model",
                baseUrlSnapshot: "https://provider.example",
                queryScriptSnapshot: "return { status: 'pending' }",
                now: Date.now() - 60_000,
            });
            store.patchTask(task.id, { status: "submission_unknown" });
            await act(async () => {
                await Promise.resolve();
                await new Promise((r) => setTimeout(r, 0));
            });
            const pushed = setGenerationStatus.mock.calls.at(-1)![0] as Array<Record<string, unknown>>;
            const hit = pushed.find((entry) => entry.nodeId === "image-1")!;
            expect(hit).toMatchObject({
                status: "submission_unknown",
                source: "remote_media",
                projectId: "p1",
                canvasId: "c1",
                sourceNodeId: "config-1",
                terminal: false,
            });
            expect(typeof hit.submittedAt).toBe("string");
            expect(typeof hit.deadlineAt).toBe("string");
        } finally {
            (window as { shotshot?: unknown }).shotshot = undefined;
        }
    });
});

describe("use-agent-bridge run_generation guard", () => {
    const guardTaskInput = (nodeId: string) => ({
        capability: "image" as const,
        target: { projectId: "p1", canvasId: "c1", nodeId },
        channelId: "channel-1",
        modelName: "image-model",
        baseUrlSnapshot: "https://provider.example",
        queryScriptSnapshot: "return { status: 'pending' }",
        now: Date.now() - 60_000,
    });

    it("进行中任务拒绝派发；force=true 打断旧任务后派发；submission_unknown 即使 force 也拒绝", async () => {
        const ctx = renderHarnessAndGetCtx();
        const store = useRemoteMediaTaskStore.getState();
        const task = store.createTask(guardTaskInput("image-1"));
        store.patchTask(task.id, { status: "pending", phase: "queued" });

        await act(async () => {
            const refused = await ctx.applyOps([{ type: "run_generation", nodeId: "image-1", mode: "image", prompt: "x" }] as never);
            expect(refused.receipts[0]).toMatchObject({ opType: "run_generation", status: "skipped" });
            expect(refused.receipts[0].reason).toContain("已有进行中任务");
            expect(refused.receipts[0].reason).toContain("force=true");
        });
        expect(generateNodeSpy).not.toHaveBeenCalled();

        await act(async () => {
            const forced = await ctx.applyOps([{ type: "run_generation", nodeId: "image-1", mode: "image", prompt: "x", force: true }] as never);
            expect(forced.receipts[0]).toMatchObject({ opType: "run_generation", status: "applied" });
            expect(forced.receipts[0].reason).toContain("已打断旧任务");
        });
        expect(useRemoteMediaTaskStore.getState().tasks.find((entry) => entry.id === task.id)?.status).toBe("interrupted");
        expect(generateNodeSpy).toHaveBeenCalledTimes(1);

        generateNodeSpy.mockClear();
        store.patchTask(task.id, { status: "submission_unknown" });
        await act(async () => {
            const refused = await ctx.applyOps([{ type: "run_generation", nodeId: "image-1", mode: "image", prompt: "x" }] as never);
            expect(refused.receipts[0].status).toBe("skipped");
            // fix round 1：submission_unknown 禁止手动重跑，拒绝文案不提示 force
            expect(refused.receipts[0].reason).toContain("禁止手动重跑");
            expect(refused.receipts[0].reason).not.toContain("force=true");
        });
        await act(async () => {
            const forced = await ctx.applyOps([{ type: "run_generation", nodeId: "image-1", mode: "image", prompt: "x", force: true }] as never);
            expect(forced.receipts[0].status).toBe("skipped");
            expect(forced.receipts[0].reason).toContain("提交结果未知");
        });
        expect(useRemoteMediaTaskStore.getState().tasks.find((entry) => entry.id === task.id)?.status).toBe("submission_unknown");
        expect(generateNodeSpy).not.toHaveBeenCalled();
    });

    it("failed/timed_out 恢复态拒绝重跑（force 也不放行），引导用户「重新获取结果」恢复原任务", async () => {
        const ctx = renderHarnessAndGetCtx();
        const store = useRemoteMediaTaskStore.getState();
        const task = store.createTask(guardTaskInput("image-4"));
        store.patchTask(task.id, { status: "timed_out" });

        await act(async () => {
            const refused = await ctx.applyOps([{ type: "run_generation", nodeId: "image-4", mode: "image", prompt: "x" }] as never);
            expect(refused.receipts[0]).toMatchObject({ opType: "run_generation", status: "skipped" });
            expect(refused.receipts[0].reason).toContain("重新获取结果");
            expect(refused.receipts[0].reason).not.toContain("force=true");
        });
        await act(async () => {
            const forced = await ctx.applyOps([{ type: "run_generation", nodeId: "image-4", mode: "image", prompt: "x", force: true }] as never);
            expect(forced.receipts[0].status).toBe("skipped");
        });
        expect(useRemoteMediaTaskStore.getState().tasks.find((entry) => entry.id === task.id)?.status).toBe("timed_out");
        expect(generateNodeSpy).not.toHaveBeenCalled();

        store.patchTask(task.id, { status: "failed" });
        await act(async () => {
            const failedRerun = await ctx.applyOps([{ type: "run_generation", nodeId: "image-4", mode: "image", prompt: "x", force: true }] as never);
            expect(failedRerun.receipts[0].status).toBe("skipped");
            expect(failedRerun.receipts[0].reason).toContain("重新获取结果");
        });
        expect(useRemoteMediaTaskStore.getState().tasks.find((entry) => entry.id === task.id)?.status).toBe("failed");
        expect(generateNodeSpy).not.toHaveBeenCalled();
    });

    it("删除存在 failed/timed_out 远端任务的节点整批拒绝；同批干净节点也不被误删，删除普通节点不受影响", async () => {
        const ctx = renderHarnessAndGetCtx();
        const store = useRemoteMediaTaskStore.getState();
        const task = store.createTask(guardTaskInput("image-5"));
        store.patchTask(task.id, { status: "timed_out" });
        await act(async () => {
            await ctx.applyOps([{ type: "add_node", id: "clean-1", nodeType: "text", position: { x: 0, y: 0 } }] as never);
        });

        await act(async () => {
            const refused = await ctx.applyOps([{ type: "delete_node", ids: ["image-5", "clean-1"] }] as never);
            const deleteReceipt = refused.receipts.find((receipt) => receipt.opType === "delete_node");
            expect(deleteReceipt).toMatchObject({ status: "skipped" });
            expect(deleteReceipt?.reason).toContain("重新获取结果");
        });
        expect(useAgentStore.getState().canvasContext!.snapshot.nodes.some((node) => node.id === "clean-1")).toBe(true);

        await act(async () => {
            const allowed = await ctx.applyOps([{ type: "delete_node", ids: ["clean-1"] }] as never);
            expect(allowed.receipts.find((receipt) => receipt.opType === "delete_node")).toMatchObject({ status: "applied", nodeIds: ["clean-1"] });
        });
        expect(useAgentStore.getState().canvasContext!.snapshot.nodes.some((node) => node.id === "clean-1")).toBe(false);
        expect(useRemoteMediaTaskStore.getState().tasks.find((entry) => entry.id === task.id)?.status).toBe("timed_out");
    });

    it("无任务记录放行；未注册远端任务时回执显式说明", async () => {
        const ctx = renderHarnessAndGetCtx();
        await act(async () => {
            const done = await ctx.applyOps([{ type: "run_generation", nodeId: "image-2", mode: "image", prompt: "x" }] as never);
            expect(done.receipts[0].status).toBe("applied");
            expect(done.receipts[0].taskId).toBeUndefined();
            expect(done.receipts[0].reason).toContain("不产生远端任务记录");
        });
        expect(generateNodeSpy).toHaveBeenCalledTimes(1);
    });

    it("节点有进行中任务时 mode:text 不受护栏影响正常派发（spec §7：text 不查任务 store）", async () => {
        const ctx = renderHarnessAndGetCtx();
        const store = useRemoteMediaTaskStore.getState();
        const task = store.createTask(guardTaskInput("image-3"));
        store.patchTask(task.id, { status: "pending", phase: "queued" });
        await act(async () => {
            const done = await ctx.applyOps([{ type: "run_generation", nodeId: "image-3", mode: "text", prompt: "x" }] as never);
            expect(done.receipts[0]).toMatchObject({ opType: "run_generation", status: "applied" });
            expect(done.receipts[0].reason).toContain("不产生远端任务记录");
        });
        expect(generateNodeSpy).toHaveBeenCalledTimes(1);
        expect(generateNodeSpy).toHaveBeenCalledWith("image-3", "text", "x");
        expect(useRemoteMediaTaskStore.getState().tasks.find((entry) => entry.id === task.id)?.status).toBe("pending");
    });
});
