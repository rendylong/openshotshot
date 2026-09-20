import { FalGenerationMedia } from "./fal-generation-settings";
import { configuredFalProfile } from "@/lib/canvas/fal-settings";
import type { AiConfig } from "@/stores/use-config-store";
import type { ProviderOptions } from "@/lib/models/provider-options";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { Button, Image } from "antd";
import { FileText, Group, Image as ImageIcon, Music2, Video, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { buildStrictGenerationContext, type NodeGenerationInput } from "./canvas-node-generation";
import { describeAutodlInput } from "@/lib/canvas/autodl-generation-input";
import { CanvasNodeReferenceBar } from "./canvas-node-reference-bar";
import { REFERENCE_TOKEN_PATTERN, type AssetMentionCandidate } from "@/lib/canvas/asset-mentions";
import { createAssetChipElement } from "./mention-menu";
import { useAssetMentionCandidates, useAssetMentionResolver } from "@/hooks/use-asset-mention";
import type { CanvasNodeData } from "@/types/canvas";

type CanvasConfigComposerProps = {
    nodeId: string;
    nodes: CanvasNodeData[];
    value: string;
    inputs: NodeGenerationInput[];
    connectedNodes?: CanvasNodeData[];
    workflowId?: string;
    falConfig?: AiConfig;
    providerOptions?: ProviderOptions;
    composerMode?: boolean;
    onChange: (value: string) => void;
    onClose: () => void;
    onDisconnectReference?: (fromNodeId: string, toNodeId: string) => void;
    onStartReferenceSelection?: (nodeId: string) => void;
};

type Token =
    | { type: "text"; value: string }
    | { type: "reference"; nodeId: string }
    | { type: "asset"; assetId: string };

type MentionState = {
    query: string;
};

type ComposerCandidate =
    | { kind: "input"; input: NodeGenerationInput; label: string }
    | { kind: "asset"; candidate: AssetMentionCandidate };
type ComposerMenuGroup = { label: string; items: ComposerCandidate[] };

export function CanvasConfigComposer({ nodeId, nodes, value, inputs, connectedNodes = [], workflowId, falConfig, providerOptions, composerMode = false, onChange, onClose, onDisconnectReference, onStartReferenceSelection }: CanvasConfigComposerProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const editorRef = useRef<HTMLDivElement>(null);
    const composingRef = useRef(false);
    const [mention, setMention] = useState<MentionState | null>(null);
    const [activeIndex, setActiveIndex] = useState(0);
    const [imagePreview, setImagePreview] = useState<string | null>(null);
    const assetCandidates = useAssetMentionCandidates();
    const resolveAsset = useAssetMentionResolver();
    const assetById = useMemo(() => new Map(assetCandidates.map((item) => [item.assetId, item])), [assetCandidates]);
    const previewResult = useMemo(() => {
        if (!workflowId) return null;
        try {
            return { preview: describeAutodlInput(workflowId, buildStrictGenerationContext(inputs, value, composerMode || value.includes("@[node:"), [], resolveAsset)) };
        } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    }, [workflowId, inputs, value, composerMode, resolveAsset, t]);
    const falProfile = falConfig && configuredFalProfile(falConfig);
    const tokens = useMemo(() => parseComposerTokens(value), [value]);
    const referenceById = useMemo(() => new Map(inputs.map((input) => [input.nodeId, input])), [inputs]);
    const menuGroups = useMemo((): ComposerMenuGroup[] => {
        if (!mention) return [];
        const query = (mention.query || "").trim().toLowerCase();
        const hit = (text: string) => !query || text.toLowerCase().includes(query);
        const inputItems: ComposerCandidate[] = inputs
            .filter((input) => hit(`${resourceLabel(input, inputs)} ${input.title} ${input.type === "group" ? "" : input.text || ""}`))
            .map((input) => ({ kind: "input" as const, input, label: resourceLabel(input, inputs) }));
        const assetItems: ComposerCandidate[] = assetCandidates
            .filter((candidate) => hit(candidate.title))
            .map((candidate) => ({ kind: "asset" as const, candidate }));
        return [
            ...(inputItems.length ? [{ label: i18n.t("canvas.composer.groupCanvas"), items: inputItems }] : []),
            ...(assetItems.length ? [{ label: i18n.t("canvas.composer.groupAssets"), items: assetItems }] : []),
        ];
    }, [mention, inputs, assetCandidates]);
    const candidates = useMemo(() => menuGroups.flatMap((group) => group.items), [menuGroups]);

    useEffect(() => {
        if (document.activeElement === editorRef.current) return;
        const editor = editorRef.current;
        if (!editor) return;
        editor.textContent = "";
        tokens.forEach((token) => {
            if (token.type === "text") {
                editor.append(document.createTextNode(token.value));
                return;
            }
            if (token.type === "asset") {
                editor.append(createAssetChipElement({ assetId: token.assetId, candidate: assetById.get(token.assetId), theme, unknownLabel: i18n.t("canvas.composer.assetUnknown"), onImagePreview: setImagePreview }));
                return;
            }
            const input = referenceById.get(token.nodeId);
            if (input) editor.append(createReferenceChip(input, inputs, theme, setImagePreview));
            else editor.append(document.createTextNode(`@[node:${token.nodeId}]`));
        });
    }, [inputs, referenceById, assetById, theme, tokens]);

    const syncFromEditor = () => {
        const editor = editorRef.current;
        if (!editor) return;
        const next = serializeEditor(editor);
        onChange(next);
        syncMention();
    };

    const syncMention = () => {
        const text = textBeforeCaret();
        const match = /@([^\s@]*)$/.exec(text);
        if (!match || (!inputs.length && !assetCandidates.length)) {
            closeMention();
            return;
        }
        setMention({ query: match[1] || "" });
        setActiveIndex(0);
    };

    const closeMention = () => {
        setMention(null);
        setActiveIndex(0);
    };

    const insertCandidate = (item: ComposerCandidate) => {
        const editor = editorRef.current;
        if (!editor) return;
        removeActiveMention();
        const chip = item.kind === "input"
            ? createReferenceChip(item.input, inputs, theme, setImagePreview)
            : createAssetChipElement({ assetId: item.candidate.assetId, candidate: item.candidate, theme, unknownLabel: i18n.t("canvas.composer.assetUnknown"), onImagePreview: setImagePreview });
        const space = document.createTextNode(" ");
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (range) {
            range.insertNode(space);
            range.insertNode(chip);
            range.setStartAfter(space);
            range.collapse(true);
            selection?.removeAllRanges();
            selection?.addRange(range);
        } else {
            editor.append(chip, space);
            placeCaretAtEnd(editor);
        }
        closeMention();
        onChange(serializeEditor(editor));
    };

    const stopCanvasInteraction = (event: PointerEvent | MouseEvent) => event.stopPropagation();

    return (
        <div
            data-canvas-no-zoom
            className="rounded-2xl border p-3 shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={stopCanvasInteraction}
            onPointerDown={stopCanvasInteraction}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-baseline gap-2">
                    <div className="shrink-0 text-xs font-semibold">{t("canvas.composer.title")}</div>
                    <div className="truncate text-[11px] opacity-55">{t("canvas.composer.description")}</div>
                </div>
                <Button size="small" type="text" className="!h-7 !w-7 !min-w-7 !p-0" icon={<X className="size-3.5" />} onClick={onClose} />
            </div>
            <CanvasNodeReferenceBar nodeId={nodeId} nodes={nodes} connectedNodes={connectedNodes} onDisconnect={onDisconnectReference} onStartSelection={onStartReferenceSelection} />
            <div className="relative rounded-xl">
                {!value.trim() ? <div className="pointer-events-none absolute left-3 top-2 text-sm leading-7" style={{ color: theme.node.placeholder }}>{t("canvas.composer.placeholder")}</div> : null}
                <div
                    ref={editorRef}
                    contentEditable
                    suppressContentEditableWarning
                    className="thin-scrollbar min-h-28 max-h-72 w-full overflow-y-auto overscroll-contain whitespace-pre-wrap break-words px-3 py-2 text-sm leading-7 outline-none"
                    style={{ color: theme.node.text }}
                    onInput={() => {
                        if (!composingRef.current) syncFromEditor();
                    }}
                    onCompositionStart={() => {
                        composingRef.current = true;
                    }}
                    onCompositionEnd={() => {
                        composingRef.current = false;
                        syncFromEditor();
                    }}
                    onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                        event.stopPropagation();
                        if (mention && candidates.length) {
                            if (event.key === "ArrowDown") {
                                event.preventDefault();
                                setActiveIndex((index) => (index + 1) % candidates.length);
                                return;
                            }
                            if (event.key === "ArrowUp") {
                                event.preventDefault();
                                setActiveIndex((index) => (index - 1 + candidates.length) % candidates.length);
                                return;
                            }
                            if (event.key === "Enter") {
                                event.preventDefault();
                                insertCandidate(candidates[Math.min(activeIndex, candidates.length - 1)]);
                                return;
                            }
                            if (event.key === "Escape") {
                                event.preventDefault();
                                closeMention();
                                return;
                            }
                        }
                        if ((event.key === "Backspace" || event.key === "Delete") && deleteAdjacentReference(event.key)) {
                            event.preventDefault();
                            requestAnimationFrame(syncFromEditor);
                            return;
                        }
                        requestAnimationFrame(syncMention);
                    }}
                    onBlur={() => window.setTimeout(closeMention, 120)}
                />
                {mention && candidates.length ? <MentionMenu groups={menuGroups} activeIndex={Math.min(activeIndex, candidates.length - 1)} theme={theme} onSelect={insertCandidate} /> : null}
            </div>
            {falProfile && falConfig ? <FalGenerationMedia profile={falProfile} config={falConfig} options={providerOptions} inputs={inputs} prompt={value} composerMode={composerMode} /> : null}
            {previewResult?.error ? <p role="alert" className="mt-2 break-words text-xs text-destructive">{previewResult.error}</p> : null}
            {previewResult?.preview ? <details className="mt-2 text-xs">
                <summary className="cursor-pointer">{t("autodlGeneration.preview")}</summary>
                <div className="mt-2 space-y-2 break-words">
                    {previewResult.preview.promptUsed ? <p className="whitespace-pre-wrap">{previewResult.preview.prompt}</p> : <p>{t("autodlGeneration.promptUnused")}</p>}
                    {previewResult.preview.bindings.map(binding => {
                        const input = inputs.flatMap(item => item.type === "group" ? item.children : [item]).find(item => item.image?.id === binding.sourceId || item.images?.some(image => image.id === binding.sourceId) || item.video?.id === binding.sourceId || item.audio?.id === binding.sourceId);
                        const assetTitle = binding.sourceId.startsWith("asset:") ? assetCandidates.find((candidate) => candidate.assetId === binding.sourceId.slice("asset:".length))?.title : undefined;
                        return <p key={`${binding.kind}:${binding.field}`}>{binding.label} ← {input?.title || assetTitle || binding.sourceId}</p>;
                    })}
                </div>
            </details> : null}
            {imagePreview ? <Image src={imagePreview} alt={t("canvas.composer.imagePreview")} style={{ display: "none" }} preview={{ visible: true, src: imagePreview, onVisibleChange: (visible) => !visible && setImagePreview(null) }} /> : null}
        </div>
    );

}

