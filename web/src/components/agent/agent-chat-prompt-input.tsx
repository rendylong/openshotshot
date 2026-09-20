import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref, type RefObject } from "react";
import { Popover } from "antd";
import { useTranslation } from "react-i18next";

import { CanvasFloatingPanel, type CanvasFloatingPanelPlacement } from "@/components/canvas/canvas-floating-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { buildCanvasResourceReferences, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { isImeComposing, isPlainEnterKey } from "@/lib/keyboard-event";
import { useAgentStore, type AgentCanvasReference } from "@/stores/use-agent-store";
import { useLocalSkillStore } from "@/stores/use-local-skill-store";
import { AgentCanvasReferencePreview, canvasReferenceIcon, canvasReferenceKindLabel } from "./agent-canvas-reference-preview";
import { agentInlineTokenClass, agentInlineTokenMediaClass, agentReferenceMarker, parseAgentInlineTokens } from "./agent-chat-inline-tokens";

type ComposerCommand = { type: "resource" | "skill"; query: string; length: number };
type ComposerCandidate = { type: "resource"; reference: CanvasResourceReference } | { type: "skill"; name: string; description: string };
type ReferenceHover = { reference: AgentCanvasReference; left: number; top: number; width: number; height: number };

export type AgentChatPromptInputHandle = { focus(): void };

