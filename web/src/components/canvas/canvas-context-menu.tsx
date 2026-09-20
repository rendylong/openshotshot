import { useEffect } from "react";
import type { ReactNode } from "react";
import { BetweenHorizontalStart, Clapperboard, Copy, Download, GalleryHorizontalEnd, GalleryHorizontal, Maximize2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData, type ContextMenuState } from "@/types/canvas";
import type { VideoFramePosition } from "@/lib/canvas/canvas-video-frame";

export function CanvasNodeContextMenu({ menu, node, canCaptureVideoFrame, groupBatch, onClose, onCaptureVideoFrame, onView, onDownload, onDuplicate, onDelete }: { menu: ContextMenuState; node?: CanvasNodeData | null; canCaptureVideoFrame: boolean; groupBatch?: { start: number; skipped: number; onGenerate: () => void }; onClose: () => void; onCaptureVideoFrame: (position: VideoFramePosition) => void; onView?: () => void; onDownload?: () => void; onDuplicate: () => void; onDelete: () => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    useEffect(() => {
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(".ant-popover")) return;
            onClose();
        };
        window.addEventListener("pointerdown", close);
        return () => window.removeEventListener("pointerdown", close);
    }, [onClose]);

    return (
        <div
            className="fixed z-[80] min-w-44 overflow-hidden rounded-xl border py-1 shadow-2xl"
            style={{ left: menu.x, top: menu.y, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {canCaptureVideoFrame ? (
                <>
                    <MenuButton icon={<BetweenHorizontalStart className="size-4" />} label={t("canvas.videoFrames.first")} onClick={() => onCaptureVideoFrame("first")} />
                    <MenuButton icon={<GalleryHorizontalEnd className="size-4" />} label={t("canvas.videoFrames.last")} onClick={() => onCaptureVideoFrame("last")} />
                    <MenuButton icon={<GalleryHorizontal className="size-4" />} label={t("canvas.videoFrames.current")} onClick={() => onCaptureVideoFrame("current")} />
                    <div className="my-1 border-t" style={{ borderColor: theme.toolbar.border }} />
                </>
            ) : null}
            {menu.type === "node" && node?.type === CanvasNodeType.Image && node.metadata?.content && onView ? (
                <MenuButton icon={<Maximize2 className="size-4" />} label={t("canvas.imageTools.view")} onClick={onView} />
            ) : null}
            {menu.type === "node" && node?.type === CanvasNodeType.Image && node.metadata?.content && onDownload ? (
                <MenuButton icon={<Download className="size-4" />} label={t("common.download")} onClick={onDownload} />
            ) : null}
            {menu.type === "node" ? <MenuButton icon={<Copy className="size-4" />} label={t("canvas.controls.duplicate")} onClick={onDuplicate} /> : null}
            {menu.type === "group" && groupBatch ? (
                groupBatch.start > 0 ? (
                    <MenuButton icon={<Clapperboard className="size-4" />} label={`${t("canvas.groupBatch.generate")}（${groupBatch.start} ${t("canvas.groupBatch.pending")} · ${groupBatch.skipped} ${t("canvas.groupBatch.doneLabel")}）`} onClick={() => { groupBatch.onGenerate(); onClose(); }} />
                ) : (
                    <div className="px-3 py-2 text-xs opacity-60">{t("canvas.groupBatch.none")}</div>
                )
            ) : null}
            <div className="my-1 border-t" style={{ borderColor: theme.toolbar.border }} />
            <MenuButton icon={<Trash2 className="size-4" />} label={t("canvas.controls.delete")} onClick={onDelete} danger />
        </div>
    );
}

function MenuButton({ icon, label, onClick, danger = false }: { icon: ReactNode; label: string; onClick?: () => void; danger?: boolean }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80" style={{ color: danger ? "var(--danger)" : theme.node.text }} onClick={onClick}>
            {icon}
            <span>{label}</span>
        </button>
    );
}
