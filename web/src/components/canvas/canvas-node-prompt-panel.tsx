import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { useMemo } from "react";
import { FalGenerationMedia } from "./fal-generation-settings";
import { buildNodeGenerationInputs, buildSourceImageReferences } from "./canvas-node-generation";
import type { CanvasConnection } from "@/types/canvas";
import { configuredFalProfile, falModelSelectionPatch } from "@/lib/canvas/fal-settings";
import { useEffect, useState } from "react";
import { ArrowUp, Maximize2, Square } from "lucide-react";
import { Button, Modal, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { videoModelSelectionPatch } from "@/components/video-settings-panel";
import { getConfiguredAutodlWorkflow } from "@/lib/canvas/autodl-generation-input";
import { CapabilityModelPicker } from "@/components/managed-model-picker";
import { modelOptionName } from "@/stores/use-config-store";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { audioConfigPatch, audioOverrideKeys, buildNodeConfig, clearMetadataPatch, hasMetadataOverride, imageOverrideKeys, textOverrideKeys, videoConfigPatch, videoOverrideKeys } from "@/lib/canvas/node-config";
import { canvasThemes } from "@/lib/canvas-theme";
import { MODAL_WIDTH } from "@/lib/design/modal";
import { Z_LAYERS } from "@/lib/design/z-layers";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover } from "./canvas-audio-settings-popover";
import { CanvasPromptChipInput } from "./canvas-prompt-chip-input";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { AssetMentionCandidate } from "@/lib/canvas/asset-mentions";
import { CanvasNodeReferenceBar } from "./canvas-node-reference-bar";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

// Bottom-row controls use the Agent composer's quiet look: no border or fill,
// a square-corner tint appears on hover only. Exported for the config node
// panel so model/settings controls look identical across nodes.
export const ghostModelPickerClass = "h-9 min-w-0 max-w-[190px] rounded-lg border-0 bg-transparent px-2 shadow-none hover:bg-black/5 focus-visible:ring-0 data-[state=open]:ring-0 dark:bg-transparent dark:hover:bg-white/10";
export const ghostSettingsButtonClass = "!h-9 !max-w-[190px] !justify-start !rounded-lg !px-2";

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onStop: (nodeId: string) => void;
    mentionReferences?: CanvasResourceReference[];
    assetCandidates?: AssetMentionCandidate[];
    nodes: CanvasNodeData[];
    connectedNodes?: CanvasNodeData[];
    connections?: CanvasConnection[];
    onDisconnectReference?: (fromNodeId: string, toNodeId: string) => void;
    onStartReferenceSelection?: (nodeId: string) => void;
    onImageSettingsOpenChange?: (open: boolean) => void;
    modeOverride?: CanvasNodeGenerationMode; // Plugin nodes set their generation type through useBuiltinPanel.mode.
};