export function AgentChatPromptInput({ value, disabled, placeholder, theme, onChange, onSubmit, onAddFiles, skillMenuRequest = 0, inputRef, menuPlacement = "topLeft", menuAnchorRef }: {
    value: string;
    disabled?: boolean;
    placeholder: string;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onChange: (value: string) => void;
    onSubmit: () => void;
    onAddFiles?: (files: FileList | File[] | null) => void | Promise<void>;
    skillMenuRequest?: number;
    inputRef?: Ref<AgentChatPromptInputHandle>;
    /** Skill/引用候选菜单展开方向：topLeft=输入卡上方（画布默认），bottomLeft=输入卡下方（首页）。 */
    menuPlacement?: CanvasFloatingPanelPlacement;
    /** 菜单锚点元素；缺省用编辑器容器。bottomLeft 时应传输入卡引用，让菜单落在卡片下方。 */
    menuAnchorRef?: RefObject<HTMLElement | null>;
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<HTMLDivElement>(null);
    const composingRef = useRef(false);
    const lastEmittedRef = useRef(value);
    const canvasReferences = useAgentStore((state) => state.canvasReferences);
    const skills = useLocalSkillStore((state) => state.skills);
    const skillsLoaded = useLocalSkillStore((state) => state.loaded);
    const scanSkills = useLocalSkillStore((state) => state.scanSkills);
    const [command, setCommand] = useState<ComposerCommand | null>(null);
    // -1 = 未激活：打开菜单/改写过滤词时任何行都不预高亮，光标只由方向键建立
    const [activeIndex, setActiveIndex] = useState(-1);
    const [composing, setComposing] = useState(false);
    const [resourceCandidates, setResourceCandidates] = useState<CanvasResourceReference[]>([]);
    const [referenceHover, setReferenceHover] = useState<ReferenceHover | null>(null);
    const closeCommandTimeoutRef = useRef<number | null>(null);
    const buttonMenuOpenRef = useRef(false);

    const availableSkills = useMemo(() => skills.filter((skill) => skill.valid).map((skill) => ({ name: skill.name, description: skill.shortDescription || skill.description })), [skills]);
    const tokens = useMemo(() => parseAgentInlineTokens(value, canvasReferences, availableSkills.map((skill) => skill.name)), [availableSkills, canvasReferences, value]);
    const selectedReferenceIds = useMemo(() => new Set(canvasReferences.map((item) => item.nodeId)), [canvasReferences]);
    const candidates = useMemo<ComposerCandidate[]>(() => {
        if (!command) return [];
        const query = command.query.trim().toLowerCase();
        if (command.type === "skill") return availableSkills
            .filter((skill) => !query || `${skill.name} ${skill.description}`.toLowerCase().includes(query))
            .map((skill) => ({ type: "skill", ...skill }));
        return resourceCandidates
            .filter((reference) => !selectedReferenceIds.has(reference.nodeId) && (!query || `${reference.label} ${reference.title} ${reference.kind} ${reference.text || ""}`.toLowerCase().includes(query)))
            .map((reference) => ({ type: "resource", reference }));
    }, [availableSkills, command, resourceCandidates, selectedReferenceIds]);

    useEffect(() => {
        if (!skillsLoaded) void scanSkills();
    }, [scanSkills, skillsLoaded]);

    useEffect(() => {
        if (!skillMenuRequest) return;
        if (closeCommandTimeoutRef.current) {
            clearTimeout(closeCommandTimeoutRef.current);
            closeCommandTimeoutRef.current = null;
        }
        buttonMenuOpenRef.current = true;
        editorRef.current?.focus();
        setCommand({ type: "skill", query: "", length: 0 });
        setActiveIndex(-1);
    }, [skillMenuRequest]);

    useLayoutEffect(() => {
        const editor = editorRef.current;
        if (!editor || document.activeElement === editor && value === lastEmittedRef.current) return;
        editor.replaceChildren(...tokens.map((token) => {
            if (token.type === "text") return document.createTextNode(token.value);
            return token.type === "reference" ? createReferenceToken(token.reference, theme) : createSkillToken(token.name, theme);
        }));
        lastEmittedRef.current = value;
    }, [theme, tokens, value]);

    useImperativeHandle(inputRef, () => ({
        focus() {
            const editor = editorRef.current;
            if (!editor || disabled) return;
            editor.focus();
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
            selection?.removeAllRanges();
            selection?.addRange(range);
        },
    }), [disabled]);

    const emit = (next: string) => {
        lastEmittedRef.current = next;
        onChange(next);
    };

    const closeCommand = () => {
        buttonMenuOpenRef.current = false;
        setCommand(null);
        setActiveIndex(-1);
    };

    const syncCommand = () => {
        // Menu opened via the toolbar button: keep it open until the user
        // selects or explicitly dismisses, even though the text has no "/" prefix.
        if (buttonMenuOpenRef.current && command) return;
        const text = textBeforeCaret(editorRef.current);
        const skillMatch = /(^|\s)\/([a-z0-9-]*)$/.exec(text);
        if (skillMatch) {
            setCommand({ type: "skill", query: skillMatch[2] || "", length: (skillMatch[2] || "").length + 1 });
            setActiveIndex(-1);
            return;
        }
        const resourceMatch = /(^|\s)@([^\s@]*)$/.exec(text);
        if (!resourceMatch) return closeCommand();
        setCommand({ type: "resource", query: resourceMatch[2] || "", length: (resourceMatch[2] || "").length + 1 });
        setActiveIndex(-1);
        const snapshot = useAgentStore.getState().canvasContext?.snapshot;
        const references = buildCanvasResourceReferences(snapshot?.nodes || []);
        const selectedIds = new Set(snapshot?.selectedNodeIds || []);
        setResourceCandidates([...references.filter((item) => selectedIds.has(item.nodeId)), ...references.filter((item) => !selectedIds.has(item.nodeId))]);
    };

    const syncFromEditor = () => {
        const editor = editorRef.current;
        if (!editor) return;
        const next = serializeEditor(editor);
        emit(next);
        syncSelectedMetadata(editor);
        syncCommand();
    };

    const insertCandidate = (candidate: ComposerCandidate) => {
        const editor = editorRef.current;
        if (!editor || !command) return;
        removeTextBeforeCaret(command.length);

        if (candidate.type === "resource") {
            const current = useAgentStore.getState().canvasReferences;
            if (!current.some((item) => item.nodeId === candidate.reference.nodeId)) useAgentStore.getState().setAgentState({ canvasReferences: [...current, candidate.reference] });
            insertTokenAtCaret(editor, createReferenceToken(candidate.reference, theme));
        } else {
            insertTokenAtCaret(editor, createSkillToken(candidate.name, theme));
        }
        emit(serializeEditor(editor));
        closeCommand();
    };

    const handleCommandKey = (event: KeyboardEvent<HTMLDivElement>) => {
        if (!command || isImeComposing(event)) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (candidates.length) setActiveIndex((index) => {
                if (index < 0) return event.key === "ArrowDown" ? 0 : candidates.length - 1;
                return (index + (event.key === "ArrowDown" ? 1 : candidates.length - 1)) % candidates.length;
            });
            return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            if (activeIndex >= 0 && candidates.length) insertCandidate(candidates[Math.min(activeIndex, candidates.length - 1)]);
            return true;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            closeCommand();
            return true;
        }
        return false;
    };

    const showReferencePreview = (event: MouseEvent<HTMLDivElement>) => {
        const token = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-agent-token-kind='resource']") : null;
        const container = containerRef.current;
        if (!token || !container?.contains(token)) return setReferenceHover(null);
        const reference = useAgentStore.getState().canvasReferences.find((item) => item.nodeId === token.dataset.nodeId);
        if (!reference) return setReferenceHover(null);
        const tokenRect = token.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        setReferenceHover({ reference, left: tokenRect.left - containerRect.left, top: tokenRect.top - containerRect.top, width: tokenRect.width, height: tokenRect.height });
    };

    return (
        <div ref={containerRef} className="relative">
            {!value.trim() && !composing ? <div className="pointer-events-none absolute left-1 top-1 text-sm leading-6" style={{ color: theme.node.placeholder }}>{placeholder}</div> : null}
            <div
                ref={editorRef}
                contentEditable={!disabled}
                suppressContentEditableWarning
                role="textbox"
                aria-multiline="true"
                aria-label={placeholder}
                className="thin-scrollbar max-h-32 min-h-20 w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-1 py-1 text-sm leading-6 outline-none"
                style={{ color: theme.node.text, cursor: disabled ? "default" : "text" }}
                onInput={() => {
                    if (!composingRef.current) syncFromEditor();
                }}
                onCompositionStart={() => { composingRef.current = true; setComposing(true); }}
                onCompositionEnd={() => {
                    composingRef.current = false;
                    setComposing(false);
                    syncFromEditor();
                }}
                onPaste={(event) => {
                    const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
                    if (images.length && onAddFiles) {
                        event.preventDefault();
                        void onAddFiles(images);
                        return;
                    }
                    event.preventDefault();
                    insertTextAtCaret(event.clipboardData.getData("text/plain"));
                    syncFromEditor();
                }}
                onKeyDown={(event) => {
                    event.stopPropagation();
                    if (isImeComposing(event) || handleCommandKey(event)) return;
                    if ((event.key === "Backspace" || event.key === "Delete") && deleteAdjacentToken(event.key)) {
                        event.preventDefault();
                        requestAnimationFrame(syncFromEditor);
                        return;
                    }
                    if (isPlainEnterKey(event)) {
                        event.preventDefault();
                        onSubmit();
                        return;
                    }
                    requestAnimationFrame(syncCommand);
                }}
                onKeyUp={(event) => {
                    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) syncCommand();
                }}
                onClick={syncCommand}
                onMouseOver={showReferencePreview}
                onMouseLeave={() => setReferenceHover(null)}
                onBlur={(event) => {
                    if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest("[data-agent-command-menu]")) return;
                    closeCommandTimeoutRef.current = window.setTimeout(closeCommand, 120);
                }}
            />
            {referenceHover ? (
                <Popover
                    open
                    placement="top"
                    content={<AgentCanvasReferencePreview reference={referenceHover.reference} previewUrl={referenceHover.reference.previewUrl} previewText={referenceHover.reference.text} theme={theme} />}
                >
                    <span
                        aria-hidden
                        className="pointer-events-none absolute"
                        style={{ left: referenceHover.left, top: referenceHover.top, width: referenceHover.width, height: referenceHover.height }}
                    />
                </Popover>
            ) : null}
            {command ? <AgentCommandMenu command={command} candidates={candidates} activeIndex={Math.min(activeIndex, Math.max(candidates.length - 1, 0))} theme={theme} onSelect={insertCandidate} anchorRef={menuAnchorRef ?? containerRef} placement={menuPlacement} onDismiss={closeCommand} /> : null}
        </div>
    );
}
function AgentCommandMenu({ command, candidates, activeIndex, theme, onSelect, anchorRef, placement = "topLeft", onDismiss }: { command: ComposerCommand; candidates: ComposerCandidate[]; activeIndex: number; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onSelect: (candidate: ComposerCandidate) => void; anchorRef: RefObject<HTMLElement | null>; placement: CanvasFloatingPanelPlacement; onDismiss: () => void }) {
    const { t } = useTranslation();
    const activeItemRef = useRef<HTMLButtonElement | null>(null);
    useEffect(() => { activeItemRef.current?.scrollIntoView({ block: "nearest" }); }, [activeIndex]);
    return (
        <CanvasFloatingPanel open anchorRef={anchorRef} placement={placement} width={320} padding={4} variant="page" className="thin-scrollbar-reveal" ariaLabel={t(command.type === "skill" ? "agent.composer.skills.select" : "agent.composer.mentions.selectResource")} onOpenChange={(open) => { if (!open) onDismiss(); }}>
            {/* editor blur 守卫靠 [data-agent-command-menu] 识别焦点落入菜单；CanvasFloatingPanel 不透传
                data 属性，故在 portal 内容上挂同名标记（缺它守卫永远不命中，菜单会被误关）。 */}
            <div data-agent-command-menu>
                <div className="flex items-center justify-between px-3 pb-1.5 pt-2 text-meta" style={{ color: theme.node.faint }}>
                    <span>{t(command.type === "skill" ? "agent.composer.skills.select" : "agent.composer.mentions.selectResource")}</span>
                    {command.type === "skill" && command.query ? <span className="truncate pl-3">{command.query}</span> : <span className="tabular-nums">{candidates.length}</span>}
                </div>
                <div role="listbox" aria-label={t(command.type === "skill" ? "agent.composer.skills.select" : "agent.composer.mentions.selectResource")} className="p-1">
                    {candidates.length ? candidates.map((candidate, index) => {
                        const reference = candidate.type === "resource" ? candidate.reference : null;
                        const title = candidate.type === "skill" ? candidate.name : reference?.title || "";
                        const description = candidate.type === "skill" ? candidate.description : reference ? `${agentReferenceMarker(reference)} · ${canvasReferenceKindLabel(reference.kind)}` : "";
                        const query = command.type === "skill" ? command.query.trim() : "";
                        return (
                            <button key={candidate.type === "skill" ? candidate.name : reference?.nodeId} ref={index === activeIndex ? activeItemRef : undefined} type="button" role="option" aria-selected={index === activeIndex} className={candidate.type === "skill" ? "block w-full rounded-lg px-2 py-1.5 text-left transition hover:bg-accent" : "flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-2 text-left transition hover:bg-accent"} style={{ background: index === activeIndex ? theme.toolbar.activeBg : undefined, color: index === activeIndex ? theme.toolbar.activeText : theme.node.text }} onPointerDown={(event) => { event.preventDefault(); onSelect(candidate); }}>
                                {candidate.type === "skill" ? (
                                    <span className="block min-w-0">
                                        <span className="flex items-baseline text-sm font-medium leading-5"><span className="mr-px font-normal" style={{ color: theme.node.faint }}>/</span><HighlightMatches text={title} query={query} /></span>
                                        <span className="mt-0.5 block truncate text-xs leading-4" style={{ color: theme.node.muted }}><HighlightMatches text={description} query={query} /></span>
                                    </span>
                                ) : (
                                    <>
                                        <ReferencePreview reference={candidate.reference} />
                                        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{title}</span><span className="mt-0.5 block truncate text-xs" style={{ color: theme.node.muted }}>{description}</span></span>
                                    </>
                                )}
                            </button>
                        );
                    }) : <div className="px-3 py-6 text-center text-xs" style={{ color: theme.node.muted }}>{t(command.type === "skill" ? "agent.composer.skills.empty" : "agent.composer.mentions.noResources")}</div>}
                </div>
            </div>
        </CanvasFloatingPanel>
    );
}

