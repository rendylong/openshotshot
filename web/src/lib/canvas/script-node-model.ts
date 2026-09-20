import { nanoid } from "nanoid";
import type { ScriptImageGenParams, ScriptNodeData, ScriptOutputStatus, ScriptRichSegment, ScriptShot, ShotAudioRef, ShotAudioSlot, ShotVideoVersion, ScriptVideoGenParams } from "@/types/script-node";
import type { ScriptEntity } from "@/stores/use-script-entity-store";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";

export type EntityNameOf = (id: string) => string | undefined;

export function buildShot(no: number, over: Partial<ScriptShot> = {}): ScriptShot {
    return {
        shotId: `shot_${nanoid(8)}`,
        no,
        origin: "manual",
        // 拍摄参数默认全空（duration 0 = 未设置）：不替用户预填假数据
        shotSize: "",
        angle: "",
        movement: "",
        duration: 0,
        mood: "",
        sfx: "",
        dialogue: "",
        descriptionRich: [],
        description: "",
        entityRefs: [],
        composed: false,
        ...over,
    };
}

export function deriveDescription(rich: ScriptRichSegment[], nameOf: EntityNameOf): string {
    return rich
        .map((seg) => (seg.t === "text" ? seg.v : (nameOf(seg.entityId) ?? "")))
        .join("")
        .replace(/\u00A0/g, " ")
        .trim();
}

/** 只读表面展示用：剥离未选中资产的孤立 @（编辑单元格保留原输入） */
export function stripDanglingAt(text: string): string {
    return text.replace(/ ?@(?=\s|$)/g, "").trimEnd();
}

export function deriveEntityRefs(rich: ScriptRichSegment[]): string[] {
    const out: string[] = [];
    for (const seg of rich) {
        if (seg.t === "ref" && !out.includes(seg.entityId)) out.push(seg.entityId);
    }
    return out;
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type ScriptEntityGroupLike = "character" | "scene" | "item";

export type EntityMetaOf = (id: string) => { name: string; group: ScriptEntityGroupLike } | undefined;

/** 内联实体胶囊的配色类：角色金 / 场景青 / 道具绿（Tailwind 语义色，随主题可用） */
export function inlineEntityClasses(group: ScriptEntityGroupLike): string {
    if (group === "scene") return "bg-cyan-600/15 text-cyan-700 dark:text-cyan-400 border-cyan-600/40";
    if (group === "item") return "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400 border-emerald-600/40";
    return "bg-amber-600/15 text-amber-700 dark:text-amber-400 border-amber-600/40";
}

export function chipHtml(entityId: string, meta: { name: string; group: ScriptEntityGroupLike }): string {
    return `<span class="inline-entity border ${inlineEntityClasses(meta.group)}" contenteditable="false" data-entity-id="${entityId}" data-entity-group="${meta.group}">${escapeHtml(meta.name)}</span>`;
}

export function richToHtml(rich: ScriptRichSegment[], metaOf: EntityMetaOf): string {
    return rich
        .map((seg) => {
            if (seg.t === "text") return escapeHtml(seg.v).replace(/\n/g, "<br>");
            const meta = metaOf(seg.entityId);
            return chipHtml(seg.entityId, meta ?? { name: "?", group: "character" });
        })
        .join("");
}

export function htmlToRich(el: HTMLElement): ScriptRichSegment[] {
    const out: ScriptRichSegment[] = [];
    const pushText = (v: string) => {
        const last = out[out.length - 1];
        if (last?.t === "text") last.v += v;
        else out.push({ t: "text", v });
    };
    el.childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            pushText(node.textContent ?? "");
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const elem = node as HTMLElement;
            const entityId = elem.dataset?.entityId;
            if (elem.classList.contains("inline-entity") && entityId) {
                out.push({ t: "ref", entityId });
            } else if (elem.tagName === "BR") {
                pushText("\n");
            } else {
                for (const seg of htmlToRich(elem)) {
                    if (seg.t === "text") pushText(seg.v);
                    else out.push(seg);
                }
            }
        }
    });
    return out;
}

