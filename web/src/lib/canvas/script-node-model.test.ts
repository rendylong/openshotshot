import { describe, expect, it } from "vitest";
import {
    buildShot,
    composeEntityRefPrompt,
    composeFinalPrompt,
    composeStoryboardPrompt,
    planAudioMaterialization,
    planLibraryRefBackfill,
    planShotExpansion,
    planStoryboardExpansion,
    selectGroupVideoTargets,
    deriveConsumptionEdges,
    deriveDescription,
    deriveEntityRefs,
    entityWritebackFromNode,
    entityRefFailureFromNode,
    shouldApplyEntityWriteback,
    htmlToRich,
    imageGenMetadataPatch,
    managedAudioNodeIds,
    nextShotVideoNo,
    normalizeShots,
    normalizeShotVideoVersions,
    pushShotVideoVersion,
    richToHtml,
    selectShotVideoVersion,
    storyboardImageStateOf,
    videoGenMetadataPatch,
} from "./script-node-model";
import type { CanvasNodeData } from "@/types/canvas";
import type { ScriptNodeData, ScriptRichSegment, ScriptShot, ShotAudioRef, ShotVideoVersion } from "@/types/script-node";
import type { ScriptEntity } from "@/stores/use-script-entity-store";

const ent = (id: string, name: string, group: ScriptEntity["group"] = "character"): ScriptEntity =>
    ({ id, projectId: "p1", group, name, refs: [], createdAt: "", updatedAt: "" });

const shot = (over: Partial<ScriptShot> = {}): ScriptShot => ({
    shotId: "s1",
    no: 1,
    origin: "manual",
    shotSize: "中景",
    angle: "平视",
    movement: "固定",
    duration: 4,
    mood: "温暖",
    sfx: "",
    dialogue: "",
    descriptionRich: [],
    description: "",
    entityRefs: [],
    composed: false,
    ...over,
});

describe("derive", () => {
    it("description 由 rich 派生，引用取实体名", () => {
        const rich: ScriptRichSegment[] = [{ t: "text", v: "灶台前，" }, { t: "ref", entityId: "e1" }, { t: "text", v: " 颠勺" }];
        expect(deriveDescription(rich, (id) => (id === "e1" ? "狸花猫大厨" : undefined))).toBe("灶台前，狸花猫大厨 颠勺");
    });

    it("entityRefs 按出现顺序去重", () => {
        expect(
            deriveEntityRefs([{ t: "ref", entityId: "a" }, { t: "text", v: "x" }, { t: "ref", entityId: "a" }, { t: "ref", entityId: "b" }]),
        ).toEqual(["a", "b"]);
    });
});

describe("rich <-> html", () => {
    it("richToHtml 渲染内联胶囊并可用 htmlToRich 无损还原", () => {
        const metaOf = (id: string) => (id === "e1" ? { name: "外星客人", group: "scene" as const } : undefined);
        const rich: ScriptRichSegment[] = [{ t: "text", v: "辣椒森林，" }, { t: "ref", entityId: "e1" }];
        const html = richToHtml(rich, metaOf);
        expect(html).toContain("data-entity-group=\"scene\"");
        expect(html).toContain("外星客人");
        const host = document.createElement("div");
        host.innerHTML = html;
        host.querySelectorAll(".inline-entity").forEach((n) => n.setAttribute("contenteditable", "false"));
        expect(htmlToRich(host)).toEqual(rich);
    });

    it("htmlToRich 处理嵌套与换行（相邻文本段合并）", () => {
        const host = document.createElement("div");
        host.innerHTML = "a<b>b</b><br><span>x</span>";
        expect(htmlToRich(host)).toEqual([{ t: "text", v: "ab\nx" }]);
    });
});

describe("buildShot / normalizeShots", () => {
    it("buildShot 默认值为空（不预填假数据），覆盖生效", () => {
        const s = buildShot(3);
        expect(s.no).toBe(3);
        expect(s.origin).toBe("manual");
        expect(s.shotSize).toBe("");
        expect(s.angle).toBe("");
        expect(s.movement).toBe("");
        expect(s.mood).toBe("");
        expect(s.duration).toBe(0); // 0 = 未设置
        expect(buildShot(1, { origin: "generated" }).origin).toBe("generated");
    });

    it("normalizeShots 重排序号", () => {
        const shots = [shot({ shotId: "b" }), shot({ shotId: "a" })];
        expect(normalizeShots(shots).map((s) => s.no)).toEqual([1, 2]);
    });
});

