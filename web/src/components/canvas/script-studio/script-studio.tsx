import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Popover } from "antd";
import { Settings, X } from "lucide-react";

import { useScriptEntityStore } from "@/stores/use-script-entity-store";
import { createEmptyScriptData, type ScriptNodeData, type ShotAudioRef, type ShotAudioSlot } from "@/types/script-node";
import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";
import type { ScriptEntityGroupLike } from "@/lib/canvas/script-node-model";
import type { AssetMentionCandidate } from "@/lib/canvas/asset-mentions";
import { createOrAttachAsset, makeEntityAttach } from "./asset-create";
import { ShotsStep } from "./shots-step";
import { AssetsStep } from "./assets-step";
import { ComposeStep, type StoryboardImageState } from "./compose-step";
import { ComposeActionsBar } from "./compose-actions-bar";
import { isVideoNodeGenerating } from "./shot-playback";
import type { ShotVideoSettings } from "./generate-video-dialog";
import type { EntityDraft } from "./entity-drawer";
import type { RichEntityMeta } from "./rich-description-cell";
import { StoryboardImagePicker, type StoryboardImageSource } from "./storyboard-image-picker";
import "./script-studio.css";

type Props = {
    node: CanvasNodeData;
    projectId: string;
    /** 画布上的图片节点（“从画布选择”来源） */
    canvasImageNodes: CanvasNodeData[];
    /** 画布上的音频节点（镜头音频“从画布选择”来源） */
    audioNodes: Array<{ id: string; title: string; storageKey?: string; assetRef?: CanvasAssetRef }>;
    /** 单元格内上传本地音频：只落存储并返回快照，不立即建节点（project.tsx 注入，物化在完成编辑时）；
     *  origin（shotId + 槽位）用于上传写入的项目资产来源溯源。 */
    onImportAudio: (file: File, origin: { shotId: string; slot: ShotAudioSlot }) => Promise<ShotAudioRef>;
    onClose: () => void;
    /** 经 project.tsx 的 setNodes 更新 metadata.script（持久化由页面 effect 自动同步） */
    onUpdateScript: (nodeId: string, updater: (data: ScriptNodeData) => ScriptNodeData) => void;
    /** 资产参考图生成：经画布图片生成节点（project.tsx 注入） */
    onGenerateRef: (scriptNodeId: string, draft: EntityDraft, entityId: string, refId: string) => void;
    /** 库来源实体参考挑选物化（project.tsx 注入，spec D1）：复用优先，否则复制为派生节点 */
    onPickEntityRefLibrary: (scriptNodeId: string, draft: EntityDraft, entityId: string, refId: string, assetId: string, storageKey?: string, assetRef?: CanvasAssetRef) => void;
    /** 批量生成视频：为已确认镜头铺视频生成节点（project.tsx 注入） */
    onBatchGenerate: (scriptNodeId: string) => void;
    /** 关闭 Studio 并打开 Agent 面板（project.tsx 注入，spec D7「让 Agent 补写」） */
    onComposeWithAgent?: () => void;
    /** 画布视频节点（镜头视频版本预览，spec v2 D2） */
    canvasVideoNodes?: CanvasNodeData[];
    /** 单镜生成/重新生成视频（project.tsx 注入，spec D10） */
    onGenerateShotVideo?: (scriptNodeId: string, shotId: string, settings?: ShotVideoSettings) => void;
    /** 切换镜头当前视频版本（project.tsx 注入） */
    onSwitchShotVideo?: (scriptNodeId: string, shotId: string, nodeId: string) => void;
    /** 分镜图先行模式（project.tsx 从 script.template 派生下发，spec D1/D9） */
    storyboardFirst: boolean;
    /** shotId → 分镜图状态 + 就绪缩略图（project.tsx 从画布节点双形态派生，thumbUrl = 已水合的 metadata.content） */
    storyboardImageState: Record<string, { state: StoryboardImageState; thumbUrl?: string }>;
    /** 生成/重新生成单镜分镜图（project.tsx 注入，spec §6） */
    onGenerateStoryboard: (shotId: string) => void;
    onSelectStoryboard: (shotId: string, source: StoryboardImageSource) => Promise<void>;
    /** 批量为未生成分镜图的镜头铺图节点（project.tsx 注入，800ms 错峰） */
    onBatchGenerateStoryboards: () => void;
    /** 「我的素材」资产 @ 引用候选（project.tsx 注入，ComposeStep 提示词 chip 用） */
    assetCandidates?: AssetMentionCandidate[];
    onToast: (message: string) => void;
};

