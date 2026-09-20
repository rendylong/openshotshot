import { describe, expect, it } from "vitest";

import type { CanvasAgentSnapshot } from "./canvas-agent-op-types";
import type { ScriptNodeData } from "@/types/script-node";
import { applyCanvasAgentOps, applyCanvasAgentOpsWithReceipts, normalizeCanvasAgentOp } from "./canvas-agent-ops";

const baseSnapshot: CanvasAgentSnapshot = {
    projectId: "p",
    canvasId: "c",
    title: "t",
    nodes: [
        { id: "n1", type: "image", title: "img", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: {} },
    ],
    connections: [],
    selectedNodeIds: [],
    viewport: { x: 0, y: 0, k: 1 },
};

describe("applyCanvasAgentOps", () => {
    it("normalizes the wrapper-schema ops the agent emits (camelCase action + nested payload + stringified coordinates)", () => {
        const result = applyCanvasAgentOps(baseSnapshot, [
            { op: "updateNode", nodeId: "n1", position: { x: "-1200", y: "-300" } },
            { op: "addText", textNode: { title: "说明", content: "文本", position: { x: "-1250", y: "-520" }, width: "420" } },
            { op: "addConnection", connection: { id: "link-1", fromNodeId: "n1", toNodeId: "n2" } },
            { op: "select", nodeIds: ["n1", "n2"] },
        ] as never);

        const moved = result.nodes.find((n) => n.id === "n1");
        expect(moved?.position).toEqual({ x: -1200, y: -300 });

        const textNode = result.nodes.find((n) => n.type === "text");
        expect(textNode?.position).toEqual({ x: -1250, y: -520 });
        expect(textNode?.width).toBe(420);
        expect(textNode?.metadata?.content).toBe("文本");

        // The agent emitted a connection whose target doesn't exist yet (n2 not created here);
        // consumer must skip it rather than silently create a dangling edge.
        expect(result.connections).toHaveLength(0);

        expect(result.selectedNodeIds).toEqual(["n1"]);
    });

    it("still applies the canonical flat schema op for update_node with patch", () => {
        const result = applyCanvasAgentOps(baseSnapshot, [
            { type: "update_node", id: "n1", patch: { position: { x: 50, y: 60 } } },
        ]);
        expect(result.nodes[0].position).toEqual({ x: 50, y: 60 });
    });

    it("places a low-level add_node without coordinates beside the selection", () => {
        const result = applyCanvasAgentOps(
            {
                ...baseSnapshot,
                selectedNodeIds: ["n1"],
                viewportSize: { width: 1200, height: 720 },
            },
            [{ type: "add_node", nodeType: "text" }],
        );

        expect(result.nodes[1].position).toEqual({ x: 148, y: -70 });
    });

    it("sets a model-relative camera only on the target 3D node", () => {
        const snapshot: CanvasAgentSnapshot = {
            ...baseSnapshot,
            nodes: [
                ...baseSnapshot.nodes,
                { id: "model", type: "3d", title: "Model", position: { x: 200, y: 0 }, width: 640, height: 480, metadata: { model3d: { name: "model.glb" } } },
            ],
        };
        const result = applyCanvasAgentOps(snapshot, [
            { type: "set_3d_camera", nodeId: "model", camera: { azimuth: 45, elevation: 25, distanceRatio: 3 } },
        ]);
        expect(result.nodes.find((node) => node.id === "model")?.metadata?.model3d?.camera).toEqual({ azimuth: 45, elevation: 25, distanceRatio: 3 });
        expect(result.nodes.find((node) => node.id === "n1")?.metadata?.model3d).toBeUndefined();
    });

    it("ignores 3D camera operations for non-3D targets or invalid poses", () => {
        const result = applyCanvasAgentOps(baseSnapshot, [
            { type: "set_3d_camera", nodeId: "n1", camera: { azimuth: 0, elevation: 0, distanceRatio: 2.6 } },
            { type: "set_3d_camera", nodeId: "n1", camera: { azimuth: Number.NaN, elevation: 0, distanceRatio: 0 } },
        ] as never);
        expect(result.nodes).toEqual(baseSnapshot.nodes);
    });
});

