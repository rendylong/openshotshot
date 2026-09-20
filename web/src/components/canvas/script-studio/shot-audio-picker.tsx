import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Music2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";

export type AudioNodeLite = { id: string; title: string; storageKey?: string; assetRef?: CanvasAssetRef };

type Props = {
    /** 触发单元格（定位锚 + 关闭回焦） */
    anchor: HTMLElement;
    audioNodes: AudioNodeLite[];
    uploading: boolean;
    /** 当前已引用的画布节点 id（高亮 aria-selected） */
    pickedId?: string;
    onPick: (node: AudioNodeLite) => void;
    onUpload: (file: File) => void;
    onClose: () => void;
};

const POPUP_HEIGHT = 244; // 列表 max 200 + 上传行 ~44：向上翻转的估算高度

/** 镜头音频选择浮层（spec 4.1）：复刻 .entity-picker 惯例；两路来源 = 画布 Audio 节点 / 本地上传。 */
export function ShotAudioPicker({ anchor, audioNodes, uploading, pickedId, onPick, onUpload, onClose }: Props) {
    const { t } = useTranslation();
    const listboxId = useId();
    const rootRef = useRef<HTMLDivElement | null>(null);
    const fileRef = useRef<HTMLInputElement | null>(null);
    const [active, setActive] = useState(0);
    const rect = anchor.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - 276);
    const top = rect.bottom + 4 + POPUP_HEIGHT > window.innerHeight && rect.top - POPUP_HEIGHT - 4 >= 0 ? rect.top - POPUP_HEIGHT - 4 : rect.bottom + 4;

    const closeAndRefocus = () => {
        (anchor.querySelector("input") as HTMLInputElement | null)?.focus();
        onClose();
    };

    useEffect(() => {
        const closeOn = () => closeAndRefocus();
        // 列表自身滚动（键盘高亮跟随 / 列表内滚轮）不算页面滚动，不关闭浮层；resize 仍无条件关闭
        const closeOnScroll = (event: Event) => {
            const target = event.target;
            // window 级滚动事件 target 不是 Node，须先判型再 contains（Node.contains 对非 Node 会抛 TypeError）
            if (target instanceof Node && rootRef.current?.contains(target)) return;
            closeAndRefocus();
        };
        const handleOutside = (event: MouseEvent) => {
            const target = event.target as Node;
            // 浮层本体 portal 在 document.body：点在浮层内（含上传按钮/文件输入）不算外点
            if (anchor.contains(target) || rootRef.current?.contains(target)) return;
            closeAndRefocus();
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                closeAndRefocus();
                return;
            }
            // Tab 聚焦到浮层底部控件（上传按钮/文件输入）时，Enter/方向键交还控件本身，不拦截为选项写入
            const target = event.target;
            if (target instanceof HTMLElement && rootRef.current?.contains(target) && target.closest("button, input")) return;
            if (!audioNodes.length) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const next = (active + (event.key === "ArrowDown" ? 1 : audioNodes.length - 1)) % audioNodes.length;
                setActive(next);
                document.getElementById(`${listboxId}-opt-${next}`)?.scrollIntoView({ block: "nearest" });
            } else if (event.key === "Enter") {
                event.preventDefault();
                const node = audioNodes[active];
                if (node) onPick(node);
            }
        };
        document.addEventListener("mousedown", handleOutside);
        window.addEventListener("scroll", closeOnScroll, true);
        window.addEventListener("resize", closeOn);
        window.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", handleOutside);
            window.removeEventListener("scroll", closeOnScroll, true);
            window.removeEventListener("resize", closeOn);
            window.removeEventListener("keydown", onKey);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [anchor, onClose, audioNodes, active, listboxId]);

    const activeId = audioNodes[active] ? `${listboxId}-opt-${active}` : undefined;

    return createPortal(
        <div ref={rootRef} role="dialog" aria-label={t("canvas.scriptStudio.audioAdd")} className="entity-picker text-sm" style={{ left, top, width: 260 }}>
            <div role="listbox" aria-label={t("canvas.scriptStudio.audioAdd")} id={listboxId} aria-activedescendant={activeId} className="max-h-[200px] overflow-y-auto">
                {audioNodes.map((node, index) => (
                    <div
                        key={node.id}
                        role="option"
                        id={`${listboxId}-opt-${index}`}
                        aria-selected={node.id === pickedId}
                        className={`ep-item${index === active || node.id === pickedId ? " active" : ""}`}
                        onMouseDown={(event) => {
                            event.preventDefault();
                            onPick(node);
                        }}
                        onMouseEnter={() => setActive(index)}
                    >
                        <Music2 className="size-3.5 flex-none text-stone-400" aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{node.title}</span>
                    </div>
                ))}
                {!audioNodes.length
                    ? (
                          <div className="ep-item ep-empty flex-col items-start">
                              <span>{t("canvas.scriptStudio.audioPickerEmpty")}</span>
                              <span className="text-[11px] opacity-60">{t("canvas.scriptStudio.audioPickerEmptyHint")}</span>
                          </div>
                      )
                    : null}
            </div>
            <div className="border-t p-2" style={{ borderColor: "var(--border)" }}>
                <button
                    type="button"
                    className="ep-action flex w-full items-center justify-center gap-1"
                    disabled={uploading}
                    onClick={() => fileRef.current?.click()}
                >
                    {uploading ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <Upload className="size-3.5" aria-hidden />}
                    {uploading ? t("canvas.scriptStudio.audioUploading") : t("canvas.scriptStudio.audioUpload")}
                </button>
                <input
                    ref={fileRef}
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) onUpload(file);
                    }}
                />
            </div>
        </div>,
        document.body,
    );
}