export function normalizeShots(shots: ScriptShot[]): ScriptShot[] {
    return shots.map((s, i) => ({ ...s, no: i + 1 }));
}

const GROUP_LABEL: Record<ScriptEntity["group"], string> = { character: "角色", scene: "场景", item: "道具" };

export function composeFinalPrompt(shot: ScriptShot, entities: ScriptEntity[], globalStyle: string, options?: { storyboardFirst?: boolean }): string {
    const byId = new Map(entities.map((e) => [e.id, e]));
    const entLines = shot.entityRefs
        .map((id) => byId.get(id))
        .filter((e): e is ScriptEntity => Boolean(e))
        .map((e) => `  [${GROUP_LABEL[e.group]}:${e.name}]`)
        .join("\n");
    // 未选中资产的孤立 @ 不该进入最终提示词（连同前导空格一起移除；邮箱类 @ 后跟非空白不受影响）
    const rawDescription = stripDanglingAt(shot.description);
    // 分镜图先行模式（spec D9a）：description 行加 I2V 指令前缀，提示下游按首帧续写运动
    const description = options?.storyboardFirst ? `从首帧开始：${rawDescription}` : rawDescription;
    // 空拍摄参数不进提示词；【】行 / 描述行 / 音效行空时槽位保留为 ""，
    // 下方 filter 依赖原始索引（i===4/i===7 是空行分隔符），不能删除元素
    const metaParts = [
        shot.shotSize,
        shot.angle,
        shot.movement,
        shot.duration > 0 ? `${shot.duration}s` : "",
        shot.mood ? `氛围:${shot.mood}` : "",
    ].filter(Boolean);
    const lines = [
        metaParts.length ? `【${metaParts.join(" · ")}】` : "",
        description,
        shot.sfx ? `音效：${shot.sfx}` : "",
        shot.dialogue ? `台词：「${shot.dialogue}」` : "",
        "",
        "— 实体绑定 —",
        entLines || "  （无）",
        "",
        "— 全局风格 —",
        globalStyle || "（未设置）",
    ];
    return lines.filter((line, i) => line !== "" || i === 4 || i === 7).join("\n");
}

/** 分镜图提示词模板兜底（spec D6）：静态关键帧转译——保留五要素/描述/实体/风格，
    剥离运镜（静态图无运动）与声音维度；agent/skill 编译过的 storyboardPrompt 原样优先。 */
export function composeStoryboardPrompt(shot: ScriptShot, entities: ScriptEntity[], globalStyle: string): string {
    if (shot.storyboardPrompt?.trim()) return shot.storyboardPrompt;
    const byId = new Map(entities.map((e) => [e.id, e]));
    const entLines = shot.entityRefs
        .map((id) => byId.get(id))
        .filter((e): e is ScriptEntity => Boolean(e))
        .map((e) => `[${GROUP_LABEL[e.group]}:${e.name}]`)
        .join(" + ");
    const metaParts = [shot.shotSize, shot.angle, shot.duration > 0 ? `${shot.duration}s` : "", shot.mood ? `氛围:${shot.mood}` : ""].filter(Boolean);
    const lines = [
        metaParts.length ? `【${metaParts.join(" · ")}】` : "",
        stripDanglingAt(shot.description) || "静态关键帧：呈现该镜头动作的进行中瞬间",
        entLines ? `参考实体：${entLines}` : "",
        globalStyle ? `风格：${globalStyle}` : "",
    ];
    return lines.filter(Boolean).join("\n");
}

/** 实体参考图生成提示词组装：参考图生成没有输入图，文本设定是唯一信息源，
 *  单字段回退链（imagePrompt||appearance||name）会丢掉其余设定，故全部拼入。
 *  imagePrompt 仍作主体；空字段整段跳过；全部为空时回落 name。 */
