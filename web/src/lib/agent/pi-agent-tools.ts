import { nanoid } from "nanoid";

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

import type { CanvasAgentOp, CanvasAgentSnapshot, CanvasOpReceipt } from "@/lib/canvas/canvas-agent-op-types";
import type { AgentCanvasImageReadResult, AgentFileContent, AgentFileDescriptor, AgentProjectSummary, AgentAssetSummary, AgentGenerationTask, AgentModelSummary, AgentScriptEntitySummary } from "@/lib/agent/pi-agent-types";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeMetadata, type CanvasNodeTypeId } from "@/types/canvas";
import { SCRIPT_NODE_TYPE, type ScriptImageGenParams, type ScriptShot, type ScriptVideoGenParams, type ShotAudioRef } from "@/types/script-node";
import { validateProviderOptions, type ProviderOptions } from "../models/provider-options";
import { DEFAULT_MODEL_3D_CAMERA, MODEL_3D_CAMERA_PRESETS, type Model3dCameraPreset } from "../canvas/model-3d-camera";
import { composeEntityRefPrompt, imageGenMetadataPatch, storyboardImageStateOf, videoGenMetadataPatch } from "../canvas/script-node-model";
import { model3dReferenceSelectionsSchema, resolveModel3dReferenceSelections, type Model3dReferenceSelection } from "./model-3d-reference-selections";
import { buildGenerationStatusReport } from "./generation-status";
// Imported via relative path because this file is bundled into the Electron main
// process alongside `electron/agent-files.ts`; the `@/` alias only maps to web/src.
import { prepareImageForView, readAsImageForView, type ImageForView, type ImageViewDetail } from "../../../../electron/agent-files";

// Agent 通过这组工具读写画布。工具把语义化的意图翻译成 CanvasAgentOp，
// 由 runtime 层的 emitOps 回调交给桥接层（applyCanvasAgentOps）落到快照上。
export type CanvasToolContext = {
    getSnapshot: () => CanvasAgentSnapshot;
    emitOps: (ops: CanvasAgentOp[]) => void | Promise<CanvasOpReceipt[]>;
    readAttachment?: (handle: string) => Promise<{ ok: true; file: AgentFileContent } | { ok: false; error: string }>;
    listFolder?: (path: string, recursive: boolean) => Promise<{ ok: true; files: AgentFileDescriptor[] } | { ok: false; error: string }>;
    emitAttachmentImport?: (attachment: AgentFileContent) => Promise<{ id: string } | null> | void;
    readCanvasImage?: (request: { nodeId: string; imageId?: string }, signal?: AbortSignal) => Promise<AgentCanvasImageReadResult>;
    // Phase 2 additions (cache-based, populated by renderer via IPC)
    listProjects?: (filter: { keyword?: string; page?: number; pageSize?: number }) =>
        Promise<{ ok: true; projects: AgentProjectSummary[]; total: number } | { ok: false; error: string }>;
    listAssets?: (filter: { kind?: "all" | "text" | "image" | "video"; keyword?: string; page?: number; pageSize?: number }) =>
        Promise<{ ok: true; assets: AgentAssetSummary[]; total: number } | { ok: false; error: string }>;
    addAsset?: (input: { kind: "text" | "image" | "video"; title: string; content?: string; imageUrl?: string; videoUrl?: string; tags?: string[]; source?: string; note?: string }) =>
        Promise<{ ok: true; assetId: string } | { ok: false; error: string }>;
    getGenerationStatus?: (filter: { nodeIds?: string[]; limit?: number }) =>
        Promise<{ ok: true; tasks: AgentGenerationTask[] } | { ok: false; error: string }>;
    listModels?: () => Promise<{ ok: true; models: AgentModelSummary[] } | { ok: false; error: string }>;
    listScriptEntities?: () => Promise<{ ok: true; entities: AgentScriptEntitySummary[] } | { ok: false; error: string }>;
};

type GenerateNodeParams = {
    mode?: CanvasGenerationMode;
    prompt: string;
    title?: string;
    referenceNodeIds?: string[];
    reference3dSelections?: Model3dReferenceSelection[];
    model?: string;
    providerOptions?: ProviderOptions;
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
};
type ApplyOpsParams = { ops?: CanvasAgentOp[] };
type LocalFileReadParams = { handle: string; mode?: "view" | "meta" };
type ViewImageParams = { nodeId: string; imageId?: string; detail?: ImageViewDetail };
type Set3dCameraParams = { nodeId: string; preset?: Model3dCameraPreset; azimuth?: number; elevation?: number; distanceRatio?: number };
type CanvasAgentTool = AgentTool<any> & { promptSnippet?: string };

const GENERATION_WAIT_HINT = '生成提交后异步执行，工具返回不代表生成完成。提交成功后立即调用 wait 并传 nodeIds=[生成节点id]（图片建议 seconds=120、视频建议 seconds=300，超时后带相同 nodeIds 续等，多次续等仍超时则向用户报告），宿主等到全部节点到终态或提前失败才返回，等待期间无模型调用；仅在与生成无关的等待场景才用无 nodeIds 的 blind wait。不能把 wait 和 generation_get_status 放在同一批并行调用。进行中重复触发生成会被拒绝（双计费防护），勿绕过状态查询直接重跑。';
const GENERATION_POLLING_RULES = '生成等待统一用 wait 的 nodeIds 模式（宿主自动轮询到终态/早退），本工具仅用于即时检查：用户明确要求查看当前状态、或 wait 返回 not_found 后排查。多个节点用 nodeIds 批量查询；terminal=true（succeeded/failed/timed_out/interrupted）后停止查询。submission_unknown 禁止重跑，只能继续查询至 deadlineAt；刚提交的任务立即查询可能尚未注册。';

function generationReferenceNodeIds(snapshot: CanvasAgentSnapshot, referenceNodeIds: string[] = [], composerContent = "") {
    const ids = [...new Set([...referenceNodeIds, ...Array.from(composerContent.matchAll(/@\[node:([^\]]+)\]/g), match => match[1])])];
    const missing = ids.filter(id => !snapshot.nodes.some(node => node.id === id));
    if (missing.length) throw new Error(`参考节点不存在：${missing.join("、")}`);
    return ids;
}

// 模型参数校验（spec D10）：目录可得时 model 必须在列表中且 capability 匹配，否则报错不发 op；
// 目录不可得（web 降级/缓存未推送）时透传不阻断——假成功风险回到既有水平，不新增失败面。
async function resolveAgentModelParam(ctx: CanvasToolContext, raw: unknown, capability: AgentModelSummary["capability"]): Promise<{ value?: string; error?: string; model?: AgentModelSummary }> {
    if (raw === undefined) return {};
    const model = String(raw).trim();
    if (!model) return {};
    if (!ctx.listModels) return { value: model };
    const result = await ctx.listModels();
    if (!result.ok) return { value: model };
    const hit = result.models.find((entry) => entry.id === model);
    if (!hit) return { error: `模型 ${model} 不存在；请调用 models_list 获取可用列表后逐字复制 id` };
    if (hit.capability !== capability) return { error: `模型 ${model} 是 ${hit.capability} 模型，不是 ${capability} 模型；请调用 models_list（capability="${capability}"）重新选择` };
    return { value: model, model: hit };
}

function imageModelAcceptsReferences(model: AgentModelSummary, referenceCount: number) {
    if (referenceCount === 0) return model.requiresReference !== true && model.inputMode !== "image";
    return model.inputMode !== "text";
}

async function resolveAgentGenerationModel(
    ctx: CanvasToolContext,
    raw: unknown,
    capability: AgentModelSummary["capability"],
    referenceCount?: number,
): Promise<{ value?: string; error?: string; model?: AgentModelSummary }> {
    const explicit = await resolveAgentModelParam(ctx, raw, capability);
    if (explicit.error || capability !== "image" || referenceCount === undefined) return explicit;
    if (explicit.model) {
        if (!imageModelAcceptsReferences(explicit.model, referenceCount)) {
            return { error: referenceCount === 0
                ? `模型 ${explicit.model.id} 需要参考图；请添加参考节点，或从 models_list 选择文生图模型`
                : `模型 ${explicit.model.id} 不接受参考图；请移除参考节点，或从 models_list 选择支持图片输入的模型` };
        }
        return explicit;
    }
    if (!ctx.listModels) return explicit;
    const listed = await ctx.listModels();
    if (!listed.ok) return explicit;
    const candidates = listed.models.filter((model) => model.capability === "image" && imageModelAcceptsReferences(model, referenceCount));
    const selected = candidates.find((model) => model.isDefault) ?? candidates[0];
    if (!selected) return { error: referenceCount === 0 ? "当前没有可用于文生图的模型" : "当前没有支持参考图的生图模型" };
    return { value: selected.id, model: selected };
}

// 任务书参数摘要：model 只显示 :: 后短名（渠道编码前缀对用户是噪音）。
function formatGenParamsSummary(params: Record<string, unknown>): string {
    return Object.entries(params).map(([key, value]) => {
        const text = String(value);
        return `${key}=${text.includes("::") ? text.slice(text.indexOf("::") + 2) : text}`;
    }).join(", ");
}

function ok(text: string): AgentToolResult<any> {
    return { content: [{ type: "text", text }], details: { text } };
}

// 回执 → 工具返回文案（spec §1 三态）：全 applied 维持原文案；混合列跳过原因；全未生效给第一条原因。
// receipts 为 undefined（emitOps 未实现回执/测试 mock 返回 void）时回落原文案，保持向后兼容。
function opsOutcomeText(receipts: CanvasOpReceipt[] | undefined | void, appliedText: string): string {
    if (!receipts || !receipts.length) return appliedText;
    const failed = receipts.filter((receipt) => receipt.status !== "applied");
    if (!failed.length) return appliedText;
    const appliedCount = receipts.length - failed.length;
    if (!appliedCount) return `操作未生效：${failed[0]!.reason ?? failed[0]!.opType}`;
    return `已应用 ${appliedCount} 条；跳过 ${failed.length} 条：${failed.map((f) => f.reason ?? f.opType).join("、")}`;
}

