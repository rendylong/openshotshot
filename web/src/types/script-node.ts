import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";

export const SCRIPT_NODE_TYPE = "script";

export type ScriptRichSegment = { t: "text"; v: string } | { t: "ref"; entityId: string };

/** 镜头音频引用：画布 Audio 节点引用或上传快照。
    audioNodeId 来自画布选择（可直接连线）；上传来源缺省，「完成脚本编辑」时物化为 Audio 节点后回填映射。 */
export type ShotAudioRef = {
    name: string;
    storageKey?: string;
    assetRef?: CanvasAssetRef;
    mimeType?: string;
    durationMs?: number;
    audioNodeId?: string;
};

export type ShotAudioSlot = "sfx" | "dialogue";

/** 镜头视频版本（spec v2 D8）：一个展开视频节点的引用 + 创建序号。 */
export type ShotVideoVersion = { nodeId: string; no: number };

export type ScriptShot = {
    shotId: string;
    no: number;
    origin: "generated" | "manual";
    shotSize: string;
    angle: string;
    movement: string;
    duration: number;
    mood: string;
    sfx?: string;
    dialogue?: string;
    descriptionRich: ScriptRichSegment[];
    description: string;
    entityRefs: string[];
    sfxAudio?: ShotAudioRef;
    dialogueAudio?: ShotAudioRef;
    composed: boolean;
    finalPrompt?: string;
    /** 分镜图提示词（分镜图先行，spec D6）：agent/skill 编译结果；空则由 composeStoryboardPrompt 模板兜底 */
    storyboardPrompt?: string;
};

export type ScriptOutputStatus = "idle" | "generating" | "done" | "error";

/** 脚本级分镜图生图参数（spec 2026-09-11 D1/D2）：与 canvas_generate_node 同键。 */
export type ScriptImageGenParams = {
    model?: string;
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
};

/** 脚本级镜头视频参数（spec D12）：与 D12/D13 生成设置弹窗可写面同键。 */
export type ScriptVideoGenParams = {
    model?: string;
    size?: string;
    vquality?: string;
    seconds?: string;
    generateAudio?: string;
    watermark?: string;
};

export type ScriptNodeData = {
    schemaVersion: 1;
    instruction: string;
    globalStyle: string;
    entityIds: string[];
    /** shotCount/开关与脚本级生成参数；lastStep 记住 Studio 上次停留视图（spec 2026-09-16 D8），空脚本恒落 1 */
    template?: { shotCount?: number; storyboardFirst?: boolean; lastStep?: 1 | 2 | 3; imageGen?: ScriptImageGenParams; videoGen?: ScriptVideoGenParams };
    output: {
        status: ScriptOutputStatus;
        errorMessage?: string;
        shots: ScriptShot[];
        raw?: string;
        generatedAt?: number;
        resourceHashSnapshot?: Array<{ entityId: string; contentHash: string }>;
        /** shotId -> 展开后的画布生成节点 id（消费边推导用） */
        expandedShotNodes?: Record<string, string>;
        /** shotId -> 分镜图节点 id（分镜图先行，spec D6） */
        storyboardNodes?: Record<string, string>;
        /** 镜头音频映射（spec D21）：shotId -> 槽位 -> { 节点 id, materialized }。
            materialized=true 是上传物化的画布节点；false 是画布选择节点的同步时记忆——清除/换源后其幽灵边可被受管集合清扫。 */
        shotAudioNodes?: Record<string, Partial<Record<ShotAudioSlot, { id: string; materialized: boolean }>>>;
        /** 镜头视频版本列表（spec v2 D8）：shotId -> 版本数组。
            数组首元素 = 当前选中版本（与 expandedShotNodes[shotId] 恒等，同一次落库同步写）；
            no 为创建序（max+1 只增不减，切换选中不改变）。读取方按画布现存节点过滤（自愈，不做后台清扫）。 */
        shotVideoVersions?: Record<string, ShotVideoVersion[]>;
    };
};

export function createEmptyScriptData(): ScriptNodeData {
    return {
        schemaVersion: 1,
        instruction: "",
        globalStyle: "",
        entityIds: [],
        output: { status: "idle", shots: [] },
    };
}