function MentionMenu({ groups, activeIndex, theme, onSelect }: { groups: ComposerMenuGroup[]; activeIndex: number; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onSelect: (item: ComposerCandidate) => void }) {
    const selectedRef = useRef(false);
    const activeItemRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        activeItemRef.current?.scrollIntoView({ block: "nearest" });
    }, [activeIndex, groups]);

    const select = (item: ComposerCandidate) => {
        if (selectedRef.current) return;
        selectedRef.current = true;
        onSelect(item);
    };

    let index = -1;
    return (
        <div className="absolute left-2 top-[calc(100%+6px)] z-[90] max-h-56 w-64 overflow-y-auto rounded-xl border p-1 shadow-2xl" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}>
            {groups.map((group) => (
                <div key={group.label}>
                    <div className="px-2 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide opacity-50">{group.label}</div>
                    {group.items.map((item) => {
                        index += 1;
                        const active = index === activeIndex;
                        const key = item.kind === "input" ? item.input.nodeId : `asset:${item.candidate.assetId}`;
                        return (
                            <button
                                key={key}
                                ref={active ? activeItemRef : undefined}
                                type="button"
                                className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition"
                                style={{ background: active ? theme.toolbar.activeBg : "transparent", color: active ? theme.toolbar.activeText : theme.node.text }}
                                onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); select(item); }}
                            >
                                {item.kind === "input" ? <ResourcePreview input={item.input} /> : <AssetPreview candidate={item.candidate} />}
                                <span className="min-w-0 flex-1">
                                    <span className="block font-medium">{item.kind === "input" ? item.label : item.candidate.title}</span>
                                    <span className="block truncate opacity-65">{item.kind === "input" ? (item.input.type === "group" ? i18n.t("canvas.node.nodeCount", { count: item.input.children.length }) : item.input.text || item.input.title) : i18n.t(item.candidate.kind === "video" ? "canvas.composer.assetTag.video" : "canvas.composer.assetTag.image")}</span>
                                </span>
                            </button>
                        );
                    })}
                </div>
            ))}
        </div>
    );
}