describe("composeFinalPrompt", () => {
    it("拼入元信息/描述/台词/实体/全局风格", () => {
        const s = shot({ description: "切开辣椒", dialogue: "「好辣」", entityRefs: ["e1"] });
        const text = composeFinalPrompt(s, [ent("e1", "发光辣椒", "item")], "皮克斯风格");
        expect(text).toContain("【中景 · 平视 · 固定 · 4s · 氛围:温暖】");
        expect(text).toContain("切开辣椒");
        expect(text).toContain("「好辣」");
        expect(text).toContain("[道具:发光辣椒]");
        expect(text).toContain("皮克斯风格");
    });

    it("无实体/无风格时有兜底行", () => {
        const text = composeFinalPrompt(shot(), [], "");
        expect(text).toContain("（无）");
        expect(text).toContain("（未设置）");
    });

    it("描述中未选中资产的孤立 @ 不进入提示词", () => {
        const text = composeFinalPrompt(shot({ description: "抬头看房梁 @ 的部分" }), [], "");
        expect(text).toContain("抬头看房梁 的部分");
        expect(text).not.toContain("@");
        // 邮箱类 @（后跟非空白）保留
        const mail = composeFinalPrompt(shot({ description: "联系 a@b.c" }), [], "");
        expect(mail).toContain("a@b.c");
    });

    it("拍摄参数部分为空：空段跳过", () => {
        const text = composeFinalPrompt(shot({ shotSize: "特写", duration: 0, mood: "" }), [], "");
        expect(text).toContain("【特写 · 平视 · 固定】");
        expect(text).not.toContain("0s");
        expect(text).not.toContain("氛围:");
    });

    it("音效/描述为空时占位文案不进入提示词", () => {
        const text = composeFinalPrompt(shot({ description: "", sfx: "", dialogue: "" }), [], "");
        expect(text).not.toContain("音效：");
        expect(text).not.toContain("（镜头描述）");
        expect(text).not.toContain("台词：");
    });

    it("五字段全空：【】行省略且分隔符保留（断言完整输出串，锁死槽位）", () => {
        const text = composeFinalPrompt(buildShot(1), [], "");
        // 头部/描述/音效/台词四槽位为空被过滤，i===4/i===7 两个空行分隔符必须保留
        expect(text).toBe("\n— 实体绑定 —\n  （无）\n\n— 全局风格 —\n（未设置）");
    });
});

describe("composeEntityRefPrompt", () => {
    it("全部设定拼入：头部含类型/名字/定位，imagePrompt 作主体，appearance/consistency 成补充段", () => {
        const text = composeEntityRefPrompt({ group: "character", name: "狸花猫大厨", role: "主角", appearance: "橘色虎斑猫，系白色围裙", consistency: "左耳缺口", imagePrompt: "厨房中景，皮克斯风格" });
        expect(text).toBe("【角色：狸花猫大厨 · 主角】\n厨房中景，皮克斯风格\n定义：橘色虎斑猫，系白色围裙\n一致性：左耳缺口");
    });

    it("imagePrompt 与 appearance 同时非空才出「定义：」段，不重复 appearance 主体", () => {
        const text = composeEntityRefPrompt({ group: "scene", name: "晨间卧室", appearance: "暖光木质卧室" });
        expect(text).toBe("【场景：晨间卧室】\n暖光木质卧室");
    });

    it("空白字段整段跳过", () => {
        const text = composeEntityRefPrompt({ group: "item", name: "铜壶", role: "  ", appearance: " ", consistency: "", imagePrompt: "  " });
        expect(text).toBe("【道具：铜壶】");
    });

    it("名字也为空时回落空串（对齐旧回退链末位）", () => {
        expect(composeEntityRefPrompt({ group: "item", name: "  " })).toBe("");
    });
});

describe("expansionTitle（经 planShotExpansion 观测）", () => {
    it("空景别省略尾缀", () => {
        const plan = planShotExpansion({
            shots: [buildShot(2), buildShot(3, { shotSize: "特写" })],
            expandedShotNodes: {},
            canvasNodeIds: new Set<string>(),
            entities: [],
            globalStyle: "",
        });
        expect(plan.create.map((c) => c.title)).toEqual(["镜头 2", "镜头 3 · 特写"]);
    });
});

describe("deriveConsumptionEdges", () => {
    const script = (expanded: Record<string, string>): ScriptNodeData => ({
        schemaVersion: 1,
        instruction: "",
        globalStyle: "",
        entityIds: ["e1", "e2"],
        output: {
            status: "done",
            shots: [shot({ shotId: "s1", entityRefs: ["e1"] }), shot({ shotId: "s2", entityRefs: ["e2", "ghost"] })],
            expandedShotNodes: expanded,
        },
    });

    it("实体槽位节点 → 展开的镜头节点；悬空/未展开跳过", () => {
        const edges = deriveConsumptionEdges(script({ s1: "video-1", s2: "video-2" }), (id) =>
            id === "e1" ? "img-1" : id === "e2" ? "img-2" : undefined,
        );
        expect(edges).toEqual([
            { fromNodeId: "img-1", toNodeId: "video-1" },
            { fromNodeId: "img-2", toNodeId: "video-2" },
        ]);
    });

    it("未展开的镜头不产生边", () => {
        expect(deriveConsumptionEdges(script({}), (id) => (id === "e1" ? "img-1" : undefined))).toEqual([]);
    });
});