export function CanvasNodePromptPanel({ node, nodes, isRunning, onPromptChange, onConfigChange, onGenerate, onStop, mentionReferences = [], assetCandidates = [], connectedNodes = [], connections = [], onDisconnectReference, onStartReferenceSelection, onImageSettingsOpenChange, modeOverride }: CanvasNodePromptPanelProps) {
    const { t } = useTranslation();
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = modeOverride ?? defaultMode(node.type);
    const config = buildNodeConfig(globalConfig, node, mode);
    const workflow = mode === "video" ? getConfiguredAutodlWorkflow(config) : undefined;
    const promptUnused = Boolean(workflow && !workflow.prompt);
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    const isEditingExistingContent = hasTextContent || hasImageContent;
    const [prompt, setPrompt] = useState(node.metadata?.composerContent ?? node.metadata?.prompt ?? "");
    const [expanded, setExpanded] = useState(false);
    const falProfile = configuredFalProfile(config);
    const falInputs = useMemo(() => falProfile ? buildNodeGenerationInputs(node.id, nodes, connections, { strictReferences: true }) : [], [falProfile, node.id, nodes, connections]);
    const sourceImages = useMemo(() => falProfile && mode === "image" && (node.type === CanvasNodeType.Image || getNodeDefinition(node.type)?.referenceKind === "image") ? buildSourceImageReferences(node) : [], [falProfile, mode, node]);

    // Restore prompts only when switching nodes; preserve the current input after generation on the same node.
    useEffect(() => {
        setPrompt(node.metadata?.composerContent ?? node.metadata?.prompt ?? "");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [node.id]);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        if (isEditingExistingContent) onConfigChange(node.id, { composerContent: value });
        else onPromptChange(node.id, value);
    };

    const submit = () => {
        const text = prompt.trim();
        if ((!text && !promptUnused) || isRunning) return;
        onGenerate(node.id, mode, text);
    };

    const canSubmit = promptUnused || Boolean(prompt.trim());

    const openExpandedEditor = () => {
        setExpanded(true);
    };

    return (
        <div
            data-canvas-no-zoom
            className="relative rounded-2xl border p-3 shadow-[0_24px_60px_rgba(0,0,0,.35)] backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <Tooltip title={t("canvas.promptPanel.expandEditor")}>
                <Button type="text" className="!absolute !right-2 !top-2 !z-10 !h-8 !w-8 !min-w-8 shrink-0 !rounded-full !bg-transparent !p-0" style={{ color: theme.node.text }} icon={<Maximize2 className="size-3.5" />} onClick={openExpandedEditor} aria-label={t("canvas.promptPanel.expandEditor")} />
            </Tooltip>
            <CanvasNodeReferenceBar nodeId={node.id} nodes={nodes} connectedNodes={connectedNodes} onDisconnect={onDisconnectReference} onStartSelection={onStartReferenceSelection} />
            {promptUnused ? <p className="mb-2 text-xs" style={{ color: theme.node.muted }}>{t("autodlGeneration.promptUnused")}</p> : null}
            <CanvasPromptChipInput
                value={prompt}
                references={mentionReferences}
                assetCandidates={assetCandidates}
                onChange={updatePrompt}
                onSubmit={submit}
                className="thin-scrollbar h-40 w-full cursor-text resize-none rounded-xl pl-3 pr-11 py-2 text-sm leading-5 outline-none"
                style={{ background: "transparent", color: theme.node.text }}
                placeholder={t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode === "text" && hasTextContent ? "editText" : mode}`)}
            />

            {falProfile ? <FalGenerationMedia profile={falProfile} config={config} options={node.metadata?.providerOptions} inputs={falInputs} prompt={prompt} composerMode={Boolean(node.metadata?.composerContent?.trim())} sourceImages={sourceImages} /> : null}
            <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    {mode === "image" ? (
                        <>
                            <CapabilityModelPicker config={config} value={config.model} nodeModel={node.metadata?.model} onChange={(model) => onConfigChange(node.id, falModelSelectionPatch(config, model, node.metadata) || { model })} capability="image" onMissingConfig={() => openConfigDialog(true)} className={ghostModelPickerClass} currentLabel={config.model ? modelOptionName(config.model) : undefined} />
                            <CanvasImageSettingsPopover
                                config={config}
                                providerOptions={node.metadata?.providerOptions}
                                onMetadataChange={patch => onConfigChange(node.id, patch)}
                                placement="topLeft"
                                buttonClassName={ghostSettingsButtonClass}
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                                onMissingConfig={() => openConfigDialog(true)}
                                onOpenChange={onImageSettingsOpenChange}
                                isOverridden={hasMetadataOverride(node.metadata, imageOverrideKeys)}
                                onResetOverrides={() => onConfigChange(node.id, clearMetadataPatch(imageOverrideKeys))}
                            />
                        </>
                    ) : mode === "video" ? (
                        <>
                            <CapabilityModelPicker config={config} value={config.model} nodeModel={node.metadata?.model} onChange={(model) => onConfigChange(node.id, (falModelSelectionPatch(config, model, node.metadata) || videoModelSelectionPatch(config, model)))} capability="video" onMissingConfig={() => openConfigDialog(true)} className={ghostModelPickerClass} currentLabel={config.model ? modelOptionName(config.model) : undefined} />
                            <CanvasVideoSettingsPopover config={config} providerOptions={node.metadata?.providerOptions} onMetadataChange={patch => onConfigChange(node.id, patch)} buttonClassName={ghostSettingsButtonClass} onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))} isOverridden={hasMetadataOverride(node.metadata, videoOverrideKeys)} onResetOverrides={() => onConfigChange(node.id, clearMetadataPatch(videoOverrideKeys))} />
                        </>
                    ) : mode === "audio" ? (
                        <>
                            <CapabilityModelPicker config={config} value={config.model} nodeModel={node.metadata?.model} onChange={(model) => onConfigChange(node.id, { model })} capability="audio" onMissingConfig={() => openConfigDialog(true)} className={ghostModelPickerClass} currentLabel={config.model ? modelOptionName(config.model) : undefined} />
                            <CanvasAudioSettingsPopover config={config} buttonClassName={ghostSettingsButtonClass} onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} isOverridden={hasMetadataOverride(node.metadata, audioOverrideKeys)} onResetOverrides={() => onConfigChange(node.id, clearMetadataPatch(audioOverrideKeys))} />
                        </>
                    ) : (
                        <>
                            <CapabilityModelPicker config={config} value={config.model} nodeModel={node.metadata?.model} onChange={(model) => onConfigChange(node.id, { model })} capability="text" onMissingConfig={() => openConfigDialog(true)} className={ghostModelPickerClass} currentLabel={config.model ? modelOptionName(config.model) : undefined} />
                            <CanvasTextSettingsPopover config={config} count={node.metadata?.textCount || 1} buttonClassName={ghostSettingsButtonClass} onConfigChange={(_, value) => onConfigChange(node.id, { reasoningEffort: value })} onCountChange={(textCount) => onConfigChange(node.id, { textCount })} isOverridden={hasMetadataOverride(node.metadata, textOverrideKeys)} onResetOverrides={() => onConfigChange(node.id, clearMetadataPatch(textOverrideKeys))} />
                        </>
                    )}
                </div>
                {isRunning ? (
                    <Tooltip title={t("canvas.promptPanel.stop")} placement="top">
                        <button type="button" className="grid size-9 shrink-0 place-items-center rounded-full transition hover:opacity-90" style={{ background: theme.node.text, color: theme.node.panel }} onClick={() => onStop(node.id)} aria-label={t("canvas.promptPanel.stopGeneration")}>
                            <Square className="size-3.5 fill-current" strokeWidth={0} />
                        </button>
                    </Tooltip>
                ) : (
                    <Tooltip title={t("canvas.promptPanel.generate")} placement="top">
                        <button type="button" className="grid size-9 shrink-0 place-items-center rounded-full transition disabled:cursor-not-allowed" style={{ background: canSubmit ? theme.node.text : theme.toolbar.itemHover, color: canSubmit ? theme.node.panel : theme.node.muted }} disabled={!canSubmit} onClick={submit} aria-label={t("canvas.promptPanel.generate")}>
                            <ArrowUp className="size-4" />
                        </button>
                    </Tooltip>
                )}
            </div>
            <Modal title={t("canvas.promptPanel.editorTitle")} open={expanded} centered width={MODAL_WIDTH.lg} footer={null} onCancel={() => setExpanded(false)} destroyOnHidden>
                <div data-canvas-no-zoom className="pt-2" onWheelCapture={(event) => event.stopPropagation()}>
                    <CanvasNodeReferenceBar nodeId={node.id} nodes={nodes} connectedNodes={connectedNodes} onDisconnect={onDisconnectReference} onStartSelection={(nodeId) => { setExpanded(false); onStartReferenceSelection?.(nodeId); }} />
                    <CanvasPromptChipInput
                        value={prompt}
                        references={mentionReferences}
                        assetCandidates={assetCandidates}
                        onChange={updatePrompt}
                        panelZ={Z_LAYERS.dropdown}
                        className="thin-scrollbar h-[52dvh] min-h-80 w-full cursor-text overflow-y-auto rounded-xl border p-4 text-[15px] leading-6 outline-none"
                        style={{ background: "transparent", borderColor: theme.toolbar.border, color: theme.node.text }}
                        placeholder={t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode === "text" && hasTextContent ? "editText" : mode}`)}
                    />
                </div>
            </Modal>
        </div>
    );
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}