function AssetPreview({ candidate }: { candidate: AssetMentionCandidate }) {
    return candidate.coverUrl
        ? <img src={candidate.coverUrl} alt="" className="size-9 rounded-md object-cover" />
        : <span className="grid size-9 shrink-0 place-items-center rounded-md bg-black/10"><ImageIcon className="size-4" /></span>;
}

function ResourcePreview({ input }: { input: NodeGenerationInput }) {
    if (input.type === "group") return <span className="grid size-9 shrink-0 place-items-center"><Group className="size-4" /></span>;
    // 多图输入（3D 多视角/多图节点）取第一张可预览的图作缩略图
    const firstImage = input.type === "image" ? (input.images || []).find((image) => image.dataUrl || image.url) : undefined;
    const previewSrc = (input.type === "image" && input.image?.dataUrl) || firstImage?.dataUrl || firstImage?.url;
    if (input.type === "image" && previewSrc) return <img src={previewSrc} alt="" className="size-9 rounded-md object-cover" />;
    if (input.type === "video" && input.video) return <video src={input.video.url} className="size-9 rounded-md bg-black object-cover" muted preload="metadata" />;
    const Icon = input.type === "audio" ? Music2 : input.type === "video" ? Video : input.type === "image" ? ImageIcon : FileText;
    return (
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-black/10">
            <Icon className="size-4" />
        </span>
    );
}