describe("entityWritebackFromNode", () => {
    it("成功 + storageKey + scriptEntityRef 齐备时产生回写", () => {
        const r = entityWritebackFromNode({ id: "n1", metadata: { status: "success", storageKey: "k1", scriptEntityRef: { entityId: "e1", refId: "r1" } } });
        expect(r).toEqual({ entityId: "e1", refId: "r1", patch: { state: "ready", source: "generated", nodeId: "n1", storageKey: "k1" } });
    });

    it("成功写在 images[i] 的多图形态也产生回写（取该图的 storageKey）", () => {
        const r = entityWritebackFromNode({ id: "n2", metadata: { status: "loading", images: [{ status: "success", storageKey: "k9" }, { status: "loading" }], scriptEntityRef: { entityId: "e2", refId: "r9" } } });
        expect(r).toEqual({ entityId: "e2", refId: "r9", patch: { state: "ready", source: "generated", nodeId: "n2", storageKey: "k9" } });
    });

    it("无 ref / 未成功 / 无 storageKey 均返回 null", () => {
        expect(entityWritebackFromNode({ id: "n1", metadata: { status: "success", storageKey: "k1" } })).toBeNull();
        expect(entityWritebackFromNode({ id: "n1", metadata: { status: "loading", storageKey: "k1", scriptEntityRef: { entityId: "e1", refId: "r1" } } })).toBeNull();
        expect(entityWritebackFromNode({ id: "n1", metadata: { status: "success", scriptEntityRef: { entityId: "e1", refId: "r1" } } })).toBeNull();
    });

    it("项目资产 assetRef 随回写进入槽位（顶层与 images[i] 两种形态）", () => {
        const fileRef = { backend: "project-file", assetId: "a1", projectId: "p1", relativePath: "assets/generated/images/a1.png", revision: 1 } as const;
        const topLevel = entityWritebackFromNode({ id: "n1", metadata: { status: "success", storageKey: "k1", assetRef: fileRef, scriptEntityRef: { entityId: "e1", refId: "r1" } } });
        expect(topLevel?.patch.assetRef).toEqual(fileRef);
        const fromImages = entityWritebackFromNode({ id: "n2", metadata: { status: "loading", images: [{ status: "success", storageKey: "k9", assetRef: fileRef }], scriptEntityRef: { entityId: "e2", refId: "r9" } } });
        expect(fromImages?.patch.assetRef).toEqual(fileRef);
    });

    it("桌面 move 语义：assetRef-only（无 storageKey）的成功节点仍可回写，patch 不含 storageKey", () => {
        const fileRef = { backend: "project-file", assetId: "a2", projectId: "p1", relativePath: "assets/generated/images/a2.png", revision: 1 } as const;
        const topLevel = entityWritebackFromNode({ id: "n1", metadata: { status: "success", assetRef: fileRef, scriptEntityRef: { entityId: "e1", refId: "r1" } } });
        expect(topLevel).toEqual({ entityId: "e1", refId: "r1", patch: { state: "ready", source: "generated", nodeId: "n1", assetRef: fileRef } });
        const fromImages = entityWritebackFromNode({ id: "n2", metadata: { status: "loading", images: [{ status: "success", assetRef: fileRef }], scriptEntityRef: { entityId: "e2", refId: "r9" } } });
        expect(fromImages).toEqual({ entityId: "e2", refId: "r9", patch: { state: "ready", source: "generated", nodeId: "n2", assetRef: fileRef } });
        // 既无 storageKey 也无 assetRef 的成功态不可回写（防未落盘空槽）
        expect(entityWritebackFromNode({ id: "n3", metadata: { status: "success", scriptEntityRef: { entityId: "e3", refId: "r3" } } })).toBeNull();
    });
});

describe("Script 序列化回归（无第二份文件型脚本状态）", () => {
    it("序列化 Script 节点：结构化数据只存在于 metadata.script，无 scriptPath/scriptFile 字段", () => {
        const script: ScriptNodeData = {
            schemaVersion: 1,
            instruction: "做菜短片",
            globalStyle: "胶片感",
            entityIds: ["e1"],
            template: { shotCount: 3, storyboardFirst: true },
            output: {
                status: "done",
                shots: [shot({ shotId: "s1", entityRefs: ["e1"], composed: true, finalPrompt: "P", sfxAudio: { name: "line.wav", assetRef: { backend: "indexeddb", storageKey: "k1" } } })],
                expandedShotNodes: { s1: "video-1" },
                storyboardNodes: { s1: "image-1" },
                shotAudioNodes: { s1: { sfx: { id: "audio-1", materialized: true } } },
                shotVideoVersions: { s1: [{ nodeId: "video-1", no: 1 }] },
            },
        };
        const node: CanvasNodeData = { id: "script-1", type: "script", title: "脚本", position: { x: 0, y: 0 }, width: 250, height: 170, metadata: { script } };
        const serialized = JSON.parse(JSON.stringify(node));
        // 结构化数据整体位于 metadata.script；节点层没有任何脚本文件路径/文件句柄字段。
        expect(serialized.metadata.script.output.shots).toHaveLength(1);
        expect(serialized.metadata.script.output.shotVideoVersions.s1).toEqual([{ nodeId: "video-1", no: 1 }]);
        expect(Object.keys(serialized.metadata)).toEqual(["script"]);
        for (const key of ["scriptPath", "scriptFile", "scriptFilePath", "scriptFileRef"]) {
            expect(serialized.metadata).not.toHaveProperty(key);
        }
    });
});