const shot = (shotId: string, over: Record<string, unknown> = {}) => ({
    shotId, no: 0, origin: "manual" as const, shotSize: "中景", angle: "平视", movement: "固定",
    duration: 4, mood: "温暖", sfx: "", dialogue: "", descriptionRich: [], description: "", entityRefs: [], composed: false, ...over,
});
const scriptData = (shots: unknown[], output: Partial<ScriptNodeData["output"]> = {}) => ({
    schemaVersion: 1 as const, instruction: "旧指令", globalStyle: "", entityIds: [],
    output: { status: "idle" as const, shots: shots as never, ...output },
});
const scriptSnapshot = (shots: unknown[], output: Partial<ScriptNodeData["output"]> = {}): CanvasAgentSnapshot => ({
    ...baseSnapshot,
    nodes: [
        baseSnapshot.nodes[0],
        { id: "s1", type: "script", title: "脚本", position: { x: 0, y: 0 }, width: 250, height: 170, metadata: { script: scriptData(shots, output) } },
    ],
});

describe("applyCanvasAgentOps script ops", () => {
    it("script_set_instruction 更新 instruction 且可选更新 globalStyle", () => {
        const result = applyCanvasAgentOps(scriptSnapshot([]), [
            { type: "script_set_instruction", nodeId: "s1", instruction: "新指令", globalStyle: "皮克斯" },
        ]);
        const script = result.nodes.find((n) => n.id === "s1")?.metadata?.script;
        expect(script?.instruction).toBe("新指令");
        expect(script?.globalStyle).toBe("皮克斯");
    });

    it("script_set_instruction 可选 template patch spread 合并：storyboardFirst 落库且不覆盖既有 shotCount/imageGen", () => {
        const snapshot = scriptSnapshot([]);
        snapshot.nodes[1] = { ...snapshot.nodes[1], metadata: { ...snapshot.nodes[1].metadata, script: { ...scriptData([]), template: { shotCount: 6, imageGen: { size: "16:9" } } } } };
        const result = applyCanvasAgentOps(snapshot, [
            { type: "script_set_instruction", nodeId: "s1", instruction: "x", template: { storyboardFirst: true } },
        ]);
        expect(result.nodes.find((n) => n.id === "s1")?.metadata?.script?.template).toEqual({ shotCount: 6, storyboardFirst: true, imageGen: { size: "16:9" } });
        // 无 template 字段时不触碰既有 template
        const untouched = applyCanvasAgentOps(snapshot, [{ type: "script_set_instruction", nodeId: "s1", instruction: "y" }]);
        expect(untouched.nodes.find((n) => n.id === "s1")?.metadata?.script?.template).toEqual({ shotCount: 6, imageGen: { size: "16:9" } });
    });

    it("script_upsert_shot 按 shotId 更新或追加，序号重排", () => {
        const result = applyCanvasAgentOps(scriptSnapshot([shot("a"), shot("b")]), [
            { type: "script_upsert_shot", nodeId: "s1", shot: shot("b", { shotSize: "特写" }) },
            { type: "script_upsert_shot", nodeId: "s1", shot: shot("c") },
        ]);
        const shots = result.nodes.find((n) => n.id === "s1")?.metadata?.script?.output.shots;
        expect(shots).toHaveLength(3);
        expect(shots?.map((s) => s.shotId)).toEqual(["a", "b", "c"]);
        expect(shots?.find((s) => s.shotId === "b")?.shotSize).toBe("特写");
        expect(shots?.map((s) => s.no)).toEqual([1, 2, 3]);
    });

    it("script_delete_shot 删除并重排序号", () => {
        const result = applyCanvasAgentOps(scriptSnapshot([shot("a"), shot("b"), shot("c")]), [
            { type: "script_delete_shot", nodeId: "s1", shotId: "a" },
        ]);
        expect(result.nodes.find((n) => n.id === "s1")?.metadata?.script?.output.shots.map((s) => [s.shotId, s.no])).toEqual([["b", 1], ["c", 2]]);
    });

    it("script_reorder_shots 按给定顺序重排；数量不匹配时不变", () => {
        const snapshot = scriptSnapshot([shot("a"), shot("b"), shot("c")]);
        const result = applyCanvasAgentOps(snapshot, [{ type: "script_reorder_shots", nodeId: "s1", shotIds: ["c", "a", "b"] }]);
        expect(result.nodes.find((n) => n.id === "s1")?.metadata?.script?.output.shots.map((s) => s.shotId)).toEqual(["c", "a", "b"]);
        const mismatch = applyCanvasAgentOps(snapshot, [{ type: "script_reorder_shots", nodeId: "s1", shotIds: ["a"] }]);
        expect(mismatch.nodes.find((n) => n.id === "s1")?.metadata?.script?.output.shots.map((s) => s.shotId)).toEqual(["a", "b", "c"]);
    });

    it("script_replace_shots 整体替换；script_bind_entity 去重绑定", () => {
        const result = applyCanvasAgentOps(scriptSnapshot([shot("a")]), [
            { type: "script_replace_shots", nodeId: "s1", shots: [shot("x"), shot("y")] },
            { type: "script_bind_entity", nodeId: "s1", entityId: "e1" },
            { type: "script_bind_entity", nodeId: "s1", entityId: "e1" },
        ]);
        const script = result.nodes.find((n) => n.id === "s1")?.metadata?.script;
        expect(script?.output.shots.map((s) => s.shotId)).toEqual(["x", "y"]);
        expect(script?.entityIds).toEqual(["e1"]);
    });

    it("nodeId 不存在或非脚本节点时静默跳过", () => {
        const snapshot = scriptSnapshot([]);
        const result = applyCanvasAgentOps(snapshot, [
            { type: "script_upsert_shot", nodeId: "ghost", shot: shot("a") },
            { type: "script_set_instruction", nodeId: "n1", instruction: "x" },
        ]);
        expect(result.nodes).toEqual(snapshot.nodes);
    });
});