function createReferenceChip(input: NodeGenerationInput, inputs: NodeGenerationInput[], theme: (typeof canvasThemes)[keyof typeof canvasThemes], onImagePreview: (url: string) => void) {
    const wrapper = document.createElement("span");
    wrapper.contentEditable = "false";
    wrapper.dataset.referenceNodeId = input.nodeId;
    wrapper.className = "mx-px inline-flex h-7 max-w-40 items-center justify-center overflow-hidden rounded-md border px-1 text-xs leading-none align-middle";
    Object.assign(wrapper.style, chipStyle(theme));
    // 多图输入（3D 多视角/多图节点）芯片显示首图缩略图并标注张数，替代按节点名的文本芯片
    const firstImage = input.type === "image" ? (input.images || []).find((image) => image.dataUrl || image.url) : undefined;
    const previewSrc = (input.type === "image" && input.image?.dataUrl) || firstImage?.dataUrl || firstImage?.url;
    const imageCount = input.type === "image" ? input.images?.length || (input.image ? 1 : 0) : 0;
    if (input.type === "image" && previewSrc) {
        const image = document.createElement("img");
        image.src = previewSrc;
        image.alt = input.title;
        image.className = "size-6 rounded object-cover";
        wrapper.className = imageCount > 1
            ? "mx-px inline-flex h-6 items-center justify-center overflow-hidden rounded align-middle"
            : "mx-px inline-flex size-6 items-center justify-center overflow-hidden rounded align-middle";
        if (imageCount > 1) {
            const badge = document.createElement("span");
            badge.textContent = `${imageCount}`;
            badge.className = "px-0.5 text-[10px] leading-none";
            wrapper.appendChild(image);
            wrapper.appendChild(badge);
        } else {
            wrapper.appendChild(image);
        }
        wrapper.title = imageCount > 1 ? `${input.title} ×${imageCount}` : input.title;
        wrapper.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            onImagePreview(previewSrc || "");
        });
    } else {
        wrapper.title = input.type === "group" ? input.title : input.text || input.title;
        const text = document.createElement("span");
        text.className = "block truncate";
        text.textContent = input.type === "text" ? input.text || input.title : input.title;
        wrapper.appendChild(text);
    }
    return wrapper;
}