describe("planShotExpansion（v0.6 幂等展开）", () => {
    const shot = (shotId: string, no: number, over: Partial<ScriptShot> = {}): ScriptShot => ({
        shotId, no, origin: "manual", shotSize: "中景", angle: "平视", movement: "固定",
        duration: 4, mood: "温暖", sfx: "", dialogue: "", descriptionRich: [], description: "d", entityRefs: [], composed: true, finalPrompt: `P-${shotId}`, ...over,
    });
    const ents = [ent("e1", "狸花猫大厨")];
    const args = (shots: ScriptShot[], expanded: Record<string, string>, canvasIds: string[]) => ({
        shots, expandedShotNodes: expanded, canvasNodeIds: new Set(canvasIds), entities: ents, globalStyle: "G",
    });

    it("首次展开全 create，title 带镜号", () => {
        const plan = planShotExpansion(args([shot("s1", 1)], {}, []));
        expect(plan.create).toHaveLength(1);
        expect(plan.create[0]).toMatchObject({ shotId: "s1", title: "镜头 1 · 中景" });
        expect(plan.reuse).toHaveLength(0);
        expect(plan.update).toHaveLength(0);
    });

    it("重复调用同输入全 reuse（幂等）", () => {
        const plan = planShotExpansion(args([shot("s1", 1)], { s1: "v1" }, ["v1"]));
        expect(plan.reuse).toHaveLength(1);
        expect(plan.create).toHaveLength(0);
    });

    it("重排后 no 变化：仍 reuse，但 title 刷新为新序号", () => {
        const plan = planShotExpansion(args([shot("s1", 3)], { s1: "v1" }, ["v1"]));
        expect(plan.reuse[0]).toMatchObject({ shotId: "s1", nodeId: "v1", title: "镜头 3 · 中景" });
    });

    it("finalPrompt 变化 → update（引用集合为 ready 槽 nodeId）", () => {
        const e1 = { ...ents[0], refs: [{ id: "r1", label: "sheet", state: "ready" as const, nodeId: "img-1" }] };
        const plan = planShotExpansion({ shots: [shot("s1", 1, { finalPrompt: "新内容", entityRefs: ["e1"] })], expandedShotNodes: { s1: "v1" }, canvasNodeIds: new Set(["v1", "img-1"]), entities: [e1], globalStyle: "G" });
        expect(plan.update).toHaveLength(1);
        expect(plan.update[0]).toMatchObject({ shotId: "s1", nodeId: "v1", prompt: "新内容", referenceNodeIds: ["img-1"] });
    });

    it("映射指向已删节点 → 重建（create）", () => {
        const plan = planShotExpansion(args([shot("s1", 1)], { s1: "v-gone" }, []));
        expect(plan.create).toHaveLength(1);
        expect(plan.reuse).toHaveLength(0);
    });

    it("引用集合比较与顺序无关（E1）", () => {
        const e1 = { ...ents[0], refs: [{ id: "r1", label: "sheet", state: "ready" as const, nodeId: "b-node" }] };
        // existingReferences 记录的来源列表与 refs 解析结果集合相同（顺序无关）→ 不该 update
        const plan = planShotExpansion({ shots: [{ ...shot("s1", 1), entityRefs: ["e1"] }], expandedShotNodes: { s1: "v1" }, canvasNodeIds: new Set(["v1", "b-node"]), entities: [e1], globalStyle: "G", existingReferences: { s1: ["b-node"], "__prompt__s1": ["P-s1"] } });
        expect(plan.update).toHaveLength(0);
        expect(plan.reuse[0]?.title).toBe("镜头 1 · 中景");
    });

    it("实体槽位 nodeId 不在画布（节点已删）时不进入 referenceNodeIds", () => {
        const e1 = { ...ents[0], refs: [{ id: "r1", label: "sheet", state: "ready" as const, nodeId: "image-deleted" }] };
        const plan = planShotExpansion({ shots: [{ ...shot("s1", 1), entityRefs: ["e1"] }], expandedShotNodes: {}, canvasNodeIds: new Set(["script-1"]), entities: [e1], globalStyle: "G" });
        expect(plan.create[0]!.referenceNodeIds).not.toContain("image-deleted");
        expect(plan.create[0]!.referenceNodeIds).toEqual([]);
    });
});

describe("selectGroupVideoTargets（v0.6 组批量）", () => {
    const video = (id: string, status: string, prompt: string): CanvasNodeData => ({
        id, type: "video", title: id, position: { x: 0, y: 0 }, width: 100, height: 100,
        metadata: { status: status as never, generationMode: "video", prompt },
    });
    it("跳过 success 与空 prompt，其余进入 start", () => {
        const members = [video("a", "success", "p1"), video("b", "idle", "p2"), video("c", "error", "p3"), video("d", "idle", "")];
        const r = selectGroupVideoTargets(members);
        expect(r.start.map((n) => n.id)).toEqual(["b", "c"]);
        expect(r.skipped).toBe(1); // 仅统计"符合候选但已有成片"的 a；d 空 prompt 非候选
    });
    it("全部已生成时 start 为空", () => {
        const r = selectGroupVideoTargets([video("a", "success", "p1")]);
        expect(r.start).toHaveLength(0);
        expect(r.skipped).toBe(1);
    });
});

describe("planShotExpansion 音频引用", () => {
    it("音频节点并入 referenceNodeIds；悬空过滤；sfx=dialogue 去重", () => {
        const s = shot({ shotId: "s1", entityRefs: [], sfxAudio: { name: "a", audioNodeId: "audio-1" }, dialogueAudio: { name: "b", audioNodeId: "audio-2" } });
        const plan = planShotExpansion({ shots: [s], expandedShotNodes: {}, canvasNodeIds: new Set(["audio-1"]), entities: [], globalStyle: "" });
        expect(plan.create[0]?.referenceNodeIds).toEqual(["audio-1"]);
    });

    it("音频变化使 reuse 转 update；受管音频边收集后稳态 reuse（D20 前提）", () => {
        const s = shot({ shotId: "s1", composed: true, finalPrompt: "p", entityRefs: [], sfxAudio: { name: "a", audioNodeId: "audio-1" } });
        const base = { shots: [s], expandedShotNodes: { s1: "video-1" }, canvasNodeIds: new Set(["video-1", "audio-1"]), entities: [], globalStyle: "" };
        expect(planShotExpansion({ ...base, existingReferences: { s1: [], __prompt__s1: ["p"] } }).update).toHaveLength(1);
        expect(planShotExpansion({ ...base, existingReferences: { s1: ["audio-1"], __prompt__s1: ["p"] } }).reuse).toHaveLength(1);
    });

    it("上传来源经 shotAudioNodes 映射并入引用；映射键悬空被过滤", () => {
        const s = shot({ shotId: "s1", entityRefs: [], dialogueAudio: { name: "b", storageKey: "audio:k1" } });
        const plan = planShotExpansion({
            shots: [s], expandedShotNodes: {}, canvasNodeIds: new Set(["audio-9"]),
            entities: [], globalStyle: "", shotAudioNodes: { s1: { dialogue: { id: "audio-9", materialized: true }, sfx: { id: "audio-gone", materialized: true } } },
        });
        expect(plan.create[0]?.referenceNodeIds).toEqual(["audio-9"]);
    });
});