describe("applyCanvasAgentOps 脚本 op 状态收尾（仅镜头写入 op 触发）", () => {
    const scriptOutput = (snapshot: CanvasAgentSnapshot) => snapshot.nodes.find((n) => n.id === "s1")?.metadata?.script?.output;

    it("generating + replace_shots(2 shots) → done", () => {
        const result = applyCanvasAgentOps(scriptSnapshot([], { status: "generating" }), [
            { type: "script_replace_shots", nodeId: "s1", shots: [shot("a"), shot("b")] },
        ]);
        const output = scriptOutput(result);
        expect(output?.status).toBe("done");
        expect(output?.shots).toHaveLength(2);
    });

    it("error + upsert_shot(1 shot) → done 并清理过期 errorMessage/raw/generatedAt", () => {
        const result = applyCanvasAgentOps(
            scriptSnapshot([], { status: "error", errorMessage: "boom", raw: "raw text", generatedAt: 123 }),
            [{ type: "script_upsert_shot", nodeId: "s1", shot: shot("a") }],
        );
        const output = scriptOutput(result);
        expect(output?.status).toBe("done");
        // 过期错误字段必须从落库对象中移除（而非置 undefined）。
        expect(Object.keys(output ?? {})).not.toContain("errorMessage");
        expect(Object.keys(output ?? {})).not.toContain("raw");
        expect(Object.keys(output ?? {})).not.toContain("generatedAt");
        expect(output?.shots).toHaveLength(1);
    });

    it("error + delete_shot 清空镜头 → 保持 error（错误仍可见）", () => {
        const result = applyCanvasAgentOps(
            scriptSnapshot([shot("a")], { status: "error", errorMessage: "boom" }),
            [{ type: "script_delete_shot", nodeId: "s1", shotId: "a" }],
        );
        const output = scriptOutput(result);
        expect(output?.status).toBe("error");
        expect(output?.errorMessage).toBe("boom");
        expect(output?.shots).toHaveLength(0);
    });

    it("done + upsert_shot → 保持 done", () => {
        const result = applyCanvasAgentOps(
            scriptSnapshot([shot("a")], { status: "done", generatedAt: 456 }),
            [{ type: "script_upsert_shot", nodeId: "s1", shot: shot("b") }],
        );
        const output = scriptOutput(result);
        expect(output?.status).toBe("done");
        expect(output?.generatedAt).toBe(456);
        expect(output?.shots).toHaveLength(2);
    });

    it("generating + bind_entity（非镜头写入 op）→ 保持 generating", () => {
        const result = applyCanvasAgentOps(
            scriptSnapshot([shot("a")], { status: "generating" }),
            [{ type: "script_bind_entity", nodeId: "s1", entityId: "e1" }],
        );
        expect(scriptOutput(result)?.status).toBe("generating");
    });

    it("done + 空数组 replace_shots → 合法清空且保持 done", () => {
        const result = applyCanvasAgentOps(
            scriptSnapshot([shot("a")], { status: "done" }),
            [{ type: "script_replace_shots", nodeId: "s1", shots: [] }],
        );
        const output = scriptOutput(result);
        expect(output?.status).toBe("done");
        expect(output?.shots).toHaveLength(0);
    });
});