function serializeEditor(editor: HTMLElement) {
    return serializeNodes(editor.childNodes).replace(/\uFEFF/g, "");
}

function serializeNodes(nodes: NodeListOf<ChildNode>) {
    let result = "";
    nodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) result += node.textContent || "";
        if (!(node instanceof HTMLElement)) return;
        const nodeId = node.dataset.referenceNodeId;
        if (nodeId) result += `@[node:${nodeId}]`;
        else if (node.dataset.assetId) result += `@[asset:${node.dataset.assetId}]`;
        else if (node.tagName === "BR") result += "\n";
        else result += serializeNodes(node.childNodes);
    });
    return result;
}

function removeActiveMention() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const text = textBeforeCaret();
    const match = /@([^\s@]*)$/.exec(text);
    if (!match) return;
    range.setStart(range.startContainer, Math.max(0, range.startOffset - (match[1] || "").length - 1));
    range.deleteContents();
}

function deleteAdjacentReference(key: string) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    const target = adjacentReferenceNode(range, key);
    if (!target) return false;
    const nextCaretNode = document.createTextNode("");
    target.replaceWith(nextCaretNode);
    range.setStart(nextCaretNode, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}

function adjacentReferenceNode(range: Range, key: string) {
    const container = range.startContainer;
    const offset = range.startOffset;
    const previous = key === "Backspace";
    if (container.nodeType === Node.TEXT_NODE) {
        const text = container.textContent || "";
        if ((previous && offset > 0) || (!previous && offset < text.length)) return null;
        return findReferenceSibling(container, previous);
    }
    const children = Array.from(container.childNodes);
    return findReferenceSibling(children[previous ? offset - 1 : offset] || container, previous, true);
}

function findReferenceSibling(node: Node, previous: boolean, includeSelf = false): HTMLElement | null {
    let current: Node | null = includeSelf ? node : previous ? node.previousSibling : node.nextSibling;
    while (current && current.nodeType === Node.TEXT_NODE && !(current.textContent || "").trim()) current = previous ? current.previousSibling : current.nextSibling;
    return current instanceof HTMLElement && (current.dataset.referenceNodeId || current.dataset.assetId) ? current : null;
}

function textBeforeCaret() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return "";
    const range = selection.getRangeAt(0).cloneRange();
    const editor = closestEditor(range.startContainer);
    if (!editor) return "";
    range.setStart(editor, 0);
    return range.toString();
}

function closestEditor(node: Node) {
    const element = node instanceof Element ? node : node.parentElement;
    return element?.closest("[contenteditable='true']") || null;
}

function placeCaretAtEnd(element: HTMLElement) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function parseComposerTokens(value: string): Token[] {
    const tokens: Token[] = [];
    let lastIndex = 0;
    for (const match of value.matchAll(REFERENCE_TOKEN_PATTERN)) {
        if (match.index === undefined) continue;
        if (match.index > lastIndex) tokens.push({ type: "text", value: value.slice(lastIndex, match.index) });
        if (match[1] === "asset") tokens.push({ type: "asset", assetId: match[2] });
        else tokens.push({ type: "reference", nodeId: match[2] });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < value.length) tokens.push({ type: "text", value: value.slice(lastIndex) });
    return tokens;
}

function resourceLabel(input: NodeGenerationInput, inputs: NodeGenerationInput[]) {
    const sameTypeInputs = inputs.filter((item) => item.type === input.type);
    const index = Math.max(0, sameTypeInputs.findIndex((item) => item.nodeId === input.nodeId));
    return i18n.t(`canvas.composer.resources.${input.type}`, { index: index + 1 });
}

function chipStyle(theme: (typeof canvasThemes)[keyof typeof canvasThemes]): CSSProperties {
    return { background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text };
}