describe("planAudioMaterialization", () => {
    const upload = (name: string, storageKey: string): ShotAudioRef => ({ name, storageKey });

    it("上传来源且映射缺失 → create；引用清除 → prune", () => {
        const plan = planAudioMaterialization({
            shots: [shot({ shotId: "s1", dialogueAudio: upload("配音.mp3", "audio:k1") })],
            shotAudioNodes: { s2: { sfx: { id: "audio-x", materialized: true } } },
            canvasNodeIds: new Set(),
            audioNodeStorageKeys: {},
        });
        expect(plan.create).toEqual([{ shotId: "s1", slot: "dialogue", snapshot: { name: "配音.mp3", storageKey: "audio:k1" } }]);
        expect(plan.update).toEqual([]);
        expect(plan.prune).toEqual([{ shotId: "s2", slot: "sfx" }]);
    });

    it("映射存在且 storageKey 一致 → noop；变化 → update；节点被删 → 复活 create", () => {
        const snapshot = upload("a.mp3", "audio:k1");
        const base = { shots: [shot({ shotId: "s1", sfxAudio: snapshot })], canvasNodeIds: new Set(["audio-1"]) };
        expect(planAudioMaterialization({ ...base, shotAudioNodes: { s1: { sfx: { id: "audio-1", materialized: true } } }, audioNodeStorageKeys: { "audio-1": "audio:k1" } })).toMatchObject({ create: [], update: [], prune: [] });
        expect(planAudioMaterialization({ ...base, shotAudioNodes: { s1: { sfx: { id: "audio-1", materialized: true } } }, audioNodeStorageKeys: { "audio-1": "audio:k2" } }).update).toEqual([{ nodeId: "audio-1", snapshot }]);
        // 节点被删：mapped 不在 canvasNodeIds → 复活 create（brief 原测试漏了 canvasNodeIds 覆盖，见 task-1-report 偏差记录）
        expect(planAudioMaterialization({ ...base, shotAudioNodes: { s1: { sfx: { id: "audio-1", materialized: true } } }, canvasNodeIds: new Set(), audioNodeStorageKeys: {} }).create).toEqual([{ shotId: "s1", slot: "sfx", snapshot }]);
    });

    it("画布选择来源（有 audioNodeId）不物化，其残留映射键 prune", () => {
        const plan = planAudioMaterialization({
            shots: [shot({ shotId: "s1", sfxAudio: { name: "x", audioNodeId: "audio-9" } })],
            shotAudioNodes: { s1: { sfx: { id: "audio-1", materialized: true }, dialogue: { id: "audio-2", materialized: true } } },
            canvasNodeIds: new Set(["audio-1", "audio-2"]),
            audioNodeStorageKeys: {},
        });
        expect(plan.create).toEqual([]);
        expect(plan.update).toEqual([]);
        expect(plan.prune).toEqual([{ shotId: "s1", slot: "sfx" }, { shotId: "s1", slot: "dialogue" }]);
    });
});

describe("picked 音频映射记忆（D21 materialized: false）", () => {
    const prePrune = { s1: { sfx: { id: "audio-1", materialized: false } } };

    it("清除画布选择音频：prune 槽位 + pre-prune 受管集合仍含旧节点（project.tsx 依此对删除幽灵边）", () => {
        const cleared = shot({ shotId: "s1" });
        const plan = planAudioMaterialization({
            shots: [cleared],
            shotAudioNodes: prePrune,
            canvasNodeIds: new Set(["audio-1"]),
            audioNodeStorageKeys: { "audio-1": "audio:k1" },
        });
        expect(plan.prune).toEqual([{ shotId: "s1", slot: "sfx" }]);
        expect(plan.create).toEqual([]);
        expect(plan.update).toEqual([]);
        expect(managedAudioNodeIds(cleared, prePrune, "s1")).toContain("audio-1");
    });

    it("换成另一个画布选择节点：prune 旧记忆 + 受管集合含旧节点", () => {
        const swapped = shot({ shotId: "s1", sfxAudio: { name: "b", audioNodeId: "audio-2" } });
        const plan = planAudioMaterialization({
            shots: [swapped],
            shotAudioNodes: prePrune,
            canvasNodeIds: new Set(["audio-1", "audio-2"]),
            audioNodeStorageKeys: {},
        });
        expect(plan.prune).toEqual([{ shotId: "s1", slot: "sfx" }]);
        expect(plan.create).toEqual([]);
        expect(plan.update).toEqual([]);
        expect(managedAudioNodeIds(swapped, prePrune, "s1")).toContain("audio-1");
    });

    it("picked 稳态（同一节点）：不 prune、不 create/update", () => {
        const steady = shot({ shotId: "s1", sfxAudio: { name: "a", audioNodeId: "audio-1" } });
        const plan = planAudioMaterialization({
            shots: [steady],
            shotAudioNodes: prePrune,
            canvasNodeIds: new Set(["audio-1"]),
            audioNodeStorageKeys: {},
        });
        expect(plan.create).toEqual([]);
        expect(plan.update).toEqual([]);
        expect(plan.prune).toEqual([]);
    });
});