it("preserves current and future provider options in canonical metadata operations", () => {
    for (const version of [1, 99]) {
        const providerOptions = { version, models: { "channel::fal-ai/flux-2-pro": { provider: "fal" as const, profileId: "fal-ai/flux-2-pro", profileVersion: version, params: { seed: 7 } } } };
        const op = normalizeCanvasAgentOp({ type: "update_node", id: "n1", metadata: { providerOptions } });
        expect(op).toMatchObject({ metadata: { providerOptions } });
        expect(applyCanvasAgentOps(baseSnapshot, [op!]).nodes[0].metadata?.providerOptions).toEqual(providerOptions);
    }
});


it("does not write the derived generation contract back into nodes", () => {
    const contract = { endpointId: "fal-ai/flux-2-pro", profileId: "fal-ai/flux-2-pro", profileVersion: 1, fields: [], media: [] };
    const snapshot = { ...baseSnapshot, nodes: [{ ...baseSnapshot.nodes[0], generationContract: contract }] };
    const result = applyCanvasAgentOps(snapshot, [{ type: "update_node", id: "n1", patch: { title: "Updated", generationContract: contract } } as never]);
    expect(result.nodes[0]).not.toHaveProperty("generationContract");
    expect(result.nodes[0].title).toBe("Updated");
    expect(snapshot.nodes[0].generationContract).toEqual(contract);
});


it("script_set_instruction imageGen/videoGen 参数块整体替换，{} 清除且互不影响", () => {
    const snapshot = scriptSnapshot([]);
    snapshot.nodes[1] = { ...snapshot.nodes[1], metadata: { ...snapshot.nodes[1].metadata, script: { ...scriptData([]), template: { imageGen: { size: "16:9", count: 2 }, videoGen: { model: "ch::v" } } } } };
    const result = applyCanvasAgentOps(snapshot, [
        { type: "script_set_instruction", nodeId: "s1", instruction: "x", template: { imageGen: { size: "1:1" } } },
    ]);
    const template = result.nodes.find((n) => n.id === "s1")?.metadata?.script?.template;
    expect(template?.imageGen).toEqual({ size: "1:1" }); // 整体替换：旧 count 不残留
    expect(template?.videoGen).toEqual({ model: "ch::v" }); // 未传不动
    const cleared = applyCanvasAgentOps(result, [
        { type: "script_set_instruction", nodeId: "s1", instruction: "y", template: { videoGen: {} } },
    ]);
    expect(cleared.nodes.find((n) => n.id === "s1")?.metadata?.script?.template?.videoGen).toEqual({});
    expect(cleared.nodes.find((n) => n.id === "s1")?.metadata?.script?.template?.imageGen).toEqual({ size: "1:1" });
});

