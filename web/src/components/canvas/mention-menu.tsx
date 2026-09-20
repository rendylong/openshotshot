import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { FileText, Image as ImageIcon, Music2, Video } from "lucide-react";

import i18n from "@/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { AssetMentionCandidate } from "@/lib/canvas/asset-mentions";

type Theme = (typeof canvasThemes)[keyof typeof canvasThemes];

export type MentionMenuItem =
    | { kind: "reference"; reference: CanvasResourceReference }
    | { kind: "asset"; candidate: AssetMentionCandidate };

export type MentionMenuGroup = { label: string; items: MentionMenuItem[] };

/** @ 候选浮层列表（编辑器共用）：只负责渲染与滚动跟随；@ 触发、键盘导航与插入由宿主编辑器持有 */
export function MentionMenu({ groups, activeIndex, theme, onSelect }: { groups: MentionMenuGroup[]; activeIndex: number; theme: Theme; onSelect: (item: MentionMenuItem) => void }) {
    const selectedRef = useRef(false);
    const activeItemRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        activeItemRef.current?.scrollIntoView({ block: "nearest" });
    }, [activeIndex, groups]);

    const select = (item: MentionMenuItem) => {
        if (selectedRef.current) return;
        selectedRef.current = true;
        onSelect(item);
    };

    let index = -1;
    return (
        <>
            {groups.map((group) => (
                <div key={group.label}>
                    <div className="px-2 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide opacity-50">{group.label}</div>
                    {group.items.map((item) => {
                        index += 1;
                        const active = index === activeIndex;
                        const id = item.kind === "reference" ? item.reference.id : item.candidate.assetId;
                        return (
                            <button
                                key={`${item.kind}:${id}`}
                                ref={active ? activeItemRef : undefined}
                                type="button"
                                className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition"
                                style={{ background: active ? theme.toolbar.activeBg : "transparent", color: active ? theme.toolbar.activeText : theme.node.text }}
                                onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); select(item); }}
                                onClick={(event) => { event.preventDefault(); event.stopPropagation(); select(item); }}
                            >
                                <ItemPreview item={item} />
                                <span className="min-w-0 flex-1">
                                    <span className="block font-medium">{item.kind === "reference" ? item.reference.label : item.candidate.title}</span>
                                    <span className="block truncate opacity-65">{item.kind === "reference" ? item.reference.text || item.reference.title : i18n.t(item.candidate.kind === "video" ? "canvas.composer.assetTag.video" : "canvas.composer.assetTag.image")}</span>
                                </span>
                            </button>
                        );
                    })}
                </div>
            ))}
        </>
    );
}

function ItemPreview({ item }: { item: MentionMenuItem }) {
    if (item.kind === "asset") {
        return item.candidate.coverUrl
            ? <img src={item.candidate.coverUrl} alt="" className="size-9 rounded-md object-cover" />
            : <span className="grid size-9 shrink-0 place-items-center rounded-md bg-black/10"><ImageIcon className="size-4" /></span>;
    }
    const reference = item.reference;
    if (reference.kind === "image" && reference.previewUrl) return <img src={reference.previewUrl} alt="" className="size-9 rounded-md object-cover" />;
    if (reference.kind === "video" && reference.previewUrl) return <video src={reference.previewUrl} className="size-9 rounded-md bg-black object-cover" muted preload="metadata" />;
    const Icon = reference.kind === "audio" ? Music2 : reference.kind === "video" ? Video : reference.kind === "image" ? ImageIcon : FileText;
    return (
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-black/10">
            <Icon className="size-4" />
        </span>
    );
}

/** 资产 chip DOM 构建（面板 chip input 与 Config Composer 共用）：缩略图 + 类型角标 + 标题；
    候选缺失（资产已删）渲染为虚线「未知资产」chip。 */
export function createAssetChipElement(args: { assetId: string; candidate?: AssetMentionCandidate; theme: Theme; unknownLabel: string; onImagePreview?: (url: string) => void }): HTMLSpanElement {
    const wrapper = document.createElement("span");
    wrapper.contentEditable = "false";
    wrapper.dataset.assetId = args.assetId;
    wrapper.className = "mx-px inline-flex h-6 max-w-44 items-center gap-1 overflow-hidden rounded-md border pl-0.5 pr-1.5 text-xs leading-none align-middle";
    Object.assign(wrapper.style, { background: args.theme.toolbar.panel, borderColor: args.theme.node.stroke, color: args.theme.node.text } as CSSProperties);
    wrapper.title = args.candidate?.title || args.unknownLabel;
    if (!args.candidate) {
        wrapper.classList.add("border-dashed");
        wrapper.style.opacity = "0.7";
        const text = document.createElement("span");
        text.className = "block truncate";
        text.textContent = args.unknownLabel;
        wrapper.appendChild(text);
        return wrapper;
    }
    if (args.candidate.coverUrl) {
        const image = document.createElement("img");
        image.src = args.candidate.coverUrl;
        image.alt = args.candidate.title;
        image.className = "size-5 rounded object-cover";
        wrapper.appendChild(image);
    }
    const tag = document.createElement("span");
    tag.className = "shrink-0 text-[10px] leading-none opacity-60";
    tag.textContent = i18n.t(args.candidate.kind === "video" ? "canvas.composer.assetTag.video" : "canvas.composer.assetTag.image");
    wrapper.appendChild(tag);
    const text = document.createElement("span");
    text.className = "block truncate";
    text.textContent = args.candidate.title;
    wrapper.appendChild(text);
    if (args.candidate.coverUrl && args.candidate.kind === "image" && args.onImagePreview) {
        wrapper.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            args.onImagePreview?.(args.candidate!.coverUrl);
        });
    }
    return wrapper;
}
