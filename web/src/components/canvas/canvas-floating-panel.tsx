/** 双域浮层原语：variant="canvas" 画布 L2 皮肤 / variant="page" 页面弹层皮肤；放 canvas/ 目录沿用 spec D17 路径，DESIGN.md 原语清单登记。 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { Z_LAYERS } from "@/lib/design/z-layers";

export type CanvasFloatingPanelPlacement = "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";

type CanvasFloatingPanelProps = {
    open: boolean;
    anchorRef: RefObject<HTMLElement | null>;
    placement?: CanvasFloatingPanelPlacement;
    width?: number;
    padding?: number;
    z?: number;
    variant?: "canvas" | "page";
    /** 追加到浮层根元素（如滚动条变体类）；根元素是唯一滚动层时用它挂 thin-scrollbar 家族。 */
    className?: string;
    ariaLabel: string;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
};

/** 画布/页面通用浮层骨架：锚点定位 + portal + 外点/Esc 关闭；滚动/resize 重定位不关闭（spec §6.2）。
 *  定位数学与原 settings popover 逐值一致（width 356 / gap 8 / margin 12），行为不变。 */
export function CanvasFloatingPanel({ open, anchorRef, placement = "topLeft", width = 356, padding = 18, z = Z_LAYERS.canvasOverlay, variant = "canvas", className, ariaLabel, onOpenChange, children }: CanvasFloatingPanelProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setAnchorRect(anchorRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            if (document.activeElement instanceof HTMLElement && panelRef.current?.contains(document.activeElement)) document.activeElement.blur();
            onOpenChange(false);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") onOpenChange(false);
        };

        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        window.addEventListener("keydown", closeOnEscape);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
            window.removeEventListener("keydown", closeOnEscape);
        };
    }, [anchorRef, onOpenChange, open]);

    if (!open || !anchorRect) return null;

    const resolvedPlacement = resolvePlacement(placement, anchorRect);
    const gap = 8;
    const margin = 12;
    const alignRight = resolvedPlacement.endsWith("Right");
    const alignCenter = resolvedPlacement === "top" || resolvedPlacement === "bottom";
    const left = alignCenter ? anchorRect.left + anchorRect.width / 2 - width / 2 : alignRight ? anchorRect.right - width : anchorRect.left;
    const topPlacement = resolvedPlacement.startsWith("top");
    const skin = variant === "canvas"
        ? ({ background: "var(--canvas-surface)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", border: "1px solid var(--canvas-border)", color: "var(--canvas-text)" } as const)
        : ({ background: "var(--popover)", border: "1px solid var(--border)", color: "var(--foreground)" } as const);

    return createPortal(
        <div
            ref={panelRef}
            className={className}
            role="dialog"
            aria-label={ariaLabel}
            onKeyDown={trapTabWithin}
            style={{
                position: "fixed",
                zIndex: z,
                width,
                left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
                ...(topPlacement ? { bottom: window.innerHeight - anchorRect.top + gap, maxHeight: Math.max(260, anchorRect.top - margin * 2) } : { top: anchorRect.bottom + gap, maxHeight: Math.max(260, window.innerHeight - anchorRect.bottom - margin * 2) }),
                borderRadius: 18,
                boxShadow: "var(--elevation-overlay)",
                padding,
                overflowY: "auto",
                ...skin,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            {children}
        </div>,
        document.body,
    );
}

/** bottom/top placement 贴近视口边缘时自动换向：当前侧可用高不足面板 minHeight(260) 且对侧足够才翻转（bottom→top、top→bottom）；左右 placement 不参与。 */
function resolvePlacement(placement: CanvasFloatingPanelPlacement, anchorRect: DOMRect): CanvasFloatingPanelPlacement {
    const gap = 8;
    const margin = 12;
    const minPanelHeight = 260;
    const below = window.innerHeight - anchorRect.bottom - gap - margin * 2;
    const above = anchorRect.top - gap - margin * 2;
    if (placement.startsWith("bottom") && below < minPanelHeight && above >= minPanelHeight) return placement.replace("bottom", "top") as CanvasFloatingPanelPlacement;
    if (placement.startsWith("top") && above < minPanelHeight && below >= minPanelHeight) return placement.replace("top", "bottom") as CanvasFloatingPanelPlacement;
    return placement;
}

/** Tab 圈定（spec §9 必测项）：焦点在面板内循环，不逃逸到画布。 */
function trapTabWithin(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const panel = event.currentTarget;
    const focusables = Array.from(panel.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((el) => !el.hasAttribute("disabled"));
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
    }
}