describe("script_assign_entity_ref 安全路由", () => {
    it("纯函数 applyCanvasAgentOps 对 assign op 原样跳过（不落节点、不打穿 nodes）", () => {
        const snapshot: CanvasAgentSnapshot = {
            ...baseSnapshot,
            nodes: [
                ...baseSnapshot.nodes,
                {
                    id: "script-1",
                    type: "script",
                    title: "脚本",
                    position: { x: 0, y: 0 },
                    width: 250,
                    height: 170,
                    metadata: { script: { schemaVersion: 1, instruction: "", globalStyle: "", entityIds: [], output: { status: "idle", shots: [] } } as unknown as ScriptNodeData },
                },
            ],
        };
        const result = applyCanvasAgentOps(snapshot, [{ type: "script_assign_entity_ref", entityId: "ent_1", refId: "ref_1", nodeId: "image-1" }], undefined as never);
        expect(result.nodes).toEqual(snapshot.nodes);
        expect(result.connections).toEqual(snapshot.connections);
    });
});

describe("applyCanvasAgentOpsWithReceipts", () => {
    it("update_node 目标不存在 → skipped（节点不存在），画布不变", () => {
        const { next, receipts } = applyCanvasAgentOpsWithReceipts(baseSnapshot, [
            { type: "update_node", id: "ghost", patch: { title: "x" } },
        ]);
        expect(next.nodes[0].title).toBe("img");
        expect(receipts).toEqual([
            { opIndex: 0, opType: "update_node", status: "skipped", reason: "节点不存在：ghost" },
        ]);
    });

    it("delete_node 部分命中 → applied 且 nodeIds 只含命中 id", () => {
        const { next, receipts } = applyCanvasAgentOpsWithReceipts(baseSnapshot, [
            { type: "delete_node", ids: ["n1", "ghost"] },
        ]);
        expect(next.nodes).toHaveLength(0);
        expect(receipts[0].status).toBe("applied");
        expect(receipts[0].nodeIds).toEqual(["n1"]);
    });

    it("connect_nodes 同向重复 → skipped（连线已存在）", () => {
        const snapshot = { ...baseSnapshot, connections: [{ id: "c1", fromNodeId: "n1", toNodeId: "n1" }] };
        const { receipts } = applyCanvasAgentOpsWithReceipts(snapshot, [
            { type: "connect_nodes", fromNodeId: "n1", toNodeId: "n1" },
        ]);
        expect(receipts[0]).toMatchObject({ status: "skipped", reason: "连线已存在" });
    });

    it("未知 op 类型 → invalid；结构无法解析 → invalid", () => {
        const { receipts } = applyCanvasAgentOpsWithReceipts(baseSnapshot, [
            { type: "teleport_node", id: "n1" } as never,
            { op: "fitView" } as never,
            "garbage" as never,
        ]);
        expect(receipts[0]).toMatchObject({ opIndex: 0, opType: "teleport_node", status: "invalid" });
        expect(receipts[0].reason).toContain("不支持的 op 类型");
        expect(receipts[1]).toMatchObject({ opIndex: 1, status: "invalid" });
        expect(receipts[2]).toMatchObject({ opIndex: 2, status: "invalid", reason: "op 结构无法解析" });
    });

    it("select_nodes 缺 ids（误传 nodeIds）→ invalid 且选区不变", () => {
        const { next, receipts } = applyCanvasAgentOpsWithReceipts(baseSnapshot, [
            { type: "select_nodes", nodeIds: ["n1"] } as never,
        ]);
        expect(next.selectedNodeIds).toEqual([]);
        expect(receipts[0]).toMatchObject({ status: "invalid" });
        expect(receipts[0].reason).toContain("select_nodes 需要 ids 字段");
    });

    it("add_node → applied 并带新节点 id；原 applyCanvasAgentOps 签名行为不变", () => {
        const { receipts } = applyCanvasAgentOpsWithReceipts(baseSnapshot, [
            { type: "add_node", id: "n2", nodeType: "text" },
        ]);
        expect(receipts[0]).toMatchObject({ opIndex: 0, opType: "add_node", status: "applied", nodeIds: ["n2"] });

        const legacy = applyCanvasAgentOps(baseSnapshot, [{ type: "add_node", id: "n2", nodeType: "text" }]);
        expect(legacy.nodes).toHaveLength(2);
        expect(legacy.receipts).toBeUndefined();
    });

    it("script op：节点不存在 → skipped；reorder 镜头 id 无效 → skipped 且顺序未变更", () => {
        const scriptNode = { ...baseSnapshot.nodes[0], id: "s1", type: "script", metadata: {} };
        const snapshot = { ...baseSnapshot, nodes: [scriptNode] } as typeof baseSnapshot;
        const { receipts } = applyCanvasAgentOpsWithReceipts(snapshot, [
            { type: "script_delete_shot", nodeId: "ghost", shotId: "shot-1" },
            { type: "script_delete_shot", nodeId: "s1", shotId: "shot-1" },
        ]);
        expect(receipts[0]).toMatchObject({ status: "skipped" });
        expect(receipts[0].reason).toContain("节点不存在：ghost");
        expect(receipts[1]).toMatchObject({ status: "skipped" });
        expect(receipts[1].reason).toContain("不是脚本节点");
    });

    it("run_generation 直入纯函数 → skipped（由生成派发分支处理）", () => {
        const { receipts } = applyCanvasAgentOpsWithReceipts(baseSnapshot, [
            { type: "run_generation", nodeId: "n1", mode: "image" },
        ]);
        expect(receipts[0]).toMatchObject({ opType: "run_generation", status: "skipped" });
    });
});

