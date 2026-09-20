import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { Image } from "antd";

import i18n from "@/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import { isImeComposing, isPlainEnterKey } from "@/lib/keyboard-event";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { ASSET_TOKEN_PATTERN, type AssetMentionCandidate } from "@/lib/canvas/asset-mentions";

import { MentionMenu, createAssetChipElement, type MentionMenuItem, type MentionMenuGroup } from "./mention-menu";
import { CanvasFloatingPanel } from "./canvas-floating-panel";

type Props = {
    value: string;
    references: CanvasResourceReference[];
    assetCandidates?: AssetMentionCandidate[];
    onChange: (value: string) => void;
    onSubmit?: () => void;
    className?: string;
    style?: CSSProperties;
    placeholder?: string;
    /** mention 浮层 z-index；默认画布 overlay 档。antd Modal 内使用时传更高档位，避免被弹层盖住。 */
    panelZ?: number;
};

type MentionState = {
    query: string;
};

type Token =
    | { type: "text"; value: string }
    | { type: "reference"; label: string }
    | { type: "asset"; assetId: string };

// Prompt-panel contentEditable input: @ references embed thumbnail chips instead of plain label text.
// Serialization converts reference chips back to labels (the panel prompt stays connection-driven) and
// asset chips back to persistent @[asset:id] tokens so removed assets surface as dangling unknown chips.
export function CanvasPromptChipInput({ value, references, assetCandidates = [], onChange, onSubmit, className, style, placeholder, panelZ }: Props) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const editorRef = useRef<HTMLDivElement>(null);
    const composingRef = useRef(false);
    // Track the last value emitted to the parent. An identical focused value is this component's own echo,
    // so skip rebuilding to preserve the caret and IME. Rebuild external changes even while focused.
    const lastEmittedRef = useRef(value);
    const [mention, setMention] = useState<MentionState | null>(null);
    const [activeIndex, setActiveIndex] = useState(0);
    const [imagePreview, setImagePreview] = useState<string | null>(null);

    const activeReferences = useMemo(() => references.filter((item) => item.active), [references]);
    const referenceByLabel = useMemo(() => new Map(activeReferences.map((item) => [item.label, item])), [activeReferences]);
    // Match longer labels first so a shorter label cannot split a longer one.
    const activeLabels = useMemo(() => Array.from(new Set(activeReferences.map((item) => item.label))).sort((a, b) => b.length - a.length), [activeReferences]);
    const tokens = useMemo(() => parseTokens(value, activeLabels), [value, activeLabels]);

    const assetById = useMemo(() => new Map(assetCandidates.map((item) => [item.assetId, item])), [assetCandidates]);
    const groups = useMemo((): MentionMenuGroup[] => {
        if (!mention) return [];
        const query = mention.query.trim().toLowerCase();
        const hit = (text: string) => !query || text.toLowerCase().includes(query);
        const references = activeReferences
            .filter((item) => hit(`${item.label} ${item.title} ${item.kind} ${item.text || ""}`))
            .map((item) => ({ kind: "reference" as const, reference: item }));
        const assets = assetCandidates
            .filter((item) => hit(`${item.title} ${item.kind}`))
            .map((item) => ({ kind: "asset" as const, candidate: item }));
        return [
            ...(references.length ? [{ label: i18n.t("canvas.composer.groupCanvas"), items: references }] : []),
            ...(assets.length ? [{ label: i18n.t("canvas.composer.groupAssets"), items: assets }] : []),
        ];
    }, [mention, activeReferences, assetCandidates]);
    const candidates = useMemo(() => groups.flatMap((group) => group.items), [groups]);

    // Rebuild the DOM from value when unfocused, or when a focused value is an external change rather than an emitted echo.
    useEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;
        if (document.activeElement === editor && value === lastEmittedRef.current) return;
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
            const reference = referenceByLabel.get(token.label);
            if (reference) editor.append(createReferenceChip(reference, theme, setImagePreview));
            else editor.append(document.createTextNode(token.label));
        });
        lastEmittedRef.current = value;
    }, [tokens, referenceByLabel, assetById, theme, value]);

    const emit = (next: string) => {
        lastEmittedRef.current = next;
        onChange(next);
    };

    const syncFromEditor = () => {
        const editor = editorRef.current;
        if (!editor) return;
        emit(serializeEditor(editor));
        syncMention();
    };

    const syncMention = () => {
        const text = textBeforeCaret();
        const match = /@([^\s@]*)$/.exec(text);
        if (!match || (!activeReferences.length && !assetCandidates.length)) {
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

    const insertItem = (item: MentionMenuItem) => {
        const editor = editorRef.current;
        if (!editor) return;
        removeActiveMention();
        const chip = item.kind === "reference"
            ? createReferenceChip(item.reference, theme, setImagePreview)
            : createAssetChipElement({ assetId: item.candidate.assetId, candidate: assetById.get(item.candidate.assetId), theme, unknownLabel: i18n.t("canvas.composer.assetUnknown"), onImagePreview: setImagePreview });
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
        emit(serializeEditor(editor));
    };

    const showPlaceholder = !value.trim();

    return (
        <div className="relative w-full">
            {showPlaceholder && placeholder ? (
                <div className="pointer-events-none absolute left-3 top-2 text-sm leading-5" style={{ color: theme.node.placeholder }}>
                    {placeholder}
                </div>
            ) : null}
            <div
                ref={editorRef}
                contentEditable
                suppressContentEditableWarning
                role="textbox"
                aria-multiline="true"
                className={`${className || ""} overflow-y-auto whitespace-pre-wrap break-words outline-none`}
                style={{ ...style, cursor: "text" }}
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
                    if (isImeComposing(event)) return;
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
                            insertItem(candidates[Math.min(activeIndex, candidates.length - 1)]);
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
                    if (isPlainEnterKey(event) && onSubmit) {
                        event.preventDefault();
                        onSubmit();
                        return;
                    }
                    requestAnimationFrame(syncMention);
                }}
                onBlur={() => window.setTimeout(closeMention, 120)}
            />
            <CanvasFloatingPanel open={Boolean(mention && candidates.length)} anchorRef={editorRef} placement="bottomLeft" width={256} padding={4} z={panelZ} ariaLabel="mention candidates" onOpenChange={(open) => { if (!open) closeMention(); }}>
                {mention && candidates.length ? <MentionMenu groups={groups} activeIndex={Math.min(activeIndex, candidates.length - 1)} theme={theme} onSelect={insertItem} /> : null}
            </CanvasFloatingPanel>
            {imagePreview ? <Image src={imagePreview} alt={i18n.t("canvas.composer.imagePreview")} style={{ display: "none" }} preview={{ visible: true, src: imagePreview, onVisibleChange: (visible) => !visible && setImagePreview(null) }} /> : null}
        </div>
    );
}