/** Skill 过滤命中片段：加粗 + faint 下划线（query 为空原样返回）。 */
function HighlightMatches({ text, query }: { text: string; query: string }) {
    if (!query) return <>{text}</>;
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const parts: ReactNode[] = [];
    let cursor = 0;
    let at = lowerText.indexOf(lowerQuery);
    while (at >= 0) {
        if (at > cursor) parts.push(text.slice(cursor, at));
        parts.push(<mark key={at} className="bg-transparent font-bold underline decoration-from-font underline-offset-2">{text.slice(at, at + query.length)}</mark>);
        cursor = at + query.length;
        at = lowerText.indexOf(lowerQuery, cursor);
    }
    parts.push(text.slice(cursor));
    return <>{parts}</>;
}

function ReferencePreview({ reference }: { reference: CanvasResourceReference }) {
    if (reference.kind === "image" && reference.previewUrl) return <img src={reference.previewUrl} alt="" className="size-9 rounded-md object-cover" />;
    const Icon = canvasReferenceIcon(reference.kind);
    return <span className="grid size-9 shrink-0 place-items-center"><Icon className="size-4" /></span>;
}

function createReferenceToken(reference: AgentCanvasReference, theme: (typeof canvasThemes)[keyof typeof canvasThemes]) {
    const token = createToken("resource", agentReferenceMarker(reference), theme);
    token.dataset.nodeId = reference.nodeId;
    token.title = reference.title;
    if (reference.kind === "image" && reference.previewUrl) {
        const image = document.createElement("img");
        image.src = reference.previewUrl;
        image.alt = "";
        image.className = agentInlineTokenMediaClass;
        token.append(image);
    }
    token.append(document.createTextNode(agentReferenceMarker(reference)));
    return token;
}