/**
 * 脚本工作台：双击画布脚本节点进入的全屏三视图界面
 * （确认镜头 / 准备资产 / 合成提示词），顶栏 tab 切换并记住上次停留，关闭即离开。
 * 分镜内容本期为手动编辑；LLM 生成分镜由后续版本的 Agent 工具链接入，不在节点内直接调用模型。
 */
export function ScriptStudio({ node, projectId, canvasImageNodes, audioNodes, onImportAudio, onClose, onUpdateScript, onGenerateRef, onPickEntityRefLibrary, onBatchGenerate, onComposeWithAgent, canvasVideoNodes, onGenerateShotVideo, onSwitchShotVideo, storyboardFirst, storyboardImageState, onGenerateStoryboard, onSelectStoryboard, onBatchGenerateStoryboards, assetCandidates = [], onToast }: Props) {
    const { t } = useTranslation();
    const script = node.metadata?.script ?? createEmptyScriptData();
    // lastStep 恢复（spec D8）：空脚本恒落 1；切换视图写回 template 持久化
    const [step, setStepState] = useState<1 | 2 | 3>(script.output.shots.length ? (script.template?.lastStep ?? 1) : 1);
    const [imagePicker, setImagePicker] = useState<{ shotId: string; source: "canvas" | "library" } | null>(null);
    const entityIds = script.entityIds;
    const allEntities = useScriptEntityStore((state) => state.entities);
    const entitiesRaw = useMemo(() => allEntities.filter((e) => entityIds.includes(e.id)), [allEntities, entityIds]);

    const updateScript = (updater: (data: ScriptNodeData) => ScriptNodeData) => onUpdateScript(node.id, updater);

    const setStep = (next: 1 | 2 | 3) => {
        setStepState(next);
        updateScript((d) => ({ ...d, template: { ...d.template, lastStep: next } }));
    };

    const handleCreateAsset = (name: string, group: ScriptEntityGroupLike): RichEntityMeta => {
        const { meta, created } = createOrAttachAsset({ projectId, group, name, attach: makeEntityAttach(updateScript) });
        onToast(t(created ? "canvas.scriptStudio.assetCreatedToast" : "canvas.scriptStudio.assetAttachedToast", { name: meta.name }));
        return meta;
    };

    const entities: RichEntityMeta[] = useMemo(
        () =>
            entitiesRaw.map((e) => ({
                id: e.id,
                name: e.name,
                group: e.group,
                ready: e.refs.some((r) => r.state === "ready"),
            })),
        [entitiesRaw],
    );

    const shotCount = script.output.shots.length;
    // storyboardFirst 由 props 下发（project.tsx 从同一 script.template 派生，Task 6 起不再本地重复声明）
    const entityReady = entitiesRaw.filter((e) => e.refs.some((r) => r.state === "ready")).length;
    const composed = script.output.shots.filter((s) => s.composed).length;
    // 生成计数只统计本脚本的镜头视频节点（expandedShotNodes + shotVideoVersions 全部版本），
    // 画布上其他脚本的生成中节点不计入（避免动作条被无关生成卡在「生成中」态）
    const scriptVideoNodeIds = useMemo(() => {
        const ids = new Set(Object.values(script.output.expandedShotNodes ?? {}));
        for (const versions of Object.values(script.output.shotVideoVersions ?? {})) {
            for (const v of versions ?? []) ids.add(v.nodeId);
        }
        return ids;
    }, [script.output.expandedShotNodes, script.output.shotVideoVersions]);
    // macOS hiddenInset：交通灯占左上 72px，头部需避让并提供拖拽区（同 user-layout 约定）
    const isMacDesktop = typeof window !== "undefined" && window.shotshot?.platform === "darwin";

    const steps = [
        {
            name: t("canvas.scriptStudio.stepShots"),
            sub: t("canvas.scriptStudio.stepShotsSub", { count: shotCount }),
        },
        { name: t("canvas.scriptStudio.stepAssets"), sub: t("canvas.scriptStudio.stepAssetsSub", { ready: entityReady, total: entities.length }) },
        { name: t("canvas.scriptStudio.stepCompose"), sub: t("canvas.scriptStudio.stepComposeSub", { done: composed, count: shotCount }) },
    ];

    return (
        <div className="fixed inset-0 z-[80] flex flex-col bg-background text-foreground">
            {/* macOS hiddenInset：交通灯悬浮在左上，头部留出 72px 并提供窗口拖拽区（与 user-layout 同约定） */}
            {isMacDesktop ? <div className="native-titlebar-drag-region" aria-hidden="true" /> : null}
            <header className={`relative flex h-14 flex-none items-center border-b px-5 ${isMacDesktop ? "pl-[88px]" : ""}`}>
                {/* 顶栏内容与 main 共用 1800px 容器，超宽屏对齐体系一致；三段 grid：返回+名称 / 视图 tab / 设置+关闭 */}
                <div className="mx-auto grid h-full w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4" style={{ maxWidth: "min(100%, 1800px)" }}>
                    <div className="flex min-w-0 items-center gap-4">
                        <button type="button" className="native-titlebar-no-drag flex-none text-sm text-stone-500 transition-colors hover:text-foreground" onClick={onClose}>
                            ← {t("canvas.scriptStudio.backToCanvas")}
                        </button>
                        <div className="native-titlebar-no-drag min-w-0">
                            <div className="min-w-0 truncate text-sm font-semibold">{node.title}</div>
                        </div>
                    </div>
                    <div className="justify-self-center">
                        <nav className="native-titlebar-no-drag flex flex-none items-center overflow-hidden" aria-label={t("canvas.scriptStudio.navLabel")}>
                            {steps.map((s, i) => (
                                <button
                                    key={s.name}
                                    type="button"
                                    aria-current={step === i + 1 ? "step" : undefined}
                                    className={`flex flex-none items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors ${
                                        step === i + 1 ? "bg-secondary" : "hover:bg-secondary"
                                    }`}
                                    onClick={() => setStep((i + 1) as 1 | 2 | 3)}
                                >
                                    <span
                                        className={`flex size-6 flex-none items-center justify-center rounded-full border text-xs ${
                                            step === i + 1
                                                ? "border-foreground bg-foreground font-bold text-background"
                                                : "border-stone-300 text-stone-400 dark:border-stone-700"
                                        }`}
                                    >
                                        {i + 1}
                                    </span>
                                    <span className="text-left">
                                        <span className={`block whitespace-nowrap text-xs ${step === i + 1 ? "font-semibold text-foreground" : "text-stone-500 dark:text-stone-400"}`}>{s.name}</span>
                                        <span className="block whitespace-nowrap text-[10px] text-stone-400">{s.sub}</span>
                                    </span>
                                </button>
                            ))}
                        </nav>
                    </div>
                    <div className="native-titlebar-no-drag flex flex-none items-center justify-self-end gap-1">
                        {/* 脚本设置（spec D5）：「分镜图先行」收纳进 popover，读写直接落 template.storyboardFirst */}
                        <Popover
                            placement="bottomRight"
                            trigger="click"
                            content={
                                <div className="w-60">
                                    <label className="flex cursor-pointer items-center justify-between gap-3 text-xs text-foreground">
                                        <span>{t("canvas.scriptStudio.storyboardFirst")}</span>
                                        <input
                                            type="checkbox"
                                            className="peer sr-only"
                                            checked={storyboardFirst}
                                            onChange={(e) => {
                                                // 快照布尔值：updater 可能延迟执行，不能惰性读 DOM（受控回填后失真）
                                                const checked = e.target.checked;
                                                updateScript((d) => ({ ...d, template: { ...d.template, storyboardFirst: checked } }));
                                            }}
                                        />
                                        <span className="relative h-4 w-7 rounded-full bg-stone-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-3 after:w-3 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-emerald-500 peer-checked:after:translate-x-3 dark:bg-stone-600" />
                                    </label>
                                    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{t("canvas.scriptStudio.storyboardFirstHint")}</p>
                                </div>
                            }
                        >
                            <button type="button" className="flex size-7 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-secondary hover:text-foreground" aria-label={t("canvas.scriptStudio.settings")} onClick={(e) => e.currentTarget.blur()}>
                                <Settings className="size-4" aria-hidden />
                            </button>
                        </Popover>
                        <button type="button" className="flex size-7 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-secondary hover:text-foreground" aria-label={t("canvas.scriptStudio.backToCanvas")} onClick={onClose}>
                            <X className="size-4" aria-hidden />
                        </button>
                    </div>
                </div>
            </header>

            <main className="flex-1 overflow-y-auto px-6 py-4">
                {/* 超宽屏（≥2K）内容收拢居中，避免左右无界拉伸；用内联样式避免 Tailwind JIT 类缺失 */}
                <div
                    className="mx-auto flex w-full flex-col"
                    style={{ maxWidth: "min(100%, 1800px)" }}
                >
                    {step === 1 && (
                        <ShotsStep
                            script={script}
                            storyboardFirst={storyboardFirst}
                            entities={entities}
                            audioNodes={audioNodes}
                            storyboardImageState={storyboardImageState}
                            onImportAudio={onImportAudio}
                            onUpdateScript={updateScript}
                            onToast={onToast}
                            onGoAssets={() => setStep(2)}
                            onCreateAsset={handleCreateAsset}
                            onReorchestrate={onComposeWithAgent}
                        />
                    )}
                    {step === 2 && (
                        <AssetsStep
                            script={script}
                            projectId={projectId}
                            entities={entitiesRaw}
                            canvasImageNodes={canvasImageNodes}
                            onUpdateScript={updateScript}
                            onGenerateRef={(draft, entityId, refId) => onGenerateRef(node.id, draft, entityId, refId)}
                            onPickLibrary={(draft, entityId, refId, assetId, storageKey, assetRef) => onPickEntityRefLibrary(node.id, draft, entityId, refId, assetId, storageKey, assetRef)}
                            onToast={onToast}
                        />
                    )}
                    {step === 3 && (
                        <ComposeStep
                            nodeId={node.id}
                            script={script}
                            entities={entitiesRaw}
                            videoNodes={canvasVideoNodes}
                            assetCandidates={assetCandidates}
                            storyboardFirst={storyboardFirst}
                            storyboardImageState={storyboardImageState}
                            onGenerateStoryboard={onGenerateStoryboard}
                            onPickStoryboard={(shotId, source) => setImagePicker({ shotId, source })}
                            onBatchGenerateStoryboards={onBatchGenerateStoryboards}
                            onUpdateScript={updateScript}
                            onToast={onToast}
                            onGenerateShotVideo={(shotId, settings) => onGenerateShotVideo?.(node.id, shotId, settings)}
                            onSwitchShotVideo={(shotId, videoNodeId) => onSwitchShotVideo?.(node.id, shotId, videoNodeId)}
                        />
                    )}
                    {step === 3 && script.output.shots.length > 0 ? (
                        <ComposeActionsBar
                            composed={composed}
                            total={shotCount}
                            generatingCount={(canvasVideoNodes ?? []).filter((n) => scriptVideoNodeIds.has(n.id) && isVideoNodeGenerating(n)).length}
                            hasAnyVersion={Object.keys(script.output.shotVideoVersions ?? {}).length > 0}
                            onBatchGenerate={() => onBatchGenerate(node.id)}
                            onComposeWithAgent={onComposeWithAgent}
                        />
                    ) : null}
                </div>
            </main>
            {imagePicker && <StoryboardImagePicker source={imagePicker.source} canvasImageNodes={canvasImageNodes}
                onClose={() => setImagePicker(null)}
                onSelect={(source) => onSelectStoryboard(imagePicker.shotId, source)} /> }
        </div>
    );
}