describe("managedAudioNodeIds", () => {
    it("引用清除但 pre-prune 映射仍在 → 旧物化节点保留在受管集合（幽灵边会被同步删除）", () => {
        const cleared = shot({ shotId: "s1" });
        expect(managedAudioNodeIds(cleared, { s1: { sfx: { id: "audio-1", materialized: true } } }, "s1")).toContain("audio-1");
    });

    it("画布选择来源的 dialogueAudio.audioNodeId 计入受管集合", () => {
        const picked = shot({ shotId: "s1", dialogueAudio: { name: "配音", audioNodeId: "audio-9" } });
        expect(managedAudioNodeIds(picked, undefined, "s1")).toContain("audio-9");
    });

    it("无引用且无映射 → 空集合", () => {
        expect(managedAudioNodeIds(shot({ shotId: "s1" }), {}, "s1")).toEqual(new Set());
    });
});

describe("shouldApplyEntityWriteback（回写竞态守卫）", () => {
    const nodeA = { id: "node-A" };

    it("agent 路径回归保护：empty 槽（canvas_script_asset 创建后未置 queued）放行", () => {
        expect(shouldApplyEntityWriteback({ state: "empty" }, nodeA)).toBe(true);
    });

    it("queued/generated 且归属节点匹配 → 放行", () => {
        expect(shouldApplyEntityWriteback({ state: "queued", source: "generated", nodeId: "node-A" }, nodeA)).toBe(true);
    });

    it("归属已被更新节点接管时，旧节点结果拒绝", () => {
        expect(shouldApplyEntityWriteback({ state: "queued", source: "generated", nodeId: "node-B" }, nodeA)).toBe(false);
    });

    it("用户已选画布图（ready/canvas）→ 在途生成不得覆盖", () => {
        expect(shouldApplyEntityWriteback({ state: "ready", source: "canvas", nodeId: "img-9" }, nodeA)).toBe(false);
    });

    it("用户已选资产库图（ready/library）→ 拒绝", () => {
        expect(shouldApplyEntityWriteback({ state: "ready", source: "library", assetId: "a1" }, nodeA)).toBe(false);
    });

    it("legacy queued/generated 无归属字段 → 放行（旧数据现状行为）", () => {
        expect(shouldApplyEntityWriteback({ state: "queued", source: "generated" }, nodeA)).toBe(true);
    });

    it("槽不存在（实体/槽已被删）→ 拒绝", () => {
        expect(shouldApplyEntityWriteback(undefined, nodeA)).toBe(false);
    });

    it("ready/generated 同节点重复回写由 effect 去重负责，本函数放行", () => {
        expect(shouldApplyEntityWriteback({ state: "ready", source: "generated", nodeId: "node-A" }, nodeA)).toBe(true);
    });
});

describe("镜头视频版本助手（spec v2 D8）", () => {
    const v = (nodeId: string, no: number): ShotVideoVersion => ({ nodeId, no });

    it("nextShotVideoNo 取历史最大 no + 1（从旧版本再生成不重名），空列表从 1 起", () => {
        expect(nextShotVideoNo([v("a", 1), v("b", 3), v("c", 2)])).toBe(4);
        expect(nextShotVideoNo(undefined)).toBe(1);
    });

    it("pushShotVideoVersion 插入头部成为当前版本，其余顺序保持", () => {
        const next = pushShotVideoVersion([v("a", 1), v("b", 2)], "c");
        expect(next.map((x) => x.nodeId)).toEqual(["c", "a", "b"]);
        expect(next[0]?.no).toBe(3);
    });

    it("selectShotVideoVersion 移动到头部且 no 不变；目标缺失返回 null", () => {
        const list = [v("a", 3), v("b", 1), v("c", 2)];
        const picked = selectShotVideoVersion(list, "c");
        expect(picked?.map((x) => x.nodeId)).toEqual(["c", "a", "b"]);
        expect(picked?.[0]?.no).toBe(2);
        expect(selectShotVideoVersion(list, "missing")).toBeNull();
    });

    it("normalizeShotVideoVersions 过滤已删除节点且保持顺序，undefined 安全", () => {
        expect(normalizeShotVideoVersions([v("a", 1), v("gone", 2), v("b", 3)], new Set(["a", "b"]))).toEqual([v("a", 1), v("b", 3)]);
        expect(normalizeShotVideoVersions(undefined, new Set())).toEqual([]);
    });
});