// Like `ok` but optionally appends a typed `ImageContent` block so the model
// sees the image directly without the base64 bytes flowing through the LLM
// transcript as text. Use for `local_file_read` image-view responses.
function okImage(text: string, image?: ImageForView, details: Record<string, unknown> = {}): AgentToolResult<any> {
    const content: AgentToolResult<any>["content"] = image
        ? [
            { type: "text", text },
            { type: "image", data: image.base64, mimeType: image.mimeType },
        ]
        : [{ type: "text", text }];
    const imageMeta = image ? {
        mimeType: image.mimeType,
        width: image.width,
        height: image.height,
        sizeBytes: image.sizeBytes,
        transformed: image.transformed,
        oversized: image.oversized,
    } : undefined;
    return { content, details: { text, ...details, ...(imageMeta ? { image: imageMeta } : {}) } };
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// 镜头音频槽位（sfxAudio/dialogueAudio）解析：raw 为画布节点 id，"" = 清除该槽。
// 错误只返回文案（由工具经 ok() 回给模型），不产生 ops。
function resolveShotAudioRef(snapshotNodes: CanvasAgentSnapshot["nodes"], raw: unknown): { ref?: ShotAudioRef; error?: string } {
    if (raw === undefined) return {};
    const nodeId = String(raw);
    if (nodeId === "") return { ref: undefined }; // "" = 清除该槽音频
    const audioNode = snapshotNodes.find((item) => item.id === nodeId);
    if (!audioNode) return { error: `音频节点 ${nodeId} 不存在` };
    if (audioNode.type !== "audio") return { error: `节点 ${nodeId} 不是音频节点` };
    if (!audioNode.metadata?.storageKey) return { error: `音频节点 ${nodeId} 缺少 storageKey，无法引用` };
    return { ref: { name: audioNode.title || audioNode.id, storageKey: audioNode.metadata.storageKey, mimeType: audioNode.metadata.mimeType, durationMs: audioNode.metadata.durationMs, audioNodeId: audioNode.id } };
}

type AttachmentMeta = {
    name: string;
    handle: string;
    kind: string;
    mimeType: string;
    sizeBytes: number;
    width?: number;
    height?: number;
};

// Agent 镜头构造（canvas_script_add_shot 与 canvas_script_replace_shots 共用）。
// 与手动/AI 路径一致：缺字段不编造默认值；文本字段 trim（空白-only 同义空）；
// duration 仅在 > 0 时取整；entityRefs 先落空数组，实体名引用由 script_resolve_shot_refs 二段解析。
function buildAgentShot(
    input: {
        description?: unknown;
        shotSize?: unknown;
        angle?: unknown;
        movement?: unknown;
        duration?: unknown;
        mood?: unknown;
        sfx?: unknown;
        dialogue?: unknown;
        storyboardPrompt?: unknown;
    },
    audio: { sfxAudio?: ShotAudioRef; dialogueAudio?: ShotAudioRef } = {},
) {
    const description = input.description !== undefined ? String(input.description) : "";
    return {
        shotId: `shot_${nanoid(8)}`,
        no: 0,
        origin: "manual" as const,
        shotSize: input.shotSize !== undefined ? String(input.shotSize).trim() : "",
        angle: input.angle !== undefined ? String(input.angle).trim() : "",
        movement: input.movement !== undefined ? String(input.movement).trim() : "",
        duration: typeof input.duration === "number" && input.duration > 0 ? Math.round(input.duration) : 0,
        mood: input.mood !== undefined ? String(input.mood).trim() : "",
        sfx: input.sfx !== undefined ? String(input.sfx).trim() : "",
        dialogue: input.dialogue !== undefined ? String(input.dialogue).trim() : "",
        storyboardPrompt: input.storyboardPrompt !== undefined ? String(input.storyboardPrompt).trim() : "",
        ...audio,
        description,
        descriptionRich: [{ t: "text", v: description }] as never,
        entityRefs: [] as string[],
        composed: false,
    };
}

// 镜头身份延续：整体替换时尽量沿用旧 shotId——分镜图/视频节点/版本表等映射都按 shotId 挂靠，
// 身份断裂会让“重新优化”表现为清空分镜图。显式 replacesShotId 优先（必须存在且不得重复）；
// 全部镜头都未显式给出且新旧数量一致时按位沿用（调整顺序的场景必须逐镜显式传，见工具描述）。
function rebindReplaceShotIds<T extends { input: { replacesShotId?: unknown }; shot: ScriptShot }>(
    built: T[],
    existingShots: ScriptShot[],
): { built: T[] } | { error: string } {
    const allImplicit = built.every((entry) => typeof entry.input.replacesShotId !== "string" || !entry.input.replacesShotId.trim());
    if (allImplicit && built.length === existingShots.length) {
        return { built: built.map((entry, i) => ({ ...entry, shot: { ...entry.shot, shotId: existingShots[i]!.shotId } })) };
    }
    const existingIds = new Set(existingShots.map((s) => s.shotId));
    const claimed = new Set<string>();
    for (const entry of built) {
        const oldId = typeof entry.input.replacesShotId === "string" ? entry.input.replacesShotId.trim() : "";
        if (!oldId) continue;
        if (!existingIds.has(oldId)) {
            return { error: `replacesShotId ${oldId} 在该脚本节点不存在。请先 canvas_get_state 读取当前镜头列表，为要保留的镜头逐镜传旧 shotId（镜头数与顺序完全一致时可全部不传，系统按位沿用）` };
        }
        if (claimed.has(oldId)) {
            return { error: `replacesShotId ${oldId} 被多条镜头重复使用：每个旧 shotId 只能延续给一条新镜头` };
        }
        claimed.add(oldId);
    }
    return {
        built: built.map((entry) => {
            const oldId = typeof entry.input.replacesShotId === "string" ? entry.input.replacesShotId.trim() : "";
            return oldId ? { ...entry, shot: { ...entry.shot, shotId: oldId } } : entry;
        }),
    };
}

// entityRefs 工具期解析（spec 2026-09-11 §4.3）：假成功必须在工具返回里拦。
// 通道不可用 → 返回空对象，工具发不带 entityIds 的 resolve op（bridge 名称匹配，现状行为）。
async function resolveAgentEntityRefs(ctx: CanvasToolContext, projectId: string, names: string[]): Promise<{ entityIds?: string[]; error?: string }> {
    if (!names.length) return {};
    const listing = await ctx.listScriptEntities?.();
    if (!listing || !listing.ok) return {};
    const scoped = listing.entities.filter((entity) => entity.projectId === projectId);
    const byName = new Map(scoped.map((entity) => [entity.name, entity]));
    const missing = names.filter((name) => !byName.has(name));
    if (missing.length) {
        const available = scoped.map((entity) => `${entity.name}（${entity.group === "character" ? "角色" : entity.group === "scene" ? "场景" : "道具"}）`).join("、");
        return { error: `实体引用未找到：${Array.from(new Set(missing)).join("、")}。entityRefs 必须是已创建资产的实体名（画布节点 id 不能作为引用——画布图请用 canvas_script_asset 的 refNodeIds 绑为实体参考图）。当前项目可用实体：${available || "（无，请先创建资产）"}。` };
    }
    return { entityIds: names.map((name) => byName.get(name)!.id) };
}

function summarizeAttachment(file: AgentFileContent): AttachmentMeta {
    return { name: file.name, handle: file.handle, kind: file.kind, mimeType: file.mimeType, sizeBytes: file.size };
}

function formatImageMeta(meta: AttachmentMeta): string {
    const dims = meta.width && meta.height ? ` ${meta.width}x${meta.height}` : "";
    return `${meta.name} (image, ${formatBytes(meta.sizeBytes)}${dims})`;
}

function formatNonImageMeta(meta: AttachmentMeta, kind: string): string {
    const hints: Record<string, string> = {
        pdf: "PDF 已上画布节点；请用 PDF 阅读器查看或要求用户抽取关键页文本（当前工具不支持 PDF 文本提取）。",
        video: "视频已上画布节点；当前工具不支持抽帧，请用画布播放器预览。",
        glb: "3D 模型已上画布节点；当前工具不支持 GLB manifest 解析，请在 3D 视图中查看。",
    };
    return `${meta.name} (${kind}, ${formatBytes(meta.sizeBytes)})${hints[kind] ? `\n${hints[kind]}` : ""}`;
}

const GENERATION_NODE_TYPE: Record<CanvasGenerationMode, CanvasNodeType> = {
    text: CanvasNodeType.Text,
    image: CanvasNodeType.Image,
    video: CanvasNodeType.Video,
    audio: CanvasNodeType.Audio,
};

// 用 additionalProperties 表达自由键值对象，避免 Type.Record 生成 patternProperties（部分模型网关拒绝该关键字）。
const providerOptionsSchema = Type.Optional(Type.Object({
    version: Type.Number(),
    models: Type.Object({}, { additionalProperties: Type.Object({
        provider: Type.Literal("fal"), profileId: Type.String(), profileVersion: Type.Number(),
        params: Type.Object({}, { additionalProperties: Type.Unknown() }),
    }, { additionalProperties: false }) }) },
    { additionalProperties: false }));

export function buildCanvasTools(context: CanvasToolContext): CanvasAgentTool[] {
    // Validate every tool's metadata path before emitting the atomic batch, including low-level ops.
    const ctx: CanvasToolContext = {
        ...context,
        emitOps: (ops) => {
            const validateMetadata = (metadata: CanvasNodeMetadata | undefined) =>
                metadata?.providerOptions === undefined ? metadata : { ...metadata, providerOptions: validateProviderOptions(metadata.providerOptions) };
            const validated = ops.map(op => {
                if (op.type !== "add_node" && op.type !== "update_node") return op;
                return {
                    ...op,
                    ...(op.metadata ? { metadata: validateMetadata(op.metadata) } : {}),
                    ...(op.type === "update_node" && op.patch?.metadata ? { patch: { ...op.patch, metadata: validateMetadata(op.patch.metadata) } } : {}),
                };
            });
            return context.emitOps(validated);
        },
    };
    const viewImageTools: CanvasAgentTool[] = ctx.readCanvasImage ? [
        {
            name: "view_image",
            description: "读取画布图片节点或 3D 节点的视图并通过视觉通道查看。先调用 canvas_get_state 获取 nodeId；多图节点可传 imageId 精确选择，3D 节点的 imageId 为 primary、left、right 或 top，省略时读取 primary。detail 默认 high，original 保留原始分辨率。",
            label: "查看画布原图",
            promptSnippet: "读取画布图片或 3D 视图像素时必须调用：先用 canvas_get_state 获取准确 nodeId，再调用 view_image；3D 可用 imageId=primary/left/right/top。blob URL 由工具内部解析，不要用 read/local_file_read，也不要受历史消息中“无法读取 blob”的说法影响。",
            parameters: Type.Object({
                nodeId: Type.String(),
                imageId: Type.Optional(Type.String()),
                detail: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("original")])),
            }),
            execute: async (_toolCallId, raw, signal) => {
                const params = raw as ViewImageParams;
                const nodeId = String(params.nodeId || "").trim();
                if (!nodeId) return ok("nodeId 不能为空");
                const imageId = params.imageId?.trim();
                const detail = params.detail ?? "high";
                if (detail !== "high" && detail !== "original") return ok(`view_image.detail 仅支持 high 或 original：${String(params.detail)}`);
                const source = await ctx.readCanvasImage!({ nodeId, ...(imageId ? { imageId } : {}) }, signal);
                if (!source.ok) return ok(source.error);
                const prepared = await prepareImageForView(source.image.dataUrl, detail);
                if ("error" in prepared) return ok(prepared.error);
                const dimensions = `${prepared.width || source.image.width}x${prepared.height || source.image.height}`;
                return okImage(
                    `已读取画布图片「${source.image.title}」 ${nodeId}${source.image.imageId ? `/${source.image.imageId}` : ""}（${dimensions}，${formatBytes(prepared.sizeBytes)}，${detail}）`,
                    prepared,
                    { nodeId, ...(source.image.imageId ? { imageId: source.image.imageId } : {}), detail, title: source.image.title },
                );
            },
        },
    ] : [];
    return [
        {
            name: "canvas_get_state",
            description: "按需返回当前画布快照（节点、连线、选中项、视口）。需要了解现有结构或获取节点 id 时调用。",
            label: "读取画布状态",
            promptSnippet: "需要了解画布现状、选区或获取节点 id 时调用。",
            parameters: Type.Object({}),
            execute: async () => ok(JSON.stringify(ctx.getSnapshot())),
        },
        ...viewImageTools,
        {
            name: "canvas_set_3d_camera",
            description: "设置指定 3D 节点的主预览摄像机。preset 支持 front/back/left/right/top/isometric，也可用 azimuth/elevation/distanceRatio 精确覆盖。后续把该节点作为 referenceNodeIds 传给生图工具时，会自动提供主视角、左视角、右视角和顶视角四张参考图。",
            label: "调整 3D 摄像机",
            promptSnippet: "设置 3D 节点主摄像机；后续生图引用该节点会自动使用四视角参考。",
            parameters: Type.Object({
                nodeId: Type.String(),
                preset: Type.Optional(Type.Union([Type.Literal("front"), Type.Literal("back"), Type.Literal("left"), Type.Literal("right"), Type.Literal("top"), Type.Literal("isometric")])),
                azimuth: Type.Optional(Type.Number()),
                elevation: Type.Optional(Type.Number()),
                distanceRatio: Type.Optional(Type.Number()),
            }),
            execute: async (_toolCallId, raw) => {
                const params = raw as Set3dCameraParams;
                const nodeId = String(params.nodeId || "").trim();
                const target = ctx.getSnapshot().nodes.find((node) => node.id === nodeId);
                if (!target) return ok(`3D 节点不存在：${nodeId}`);
                if (target.type !== "3d") return ok(`目标节点不是 3D 节点：${nodeId}`);

                for (const [name, value] of [["azimuth", params.azimuth], ["elevation", params.elevation], ["distanceRatio", params.distanceRatio]] as const) {
                    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) return ok(`${name} 必须是有限数字`);
                }
                if (params.distanceRatio !== undefined && params.distanceRatio <= 0) return ok("distanceRatio 必须大于 0");

                const current = target.metadata?.model3d?.camera || DEFAULT_MODEL_3D_CAMERA;
                const preset = params.preset && params.preset in MODEL_3D_CAMERA_PRESETS ? MODEL_3D_CAMERA_PRESETS[params.preset] : current;
                const camera = {
                    azimuth: params.azimuth ?? preset.azimuth,
                    elevation: params.elevation ?? preset.elevation,
                    distanceRatio: params.distanceRatio ?? preset.distanceRatio,
                };
                const receipts = await ctx.emitOps([{ type: "set_3d_camera", nodeId, camera }]);
                return ok(opsOutcomeText(receipts, `已调整 3D 节点 ${nodeId} 的主摄像机；生图引用将自动使用四视角参考`));
            },
        },
        {
            name: "local_file_read",
            description: "读取当前会话中已注册的本地附件。必须使用附件句柄，不接受任意路径。mode 默认 view：image 走视觉通道返回 typed image block（不返回 base64 文本，避免吃光 context），其他类型返回元数据说明已上画布；mode=meta 仅返回元数据。",
            label: "读取本地附件",
            promptSnippet: "通过 handle 读取本会话已注册的本地附件（图片/视频/PDF/GLB）。",
            parameters: Type.Object({
                handle: Type.String(),
                mode: Type.Optional(Type.Union([Type.Literal("view"), Type.Literal("meta")])),
            }),
            execute: async (_toolCallId, raw) => {
                if (!ctx.readAttachment) return ok("当前运行环境不支持读取本地附件");
                const params = raw as LocalFileReadParams;
                const handle = String(params.handle || "");
                const mode: "view" | "meta" = params.mode === "meta" ? "meta" : "view";
                const result = await ctx.readAttachment(handle);
                if (!result.ok) return ok(`读取附件失败：${result.error}`);
                const file = result.file;
                const meta = summarizeAttachment(file);
                if (mode === "meta" || file.kind !== "image") {
                    // Text-only response — never inline base64 in text. PDFs/videos/GLBs
                    // are visual-previews-only for now; caller should look at the canvas
                    // node or ask the user.
                    if (file.kind === "image") return ok(formatImageMeta(meta));
                    return ok(formatNonImageMeta(meta, file.kind));
                }
                // mode === "view" && file.kind === "image": route through the typed
                // image pipeline so the model sees pixels, not base64 text.
                const view = await readAsImageForView(handle, { read: ctx.readAttachment });
                if ("error" in view) {
                    return ok(`读取图片失败：${view.error}\n${formatImageMeta(meta)}`);
                }
                const warning = view.oversized ? `\n[warning] 原图 ${formatBytes(view.sizeBytes)} 超过 5MB，建议让用户先用画布导出更小的版本。` : "";
                const transformedNote = view.transformed ? "（已自动降采样/重压）" : "";
                const header = formatImageMeta({ ...meta, sizeBytes: view.sizeBytes, width: view.width, height: view.height }) + transformedNote + warning;
                return okImage(header, view);
            },
        },
        {
            name: "local_folder_list",
            description: "列出用户提供的本地文件夹中的受支持附件。递归读取时只返回图片、视频、PDF、GLB。",
            label: "列出本地文件夹",
            promptSnippet: "扫描本地目录中的图片、视频、PDF、GLB 附件并注册到当前会话。",
            parameters: Type.Object({ path: Type.String(), recursive: Type.Optional(Type.Boolean()) }),
            execute: async (_toolCallId, raw) => {
                if (!ctx.listFolder) return ok("当前运行环境不支持读取本地文件夹");
                const params = raw as { path: string; recursive?: boolean };
                const result = await ctx.listFolder(params.path, params.recursive !== false);
                return result.ok ? ok(JSON.stringify(result.files)) : ok(`读取文件夹失败：${result.error}`);
            },
        },
        {
            name: "canvas_import_attachment",
            description: "把当前会话中的本地附件导入白板。导入后会按类型生成 Image、Video、PDF/File 或 3D 节点。",
            label: "导入附件到白板",
            promptSnippet: "把已注册的本地附件按类型创建为画布节点（Image/Video/PDF/File/3D）。",
            parameters: Type.Object({ handle: Type.String() }),
            execute: async (_toolCallId, raw) => {
                if (!ctx.readAttachment || !ctx.emitAttachmentImport) return ok("当前运行环境不支持导入本地附件");
                const result = await ctx.readAttachment(String((raw as { handle?: unknown }).handle || ""));
                if (!result.ok) return ok(`导入附件失败：${result.error}`);
                ctx.emitAttachmentImport(result.file);
                return ok(`已将 ${result.file.name} 导入白板`);
            },
        },
        {
            name: "canvas_generate_node",
            description: `新建一个自生成节点并触发生成（text / image / video / audio），产物写入该节点自身；仅应在用户明确要求生成该内容时调用。脚本节点的分镜关键帧必须使用 canvas_script_generate_storyboards，不得用本工具代替。prompt 为生成指令。image 模式支持 model、size（如 1:1、16:9 或 1024x1024）、quality、background 和 count（1-15）；video 模式支持 seconds（时长秒数）、vquality（如 768p横）、generateAudio、watermark；audio 模式支持 audioVoice/audioFormat/audioSpeed/audioInstructions；不传时使用当前配置。referenceNodeIds 为可选的参考节点 id 列表并建立参考连线；引用 3D 节点时传 reference3dSelections，例如 [{"nodeId":"3d-node-id","view":"all"}]；view 是单个枚举字符串，all 已代表 primary/left/right/top，禁止数组或 item 键。用户未明确指定模型时省略 model，让工具按参考输入选择兼容默认模型。需要参考时先从 canvas_get_state 拿到目标节点 id。${GENERATION_WAIT_HINT}`,
            label: "生成节点",
            promptSnippet: "用户明确要求生成时，创建 text/image/video/audio 生成节点并立即触发；image 支持 model/size/quality/background/count，video 支持 seconds/vquality 等，audio 支持 voice 参数。",
            parameters: Type.Object({
                mode: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("image"), Type.Literal("video"), Type.Literal("audio")])),
                prompt: Type.String(),
                title: Type.Optional(Type.String()),
                referenceNodeIds: Type.Optional(Type.Array(Type.String())),
                reference3dSelections: model3dReferenceSelectionsSchema,
                model: Type.Optional(Type.String()),
                providerOptions: providerOptionsSchema,
                size: Type.Optional(Type.String()),
                quality: Type.Optional(Type.String()),
                background: Type.Optional(Type.String()),
                count: Type.Optional(Type.Number()),
                seconds: Type.Optional(Type.String()),
                vquality: Type.Optional(Type.String()),
                generateAudio: Type.Optional(Type.String()),
                watermark: Type.Optional(Type.String()),
                audioVoice: Type.Optional(Type.String()),
                audioFormat: Type.Optional(Type.String()),
                audioSpeed: Type.Optional(Type.String()),
                audioInstructions: Type.Optional(Type.String()),
            }),
            execute: async (_toolCallId, raw) => {
                const params = raw as GenerateNodeParams;
                const mode: CanvasGenerationMode = params.mode ?? "image";
                const nodeType = GENERATION_NODE_TYPE[mode];
                const nodeId = `${nodeType}-${nanoid()}`;
                const snapshot = ctx.getSnapshot();
                let referenceNodeIds: string[];
                try { referenceNodeIds = generationReferenceNodeIds(snapshot, params.referenceNodeIds); }
                catch (error) { return ok(error instanceof Error ? error.message : String(error)); }
                const reference3dViews = resolveModel3dReferenceSelections(snapshot, referenceNodeIds, params.reference3dSelections);
                if (reference3dViews.error) return ok(reference3dViews.error);
                const model = await resolveAgentGenerationModel(ctx, params.model, mode, mode === "image" ? referenceNodeIds.length : undefined);
                if (model.error) return ok(model.error);
                const metadata: CanvasNodeMetadata = {
                    ...(params.providerOptions !== undefined ? { providerOptions: params.providerOptions } : {}),
                    generationMode: mode,
                    prompt: params.prompt,
                    ...(reference3dViews.value ? { reference3dViews: reference3dViews.value } : {}),
                    ...(model.value ? { model: model.value } : {}),
                    ...(params.size !== undefined ? { size: params.size } : {}),
                    ...(params.quality !== undefined ? { quality: params.quality } : {}),
                    ...(params.background?.trim() ? { background: params.background.trim() } : {}),
                    ...(typeof params.count === "number" && Number.isFinite(params.count) ? { count: Math.max(1, Math.min(15, Math.floor(Math.abs(params.count)))) } : {}),
                    ...(params.seconds !== undefined ? { seconds: params.seconds } : {}),
                    ...(params.vquality !== undefined ? { vquality: params.vquality } : {}),
                    ...(params.generateAudio !== undefined ? { generateAudio: params.generateAudio } : {}),
                    ...(params.watermark !== undefined ? { watermark: params.watermark } : {}),
                    ...(params.audioVoice !== undefined ? { voice: params.audioVoice } : {}),
                    ...(params.audioFormat !== undefined ? { audioFormat: params.audioFormat } : {}),
                    ...(params.audioSpeed !== undefined ? { audioSpeed: params.audioSpeed } : {}),
                    ...(params.audioInstructions !== undefined ? { audioInstructions: params.audioInstructions } : {}),
                };
                const ops: CanvasAgentOp[] = [
                    { type: "add_node", id: nodeId, nodeType, title: params.title, ...(referenceNodeIds.length ? { anchorNodeIds: referenceNodeIds } : {}), metadata },
                    ...referenceNodeIds.map((fromNodeId) => ({ type: "connect_nodes" as const, fromNodeId, toNodeId: nodeId })),
                    { type: "run_generation", nodeId, mode, prompt: params.prompt },
                ];
                const receipts = await ctx.emitOps(ops);
                return ok(opsOutcomeText(receipts, `已创建 ${mode} 生成节点 ${nodeId} 并开始生成${referenceNodeIds.length ? `（参考节点：${referenceNodeIds.join(", ")}）` : ""}。${GENERATION_WAIT_HINT}`));
            },
        },
        {
            name: "canvas_generate_script",
            description:
                "创建（或复用）脚本节点并返回创作任务书；工具本身不再生成分镜。分镜由你创作：先按任务书用 canvas_script_asset 逐个创建资产，再用 canvas_script_replace_shots 一次性写入全部分镜。instruction 为脚本指令；shotCount 可选（分镜数量参考值）；globalStyle 为全局风格；storyboardFirst=true 开启分镜图先行模式（每镜需同时给出 storyboardPrompt 与 finalPrompt）；referenceNodeIds 仅作画布连线组织，不参与分镜生成。imageGen 为分镜图生图参数、videoGen 为镜头视频参数（均整体替换，传空对象 {} 清除）；两处 model 取值来自 models_list。",
            label: "生成分镜脚本",
            promptSnippet: "创建/复用脚本节点并返回创作任务书：先 canvas_script_asset 建资产，再 canvas_script_replace_shots 写全部分镜（工具本身不生成分镜）。",
            parameters: Type.Object({
                nodeId: Type.Optional(Type.String({ description: "已存在的脚本节点 id；缺省新建" })),
                instruction: Type.String(),
                shotCount: Type.Optional(Type.Number()),
                globalStyle: Type.Optional(Type.String()),
                storyboardFirst: Type.Optional(Type.Boolean({ description: "true = 分镜图先行模式：每镜需同时给出 storyboardPrompt（静态关键帧）与 finalPrompt" })),
                imageGen: Type.Optional(Type.Object({
                    model: Type.Optional(Type.String()),
                    size: Type.Optional(Type.String()),
                    quality: Type.Optional(Type.String()),
                    background: Type.Optional(Type.String()),
                    count: Type.Optional(Type.Number()),
                })),
                videoGen: Type.Optional(Type.Object({
                    model: Type.Optional(Type.String()),
                    size: Type.Optional(Type.String()),
                    vquality: Type.Optional(Type.String()),
                    seconds: Type.Optional(Type.String()),
                    generateAudio: Type.Optional(Type.String()),
                    watermark: Type.Optional(Type.String()),
                })),
                referenceNodeIds: Type.Optional(Type.Array(Type.String({ description: "仅作画布连线组织，不参与分镜生成" }))),
            }),
            execute: async (_toolCallId, raw) => {
                const params = raw as { nodeId?: string; instruction: string; shotCount?: number; globalStyle?: string; storyboardFirst?: boolean; referenceNodeIds?: string[]; imageGen?: ScriptImageGenParams; videoGen?: ScriptVideoGenParams };
                const referenceNodeIds = (params.referenceNodeIds ?? []).map((id) => String(id).trim()).filter(Boolean);
                // 参数块校验+清洗（spec D3/D10）：model 先对目录校验（报错即返回，不发 op），
                // 再经 patch 函数清洗；显式 {} = 清除；有键但全非法 = 视同未传。
                const imageModelCheck = await resolveAgentModelParam(ctx, (params.imageGen as Record<string, unknown> | undefined)?.model, "image");
                if (imageModelCheck.error) return ok(imageModelCheck.error);
                const videoModelCheck = await resolveAgentModelParam(ctx, (params.videoGen as Record<string, unknown> | undefined)?.model, "video");
                if (videoModelCheck.error) return ok(videoModelCheck.error);
                const imageGenRaw: unknown = params.imageGen;
                const videoGenRaw: unknown = params.videoGen;
                // 显式 {} = 清除；有键但全非法 = 视同未传（undefined，不动既有参数）。
                // clean 显式标注 Script*GenParams：imageGenMetadataPatch 返回的 Partial<CanvasNodeMetadata> 结构兼容，
                // 收窄后才能赋给 template.imageGen/videoGen（CanvasNodeMetadata['script'] 类型）。
                const imageGenClean: ScriptImageGenParams = imageGenRaw ? imageGenMetadataPatch(params.imageGen) : {};
                const videoGenClean: ScriptVideoGenParams = videoGenRaw ? videoGenMetadataPatch(params.videoGen) : {};
                // 形状守卫（spec 失败模式表）：LLM 幻觉可能把参数块传成 ""/[] 等错型，
                // 非 plain object（含 null）视同未传，防止落入 Object.keys().length === 0 的「显式 {} 清除」误判。
                const isPlainObjectBlock = (raw: unknown): raw is Record<string, unknown> =>
                    typeof raw === "object" && raw !== null && !Array.isArray(raw);
                const resolveGenPatch = <T extends object>(rawBlock: unknown, clean: T): T | undefined =>
                    !isPlainObjectBlock(rawBlock) ? undefined
                        : Object.keys(rawBlock).length === 0 ? ({} as T)
                        : Object.keys(clean).length ? clean : undefined;
                const imageGenPatch = resolveGenPatch(imageGenRaw, imageGenClean);
                const videoGenPatch = resolveGenPatch(videoGenRaw, videoGenClean);
                const imageGenSummary = imageGenPatch && Object.keys(imageGenPatch).length ? `分镜图生图参数已设置（生成分镜图时生效）：${formatGenParamsSummary(imageGenPatch)}。` : "";
                const videoGenSummary = videoGenPatch && Object.keys(videoGenPatch).length ? `镜头视频参数已设置（完成脚本编辑展开视频节点时生效，生成弹窗可逐镜覆盖）：${formatGenParamsSummary(videoGenPatch)}。` : "";
                const storyboardFirstLine = `本节点为分镜图先行模式：每镜需同时给出 storyboardPrompt（静态关键帧，进行中瞬间，无运镜/声音）与 finalPrompt（运动优先，不复述画面），并建议 duration 默认 5s`;
                const requestedNodeId = params.nodeId?.trim();
                if (requestedNodeId) {
                    // 复用分支：只更新指令与全局风格，保留既有 entityIds/镜头/模板，不发 add_node。
                    const existing = ctx.getSnapshot().nodes.find((item) => item.id === requestedNodeId);
                    if (!existing) return ok(`脚本节点 ${requestedNodeId} 不存在，无法复用`);
                    if (existing.type !== SCRIPT_NODE_TYPE || !existing.metadata?.script) return ok(`节点 ${requestedNodeId} 不是脚本节点，无法复用`);
                    // storyboardFirst 落库（final-review Important 2）：script_set_instruction 携带 template patch
                    // （bridge 侧 spread 合并，不覆盖既有 shotCount），否则复用节点时模式开关永不生效
                    const templatePatch = {
                        ...(params.storyboardFirst ? { storyboardFirst: true as const } : {}),
                        ...(imageGenPatch !== undefined ? { imageGen: imageGenPatch } : {}),
                        ...(videoGenPatch !== undefined ? { videoGen: videoGenPatch } : {}),
                    };
                    const receipts = await ctx.emitOps([{
                        type: "script_set_instruction",
                        nodeId: requestedNodeId,
                        instruction: params.instruction,
                        ...(params.globalStyle !== undefined ? { globalStyle: params.globalStyle } : {}),
                        ...(Object.keys(templatePatch).length ? { template: templatePatch } : {}),
                    }]);
                    const templateShotCount = existing.metadata.script.template?.shotCount;
                    const shotCountHint = typeof params.shotCount === "number" && params.shotCount > 0 ? String(Math.floor(params.shotCount)) : typeof templateShotCount === "number" ? String(templateShotCount) : "由你按叙事节奏决定";
                    const lines = [
                        `已复用脚本节点 ${requestedNodeId}（更新 instruction/globalStyle，保留既有资产与镜头；该节点已有内容，后续 canvas_script_replace_shots 会整体替换全部镜头——为保留已生成的分镜图/视频，先 canvas_get_state 读取旧镜头，迭代时逐镜传 replacesShotId=旧 shotId）。创作任务书——两步工作流（必做，按顺序）：`,
                        `第一步：按 instruction 判断需要哪些角色/场景/道具，逐个调用 canvas_script_asset 创建资产。每个资产必须填全字段：role（定位：角色=主角/配角，场景=主要/过场，道具=关键/装饰）、appearance（定义：角色=外貌性格，场景=环境空间，道具=形态材质）、consistency（一致性要点）、imagePrompt（生图主体描述：主体+风格+构图）——生成参考图时系统会把 name/role/appearance/consistency 自动拼进节点提示词，无需把 appearance 抄进 imagePrompt；只给名字不填字段 = 参考图与一致性失效。资产默认不生成参考图；用户明确许可后才传 generate=true 生成。`,
                        `第二步：一次性调用 canvas_script_replace_shots（nodeId 用 ${requestedNodeId}）写入全部分镜，数量参考 ${shotCountHint}；镜头 entityRefs 传已创建资产的实体名建立引用（画布节点 id 不能作为引用；画布图先用 canvas_script_asset 的 refNodeIds 绑为实体参考图）；镜头字段要求：description 多句电影化描述/shotSize/angle/movement/duration 秒数/mood/sfx/dialogue。`,
                    ];
                    if (imageGenSummary) lines.push(imageGenSummary);
                    if (videoGenSummary) lines.push(videoGenSummary);
                    if (params.storyboardFirst) lines.push(storyboardFirstLine);
                    if (referenceNodeIds.length) lines.push(`参考节点仅作画布连线组织，不参与分镜生成：${referenceNodeIds.join(", ")}（复用已有节点时不重复连线）。`);
                    return ok(opsOutcomeText(receipts, lines.join("\n")));
                }
                const nodeId = `${SCRIPT_NODE_TYPE}-${nanoid()}`;
                // spread 合并（评审修正 10）：storyboardFirst 不得覆盖既有 shotCount。
                const template = {
                    ...(typeof params.shotCount === "number" && params.shotCount > 0 ? { shotCount: Math.floor(params.shotCount) } : {}),
                    ...(params.storyboardFirst ? { storyboardFirst: true as const } : {}),
                    ...(imageGenPatch !== undefined ? { imageGen: imageGenPatch } : {}),
                    ...(videoGenPatch !== undefined ? { videoGen: videoGenPatch } : {}),
                };
                const ops: CanvasAgentOp[] = [
                    {
                        type: "add_node",
                        id: nodeId,
                        nodeType: SCRIPT_NODE_TYPE,
                        title: "脚本",
                        metadata: {
                            script: {
                                schemaVersion: 1,
                                instruction: params.instruction,
                                globalStyle: params.globalStyle ?? "",
                                entityIds: [],
                                ...(Object.keys(template).length ? { template } : {}),
                                output: { status: "generating", shots: [] },
                            },
                        },
                    },
                    ...referenceNodeIds.map((fromNodeId) => ({ type: "connect_nodes" as const, fromNodeId, toNodeId: nodeId })),
                ];
                const receipts = await ctx.emitOps(ops);
                const shotCountHint = typeof params.shotCount === "number" && params.shotCount > 0 ? String(Math.floor(params.shotCount)) : "由你按叙事节奏决定";
                const lines = [
                    `已创建脚本节点 ${nodeId}（生成中，分镜由你创作）。创作任务书——两步工作流（必做，按顺序）：`,
                    `第一步：按 instruction 判断需要哪些角色/场景/道具，逐个调用 canvas_script_asset 创建资产。每个资产必须填全字段：role（定位：角色=主角/配角，场景=主要/过场，道具=关键/装饰）、appearance（定义：角色=外貌性格，场景=环境空间，道具=形态材质）、consistency（一致性要点）、imagePrompt（生图主体描述：主体+风格+构图）——生成参考图时系统会把 name/role/appearance/consistency 自动拼进节点提示词，无需把 appearance 抄进 imagePrompt；只给名字不填字段 = 参考图与一致性失效。资产默认不生成参考图；用户明确许可后才传 generate=true 生成。`,
                    `第二步：一次性调用 canvas_script_replace_shots（nodeId 用 ${nodeId}）写入全部分镜，数量参考 ${shotCountHint}；镜头 entityRefs 传已创建资产的实体名建立引用（画布节点 id 不能作为引用；画布图先用 canvas_script_asset 的 refNodeIds 绑为实体参考图）；镜头字段要求：description 多句电影化描述/shotSize/angle/movement/duration 秒数/mood/sfx/dialogue。`,
                ];
                if (imageGenSummary) lines.push(imageGenSummary);
                if (videoGenSummary) lines.push(videoGenSummary);
                if (params.storyboardFirst) lines.push(storyboardFirstLine);
                if (referenceNodeIds.length) lines.push(`参考节点已连线（仅作画布连线组织，不参与分镜生成）：${referenceNodeIds.join(", ")}。`);
                return ok(opsOutcomeText(receipts, lines.join("\n")));
            },
        },
        {
            name: "canvas_script_asset",
            description:
                "为脚本节点准备一个资产（角色/场景/道具）并写入全部生成字段：name、role（定位：角色=主角/配角，场景=主要/过场，道具=关键/装饰）、appearance（定义：角色=外貌性格，场景=环境空间，道具=形态材质）、consistency、imagePrompt（生成参考图时节点提示词由这些字段自动组装，imagePrompt 作主体，无需把 appearance 抄进 imagePrompt）；默认只建实体与槽位、不生成参考图，仅在用户明确许可后传 generate=true，经 sheet 槽的画布图片生成节点生成参考图并自动回写。scriptNodeId 为目标脚本节点；group 按语义选择：character=人物、scene=地点/环境、item=物品（场景资产不要传 character）。支持 model/size/quality/background/count/providerOptions 控制参考图生成；model 取值来自 models_list 返回的 id。传 refNodeIds（画布 image 节点 id 数组）时把已有图片绑定为实体参考图，不建节点不触发生成——画布上已有的参考图（如产品图）应这样进实体。同名实体已存在时为原地更新（可纠正 group），不会重复创建。",
            label: "生成脚本资产",
            promptSnippet: "为脚本创建角色/场景/道具资产（默认不生成参考图，用户明确许可后传 generate=true 才生成）；画布已有图片用 refNodeIds 绑定为实体参考图。",
            parameters: Type.Object({
                scriptNodeId: Type.String(),
                group: Type.Union([Type.Literal("character"), Type.Literal("scene"), Type.Literal("item")]),
                name: Type.String(),
                role: Type.Optional(Type.String()),
                appearance: Type.Optional(Type.String()),
                consistency: Type.Optional(Type.String()),
                imagePrompt: Type.Optional(Type.String()),
                model: Type.Optional(Type.String()),
                providerOptions: providerOptionsSchema,
                size: Type.Optional(Type.String()),
                quality: Type.Optional(Type.String()),
                background: Type.Optional(Type.String()),
                count: Type.Optional(Type.Number()),
                refNodeIds: Type.Optional(Type.Array(Type.String({ description: "已有画布 image 节点 id：绑定为该实体参考图槽位（source=canvas），不建节点不生成" }))),
                generate: Type.Optional(Type.Boolean({ description: "true = 生成参考图（仅在用户明确许可后传；默认不生成，只建实体与槽位）" })),
            }),
            execute: async (_toolCallId, raw) => {
                const params = raw as { scriptNodeId: string; group: "character" | "scene" | "item"; name: string; role?: string; appearance?: string; consistency?: string; imagePrompt?: string; model?: string; providerOptions?: ProviderOptions; size?: string; quality?: string; background?: string; count?: number; refNodeIds?: unknown; generate?: boolean };
                const snapshot = ctx.getSnapshot();
                if (!snapshot.nodes.some((node) => node.id === params.scriptNodeId)) {
                    return ok(`脚本节点 ${params.scriptNodeId} 不存在，请先用 canvas_generate_script 创建`);
                }
                const name = params.name.trim();
                if (!name) return ok("name 不能为空");
                // refNodeIds 校验：数组、存在、image 类型（spec 失败模式表）
                if (params.refNodeIds !== undefined && !Array.isArray(params.refNodeIds)) return ok("refNodeIds 需为画布节点 id 数组");
                const refNodeIds = Array.isArray(params.refNodeIds) ? params.refNodeIds.map((value) => String(value).trim()).filter(Boolean) : [];
                const invalidRefs = refNodeIds.filter((id) => {
                    const node = snapshot.nodes.find((item) => item.id === id);
                    return !node || (node.type !== CanvasNodeType.Image && node.referenceKind !== "image");
                });
                if (invalidRefs.length) return ok(`refNodeIds 含不存在或不能作为图片参考的节点：${invalidRefs.join("、")}（接受 image 节点及 referenceKind=image 的 3D/插件节点；先用 canvas_get_state 确认 id）`);
                const generate = params.generate === true;
                const model = generate
                    ? await resolveAgentGenerationModel(ctx, params.model, "image", 0)
                    : await resolveAgentModelParam(ctx, params.model, "image");
                if (model.error) return ok(model.error);
                const GROUP_LABEL = { character: "角色", scene: "场景", item: "道具" } as const;
                const groupLabel = GROUP_LABEL[params.group];
                const entityFields = { projectId: snapshot.projectId, group: params.group, name, ...(params.role ? { role: params.role } : {}), ...(params.appearance ? { appearance: params.appearance } : {}), ...(params.consistency ? { consistency: params.consistency } : {}), ...(params.imagePrompt ? { imagePrompt: params.imagePrompt } : {}) };
                // 参考图节点的参数元数据（spec 2026-09-11 生成参数）：仅在真生成路径使用
                const genMetadata = {
                    ...(model.value ? { model: model.value } : {}),
                    ...(params.providerOptions !== undefined ? { providerOptions: params.providerOptions } : {}),
                    ...(params.size?.trim() ? { size: params.size.trim() } : {}),
                    ...(params.quality?.trim() ? { quality: params.quality.trim() } : {}),
                    ...(params.background?.trim() ? { background: params.background.trim() } : {}),
                    ...(typeof params.count === "number" && Number.isFinite(params.count) ? { count: Math.max(1, Math.min(15, Math.floor(Math.abs(params.count)))) } : {}),
                };
                const prompt = composeEntityRefPrompt({ group: params.group, name, role: params.role, appearance: params.appearance, consistency: params.consistency, imagePrompt: params.imagePrompt });
                // 同名查重（实体表未同步时降级为新建——现状行为）
                const listing = await ctx.listScriptEntities?.();
                const entities = listing?.ok ? listing.entities : [];
                const existing = entities.find((entity) => entity.projectId === snapshot.projectId && entity.name === name);

                if (existing) {
                    // 同名 = 原地更新：refs 键省略（store 保留既有槽位归属，重发 refs 会清 source/nodeId）
                    const ops: CanvasAgentOp[] = [
                        { type: "script_entity_upsert", entity: { id: existing.id, ...entityFields } },
                        { type: "script_bind_entity", nodeId: params.scriptNodeId, entityId: existing.id },
                    ];
                    let note = `实体「${name}」（${groupLabel}，group=${params.group}）已存在，已原地更新字段（entityId=${existing.id}）`;
                    if (refNodeIds.length) {
                        const emptySlots = existing.refs.filter((ref) => ref.state === "empty");
                        if (emptySlots.length < refNodeIds.length) {
                            return ok(`实体「${name}」空参考槽不足：空槽 ${emptySlots.length} 个 < 待绑节点 ${refNodeIds.length} 个。请在脚本 Studio 资产抽屉增加参考槽，或改用新实体名`);
                        }
                        refNodeIds.forEach((nodeId, index) => {
                            ops.push({ type: "script_assign_entity_ref", entityId: existing.id, refId: emptySlots[index]!.id, nodeId });
                        });
                        const receipts = await ctx.emitOps(ops);
                        return ok(opsOutcomeText(receipts, `${note}；已绑定 ${refNodeIds.length} 个画布参考图（source=canvas，不触发生成）。后续镜头 entityRefs 引用实体名「${name}」`));
                    }
                    const hasReady = existing.refs.some((ref) => ref.state === "ready");
                    if (!generate || hasReady) {
                        if (generate) note += "；已有参考图，跳过生成";
                        const receipts = await ctx.emitOps(ops);
                        return ok(opsOutcomeText(receipts, `${note}${generate ? "" : "；未生成参考图（默认不生成，用户明确许可后传 generate=true）"}。后续镜头 entityRefs 引用实体名「${name}」`));
                    }
                    const slot = existing.refs.find((ref) => ref.state === "empty") ?? existing.refs[0];
                    if (!slot) return ok(`实体「${name}」没有任何参考槽位，无法生成参考图；请改用新实体名`);
                    const imageNodeId = `image-${nanoid()}`;
                    ops.push(
                        { type: "add_node", id: imageNodeId, nodeType: CanvasNodeType.Image, title: `${name} · 参考图`, metadata: { prompt, scriptEntityRef: { entityId: existing.id, refId: slot.id }, ...genMetadata } },
                        { type: "connect_nodes", fromNodeId: params.scriptNodeId, toNodeId: imageNodeId },
                        { type: "run_generation", nodeId: imageNodeId, mode: "image", prompt },
                    );
                    const receipts = await ctx.emitOps(ops);
                    return ok(opsOutcomeText(receipts, `${note}；已就绪参考图生成（图片节点 ${imageNodeId}）。${GENERATION_WAIT_HINT}`));
                }

                const entityId = `ent_${nanoid(10)}`;
                const ops: CanvasAgentOp[] = [];
                if (refNodeIds.length) {
                    // 绑定路径：每节点一槽，source=canvas，不建图节点不生成
                    const slotIds = refNodeIds.map(() => `ref_${nanoid(8)}`);
                    ops.push({ type: "script_entity_upsert", entity: { id: entityId, ...entityFields, refs: slotIds.map((id, index) => ({ id, label: index === 0 ? "sheet" : `sheet ${index + 1}`, state: "empty" as const })) } });
                    ops.push({ type: "script_bind_entity", nodeId: params.scriptNodeId, entityId });
                    slotIds.forEach((refId, index) => {
                        ops.push({ type: "script_assign_entity_ref", entityId, refId, nodeId: refNodeIds[index]! });
                    });
                    const receipts = await ctx.emitOps(ops);
                    return ok(opsOutcomeText(receipts, `已创建${groupLabel}资产「${name}」（group=${params.group}，entityId=${entityId}）；已绑定 ${refNodeIds.length} 个画布参考图（source=canvas，不触发生成）。后续镜头 entityRefs 引用实体名「${name}」`));
                }
                const refId = `ref_${nanoid(8)}`;
                ops.push({ type: "script_entity_upsert", entity: { id: entityId, ...entityFields, refs: [{ id: refId, label: "sheet", state: "empty" }] } });
                ops.push({ type: "script_bind_entity", nodeId: params.scriptNodeId, entityId });
                if (!generate) {
                    const receipts = await ctx.emitOps(ops);
                    return ok(opsOutcomeText(receipts, `已创建${groupLabel}资产「${name}」（group=${params.group}，entityId=${entityId}）；槽位已建、未生成参考图（默认不生成，用户明确许可后传 generate=true）。后续镜头 entityRefs 引用实体名「${name}」`));
                }
                const imageNodeId = `image-${nanoid()}`;
                ops.push(
                    { type: "add_node", id: imageNodeId, nodeType: CanvasNodeType.Image, title: `${name} · 参考图`, metadata: { prompt, scriptEntityRef: { entityId, refId }, ...genMetadata } },
                    { type: "connect_nodes", fromNodeId: params.scriptNodeId, toNodeId: imageNodeId },
                    { type: "run_generation", nodeId: imageNodeId, mode: "image", prompt },
                );
                const receipts = await ctx.emitOps(ops);
                return ok(opsOutcomeText(receipts, `已创建${groupLabel}资产「${name}」（group=${params.group}，entityId=${entityId}）并开始生成参考图（图片节点 ${imageNodeId}）。后续镜头 entityRefs 引用实体名「${name}」。${GENERATION_WAIT_HINT}`));
            },
        },
        {
            name: "canvas_script_update_shot",
            description: "修改脚本节点的一条镜头（按 shotId 更新；no/origin 不可改）。支持全部字段：description/shotSize/angle/movement/duration/mood（自由文本）/sfx/dialogue/storyboardPrompt（静态关键帧提示词，空串=未设置），以及 entityRefs（实体名称数组——必须是已创建资产的实体名，先 canvas_script_asset 建资产；引用不存在的名字会整体报错并列出可用实体）和 sfxAudioNodeId/dialogueAudioNodeId（画布音频节点 id，传空串清除对应音频）。",
            label: "修改镜头",
            promptSnippet: "按 shotId 更新脚本节点中一条镜头的任意字段（含实体名称引用列表）。",
            parameters: Type.Object({
                nodeId: Type.String(),
                shotId: Type.String(),
                description: Type.Optional(Type.String()),
                shotSize: Type.Optional(Type.String()),
                angle: Type.Optional(Type.String()),
                movement: Type.Optional(Type.String()),
                duration: Type.Optional(Type.Number()),
                mood: Type.Optional(Type.String()),
                sfx: Type.Optional(Type.String()),
                dialogue: Type.Optional(Type.String()),
                storyboardPrompt: Type.Optional(Type.String()),
                sfxAudioNodeId: Type.Optional(Type.String()),
                dialogueAudioNodeId: Type.Optional(Type.String()),
                entityRefs: Type.Optional(Type.Array(Type.String())),
            }),
            execute: async (_toolCallId, raw) => {
                const params = raw as Record<string, unknown> & { nodeId: string; shotId: string; entityRefs?: string[] };
                const snapshot = ctx.getSnapshot();
                const node = snapshot.nodes.find((item) => item.id === params.nodeId);
                if (!node) return ok(`脚本节点 ${params.nodeId} 不存在`);
                if (node.type !== SCRIPT_NODE_TYPE || !node.metadata?.script) return ok(`节点 ${params.nodeId} 不是脚本节点，无法操作分镜`);
                const existing = node?.metadata?.script?.output.shots.find((shot) => shot.shotId === params.shotId);
                if (!existing) return ok(`未找到镜头 ${params.shotId}（节点 ${params.nodeId}）`);
                const patch: Record<string, unknown> = {};
                for (const key of ["description", "shotSize", "angle", "movement", "duration", "mood", "sfx", "dialogue", "storyboardPrompt"]) {
                    if (params[key] !== undefined) patch[key] = params[key];
                }
                const audioPatch: Partial<typeof existing> = {};
                for (const [paramKey, slotKey] of [["sfxAudioNodeId", "sfxAudio"], ["dialogueAudioNodeId", "dialogueAudio"]] as const) {
                    const slotRaw = params[paramKey];
                    if (slotRaw === undefined) continue;
                    const resolved = resolveShotAudioRef(snapshot.nodes, slotRaw);
                    if (resolved.error) return ok(resolved.error);
                    audioPatch[slotKey] = resolved.ref;
                }
                const ops: CanvasAgentOp[] = [
                    {
                        type: "script_upsert_shot",
                        nodeId: params.nodeId,
                        shot: { ...existing, ...patch, ...audioPatch, descriptionRich: patch.description !== undefined ? [{ t: "text", v: String(patch.description) }] : existing.descriptionRich },
                    },
                ];
                const names = Array.isArray(params.entityRefs) ? params.entityRefs.map(String).filter(Boolean) : [];
                if (names.length) {
                    const resolved = await resolveAgentEntityRefs(ctx, snapshot.projectId, names);
                    if (resolved.error) return ok(resolved.error);
                    ops.push({ type: "script_resolve_shot_refs", nodeId: params.nodeId, shotId: params.shotId, names, ...(resolved.entityIds ? { entityIds: resolved.entityIds } : {}) });
                }
                const receipts = await ctx.emitOps(ops);
                return ok(opsOutcomeText(receipts, `已更新镜头 ${params.shotId}${names.length ? `（引用实体：${names.join("、")}）` : ""}`));
            },
        },
        {
            name: "canvas_script_add_shot",
            description: "向脚本节点追加一条镜头并写入全部字段（description/shotSize/angle/movement/duration/mood/sfx/dialogue/storyboardPrompt/sfxAudioNodeId/dialogueAudioNodeId/entityRefs）。storyboardPrompt 为静态关键帧提示词（进行中瞬间，无运镜/声音），空串=未设置。entityRefs 为实体名称数组（必须是已创建资产的实体名，先 canvas_script_asset 建资产；引用不存在的名字会整体报错并列出可用实体）；sfxAudioNodeId/dialogueAudioNodeId 为画布音频节点 id，传空串清除对应音频；序号自动排。",
            label: "追加镜头",
            promptSnippet: "向脚本节点追加一条镜头（全字段 + 实体名称引用）。可携带画布音频节点 id 作为音效/台词音频。",
            parameters: Type.Object({
                nodeId: Type.String(),
                description: Type.Optional(Type.String()),
                shotSize: Type.Optional(Type.String()),
                angle: Type.Optional(Type.String()),
                movement: Type.Optional(Type.String()),
                duration: Type.Optional(Type.Number()),
                mood: Type.Optional(Type.String()),
                sfx: Type.Optional(Type.String()),
                dialogue: Type.Optional(Type.String()),
                storyboardPrompt: Type.Optional(Type.String()),
                sfxAudioNodeId: Type.Optional(Type.String()),
                dialogueAudioNodeId: Type.Optional(Type.String()),
                entityRefs: Type.Optional(Type.Array(Type.String())),
            }),
            execute: async (_toolCallId, raw) => {
                const params = raw as Record<string, unknown> & { nodeId: string; entityRefs?: string[] };
                const snapshot = ctx.getSnapshot();
                const node = snapshot.nodes.find((item) => item.id === params.nodeId);
                if (!node) return ok(`脚本节点 ${params.nodeId} 不存在`);
                if (node.type !== SCRIPT_NODE_TYPE || !node.metadata?.script) return ok(`节点 ${params.nodeId} 不是脚本节点，无法操作分镜`);
                const audioSlots: { sfxAudio?: ShotAudioRef; dialogueAudio?: ShotAudioRef } = {};
                for (const [paramKey, slotKey] of [["sfxAudioNodeId", "sfxAudio"], ["dialogueAudioNodeId", "dialogueAudio"]] as const) {
                    const slotRaw = params[paramKey];
                    if (slotRaw === undefined) continue;
                    const resolved = resolveShotAudioRef(snapshot.nodes, slotRaw);
                    if (resolved.error) return ok(resolved.error);
                    audioSlots[slotKey] = resolved.ref;
                }
                const shot = buildAgentShot({
                    description: params.description, shotSize: params.shotSize, angle: params.angle, movement: params.movement,
                    duration: params.duration, mood: params.mood, sfx: params.sfx, dialogue: params.dialogue, storyboardPrompt: params.storyboardPrompt,
                }, audioSlots);
                const ops: CanvasAgentOp[] = [{ type: "script_upsert_shot", nodeId: params.nodeId, shot }];
                const names = Array.isArray(params.entityRefs) ? params.entityRefs.map(String).filter(Boolean) : [];
                if (names.length) {
                    const resolved = await resolveAgentEntityRefs(ctx, snapshot.projectId, names);
                    if (resolved.error) return ok(resolved.error);
                    ops.push({ type: "script_resolve_shot_refs", nodeId: params.nodeId, shotId: shot.shotId, names, ...(resolved.entityIds ? { entityIds: resolved.entityIds } : {}) });
                }
                const receipts = await ctx.emitOps(ops);
                return ok(opsOutcomeText(receipts, `已追加镜头（描述：${shot.description.slice(0, 40)}…）${names.length ? `，引用实体：${names.join("、")}` : ""}`));
            },
        },
        {
            name: "canvas_script_delete_shot",
            description: "删除脚本节点的一条镜头（按 shotId），序号自动重排。",
            label: "删除镜头",
            promptSnippet: "按 shotId 删除脚本节点中的一条镜头。",
            parameters: Type.Object({ nodeId: Type.String(), shotId: Type.String() }),
            execute: async (_toolCallId, raw) => {
                const params = raw as { nodeId: string; shotId: string };
                const snapshot = ctx.getSnapshot();
                const node = snapshot.nodes.find((item) => item.id === params.nodeId);
                if (!node) return ok(`脚本节点 ${params.nodeId} 不存在`);
                if (node.type !== SCRIPT_NODE_TYPE || !node.metadata?.script) return ok(`节点 ${params.nodeId} 不是脚本节点，无法操作分镜`);
                const receipts = await ctx.emitOps([{ type: "script_delete_shot", nodeId: params.nodeId, shotId: params.shotId }]);
                return ok(opsOutcomeText(receipts, `已删除镜头 ${params.shotId}`));
            },
        },
        {
            name: "canvas_script_replace_shots",
            description: "整体替换脚本节点的全部分镜（清空既有镜头后写入新列表）。每次调用写入完整创作结果；如需保留部分旧镜头，先用 canvas_get_state 读取并在 shots 中合并。迭代优化既有脚本时逐镜传 replacesShotId=旧 shotId 延续镜头身份（沿用后该镜已生成的分镜图与视频映射保留）；调整了镜头顺序时必须逐镜传；镜头数与顺序完全一致且全部不传时系统自动按位沿用。镜头支持 storyboardPrompt（静态关键帧提示词，进行中瞬间，无运镜/声音；空串=未设置）。entityRefs 为实体名称数组，必须是已创建资产的实体名（先 canvas_script_asset 建资产；引用不存在的名字会整体报错并列出可用实体）。",
            label: "替换分镜",
            promptSnippet: "一次性替换脚本节点全部分镜（整批写入，含实体名称引用；迭代时回带 replacesShotId 延续镜头身份）。",
            parameters: Type.Object({
                nodeId: Type.String(),
                shots: Type.Array(Type.Object({
                    description: Type.Optional(Type.String()),
                    shotSize: Type.Optional(Type.String()),
                    angle: Type.Optional(Type.String()),
                    movement: Type.Optional(Type.String()),
                    duration: Type.Optional(Type.Number()),
                    mood: Type.Optional(Type.String()),
                    sfx: Type.Optional(Type.String()),
                    dialogue: Type.Optional(Type.String()),
                    storyboardPrompt: Type.Optional(Type.String()),
                    entityRefs: Type.Optional(Type.Array(Type.String())),
                    replacesShotId: Type.Optional(Type.String()),
                }), { maxItems: 50 }),
            }),
            execute: async (_toolCallId, raw) => {
                const params = raw as { nodeId: string; shots: Array<{ description?: string; shotSize?: string; angle?: string; movement?: string; duration?: number; mood?: string; sfx?: string; dialogue?: string; storyboardPrompt?: string; entityRefs?: string[]; replacesShotId?: string }> };
                const snapshot = ctx.getSnapshot();
                const node = snapshot.nodes.find((item) => item.id === params.nodeId);
                if (!node) return ok(`脚本节点 ${params.nodeId} 不存在`);
                if (node.type !== SCRIPT_NODE_TYPE || !node.metadata?.script) return ok(`节点 ${params.nodeId} 不是脚本节点，无法写入分镜`);
                if (!Array.isArray(params.shots)) return ok(`shots 需为分镜数组；未收到有效数组（可能是 null），请传入完整镜头列表`);
                if (node.metadata.script.output.status === "generating" && params.shots.length === 0) return ok(`生成中的脚本节点不接受空分镜：请写入完整镜头列表（或等我方解除生成态后再操作）`);
                if (params.shots.length > 50) return ok(`镜头数量 ${params.shots.length} 超过上限 50`);
                const built = params.shots.map((input) => ({ input, shot: buildAgentShot(input) }));
                const rebound = rebindReplaceShotIds(built, node.metadata.script.output.shots);
                if ("error" in rebound) return ok(rebound.error);
                const entries = rebound.built;
                const carriedCount = entries.filter((entry, i) => entry.shot.shotId !== built[i]!.shot.shotId).length;
                const ops: CanvasAgentOp[] = [{ type: "script_replace_shots", nodeId: params.nodeId, shots: entries.map((entry) => entry.shot) }];
                const shotRefNames: string[][] = entries.map((entry) => (Array.isArray(entry.input.entityRefs) ? entry.input.entityRefs.map(String).filter(Boolean) : []));
                const allNames = shotRefNames.flat();
                const resolvedRefs = await resolveAgentEntityRefs(ctx, snapshot.projectId, allNames);
                if (resolvedRefs.error) return ok(resolvedRefs.error);
                // resolvedRefs.entityIds 与 allNames 一一对应，按每镜偏移切片
                const offsets: number[] = [];
                let cursor = 0;
                for (const names of shotRefNames) {
                    offsets.push(cursor);
                    cursor += names.length;
                }
                const refNames: string[] = [];
                entries.forEach((entry, index) => {
                    const names = shotRefNames[index]!;
                    if (!names.length) return;
                    refNames.push(...names);
                    ops.push({ type: "script_resolve_shot_refs", nodeId: params.nodeId, shotId: entry.shot.shotId, names, ...(resolvedRefs.entityIds ? { entityIds: resolvedRefs.entityIds.slice(offsets[index]!, offsets[index]! + names.length) } : {}) });
                });
                const receipts = await ctx.emitOps(ops);
                return ok(opsOutcomeText(receipts, `已替换脚本节点 ${params.nodeId} 全部分镜（共 ${entries.length} 条${carriedCount ? `，沿用 ${carriedCount} 条旧镜头身份` : ""}${refNames.length ? `，引用实体：${refNames.join("、")}` : ""}）。镜头已写入，生成态将由系统解除`));
            },
        },
        {
            name: "canvas_script_reorder_shots",
            description: "重排脚本节点的镜头顺序（给出全部 shotId 的新顺序）。",
            label: "重排镜头",
            promptSnippet: "按给定 shotId 顺序重排脚本节点镜头。",
            parameters: Type.Object({ nodeId: Type.String(), shotIds: Type.Array(Type.String()) }),
            execute: async (_toolCallId, raw) => {
                const params = raw as { nodeId: string; shotIds: string[] };
                const snapshot = ctx.getSnapshot();
                const node = snapshot.nodes.find((item) => item.id === params.nodeId);
                if (!node) return ok(`脚本节点 ${params.nodeId} 不存在`);
                if (node.type !== SCRIPT_NODE_TYPE || !node.metadata?.script) return ok(`节点 ${params.nodeId} 不是脚本节点，无法操作分镜`);
                const receipts = await ctx.emitOps([{ type: "script_reorder_shots", nodeId: params.nodeId, shotIds: params.shotIds }]);
                return ok(opsOutcomeText(receipts, `已重排 ${params.shotIds.length} 条镜头`));
            },
        },
        {
            name: "canvas_script_compile_prompts",
            description: "把 Agent 编译好的最终提示词批量回写到脚本节点（一键合成的落库通道）。你先按分镜字段、实体与全局风格为每镜编译模型定制 finalPrompt（shotshot-director 技能的 prompt-compiler 出货规范：运镜全文唯一/官方声音符号/结尾约束段/资产名内联）与 storyboardPrompt（静态关键帧：进行中瞬间，无运镜/声音），再用本工具一次性写入。只改 finalPrompt 与可选的 storyboardPrompt，并把 composed 重置为草稿（待用户逐镜确认），绝不动分镜其他字段。",
            label: "回写合成提示词",
            promptSnippet: "把每镜编译好的 finalPrompt（含可选 storyboardPrompt）批量回写脚本节点（composed 重置为草稿）。",
            parameters: Type.Object({
                nodeId: Type.String(),
                prompts: Type.Array(Type.Object({
                    shotId: Type.String(),
                    finalPrompt: Type.String(),
                    storyboardPrompt: Type.Optional(Type.String()),
                }), { maxItems: 50 }),
            }),
            execute: async (_toolCallId, raw) => {
                const params = raw as { nodeId: string; prompts: Array<{ shotId: string; finalPrompt: string; storyboardPrompt?: string }> };
                const snapshot = ctx.getSnapshot();
                const node = snapshot.nodes.find((item) => item.id === params.nodeId);
                if (!node) return ok(`脚本节点 ${params.nodeId} 不存在`);
                if (node.type !== SCRIPT_NODE_TYPE || !node.metadata?.script) return ok(`节点 ${params.nodeId} 不是脚本节点，无法回写提示词`);
                const shots = node.metadata.script.output.shots;
                if (!Array.isArray(params.prompts) || params.prompts.length === 0) return ok(`prompts 需为非空数组（{shotId, finalPrompt} 列表）`);
                if (params.prompts.length > 50) return ok(`prompts 数量 ${params.prompts.length} 超过上限 50`);
                const ops: CanvasAgentOp[] = [];
                const skipped: string[] = [];
                for (const entry of params.prompts) {
                    const existing = shots.find((shot) => shot.shotId === entry.shotId);
                    const text = String(entry?.finalPrompt ?? "").trim();
                    if (!existing || !text) {
                        skipped.push(!existing ? entry.shotId : `${entry.shotId}（finalPrompt 为空）`);
                        continue;
                    }
                    const storyboardPromptText = String(entry?.storyboardPrompt ?? "").trim();
                    ops.push({ type: "script_upsert_shot", nodeId: params.nodeId, shot: { ...existing, finalPrompt: text, ...(storyboardPromptText ? { storyboardPrompt: storyboardPromptText } : {}), composed: false } });
                }
                const receipts = ops.length ? await ctx.emitOps(ops) : undefined;
                if (skipped.length) return ok(opsOutcomeText(receipts, `已回写 ${ops.length} 条；跳过（未找到镜头或 finalPrompt 为空）：${skipped.join("、")}`));
                return ok(opsOutcomeText(receipts, `已回写 ${ops.length} 条 finalPrompt（composed 已重置为草稿，请在「合成提示词」步逐镜确认）`));
            },
        },
        {
            name: "canvas_script_generate_storyboards",
            description: `为脚本节点生成分镜关键帧。系统按每镜 entityRefs 自动解析已就绪的角色、场景、道具和 3D/插件图片参考，创建带 shotStoryboardRef 的 Image 节点并写回 storyboardNodes；不要自行传参考节点，也不要使用通用生成工具代替。引用 3D 节点时传 reference3dSelections，例如 [{"nodeId":"3d-node-id","view":"all"}]；view 是单个枚举字符串，all 已代表 primary/left/right/top，禁止数组或 item 键。shotIds 省略时只生成既未 ready、也未生成中的镜头；传入时生成指定镜头。model 必须来自 models_list 且支持图片参考。${GENERATION_WAIT_HINT}`,
            label: "生成分镜关键帧",
            promptSnippet: "为脚本镜头生成分镜关键帧；引用资产由系统从 entityRefs 自动解析并写回脚本映射。",
            parameters: Type.Object({
                scriptNodeId: Type.String(),
                shotIds: Type.Optional(Type.Array(Type.String())),
                reference3dSelections: model3dReferenceSelectionsSchema,
                model: Type.Optional(Type.String()),
                size: Type.Optional(Type.String()),
                quality: Type.Optional(Type.String()),
                background: Type.Optional(Type.String()),
                count: Type.Optional(Type.Number()),
            }),
            execute: async (_toolCallId, raw) => {
                const params = raw as { scriptNodeId: string; shotIds?: string[]; reference3dSelections?: Model3dReferenceSelection[]; model?: string; size?: string; quality?: string; background?: string; count?: number };
                const snapshot = ctx.getSnapshot();
                const node = snapshot.nodes.find((item) => item.id === params.scriptNodeId);
                const script = node?.metadata?.script;
                if (!node || node.type !== SCRIPT_NODE_TYPE || !script) return ok(`脚本节点 ${params.scriptNodeId} 不存在`);
                if (!script.template?.storyboardFirst) return ok(`脚本节点 ${params.scriptNodeId} 未开启分镜图先行模式`);

                const requested = params.shotIds?.map((id) => id.trim()).filter(Boolean);
                const requestedSet = requested?.length ? new Set(requested) : undefined;
                if (requestedSet) {
                    const missing = [...requestedSet].filter((id) => !script.output.shots.some((shot) => shot.shotId === id));
                    if (missing.length) return ok(`镜头不存在：${missing.join("、")}`);
                }
                const shots = script.output.shots.filter((shot) => {
                    if (requestedSet) return requestedSet.has(shot.shotId);
                    const storyboardId = script.output.storyboardNodes?.[shot.shotId];
                    const storyboard = storyboardId ? snapshot.nodes.find((item) => item.id === storyboardId) : undefined;
                    const state = storyboardImageStateOf(storyboard);
                    return state !== "ready" && state !== "generating";
                });
                if (!shots.length) return ok("没有待生成的分镜关键帧");

                if (!ctx.listScriptEntities) return ok("脚本实体表尚未同步，无法确认分镜关键帧的资产引用");
                const listedEntities = await ctx.listScriptEntities();
                if (!listedEntities.ok) return ok(`脚本实体表尚未同步，无法确认分镜关键帧的资产引用：${listedEntities.error}`);
                const entityById = new Map(listedEntities.entities.map((entity) => [entity.id, entity]));
                const referenceNodeIdsByShot = new Map(shots.map((shot) => [shot.shotId, [...new Set(shot.entityRefs.flatMap((entityId) =>
                    entityById.get(entityId)?.refs.flatMap((ref) => {
                        if (ref.state !== "ready" || !ref.nodeId) return [];
                        const refNode = snapshot.nodes.find((item) => item.id === ref.nodeId);
                        return refNode?.type === CanvasNodeType.Image || refNode?.referenceKind === "image" ? [ref.nodeId] : [];
                    }) ?? []
                ))]]));
                const missingAssetShots = shots.filter((shot) => !referenceNodeIdsByShot.get(shot.shotId)?.length);
                if (missingAssetShots.length) {
                    return ok(`以下镜头没有就绪资产参考图，未提交分镜关键帧：${missingAssetShots.map((shot) => `#${shot.no}`).join("、")}。请先用 canvas_script_asset 绑定或生成参考资产。`);
                }
                const referenced3dIds = [...new Set([...referenceNodeIdsByShot.values()].flat().filter((id) =>
                    snapshot.nodes.some((item) => item.id === id && item.type === "3d"),
                ))];
                const reference3dViews = resolveModel3dReferenceSelections(snapshot, referenced3dIds, params.reference3dSelections);
                if (reference3dViews.error) return ok(reference3dViews.error);

                // 分镜一定带实体参考图：未显式指定时从实时目录重新选择支持图片输入的模型，
                // 不沿用模板里可能是文生图的旧 model。
                const model = await resolveAgentGenerationModel(ctx, params.model, "image", 1);
                if (model.error) return ok(model.error);
                const metadata = imageGenMetadataPatch({
                    ...script.template.imageGen,
                    ...(model.value ? { model: model.value } : {}),
                    ...(params.size !== undefined ? { size: params.size } : {}),
                    ...(params.quality !== undefined ? { quality: params.quality } : {}),
                    ...(params.background !== undefined ? { background: params.background } : {}),
                    ...(params.count !== undefined ? { count: params.count } : {}),
                });
                ctx.emitOps(shots.map((shot) => {
                    const shotReferenceIds = new Set(referenceNodeIdsByShot.get(shot.shotId));
                    const shotReference3dViews = reference3dViews.value
                        ? Object.fromEntries(Object.entries(reference3dViews.value).filter(([id]) => shotReferenceIds.has(id)))
                        : undefined;
                    return {
                        type: "script_generate_storyboard" as const,
                        nodeId: params.scriptNodeId,
                        shotId: shot.shotId,
                        settings: {
                            metadata: { ...metadata, ...(shotReference3dViews && Object.keys(shotReference3dViews).length ? { reference3dViews: shotReference3dViews } : {}) },
                        },
                    };
                }));
                return ok(`已提交 ${shots.length} 个镜头的分镜关键帧生成。${GENERATION_WAIT_HINT}`);
            },
        },
        {
            name: "canvas_apply_ops",
            description: "直接应用一组画布操作。ops 每项规范形状：{type:\"add_node\", nodeType, title?, position?{x,y}, anchorNodeIds?} | {type:\"add_text_nodes\", items:[{text,title?}], direction?, gap?} | {type:\"update_node\", id, patch?{title,position,width,height}, metadata?} | {type:\"delete_node\", ids:[...]} | {type:\"connect_nodes\", fromNodeId, toNodeId} | {type:\"select_nodes\", ids:[...]}（ids 为空数组=清空选区）| {type:\"set_viewport\", viewport:{x,y,k}}。未识别类型或错误字段会逐条返回 invalid 并被拒收。优先使用语义工具。",
            label: "应用画布操作",
            promptSnippet: "直接应用一组低级画布操作（add/update/delete 节点，连线，选区，视口）。低层级原语。",
            parameters: Type.Object({ ops: Type.Array(Type.Unknown()) }),
            execute: async (_toolCallId, raw) => {
                const params = raw as ApplyOpsParams;
                const ops = params.ops ?? [];
                if (ops.some((op) => op.type === "add_node" && op.nodeType === CanvasNodeType.Config)) {
                    return ok("Agent 不支持创建 Config 节点；请使用对应的语义生成工具");
                }
                const configTarget = ops.find((op) => op.type === "run_generation"
                    && ctx.getSnapshot().nodes.some((node) => node.id === op.nodeId && node.type === CanvasNodeType.Config));
                if (configTarget) return ok("Agent 不支持触发 Config 节点；请由用户在画布中手动运行");
                const model3dTarget = ops.find((op) => op.type === "run_generation"
                    && ctx.getSnapshot().nodes.some((node) => node.id === op.nodeId && node.type === "3d"));
                if (model3dTarget) return ok("Agent 不能直接触发 3D 节点生成；请使用 canvas_generate_node，并通过 reference3dSelections 为每个节点传入一项 { nodeId, view }，多视角使用 view: \"all\"");
                const receipts = await ctx.emitOps(ops);
                return ok(opsOutcomeText(receipts, `已应用 ${ops.length} 条操作`));
            },
        },
        // === canvas_get_selection ===
        {
            name: "canvas_get_selection",
            description: "读取当前画布选中的节点。返回选中节点的完整数据（id/type/position/metadata 等），适合只想了解选区而不要全量画布的场景。",
            label: "读取选区",
            promptSnippet: "返回当前画布选中的节点列表（不含全量画布）。",
            parameters: Type.Object({}),
            execute: async () => {
                const snapshot = ctx.getSnapshot();
                const selectedSet = new Set(snapshot.selectedNodeIds);
                const nodes = snapshot.nodes.filter((n) => selectedSet.has(n.id));
                return ok(JSON.stringify({ nodes, count: nodes.length }));
            },
        },
        // === canvas_select_nodes ===
        {
            name: "canvas_select_nodes",
            description: "设置画布选中节点。ids 为空数组表示清空选区。",
            label: "设置选中节点",
            promptSnippet: "设置画布选中节点；ids 为空数组表示清空选区。",
            parameters: Type.Object({ ids: Type.Array(Type.String()) }),
            execute: async (_toolCallId, raw) => {
                const params = raw as { ids: string[] };
                const receipts = await ctx.emitOps([{ type: "select_nodes", ids: params.ids }]);
                return ok(opsOutcomeText(receipts, `已选中 ${params.ids.length} 个节点`));
            },
        },
        // === canvas_set_viewport ===
        {
            name: "canvas_set_viewport",
            description: "调整画布视口。x/y 是视口左上角的世界坐标，k 是缩放比例。",
            label: "设置视口",
            promptSnippet: "调整画布视口：x/y 是视口左上角的世界坐标，k 是缩放比例。",
            parameters: Type.Object({
                viewport: Type.Object({
                    x: Type.Number(),
                    y: Type.Number(),
                    k: Type.Number({ description: "缩放比例，1 表示原始大小" }),
                }),
            }),
            execute: async (_toolCallId, raw) => {
                const params = raw as { viewport: { x: number; y: number; k: number } };
                const receipts = await ctx.emitOps([{ type: "set_viewport", viewport: params.viewport }]);
                return ok(opsOutcomeText(receipts, "已调整视口"));
            },
        },
        // === canvas_update_node ===
        {
            name: "canvas_update_node",
            description: "更新节点基础字段或 metadata。patch 改 title/position/width/height（坐标支持字符串数字，会自动转）；dx/dy 为相对当前坐标的偏移，与 position 同传时 dx/dy 优先。metadata 改 prompt/model/status 等扩展字段。文本内容请用 canvas_update_node_text。",
            label: "更新节点",
            promptSnippet: "更新节点 title/position/width/height 或 dx/dy（相对当前坐标偏移，与 position 同传时 dx/dy 优先）或 metadata；文本内容请用 canvas_update_node_text。",
            parameters: Type.Object({
                providerOptions: providerOptionsSchema,
                id: Type.String({ description: "节点 id，先用 canvas_get_state 获取" }),
                patch: Type.Optional(Type.Object({
                    title: Type.Optional(Type.String()),
                    position: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number() })),
                    dx: Type.Optional(Type.Number({ description: "相对当前坐标的 X 偏移；与 position.x 同传时 dx 优先" })),
                    dy: Type.Optional(Type.Number({ description: "相对当前坐标的 Y 偏移；与 position.y 同传时 dy 优先" })),
                    width: Type.Optional(Type.Number()),
                    height: Type.Optional(Type.Number()),
                }, { additionalProperties: true })),
                metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
            }),
            execute: async (_toolCallId, raw) => {
                const params = raw as {
                    id: string;
                    providerOptions?: ProviderOptions;
                    patch?: { title?: string; position?: { x: number; y: number }; dx?: number; dy?: number; width?: number; height?: number };
                    metadata?: Record<string, unknown>;
                };
                let patch = params.patch;
                if (patch && (typeof patch.dx === "number" || typeof patch.dy === "number")) {
                    const node = ctx.getSnapshot().nodes.find((n) => n.id === params.id);
                    if (!node) return ok(`节点不存在：${params.id}（dx/dy 相对移动需要已存在的节点）`);
                    const position = { x: node.position.x, y: node.position.y };
                    // dx/dy 与 position 同传时 dx/dy 优先（继承原 move_nodes 语义）
                    if (typeof patch.dx === "number") position.x += patch.dx;
                    else if (typeof patch.position?.x === "number") position.x = patch.position.x;
                    if (typeof patch.dy === "number") position.y += patch.dy;
                    else if (typeof patch.position?.y === "number") position.y = patch.position.y;
                    const { dx: _dx, dy: _dy, ...rest } = patch;
                    patch = { ...rest, position };
                }
                const metadata = { ...params.metadata, ...(params.providerOptions !== undefined ? { providerOptions: params.providerOptions } : {}) };
                const op: CanvasAgentOp = {
                    type: "update_node",
                    id: params.id,
                    ...(patch ? { patch } : {}),
                    ...(Object.keys(metadata).length ? { metadata } : {}),
                };
                const receipts = await ctx.emitOps([op]);
                return ok(opsOutcomeText(receipts, `已更新节点 ${params.id}`));
            },
        },
        // === canvas_update_node_text ===
        {
            name: "canvas_update_node_text",
            description: "更新文本节点内容和标题。仅作用于 Text 类型节点；其它类型请用 canvas_update_node。",
            label: "更新文本节点",
            promptSnippet: "更新 Text 类型节点的内容（content）和标题。",
            parameters: Type.Object({
                id: Type.String({ description: "文本节点 id" }),
                text: Type.String(),
                title: Type.Optional(Type.String()),
            }),
            execute: async (_toolCallId, raw) => {
                const params = raw as { id: string; text: string; title?: string };
                const snapshot = ctx.getSnapshot();
                const node = snapshot.nodes.find((n) => n.id === params.id);
                if (!node) return ok(`节点不存在：${params.id}`);
                if (node.type !== "text") return ok(`节点 ${params.id} 不是 Text 类型（当前类型：${node.type}），请用 canvas_update_node`);
                const receipts = await ctx.emitOps([{
                    type: "update_node",
                    id: params.id,
                    patch: params.title ? { title: params.title } : {},
                    metadata: { content: params.text },
                }]);
                return ok(opsOutcomeText(receipts, `已更新文本节点 ${params.id}`));
            },
        },
        // === canvas_delete_nodes ===
        {
            name: "canvas_delete_nodes",
            description: "删除指定节点及相关连线。ids 至少 1 个，先用 canvas_get_state 拿到节点 id。节点存在 failed/timed_out 远端任务时整批拒绝删除：远端可能仍在执行或结果待交付，删除会丢失「重新获取结果」的恢复入口；请保留节点并引导用户手动恢复或删除。",
            label: "删除节点",
            promptSnippet: "删除指定节点及相关连线；ids 至少 1 个。",
            parameters: Type.Object({ ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) }),
            execute: async (_toolCallId, raw) => {
                const params = raw as { ids: string[] };
                const receipts = await ctx.emitOps([{ type: "delete_node", ids: params.ids }]);
                return ok(opsOutcomeText(receipts, `已删除 ${params.ids.length} 个节点`));
            },
        },
        // === canvas_connect_nodes ===
        {
            name: "canvas_connect_nodes",
            description: "批量连接节点。每对 {fromNodeId, toNodeId} 形成一条有向边；同向重复会被忽略。",
            label: "连接节点",
            promptSnippet: "批量连接节点（有向边），同向重复会被忽略。",
            parameters: Type.Object({
                connections: Type.Array(Type.Object({
                    fromNodeId: Type.String(),
                    toNodeId: Type.String(),
                }), { minItems: 1 }),
            }),
            execute: async (_toolCallId, raw) => {
                const params = raw as {
                    connections: Array<{ fromNodeId: string; toNodeId: string }>;
                };
                const ops: CanvasAgentOp[] = params.connections.map((c) => ({
                    type: "connect_nodes",
                    fromNodeId: c.fromNodeId,
                    toNodeId: c.toNodeId,
                }));
                const receipts = await ctx.emitOps(ops);
                return ok(opsOutcomeText(receipts, `已连接 ${ops.length} 对节点`));
            },
        },
        // === canvas_create_node ===
        {
            name: "canvas_create_node",
            description: "创建普通节点（text/image/video/audio 或 plugin 节点）。x/y 给绝对坐标，否则自动布局。Agent 不创建 Config 节点；带 prompt 的生成使用 canvas_generate_node 或 canvas_generate_text。",
            label: "创建节点",
            promptSnippet: "创建普通节点（text/image/video/audio 或 plugin 节点）；Config 仅供用户手动创建。",
            parameters: Type.Object({
                nodeType: Type.Union([
                    Type.Literal("text"), Type.Literal("image"), Type.Literal("video"),
                    Type.Literal("audio"),
                    Type.String({ pattern: "^(?!config$)[a-z][a-z0-9-]*$" }),
                ]),
                title: Type.Optional(Type.String()),
                x: Type.Optional(Type.Number()),
                y: Type.Optional(Type.Number()),
                width: Type.Optional(Type.Number()),
                height: Type.Optional(Type.Number()),
                metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
            }),
            execute: async (_toolCallId, raw) => {
                const params = raw as {
                    nodeType: string;
                    title?: string;
                    x?: number;
                    y?: number;
                    width?: number;
                    height?: number;
                    metadata?: Record<string, unknown>;
                };
                if (params.nodeType === CanvasNodeType.Config) return ok("Agent 不支持创建 Config 节点；请使用对应的语义生成工具");
                const position = (typeof params.x === "number" || typeof params.y === "number")
                    ? { x: params.x ?? 0, y: params.y ?? 0 }
                    : undefined;
                const op: CanvasAgentOp = {
                    type: "add_node",
                    nodeType: params.nodeType as CanvasNodeTypeId,
                    ...(params.title ? { title: params.title } : {}),
                    ...(position ? { position } : {}),
                    ...(typeof params.width === "number" ? { width: params.width } : {}),
                    ...(typeof params.height === "number" ? { height: params.height } : {}),
                    ...(params.metadata ? { metadata: params.metadata } : {}),
                };
                const receipts = await ctx.emitOps([op]);
                return ok(opsOutcomeText(receipts, `已创建 ${params.nodeType} 节点`));
            },
        },
        // === canvas_create_text_nodes ===
        {
            name: "canvas_create_text_nodes",
            description: "批量创建文本节点（content 为正文，title 为标题）。适合标题/段落/脚本/说明等。direction=row/column 控制排列方向。",
            label: "批量创建文本节点",
            promptSnippet: "批量创建文本节点（content 为正文，title 为标题），可指定排列方向。",
            parameters: Type.Object({
                items: Type.Array(Type.Object({
                    text: Type.String(),
                    title: Type.Optional(Type.String()),
                    width: Type.Optional(Type.Number()),
                    height: Type.Optional(Type.Number()),
                }), { minItems: 1 }),
                gap: Type.Optional(Type.Number({ default: 24 })),
                direction: Type.Optional(Type.Union([Type.Literal("row"), Type.Literal("column")])),
            }),
            execute: async (_toolCallId, raw) => {
                const params = raw as {
                    items: Array<{ text: string; title?: string; width?: number; height?: number }>;
                    gap?: number; direction?: "row" | "column";
                };
                const ops: CanvasAgentOp[] = [{
                    type: "add_text_nodes",
                    items: params.items.map((item) => ({
                        text: item.text,
                        ...(item.title ? { title: item.title } : {}),
                        ...(typeof item.width === "number" ? { width: item.width } : {}),
                        ...(typeof item.height === "number" ? { height: item.height } : {}),
                    })),
                    ...(params.direction ? { direction: params.direction } : {}),
                    ...(typeof params.gap === "number" ? { gap: params.gap } : {}),
                }];
                const receipts = await ctx.emitOps(ops);
                return ok(opsOutcomeText(receipts, `已批量创建 ${params.items.length} 个文本节点`));
            },
        },
        // === canvas_create_attachment_nodes ===
        {
            name: "canvas_create_attachment_nodes",
            description: "把会话中已注册的附件（用 local_file_read 看到的 handle）一次性导入白板为图片节点。每个 handle 必须是 image 类型；返回的节点 ID 可传给 canvas_generate_node.referenceNodeIds 作为生成参考。",
            label: "从附件创建图片节点",
            promptSnippet: "把会话中已注册的附件 (handle) 一次性导入白板为图片节点。",
            parameters: Type.Object({
                handles: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
                x: Type.Optional(Type.Number()),
                y: Type.Optional(Type.Number()),
                gap: Type.Optional(Type.Number({ default: 32 })),
                direction: Type.Optional(Type.Union([Type.Literal("row"), Type.Literal("column")])),
            }),
            execute: async (_toolCallId, raw) => {
                if (!ctx.readAttachment || !ctx.emitAttachmentImport) {
                    return ok("当前运行环境不支持导入附件");
                }
                const params = raw as { handles: string[] };
                const imported: string[] = [];
                for (const handle of params.handles) {
                    const result = await ctx.readAttachment(handle);
                    if (!result.ok) continue;
                    if (result.file.kind !== "image") continue;
                    const created = await ctx.emitAttachmentImport(result.file);
                    if (created) imported.push(created.id);
                }
                return ok(`已导入 ${imported.length} 张附件到白板`);
            },
        },
        // === canvas_generate_text ===
        {
            name: "canvas_generate_text",
            description: "创建文本节点。prompt 可选：传入时创建文本生成节点并立即触发（仅在用户明确许可生成时才传 prompt），prompt 为生成内容（标题、文案、脚本等），textCount=1 生成单条、>1 生成多文本备选；省略时仅创建空文本节点、不触发生成，适合只想在画布放置文本呈现内容的场景（内容稍后用 canvas_update_node_text 写入）。",
            label: "生成文本",
            promptSnippet: "创建文本节点：用户明确许可时带 prompt 触发生成（textCount>1 多备选）；省略 prompt 仅放置空文本节点。",
            parameters: Type.Object({
                prompt: Type.Optional(Type.String()),
                title: Type.Optional(Type.String()),
                x: Type.Optional(Type.Number()),
                y: Type.Optional(Type.Number()),
                referenceNodeIds: Type.Optional(Type.Array(Type.String())),
                model: Type.Optional(Type.String()),
                reasoningEffort: Type.Optional(Type.String()),
                textCount: Type.Optional(Type.Number({ minimum: 1, maximum: 10, default: 1 })),
            }),
            execute: async (_toolCallId, raw) => {
                const params = raw as {
                    prompt?: string; title?: string; x?: number; y?: number;
                    referenceNodeIds?: string[]; model?: string; reasoningEffort?: CanvasNodeMetadata["reasoningEffort"]; textCount?: number;
                };
                const textNodeId = `text-${nanoid()}`;
                const prompt = params.prompt?.trim();
                if (!prompt) {
                    const receipts = await ctx.emitOps([{
                        type: "add_node",
                        id: textNodeId,
                        nodeType: CanvasNodeType.Text,
                        title: params.title,
                        ...(typeof params.x === "number" || typeof params.y === "number" ? { position: { x: params.x ?? 0, y: params.y ?? 0 } } : {}),
                    }]);
                    return ok(opsOutcomeText(receipts, `已创建空文本节点 ${textNodeId}（未触发生成）；需要内容时用 canvas_update_node_text 写入。`));
                }
                const referenceNodeIds = params.referenceNodeIds || [];
                const textMetadata: CanvasNodeMetadata = {
                    prompt,
                    generationMode: "text",
                    ...(params.model ? { model: params.model } : {}),
                    ...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
                    ...(typeof params.textCount === "number" ? { textCount: params.textCount } : {}),
                };
                const ops: CanvasAgentOp[] = [
                    { type: "add_node", id: textNodeId, nodeType: CanvasNodeType.Text, ...(typeof params.x === "number" || typeof params.y === "number" ? { position: { x: params.x ?? 0, y: params.y ?? 0 } } : referenceNodeIds.length ? { anchorNodeIds: referenceNodeIds } : {}), metadata: textMetadata },
                    ...referenceNodeIds.map((refId) => ({ type: "connect_nodes" as const, fromNodeId: refId, toNodeId: textNodeId })),
                    { type: "run_generation", nodeId: textNodeId, mode: "text", prompt },
                ];
                const receipts = await ctx.emitOps(ops);
                return ok(opsOutcomeText(receipts, `已创建文本生成节点 ${textNodeId} 并触发；通过 generation_get_status 查询该节点，避免无等待地连续查询。`));
            },
        },
        // === canvas_run_generation ===
        {
            name: "canvas_run_generation",
            description: `触发指定生成结果节点重跑（不创建新节点）。可传 mode 覆盖节点的 generationMode；可传 prompt 覆盖节点的 prompt。节点已有进行中任务（submitting/pending/waiting_network/waiting_configuration）时会被拒绝回执；确要放弃当前任务重跑传 force=true（打断旧任务并产生新的付费提交）；submission_unknown（提交结果未知）无论是否传 force 都会被拒绝。节点上一个任务为 failed/timed_out 时同样拒绝且 force 不放行：timed_out 只是本地停止跟踪，远端可能仍在执行或结果待交付，不要重跑、不要删除节点、也不要新建节点重跑同一内容，引导用户在节点上「重新获取结果」恢复原任务。Config 节点仅供用户手动操作，Agent 不得触发。脚本分镜使用 canvas_script_generate_storyboards。${GENERATION_WAIT_HINT}`,
            label: "触发节点生成",
            promptSnippet: "触发指定节点重跑生成，不创建新节点；进行中任务会被拒绝，force=true 显式打断重跑。",
            parameters: Type.Object({
                nodeId: Type.String(),
                mode: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("image"), Type.Literal("video"), Type.Literal("audio")])),
                prompt: Type.Optional(Type.String()),
                force: Type.Optional(Type.Boolean({ description: "true = 打断该节点进行中的生成任务并重跑（产生新的付费提交）；默认 false；submission_unknown 状态即使 force=true 也会被拒绝" })),
            }),
            execute: async (_toolCallId, raw) => {
                const params = raw as { nodeId: string; mode?: "text" | "image" | "video" | "audio"; prompt?: string; force?: boolean };
                const target = ctx.getSnapshot().nodes.find((node) => node.id === params.nodeId);
                if (!target) return ok(`节点不存在：${params.nodeId}`);
                if (target.type === CanvasNodeType.Config) return ok("Agent 不支持触发 Config 节点；请由用户在画布中手动运行");
                if (target.type === "3d") return ok("Agent 不能直接触发 3D 节点生成；请使用 canvas_generate_node，并通过 reference3dSelections 为每个节点传入一项 { nodeId, view }，多视角使用 view: \"all\"");
                const receipts = await ctx.emitOps([{ type: "run_generation", nodeId: params.nodeId, mode: params.mode, prompt: params.prompt, ...(params.force ? { force: true } : {}) }]);
                const refused = receipts?.find((receipt) => receipt.status === "skipped");
                if (refused) return ok(refused.reason ?? "操作未生效");
                const applied = receipts?.find((receipt) => receipt.status === "applied");
                const taskNote = applied?.taskId ? `（任务 ${applied.taskId}，状态 ${applied.taskStatus}）` : "";
                return ok(`${opsOutcomeText(receipts, `已触发节点 ${params.nodeId} 的生成`)}${taskNote}。${GENERATION_WAIT_HINT}`);
            },
        },
        // === canvas_list_projects ===
        {
            name: "canvas_list_projects",
            description: "列出用户的全部画布（仅返回标题、创建/更新时间、节点数、连线数，不含完整数据）。支持 keyword 模糊搜索和 page/pageSize 分页。需要切换画布时用返回的 projectId/canvasId 让用户确认切换。",
            label: "列出画布项目",
            promptSnippet: "列出用户的全部画布项目（标题/节点数/连线数），支持 keyword 搜索和分页。",
            parameters: Type.Object({
                keyword: Type.Optional(Type.String({ description: "按标题模糊匹配" })),
                page: Type.Optional(Type.Number({ default: 1, minimum: 1 })),
                pageSize: Type.Optional(Type.Number({ default: 20, maximum: 100 })),
            }),
            execute: async (_toolCallId, raw) => {
                if (!ctx.listProjects) return ok("当前运行环境不支持项目列表");
                const params = raw as { keyword?: string; page?: number; pageSize?: number };
                const result = await ctx.listProjects({
                    keyword: params.keyword,
                    page: params.page || 1,
                    pageSize: params.pageSize || 20,
                });
                return result.ok
                    ? ok(JSON.stringify({ projects: result.projects, total: result.total, page: params.page || 1 }))
                    : ok(`列出项目失败：${result.error}`);
            },
        },
        // === generation_get_status ===
        {
            name: "generation_get_status",
            description: `查询当前画布生成任务的本地缓存状态（仅当前画布；按 nodeIds 过滤，不传返回最近 limit 条；同一节点多条记录时只返回最新一条；不会加速生成）。status 取值：submitting=提交中；pending=已提交等待远端（phase=queued/running，附 progress）；waiting_network=等待网络恢复；waiting_configuration=等待配置；succeeded=成功；failed=远端失败（error 字段有原因；重跑会被拒绝）；timed_out=本地等待超时（超过 deadlineAt 即停止跟踪，远端可能仍在执行或结果待交付；重跑与删除节点都会被拒绝，引导用户在节点上「重新获取结果」恢复原任务）；interrupted=被中断；submission_unknown=提交结果未知（系统凭幂等键自动重试至 deadlineAt，禁止重跑、只能继续查询）。source="node_status" 的文本生成任务只有 running/succeeded/failed。terminal=true 为终态，停止轮询；submittedAt/deadlineAt 为 ISO 时间，可计算已等待时长。查无记录的 id 显式返回 not_found。failed 回执的 error 字段即失败原因（如 upstream_failed=上游生成失败、delivery_failed=交付失败）；交付/下载类失败（downloading 阶段超时、delivery_blocked）用「重试结果」恢复原任务即可，不要换模型重跑；failed/timed_out 状态下 canvas_run_generation 会被直接拒绝。持续等待请用 wait 的 nodeIds 模式（宿主自动轮询到终态/早退），本工具用于即时检查。${GENERATION_POLLING_RULES}`,
            label: "查询生成任务状态",
            promptSnippet: '按 nodeIds 批量即时查询当前画布生成状态；持续等待用 wait 的 nodeIds 模式。terminal=true 停止查询，submission_unknown 禁止重跑。',
            parameters: Type.Object({
                nodeIds: Type.Optional(Type.Array(Type.String())),
                limit: Type.Optional(Type.Number({ default: 20, maximum: 100 })),
            }),
            execute: async (_toolCallId, raw) => {
                if (!ctx.getGenerationStatus) return ok("当前运行环境不支持任务状态查询");
                const params = raw as { nodeIds?: string[]; limit?: number };
                const result = await ctx.getGenerationStatus({ nodeIds: params.nodeIds, limit: params.limit || 20 });
                if (!result.ok) return ok(`查询任务状态失败：${result.error}`);
                const report = buildGenerationStatusReport({
                    tasks: result.tasks,
                    snapshot: ctx.getSnapshot(),
                    nodeIds: params.nodeIds,
                    limit: Math.min(100, Math.max(1, params.limit || 20)),
                });
                return ok(JSON.stringify({ tasks: report.entries }));
            },
        },
        // === models_list ===
        {
            name: "models_list",
            description: '列出当前凭据模式实际可执行的生成模型（text/image/video/audio）：BYOK 返回 channelId::modelName，ShotShot 托管模式返回套餐目录 id。生成工具的 model 参数必须逐字传递本工具返回的 id，不要自造模型字符串。图片模型的 inputMode 表示 text（文生图）、image（必须有参考图）、text-and-image（参考图可选）或 unknown；requiresReference=true 时必须传 referenceNodeIds。isDefault=true 表示该能力当前默认模型。AutoDL 工作流的 vquality 需使用其合法枚举（如「768p横」）。',
            label: "列出可用模型",
            promptSnippet: "需要指定 model 时先调用；model 参数逐字传递返回的 id。",
            parameters: Type.Object({
                capability: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("image"), Type.Literal("video"), Type.Literal("audio")])),
                keyword: Type.Optional(Type.String()),
            }),
            execute: async (_toolCallId, raw) => {
                if (!ctx.listModels) return ok("当前运行环境不支持模型列表");
                const params = raw as { capability?: AgentModelSummary["capability"]; keyword?: string };
                const result = await ctx.listModels();
                if (!result.ok) return ok("当前运行环境不支持模型列表");
                const keyword = params.keyword?.trim().toLowerCase() ?? "";
                const models = result.models.filter((model) => {
                    if (params.capability && model.capability !== params.capability) return false;
                    if (!keyword) return true;
                    return `${model.name} ${model.channelName}`.toLowerCase().includes(keyword);
                });
                return ok(JSON.stringify({ models, total: models.length }));
            },
        },
        // === assets_list ===
        {
            name: "assets_list",
            description: "列出用户「我的素材」，支持 kind（text/image/video）过滤、keyword 搜索和 page/pageSize 分页。仅返回元信息（不返回图片/视频原始数据）。",
            label: "列出素材",
            promptSnippet: "列出「我的素材」（本地素材库）中的资产（支持 kind/keyword/分页）。",
            parameters: Type.Object({
                kind: Type.Optional(Type.Union([
                    Type.Literal("all"),
                    Type.Literal("text"),
                    Type.Literal("image"),
                    Type.Literal("video"),
                ])),
                keyword: Type.Optional(Type.String()),
                page: Type.Optional(Type.Number({ default: 1, minimum: 1 })),
                pageSize: Type.Optional(Type.Number({ default: 20, maximum: 100 })),
            }),
            execute: async (_toolCallId, raw) => {
                if (!ctx.listAssets) return ok("当前运行环境不支持素材列表");
                const params = raw as { kind?: "all" | "text" | "image" | "video"; keyword?: string; page?: number; pageSize?: number };
                const result = await ctx.listAssets({
                    kind: params.kind || "all",
                    keyword: params.keyword,
                    page: params.page || 1,
                    pageSize: params.pageSize || 20,
                });
                return result.ok
                    ? ok(JSON.stringify({ assets: result.assets, total: result.total, page: params.page || 1 }))
                    : ok(`列出素材失败：${result.error}`);
            },
        },
        // === assets_add ===
        {
            name: "assets_add",
            description: "向「我的素材」新增素材（桌面端持久化到本地素材库目录）。kind=text 时用 content 传文本内容；kind=image 时用 imageUrl 传本地文件绝对路径、http(s) 地址或 dataURL；kind=video 时用 videoUrl，规则相同。可附带 title、tags、source、note。",
            label: "添加素材",
            promptSnippet: "向「我的素材」新增 text/image/video 素材。",
            parameters: Type.Object({
                kind: Type.Union([
                    Type.Literal("text"),
                    Type.Literal("image"),
                    Type.Literal("video"),
                ]),
                title: Type.String(),
                content: Type.Optional(Type.String({ description: "kind=text 时必填" })),
                imageUrl: Type.Optional(Type.String({ description: "kind=image 时必填" })),
                videoUrl: Type.Optional(Type.String({ description: "kind=video 时必填" })),
                tags: Type.Optional(Type.Array(Type.String())),
                source: Type.Optional(Type.String()),
                note: Type.Optional(Type.String()),
            }),
            execute: async (_toolCallId, raw) => {
                if (!ctx.addAsset) return ok("当前运行环境不支持添加素材");
                const params = raw as {
                    kind: "text" | "image" | "video"; title: string; content?: string;
                    imageUrl?: string; videoUrl?: string; tags?: string[]; source?: string; note?: string;
                };
                const result = await ctx.addAsset(params);
                return result.ok ? ok(`已添加素材 ${params.title}（id: ${result.assetId}）`) : ok(`添加素材失败：${result.error}`);
            },
        },
    ];
}