describe("add_text_nodes 与 anchorNodeIds", () => {
    it("add_text_nodes 游标布局（column 默认 gap 24），产出单条汇总回执", () => {
        const { next, receipts } = applyCanvasAgentOpsWithReceipts(baseSnapshot, [
            { type: "add_text_nodes", items: [{ text: "一" }, { text: "二" }] },
        ]);
        const created = next.nodes.filter((node) => node.type === "text");
        expect(created).toHaveLength(2);
        expect(created[1].position.y).toBe(created[0].position.y + created[0].height + 24);
        expect(created[0].metadata?.content).toBe("一");
        expect(receipts[0]).toMatchObject({ opIndex: 0, opType: "add_text_nodes", status: "applied" });
        expect(receipts[0].nodeIds).toEqual([created[0].id, created[1].id]);
    });

    it("add_text_nodes row 方向：沿 x 游标推进，y 保持一致", () => {
        const { next } = applyCanvasAgentOpsWithReceipts(baseSnapshot, [
            { type: "add_text_nodes", items: [{ text: "一" }, { text: "二" }], direction: "row" },
        ]);
        const created = next.nodes.filter((node) => node.type === "text");
        expect(created).toHaveLength(2);
        expect(created[1].position.x).toBe(created[0].position.x + created[0].width + 24);
        expect(created[1].position.y).toBe(created[0].position.y);
    });

    it("add_node 无坐标 + anchorNodeIds：新节点贴着锚点放置且互不重叠", () => {
        const { next } = applyCanvasAgentOpsWithReceipts(
            { ...baseSnapshot, selectedNodeIds: [], viewportSize: { width: 1200, height: 720 } },
            [
                { type: "add_node", id: "a", nodeType: "text", position: { x: 0, y: 0 } },
                { type: "add_node", id: "b", nodeType: "text", anchorNodeIds: ["a"] },
                { type: "add_node", id: "c", nodeType: "text", anchorNodeIds: ["a"] },
            ],
        );
        const placed = next.nodes.filter((node) => ["b", "c"].includes(node.id));
        expect(placed).toHaveLength(2);
        const overlap = placed[0].position.x < placed[1].position.x + placed[1].width
            && placed[1].position.x < placed[0].position.x + placed[0].width
            && placed[0].position.y < placed[1].position.y + placed[1].height
            && placed[1].position.y < placed[0].position.y + placed[0].height;
        expect(overlap).toBe(false);
    });

    it("add_text_nodes items 为空 → invalid 回执", () => {
        const { receipts } = applyCanvasAgentOpsWithReceipts(baseSnapshot, [
            { type: "add_text_nodes", items: [] } as never,
        ]);
        expect(receipts[0]).toMatchObject({ opType: "add_text_nodes", status: "invalid" });
    });
});