describe("composeStoryboardPrompt（分镜图模板兜底，spec D6）", () => {
    const entities: ScriptEntity[] = [
        { id: "e1", projectId: "p", group: "character", name: "陆远", refs: [], createdAt: "", updatedAt: "" },
        { id: "e2", projectId: "p", group: "scene", name: "深夜办公室", refs: [], createdAt: "", updatedAt: "" },
    ];
    const shot = (over: Partial<ScriptShot> = {}): ScriptShot => ({
        shotId: "s1", no: 1, origin: "manual", shotSize: "中景", angle: "平视", movement: "缓慢推镜",
        duration: 5, mood: "疲惫", sfx: "键盘声", dialogue: "「又是十一个小时。」", descriptionRich: [],
        description: "陆远瘫在工位上揉眼睛，屏幕冷光打在他脸上。", entityRefs: ["e1", "e2"], composed: false, ...over,
    });

    it("静态转译：保留五要素/描述/实体，剥离运镜与声音维度", () => {
        const prompt = composeStoryboardPrompt(shot(), entities, "城市现实主义");
        expect(prompt).toContain("【中景 · 平视 · 5s · 氛围:疲惫】");
        expect(prompt).toContain("陆远瘫在工位上揉眼睛");
        expect(prompt).toContain("[角色:陆远]");
        expect(prompt).toContain("[场景:深夜办公室]");
        expect(prompt).toContain("风格：城市现实主义");
        expect(prompt).not.toContain("缓慢推镜");
        expect(prompt).not.toContain("音效");
        expect(prompt).not.toContain("台词");
    });

    it("storyboardPrompt 已填时原样返回（不套模板）", () => {
        const prompt = composeStoryboardPrompt(shot({ storyboardPrompt: "自定义分镜图提示词" }), entities, "");
        expect(prompt).toBe("自定义分镜图提示词");
    });

    it("空描述与空参数不产生空行堆叠", () => {
        const prompt = composeStoryboardPrompt(shot({ description: "", shotSize: "", angle: "", duration: 0, mood: "" }), [], "");
        expect(prompt).not.toMatch(/\n{3,}/);
    });
});

describe("planStoryboardExpansion（幂等分镜图规划，spec D2/D3/D10 + 评审 D-A）", () => {
    const entities: ScriptEntity[] = [
        { id: "e1", projectId: "p", group: "character", name: "陆远", refs: [], createdAt: "", updatedAt: "" },
    ];
    const shot = (shotId: string, entityRefs: string[], over: Partial<ScriptShot> = {}): ScriptShot => ({
        shotId, no: 1, origin: "manual", shotSize: "中景", angle: "", movement: "", duration: 5, mood: "",
        sfx: "", dialogue: "", descriptionRich: [], description: "描述", entityRefs, composed: true, ...over,
    });

    it("映射有效 → reuse（先于 skipped 判定，评审修正 7）；ready → firstFrames", () => {
        const plan = planStoryboardExpansion({
            shots: [shot("s1", ["e1"])], storyboardNodes: { s1: "img-sb-1" },
            canvasNodeIds: new Set(["img-sb-1"]), readyStoryboardNodeIds: new Set(["img-sb-1"]),
        });
        expect(plan.reuse).toEqual([{ shotId: "s1", nodeId: "img-sb-1" }]);
        expect(plan.firstFrames).toEqual({ s1: "img-sb-1" });
        expect(plan.skipped).toEqual([]);
    });

    it("无映射 → storyboard-missing；映射指向已删节点 → 同样 missing 且 prune 孤儿", () => {
        const plan = planStoryboardExpansion({
            shots: [shot("s1", ["e1"]), shot("s2", ["e1"])],
            storyboardNodes: { s2: "img-sb-dead", s9: "img-orphan" },
            canvasNodeIds: new Set(["img-orphan"]), readyStoryboardNodeIds: new Set(),
        });
        expect(plan.skipped).toContainEqual({ shotId: "s1", reason: "storyboard-missing" });
        expect(plan.skipped).toContainEqual({ shotId: "s2", reason: "storyboard-missing" });
        expect(plan.prune).toEqual([{ shotId: "s9", nodeId: "img-orphan" }]);
    });

    it("映射存在但图未 ready → storyboard-not-ready（不进 firstFrames，不误报 missing）", () => {
        const plan = planStoryboardExpansion({
            shots: [shot("s1", ["e1"])], storyboardNodes: { s1: "img-sb-1" },
            canvasNodeIds: new Set(["img-sb-1"]), readyStoryboardNodeIds: new Set(),
        });
        expect(plan.reuse).toEqual([{ shotId: "s1", nodeId: "img-sb-1" }]);
        expect(plan.firstFrames).toEqual({});
        expect(plan.skipped).toEqual([{ shotId: "s1", reason: "storyboard-not-ready" }]);
    });

    it("storyboardImageStateOf：双形态 ready + 三态", () => {
        expect(storyboardImageStateOf(undefined)).toBe("none");
        expect(storyboardImageStateOf({ metadata: { status: "success", storageKey: "k" } })).toBe("ready");
        expect(storyboardImageStateOf({ metadata: { status: "done", images: [{ status: "success", storageKey: "k2" }] } })).toBe("ready");
        expect(storyboardImageStateOf({ metadata: { status: "error" } })).toBe("error");
        expect(storyboardImageStateOf({ metadata: { status: "loading" } })).toBe("generating");
    });

    it("storyboardImageStateOf：迁移后 assetRef-only 的分镜图节点为 ready（终审 C1）", () => {
        const fileRef = { backend: "project-file", assetId: "a1", projectId: "p1", relativePath: "assets/generated/images/a1.png", revision: 1 } as const;
        // 顶层 assetRef-only（单图交付后 storageKey 已剥离）
        expect(storyboardImageStateOf({ metadata: { status: "success", assetRef: fileRef } })).toBe("ready");
        // 多图形态 images[i] assetRef-only
        expect(storyboardImageStateOf({ metadata: { status: "done", images: [{ status: "success", assetRef: fileRef }] } })).toBe("ready");
        // 成功态但两者皆无 → 仍 generating（未落盘不得放行首帧）
        expect(storyboardImageStateOf({ metadata: { status: "success" } })).toBe("generating");
    });
});