function createSkillToken(name: string, theme: (typeof canvasThemes)[keyof typeof canvasThemes]) {
    const token = createToken("skill", `/${name}`, theme);
    token.className = `${agentInlineTokenClass.replace("rounded-md", "rounded-full")} px-2`;
    // 与候选菜单行同构：淡化 slash + 名称（无圆点，见 mock ③ B'）
    const slash = document.createElement("span");
    slash.textContent = "/";
    slash.style.color = theme.node.faint;
    slash.style.marginRight = "1px";
    token.append(slash, document.createTextNode(name));
    return token;
}

function createToken(kind: "resource" | "skill", marker: string, theme: (typeof canvasThemes)[keyof typeof canvasThemes]) {
    const token = document.createElement("span");
    token.contentEditable = "false";
    token.dataset.agentToken = marker;
    token.dataset.agentTokenKind = kind;
    token.className = agentInlineTokenClass;
    Object.assign(token.style, { background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text } as CSSProperties);
    return token;
}

function insertTokenAtCaret(editor: HTMLElement, token: HTMLElement) {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const space = document.createTextNode(" ");
    if (!range || !editor.contains(range.startContainer)) {
        editor.append(token, space);
        placeCaretAfter(space);
        return;
    }
    range.deleteContents();
    range.insertNode(space);
    range.insertNode(token);
    placeCaretAfter(space);
}