function createReferenceChip(reference: CanvasResourceReference, theme: (typeof canvasThemes)[keyof typeof canvasThemes], onImagePreview: (url: string) => void) {
    const wrapper = document.createElement("span");
    wrapper.contentEditable = "false";
    wrapper.dataset.refLabel = reference.label;
    if (reference.kind === "image" && reference.previewUrl) {
        const image = document.createElement("img");
        image.src = reference.previewUrl;
        image.alt = reference.title;
        image.className = "size-6 rounded object-cover";
        wrapper.className = "mx-px inline-flex size-6 items-center justify-center overflow-hidden rounded align-middle";
        wrapper.appendChild(image);
        wrapper.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            onImagePreview(reference.previewUrl || "");
        });
    } else {
        wrapper.className = "mx-px inline-flex h-6 max-w-40 items-center justify-center overflow-hidden rounded-md border px-1 text-xs leading-none align-middle";
        Object.assign(wrapper.style, { background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text } as CSSProperties);
        wrapper.title = reference.text || reference.title;
        const text = document.createElement("span");
        text.className = "block truncate";
        text.textContent = reference.kind === "text" ? reference.text || reference.title : reference.label;
        wrapper.appendChild(text);
    }
    return wrapper;
}

function serializeEditor(editor: HTMLElement) {
    return serializeNodes(editor.childNodes).replace(/﻿/g, "");
}

function serializeNodes(nodes: NodeListOf<ChildNode>) {
    let result = "";
    nodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) result += node.textContent || "";
        if (!(node instanceof HTMLElement)) return;
        const assetId = node.dataset.assetId;
        if (assetId) result += `@[asset:${assetId}]`;
        else {
            const label = node.dataset.refLabel;
            if (label) result += label;
            else if (node.tagName === "BR") result += "\n";
            else result += serializeNodes(node.childNodes);
        }
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

// Chips are atomic contentEditable="false" blocks and are removed as a unit with adjacent Backspace/Delete presses.
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
    return current instanceof HTMLElement && (current.dataset.refLabel || current.dataset.assetId) ? current : null;
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

// Asset tokens are persistent (@[asset:id]) and split first; active reference labels are then matched inside text fragments.
function parseTokens(value: string, labels: string[]): Token[] {
    const tokens: Token[] = [];
    let lastIndex = 0;
    for (const match of value.matchAll(ASSET_TOKEN_PATTERN)) {
        if (match.index === undefined) continue;
        if (match.index > lastIndex) tokens.push(...parseLabelTokens(value.slice(lastIndex, match.index), labels));
        tokens.push({ type: "asset", assetId: match[1] });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < value.length) tokens.push(...parseLabelTokens(value.slice(lastIndex), labels));
    return tokens;
}

function parseLabelTokens(value: string, labels: string[]): Token[] {
    if (!labels.length) return value ? [{ type: "text", value }] : [];
    const escaped = labels.map(escapeRegExp).join("|");
    const pattern = new RegExp(`(${escaped})`, "g");
    const tokens: Token[] = [];
    let lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
        if (match.index === undefined) continue;
        if (match.index > lastIndex) tokens.push({ type: "text", value: value.slice(lastIndex, match.index) });
        tokens.push({ type: "reference", label: match[0] });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < value.length) tokens.push({ type: "text", value: value.slice(lastIndex) });
    return tokens;
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