describe("planShotExpansion firstFrameNodeIds（D4' v0.1 简化）与 composeFinalPrompt 前缀（D9a）", () => {
    const entities: ScriptEntity[] = [{ id: "e1", projectId: "p", group: "character", name: "陆远", refs: [], createdAt: "", updatedAt: "" }];
    const shot = (over: Partial<ScriptShot> = {}): ScriptShot => ({
        shotId: "s1", no: 1, origin: "manual", shotSize: "", angle: "", movement: "", duration: 5, mood: "",
        sfx: "", dialogue: "", descriptionRich: [], description: "d", entityRefs: ["e1"], composed: true, finalPrompt: "P", ...over,
    });

    it("firstFrameNodeIds 覆盖：references=[分镜图, ...音频]，实体图不进入", () => {
        const plan = planShotExpansion({
            shots: [shot()], expandedShotNodes: {}, canvasNodeIds: new Set(["img-sb", "img-sheet"]), entities, globalStyle: "",
            firstFrameNodeIds: { s1: "img-sb" },
        });
        expect(plan.create[0].referenceNodeIds).toEqual(["img-sb"]);
    });

    it("无 firstFrameNodeIds 的镜保持原行为（实体图进入）", () => {
        const e1 = { ...entities[0], refs: [{ id: "r1", label: "sheet", state: "ready" as const, source: "generated" as const, nodeId: "img-sheet" }] };
        const plan = planShotExpansion({ shots: [shot()], expandedShotNodes: {}, canvasNodeIds: new Set(["img-sheet"]), entities: [e1], globalStyle: "" });
        expect(plan.create[0].referenceNodeIds).toEqual(["img-sheet"]);
    });

    it("composeFinalPrompt storyboard 前缀仅在该模式下出现", () => {
        const s = shot({ description: "他缓缓抬头。" });
        expect(composeFinalPrompt(s, entities, "")).toContain("他缓缓抬头。");
        expect(composeFinalPrompt(s, entities, "", { storyboardFirst: true })).toContain("从首帧开始：他缓缓抬头。");
        expect(composeFinalPrompt(s, entities, "")).not.toContain("从首帧开始：");
    });
});

describe("imageGenMetadataPatch / videoGenMetadataPatch", () => {
    it("undefined 与空对象 → 空 patch", () => {
        expect(imageGenMetadataPatch(undefined)).toEqual({});
        expect(imageGenMetadataPatch({})).toEqual({});
        expect(videoGenMetadataPatch(undefined)).toEqual({});
        expect(videoGenMetadataPatch({})).toEqual({});
    });

    it("字符串字段 trim 非空才写（含容错非字符串垃圾输入）；count 钳制 1–15 取整", () => {
        expect(imageGenMetadataPatch({ model: " ch1::m1 ", size: "16:9", quality: "  ", background: "", count: 0 })).toEqual({ model: "ch1::m1", size: "16:9", count: 1 });
        expect(imageGenMetadataPatch({ count: 20.7 })).toEqual({ count: 15 });
        expect(imageGenMetadataPatch({ count: -3.4 })).toEqual({ count: 3 });
        // LLM 垃圾输入不抛错（typeof 守卫）：非字符串字段直接剔除
        expect(imageGenMetadataPatch({ size: 123 as unknown as string, quality: true as unknown as string })).toEqual({});
        expect(videoGenMetadataPatch({ model: "ch1::v1", vquality: "768p横", seconds: " ", generateAudio: "", watermark: "false" })).toEqual({ model: "ch1::v1", vquality: "768p横", watermark: "false" });
    });
});

describe("entityRefFailureFromNode", () => {
    const ref = { scriptEntityRef: { entityId: "e1", refId: "r1" } };
    it("fires on error with no success image", () => {
        expect(entityRefFailureFromNode({ id: "n1", metadata: { status: "error", ...ref } })).toEqual({ entityId: "e1", refId: "r1" });
    });
    it("does not fire when a multi-image entry succeeded", () => {
        expect(entityRefFailureFromNode({ id: "n1", metadata: { status: "error", images: [{ status: "success", storageKey: "k" }], ...ref } })).toBeNull();
    });
    it("does not fire on non-error states", () => {
        expect(entityRefFailureFromNode({ id: "n1", metadata: { status: "success", storageKey: "k", ...ref } })).toBeNull();
        expect(entityRefFailureFromNode({ id: "n1", metadata: { status: "loading", ...ref } })).toBeNull();
        expect(entityRefFailureFromNode({ id: "n1", metadata: { ...ref } })).toBeNull();
    });
    it("ignores nodes without scriptEntityRef", () => {
        expect(entityRefFailureFromNode({ id: "n1", metadata: { status: "error" } })).toBeNull();
    });
});

describe("planLibraryRefBackfill（spec D1 legacy 回填）", () => {
    const libraryRef = (id: string, nodeId?: string) => ({ id, label: "l", state: "ready" as const, source: "library" as const, assetId: "a1", ...(nodeId ? { nodeId } : {}) });
    const entity = (refs: ReturnType<typeof libraryRef>[]): never => ({ id: "e1", group: "character", name: "n", refs, createdAt: "", updatedAt: "" } as never);
    it("无 nodeId / nodeId 已死都进回填清单", () => {
        const plan = planLibraryRefBackfill([entity([libraryRef("r1"), libraryRef("r2", "dead")])], new Set(["live"]));
        expect(plan).toEqual([{ entityId: "e1", refId: "r1", assetId: "a1" }, { entityId: "e1", refId: "r2", assetId: "a1" }]);
    });
    it("活 nodeId / 非 library / 非 ready 跳过", () => {
        const plan = planLibraryRefBackfill([entity([libraryRef("r1", "live")])], new Set(["live"]));
        expect(plan).toEqual([]);
    });
});