function insertTextAtCaret(text: string) {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    placeCaretAfter(node);
}

function placeCaretAfter(node: Node) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function removeTextBeforeCaret(length: number) {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (range.startContainer.nodeType !== Node.TEXT_NODE || range.startOffset < length) return;
    range.setStart(range.startContainer, range.startOffset - length);
    range.deleteContents();
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
}

function deleteAdjacentToken(key: string) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    const previous = key === "Backspace";
    const target = adjacentToken(range, previous);
    if (!target) return false;
    const caret = document.createTextNode("");
    target.replaceWith(caret);
    const nextRange = document.createRange();
    nextRange.setStart(caret, 0);
    nextRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(nextRange);
    return true;
}

function adjacentToken(range: Range, previous: boolean) {
    const container = range.startContainer;
    const offset = range.startOffset;
    if (container.nodeType === Node.TEXT_NODE) {
        const text = container.textContent || "";
        if (previous ? offset > 0 : offset < text.length) return null;
        return tokenSibling(container, previous);
    }
    const children = Array.from(container.childNodes);
    const node = children[previous ? offset - 1 : offset];
    return node instanceof HTMLElement && node.dataset.agentToken ? node : tokenSibling(node || container, previous);
}

function tokenSibling(node: Node, previous: boolean) {
    let current: Node | null = previous ? node.previousSibling : node.nextSibling;
    while (current?.nodeType === Node.TEXT_NODE && !(current.textContent || "").trim()) current = previous ? current.previousSibling : current.nextSibling;
    return current instanceof HTMLElement && current.dataset.agentToken ? current : null;
}

function syncSelectedMetadata(editor: HTMLElement) {
    const state = useAgentStore.getState();
    const nodeIds = new Set(Array.from(editor.querySelectorAll<HTMLElement>("[data-agent-token-kind='resource']")).map((item) => item.dataset.nodeId));
    const references = state.canvasReferences.filter((item) => nodeIds.has(item.nodeId));
    if (references.length !== state.canvasReferences.length) state.setAgentState({ canvasReferences: references });
}

function textBeforeCaret(editor: HTMLElement | null) {
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return "";
    const range = selection.getRangeAt(0).cloneRange();
    if (!editor.contains(range.startContainer)) return "";
    range.setStart(editor, 0);
    return range.toString();
}

function serializeEditor(editor: HTMLElement) {
    return serializeNodes(editor.childNodes).replace(/﻿/g, "");
}

function serializeNodes(nodes: NodeListOf<ChildNode>) {
    let result = "";
    nodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            result += node.textContent || "";
            return;
        }
        if (!(node instanceof HTMLElement)) return;
        const marker = node.dataset.agentToken;
        if (marker) result += marker;
        else if (node.tagName === "BR") result += "\n";
        else {
            if (["DIV", "P"].includes(node.tagName) && result && !result.endsWith("\n")) result += "\n";
            result += serializeNodes(node.childNodes);
        }
    });
    return result;
}