export function composeEntityRefPrompt(entity: {
    group: ScriptEntity["group"];
    name: string;
    role?: string;
    appearance?: string;
    consistency?: string;
    imagePrompt?: string;
}): string {
    const name = entity.name.trim();
    const role = entity.role?.trim() ?? "";
    const imagePrompt = entity.imagePrompt?.trim() ?? "";
    const appearance = entity.appearance?.trim() ?? "";
    const consistency = entity.consistency?.trim() ?? "";
    const headerParts = [name, role].filter(Boolean);
    const lines = [
        headerParts.length ? `【${GROUP_LABEL[entity.group]}：${headerParts.join(" · ")}】` : "",
        imagePrompt || appearance,
        imagePrompt && appearance ? `定义：${appearance}` : "",
        consistency ? `一致性：${consistency}` : "",
    ].filter(Boolean);
    return lines.join("\n") || name;
}

export function deriveConsumptionEdges(
    script: ScriptNodeData,
    resolveSlotNodeId: (entityId: string) => string | undefined,
): Array<{ fromNodeId: string; toNodeId: string }> {
    const edges: Array<{ fromNodeId: string; toNodeId: string }> = [];
    const seen = new Set<string>();
    for (const shot of script.output.shots) {
        const toNodeId = script.output.expandedShotNodes?.[shot.shotId];
        if (!toNodeId) continue;
        for (const entityId of shot.entityRefs) {
            const fromNodeId = resolveSlotNodeId(entityId);
            if (!fromNodeId) continue;
            const key = `${fromNodeId}->${toNodeId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({ fromNodeId, toNodeId });
        }
    }
    return edges;
}

/** 图片生成节点完成后的实体槽位回写意图：scriptEntityRef + 可用的成功图片（顶层 status 或 images[i] 任一形态）即产生。
 *  项目资产 assetRef 随成功图片一并回写（槽位预览经 useProjectAssetUrl 消费）。
 *  桌面 move 语义：交付/迁移后的成功图只剩 project-file assetRef（storageKey 已剥离）——
 *  assetRef 存在同样视为已落盘可回写，patch 的 storageKey 变为可选。 */
export function entityWritebackFromNode(node: {
    id: string;
    metadata?: {
        status?: string;
        storageKey?: string;
        assetRef?: CanvasAssetRef;
        images?: Array<{ status?: string; storageKey?: string; assetRef?: CanvasAssetRef }>;
        scriptEntityRef?: { entityId: string; refId: string };
    };
}): { entityId: string; refId: string; patch: { state: "ready"; source: "generated"; nodeId: string; storageKey?: string; assetRef?: CanvasAssetRef } } | null {
    const ref = node.metadata?.scriptEntityRef;
    if (!ref) return null;
    // 直接生成路径把成功写在顶层；多图/空节点路径把成功写在 images[i] —— 两种形态都认。
    const successImage = node.metadata?.images?.find((image) => image.status === "success" && (image.storageKey || image.assetRef));
    const topSuccess = node.metadata?.status === "success" && Boolean(node.metadata.storageKey || node.metadata.assetRef);
    const storageKey = topSuccess ? node.metadata?.storageKey : successImage?.storageKey;
    // 顶层缺失 assetRef 时回退成功图的 assetRef（多图节点顶层只有暂存 storageKey 的形态）
    const assetRef = (topSuccess ? node.metadata?.assetRef : undefined) ?? successImage?.assetRef;
    if (!storageKey && !assetRef) return null;
    return { entityId: ref.entityId, refId: ref.refId, patch: { state: "ready", source: "generated", nodeId: node.id, ...(storageKey ? { storageKey } : {}), ...(assetRef ? { assetRef } : {}) } };
}

/** 生成节点完成结果是否允许回写该槽：用户已显式选图或归属已被更新节点接管时，旧结果作废。 */
export function shouldApplyEntityWriteback(
    // 鸭子类型兼容 ScriptEntityRefSlot（含 assetId/storageKey 等额外字段），此处只声明守卫关心的字段
    slot: { state?: string; source?: string; nodeId?: string; assetId?: string } | undefined,
    node: { id: string },
): boolean {
    if (!slot) return false;
    if (slot.nodeId && slot.nodeId !== node.id) return false;
    if (slot.state === "ready" && slot.source && slot.source !== "generated") return false;
    return true;
}

/** 生图节点失败后的实体槽位清理意图（spec 2026-09-17 D5）：scriptEntityRef + 节点 error + 多图形态
 *  也无成功图时产生。顶层 status==="error" 与顶层成功互斥，只需排除 images[i] 部分成功
 *  （有任一成功图即交给 entityWritebackFromNode 的成功回写路径）。 */
export function entityRefFailureFromNode(node: {
    id: string;
    metadata?: {
        status?: string;
        storageKey?: string;
        images?: Array<{ status?: string; storageKey?: string }>;
        scriptEntityRef?: { entityId: string; refId: string };
    };
}): { entityId: string; refId: string } | null {
    const ref = node.metadata?.scriptEntityRef;
    if (!ref || node.metadata?.status !== "error") return null;
    const successImage = node.metadata.images?.find((image) => image.status === "success" && image.storageKey);
    if (successImage) return null;
    return { entityId: ref.entityId, refId: ref.refId };
}

/* ================= v0.6：幂等展开 ================= */

export type ShotExpansionPlan = {
    /** 已有节点：仅同步标题（镜号/景别可能因重排变化） */
    reuse: Array<{ shotId: string; nodeId: string; title: string }>;
    /** prompt 或引用变化：更新既有节点（不动 position） */
    update: Array<{ shotId: string; nodeId: string; prompt: string; title: string; referenceNodeIds: string[] }>;
    /** 新建 */
    create: Array<{ shotId: string; prompt: string; title: string; referenceNodeIds: string[] }>;
};

const expansionTitle = (shot: ScriptShot) => (shot.shotSize ? `镜头 ${shot.no} · ${shot.shotSize}` : `镜头 ${shot.no}`);

/** 受管音频节点集合（spec D20）：该镜头的画布选择 audioNodeId + 映射值（物化节点与画布选择记忆均计入）。
    调用方必须传物化前的映射快照（pre-prune），保证清除/换源的旧节点仍在集合内、其幽灵边会被同步删除。 */
export function managedAudioNodeIds(shot: Pick<ScriptShot, "sfxAudio" | "dialogueAudio">, shotAudioNodes: Record<string, Partial<Record<ShotAudioSlot, { id: string; materialized: boolean }>>> | undefined, shotId: string): Set<string> {
    return new Set([shot.sfxAudio?.audioNodeId, shot.dialogueAudio?.audioNodeId, shotAudioNodes?.[shotId]?.sfx?.id, shotAudioNodes?.[shotId]?.dialogue?.id].filter((id): id is string => Boolean(id)));
}

/**
 * 展开同步前的音频物化规划（纯函数，spec D3）：只管理上传来源（无 audioNodeId）的镜头音频。
 * create = 映射缺失/非物化记忆/指向已删节点（复活）；update = 物化映射节点存在但 storageKey 变化；
 * prune = 引用已清除或换成了不同的画布选择节点（映射记忆由调用方在应用后重录）。物化应用后 plan 拥有全部连线写入权。
 */
export function planAudioMaterialization(args: {
    shots: ScriptShot[];
    shotAudioNodes: Record<string, Partial<Record<ShotAudioSlot, { id: string; materialized: boolean }>>>;
    canvasNodeIds: Set<string>;
    audioNodeStorageKeys: Record<string, string | undefined>;
}): { create: Array<{ shotId: string; slot: ShotAudioSlot; snapshot: ShotAudioRef }>; update: Array<{ nodeId: string; snapshot: ShotAudioRef }>; prune: Array<{ shotId: string; slot: ShotAudioSlot }> } {
    const plan = { create: [], update: [], prune: [] } as {
        create: Array<{ shotId: string; slot: ShotAudioSlot; snapshot: ShotAudioRef }>;
        update: Array<{ nodeId: string; snapshot: ShotAudioRef }>;
        prune: Array<{ shotId: string; slot: ShotAudioSlot }>;
    };
    const refOf = (shot: ScriptShot, slot: ShotAudioSlot) => (slot === "sfx" ? shot.sfxAudio : shot.dialogueAudio);
    for (const shot of args.shots) {
        for (const slot of ["sfx", "dialogue"] as const) {
            const snapshot = refOf(shot, slot);
            if (!snapshot || snapshot.audioNodeId) continue; // 画布选择来源直接引用，不物化（映射记忆由调用方记录）
            const mapped = args.shotAudioNodes[shot.shotId]?.[slot];
            if (mapped?.materialized && args.canvasNodeIds.has(mapped.id)) {
                if (args.audioNodeStorageKeys[mapped.id] !== snapshot.storageKey) plan.update.push({ nodeId: mapped.id, snapshot });
                continue;
            }
            plan.create.push({ shotId: shot.shotId, slot, snapshot });
        }
    }
    for (const [shotId, slots] of Object.entries(args.shotAudioNodes)) {
        const shot = args.shots.find((s) => s.shotId === shotId);
        for (const slot of ["sfx", "dialogue"] as const) {
            const mapped = slots[slot];
            if (!mapped) continue;
            const ref = shot ? refOf(shot, slot) : undefined;
            // 引用已清除，或换成了另一个画布选择节点（同节点记忆保持稳态不 prune）
            if (!ref || (ref.audioNodeId && ref.audioNodeId !== mapped.id)) plan.prune.push({ shotId, slot });
        }
    }
    return plan;
}

/* ================= 分镜图先行（storyboard-first，spec v1.0 + 评审 D-A） ================= */

export type StoryboardExpansionPlan = {
    reuse: Array<{ shotId: string; nodeId: string }>;
    prune: Array<{ shotId: string; nodeId: string }>;
    firstFrames: Record<string, string>;
    skipped: Array<{ shotId: string; reason: "storyboard-missing" | "storyboard-not-ready" }>;
};

/** 双形态就绪读取（评审修正 8）：与 entityWritebackFromNode 同规则——顶层 success+storageKey
    或 images[i] success+storageKey 任一命中即 ready。单形态读取会让多图路径永久卡 generating。
    桌面 move 语义：交付/迁移后的成功图只剩 project-file assetRef（storageKey 已剥离）——
    assetRef 存在同样视为已落盘就绪，否则分镜图先行守卫恒卡 generating。 */
export function storyboardImageStateOf(node?: { metadata?: { status?: string; storageKey?: string; assetRef?: CanvasAssetRef; images?: Array<{ status?: string; storageKey?: string; assetRef?: CanvasAssetRef }> } }): "none" | "generating" | "ready" | "error" {
    if (!node?.metadata) return "none";
    const m = node.metadata;
    if (m.status === "success" && (m.storageKey || m.assetRef)) return "ready";
    if ((m.images ?? []).some((image) => image.status === "success" && (image.storageKey || image.assetRef))) return "ready";
    if (m.status === "error") return "error";
    return "generating";
}

/** 幂等分镜图规划（评审 D-A 简化）：创建只发生在第 3 步 handler；本函数只做
    reuse 判定（先于 skipped，防资产态误报）、孤儿 prune 与 ready 首帧派生。
    skipped 语义：映射缺失或指向已删节点 → storyboard-missing（资产不存在，handler 补建）；
    节点在但未 ready → storyboard-not-ready（同时留在 reuse，等待生成完成）。 */
export function planStoryboardExpansion(args: {
    shots: ScriptShot[];
    storyboardNodes: Record<string, string>;
    canvasNodeIds: Set<string>;
    readyStoryboardNodeIds: Set<string>;
}): StoryboardExpansionPlan {
    const plan: StoryboardExpansionPlan = { reuse: [], prune: [], firstFrames: {}, skipped: [] };
    const liveIds = new Set(args.shots.map((s) => s.shotId));
    for (const [shotId, nodeId] of Object.entries(args.storyboardNodes)) {
        if (!liveIds.has(shotId) && args.canvasNodeIds.has(nodeId)) plan.prune.push({ shotId, nodeId });
    }
    // prune 必须同时清理节点的全部关联边（从属边 + 参考输入边），否则留下幽灵边
    for (const shot of args.shots) {
        const existingId = args.storyboardNodes[shot.shotId];
        if (existingId && args.canvasNodeIds.has(existingId)) {
            plan.reuse.push({ shotId: shot.shotId, nodeId: existingId });
            if (args.readyStoryboardNodeIds.has(existingId)) plan.firstFrames[shot.shotId] = existingId;
            else plan.skipped.push({ shotId: shot.shotId, reason: "storyboard-not-ready" });
            continue;
        }
        plan.skipped.push({ shotId: shot.shotId, reason: "storyboard-missing" });
    }
    return plan;
}

/**
 * 幂等展开规划（v0.6）：shotId 是镜头的稳定身份，no 仅是展示顺序。
 * - 已有节点且 prompt/引用一致 → reuse（title 按新序号刷新）；
 * - 已有节点但 prompt/引用变化 → update（引用集合比较与顺序无关）；
 * - 映射缺失或指向已删节点 → create。
 * existingReferences 由调用方从画布连线收集：{ shotId: [来源节点id] }，
 * 另以 "__prompt__<shotId>" 键传入该节点当前 prompt 供一致性比对。
 * 不产出 position 变更——尊重用户手动布局。
 */
export function planShotExpansion(args: {
    shots: ScriptShot[];
    expandedShotNodes: Record<string, string>;
    canvasNodeIds: Set<string>;
    entities: ScriptEntity[];
    globalStyle: string;
    existingReferences?: Record<string, string[]>;
    shotAudioNodes?: Record<string, Partial<Record<ShotAudioSlot, { id: string; materialized: boolean }>>>;
    /** 分镜图先行（spec D4' v0.1 简化）：shotId → ready 分镜图节点。存在时该镜实体参考图被首帧替换，音频引用保留。 */
    firstFrameNodeIds?: Record<string, string>;
}): ShotExpansionPlan {
    const plan: ShotExpansionPlan = { reuse: [], update: [], create: [] };
    const byId = new Map(args.entities.map((e) => [e.id, e]));
    for (const shot of args.shots) {
        const title = expansionTitle(shot);
        const prompt = shot.finalPrompt ?? "";
        // 首帧覆盖模式下实体图不进入（references = [分镜图, ...音频]，分镜图即该镜画面的权威来源）
        const firstFrameNodeId = args.firstFrameNodeIds?.[shot.shotId];
        const entityNodeIds = firstFrameNodeId
            ? []
            : shot.entityRefs
                .map((id) => byId.get(id)?.refs.find((r) => r.state === "ready" && r.nodeId && args.canvasNodeIds.has(r.nodeId))?.nodeId)
                .filter((id): id is string => Boolean(id));
        // 受管音频节点：画布选择的 audioNodeId + 映射节点（物化与选择记忆）；悬空（不在画布）过滤，跨槽去重（spec D20/D21）
        const audioNodeIds = [shot.sfxAudio?.audioNodeId, shot.dialogueAudio?.audioNodeId, args.shotAudioNodes?.[shot.shotId]?.sfx?.id, args.shotAudioNodes?.[shot.shotId]?.dialogue?.id].filter(
            (id): id is string => id !== undefined && args.canvasNodeIds.has(id),
        );
        // 首帧永远排第一位：下游 fal 槽位按图片顺序填充，第一位路由到 i2v 的 start_image_url
        const referenceNodeIds = [...new Set([...(firstFrameNodeId ? [firstFrameNodeId] : []), ...entityNodeIds, ...audioNodeIds])];
        const existingId = args.expandedShotNodes[shot.shotId];
        const nodeExists = existingId ? args.canvasNodeIds.has(existingId) : false;
        if (!nodeExists) {
            plan.create.push({ shotId: shot.shotId, prompt, title, referenceNodeIds });
            continue;
        }
        const existingRefs = [...(args.existingReferences?.[shot.shotId] ?? [])].sort();
        const nextRefs = [...referenceNodeIds].sort();
        const sameRefs = existingRefs.length === nextRefs.length && existingRefs.every((id, i) => id === nextRefs[i]);
        const existingPrompt = args.existingReferences?.[`__prompt__${shot.shotId}`]?.[0];
        const promptUnchanged = existingPrompt === undefined || existingPrompt === prompt;
        if (promptUnchanged && sameRefs) {
            plan.reuse.push({ shotId: shot.shotId, nodeId: existingId, title });
        } else {
            plan.update.push({ shotId: shot.shotId, nodeId: existingId, prompt, title, referenceNodeIds });
        }
    }
    return plan;
}

/** 库来源槽位回填清单（spec D1 legacy 回填）：ready+library 且 nodeId 缺失或已不在画布。
    幂等；执行侧（project.tsx ensureEntityRefNodes）逐条物化并急切同步后再进规划。 */
export function planLibraryRefBackfill(entities: ScriptEntity[], canvasNodeIds: Set<string>): Array<{ entityId: string; refId: string; assetId: string }> {
    const plan: Array<{ entityId: string; refId: string; assetId: string }> = [];
    for (const entity of entities) {
        for (const ref of entity.refs) {
            if (ref.state !== "ready" || ref.source !== "library" || !ref.assetId) continue;
            if (ref.nodeId && canvasNodeIds.has(ref.nodeId)) continue;
            plan.push({ entityId: entity.id, refId: ref.id, assetId: ref.assetId });
        }
    }
    return plan;
}

/** v0.6 组批量：从组成员中挑出待生成节点（跳过已有成片 success 与空 prompt）。 */
export function selectGroupVideoTargets(members: CanvasNodeData[]): { start: CanvasNodeData[]; skipped: number } {
    const candidates = members.filter((n) => n.type === "video" && n.metadata?.generationMode === "video" && Boolean(n.metadata?.prompt?.trim()));
    const start = candidates.filter((n) => n.metadata?.status !== "success");
    return { start, skipped: candidates.length - start.length };
}

/* ── 镜头视频版本（spec v2 D8）：纯函数助手，UI 解析与 project.tsx 落库共用 ── */

/** 过滤指向已删除节点的版本（读取/落库前自愈），保持顺序不变。 */
export function normalizeShotVideoVersions(versions: ShotVideoVersion[] | undefined, canvasNodeIds: Set<string>): ShotVideoVersion[] {
    return (versions ?? []).filter((version) => canvasNodeIds.has(version.nodeId));
}

/** 新版本编号：历史最大 no + 1（从旧版本再生成时避免重名），空列表从 1 起。 */
export function nextShotVideoNo(versions: ShotVideoVersion[] | undefined): number {
    return (versions ?? []).reduce((max, version) => Math.max(max, version.no), 0) + 1;
}

/** 重新生成产生新版本：插入头部成为当前版本。调用方需同步 expandedShotNodes[shotId] = nodeId。 */
export function pushShotVideoVersion(versions: ShotVideoVersion[] | undefined, nodeId: string): ShotVideoVersion[] {
    return [{ nodeId, no: nextShotVideoNo(versions) }, ...(versions ?? [])];
}

/** 切换当前版本：移动到头部（no 不变）；目标不在列表中返回 null（调用方忽略）。 */
export function selectShotVideoVersion(versions: ShotVideoVersion[] | undefined, nodeId: string): ShotVideoVersion[] | null {
    const list = versions ?? [];
    const picked = list.find((version) => version.nodeId === nodeId);
    if (!picked) return null;
    return [picked, ...list.filter((version) => version.nodeId !== nodeId)];
}

/* ── 脚本级生成参数 → 节点 metadata patch（spec 2026-09-11 §4.2）──
   仅返回显式定义的键；undefined/{} → 空 patch。字段带 typeof 守卫：
   本函数同时被 agent 工具（主进程，清洗 LLM 输入）复用，垃圾输入不抛错。 */

/** 分镜图生图参数：字符串 trim 非空才写；count 钳制 1–15 取整。 */
export function imageGenMetadataPatch(imageGen?: ScriptImageGenParams): Partial<CanvasNodeMetadata> {
    if (!imageGen || typeof imageGen !== "object") return {};
    const input = imageGen as Record<string, unknown>;
    return {
        ...(typeof input.model === "string" && input.model.trim() ? { model: input.model.trim() } : {}),
        ...(typeof input.size === "string" && input.size.trim() ? { size: input.size.trim() } : {}),
        ...(typeof input.quality === "string" && input.quality.trim() ? { quality: input.quality.trim() } : {}),
        ...(typeof input.background === "string" && input.background.trim() ? { background: input.background.trim() } : {}),
        ...(typeof input.count === "number" && Number.isFinite(input.count) ? { count: Math.max(1, Math.min(15, Math.floor(Math.abs(input.count)))) } : {}),
    };
}

/** 镜头视频参数：字符串 trim 非空才写（vquality 需生成层合法枚举，此处不做枚举校验）。 */
export function videoGenMetadataPatch(videoGen?: ScriptVideoGenParams): Partial<CanvasNodeMetadata> {
    if (!videoGen || typeof videoGen !== "object") return {};
    const input = videoGen as Record<string, unknown>;
    return {
        ...(typeof input.model === "string" && input.model.trim() ? { model: input.model.trim() } : {}),
        ...(typeof input.size === "string" && input.size.trim() ? { size: input.size.trim() } : {}),
        ...(typeof input.vquality === "string" && input.vquality.trim() ? { vquality: input.vquality.trim() } : {}),
        ...(typeof input.seconds === "string" && input.seconds.trim() ? { seconds: input.seconds.trim() } : {}),
        ...(typeof input.generateAudio === "string" && input.generateAudio.trim() ? { generateAudio: input.generateAudio.trim() } : {}),
        ...(typeof input.watermark === "string" && input.watermark.trim() ? { watermark: input.watermark.trim() } : {}),
    };
}

/** 节点场记板摘要（spec 2026-09-16 D1/D3）：纯函数推导，供摘要卡组件消费。 */
export type ScriptFilmstripFrame = {
    shotId: string;
    no: number;
    shotSize: string;
    hasStoryboard: boolean;
};

export type ScriptNodeSummary = {
    status: ScriptOutputStatus;
    errorMessage?: string;
    shotCount: number;
    totalDuration: number;
    assetsReady: number;
    assetsTotal: number;
    promptsComposed: number;
    /** 完成态 0-1；生成中恒 -1（UI 渲染不确定态，不显数字）。 */
    progress: number;
    frames: ScriptFilmstripFrame[];
    extraCount: number;
};

export function buildScriptNodeSummary(
    script: ScriptNodeData,
    options: { assetsReady: number; assetsTotal: number; hydratedStoryboardIds?: Set<string>; maxFrames?: number },
): ScriptNodeSummary {
    const shots = script.output.shots;
    const generating = script.output.status === "generating";
    const promptsComposed = shots.filter((s) => s.composed).length;
    const maxFrames = options.maxFrames ?? 4;
    const frames = shots.slice(0, maxFrames).map((s) => ({
        shotId: s.shotId,
        no: s.no,
        shotSize: s.shotSize,
        hasStoryboard: Boolean(options.hydratedStoryboardIds?.has(script.output.storyboardNodes?.[s.shotId] ?? "")),
    }));
    const denom = options.assetsTotal + shots.length;
    return {
        status: script.output.status,
        errorMessage: script.output.errorMessage,
        shotCount: shots.length,
        totalDuration: shots.reduce((sum, s) => sum + (s.duration || 0), 0),
        assetsReady: options.assetsReady,
        assetsTotal: options.assetsTotal,
        promptsComposed,
        progress: generating ? -1 : denom === 0 ? 0 : (options.assetsReady + promptsComposed) / denom,
        frames,
        extraCount: Math.max(0, shots.length - frames.length),
    };
}
