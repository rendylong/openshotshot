import React, { useEffect, useRef, useState } from "react";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "@/types/canvas";

type ShotshotProps = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    tool: "select" | "pan";
    backgroundMode?: CanvasBackgroundMode;
    onViewportChange: (viewport: ViewportTransform) => void;
    onCanvasMouseDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onCanvasDeselect?: () => void;
    onCanvasDoubleClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
    onNodeClickSelect?: (event: PointerEvent, nodeId: string) => void;
    onContextMenu?: (event: React.MouseEvent) => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    // 与 Shotshot 共享：平移手势存续期间节点侧的选中/拖拽需让路。
    panGestureRef: React.MutableRefObject<boolean>;
    // 节点按下必须直达节点自身的交互（如参考图选择态）时，平移退回仅背景发起。
    suppressNodePan?: boolean;
    children: React.ReactNode;
};

export function Shotshot({ containerRef, viewport, tool, backgroundMode = "lines", onViewportChange, onCanvasMouseDown, onCanvasDeselect, onCanvasDoubleClick, onNodeClickSelect, onContextMenu, onDrop, panGestureRef, suppressNodePan = false, children }: ShotshotProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const panState = useRef({
        isPanning: false,
        startX: 0,
        startY: 0,
        initialX: 0,
        initialY: 0,
        hasMoved: false,
        startedOnBackground: false,
        nodeId: null as string | null,
    });
    const viewportRef = useRef(viewport);
    const scaleRef = useRef(viewport.k);
    const frameRef = useRef<number | null>(null);
    const nextViewportRef = useRef<ViewportTransform | null>(null);
    const [isSpacePressed, setIsSpacePressed] = useState(false);
    const [isControlPressed, setIsControlPressed] = useState(false);
    const [isPanning, setIsPanning] = useState(false);

    useEffect(() => {
        viewportRef.current = viewport;
        scaleRef.current = viewport.k;
    }, [viewport]);

    useEffect(
        () => () => {
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
        },
        [],
    );

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Control") setIsControlPressed(true);
            if (event.code !== "Space") return;
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']")) return;
            event.preventDefault();
            setIsSpacePressed(true);
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code === "Space") {
                const target = event.target instanceof Element ? event.target : null;
                if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']"))) event.preventDefault();
                setIsSpacePressed(false);
            }
            if (event.key === "Control") setIsControlPressed(false);
        };

        const handleBlur = () => {
            setIsSpacePressed(false);
            setIsControlPressed(false);
            panState.current.isPanning = false;
            panGestureRef.current = false;
            setIsPanning(false);
            document.body.style.cursor = "";
        };

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        window.addEventListener("blur", handleBlur);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
            window.removeEventListener("blur", handleBlur);
        };
    }, []);

    const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;
        const currentViewport = viewportRef.current;
        if (!event.ctrlKey) {
            const nextViewport = {
                x: currentViewport.x - event.deltaX,
                y: currentViewport.y - event.deltaY,
                k: currentViewport.k,
            };
            viewportRef.current = nextViewport;
            onViewportChange(nextViewport);
            return;
        }

        const delta = -event.deltaY;
        const factor = Math.pow(1.8, delta / 100);
        const newScale = Math.min(Math.max(currentViewport.k * factor, 0.05), 5);
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        const worldX = (mouseX - currentViewport.x) / currentViewport.k;
        const worldY = (mouseY - currentViewport.y) / currentViewport.k;

        const nextViewport = {
            x: mouseX - worldX * newScale,
            y: mouseY - worldY * newScale,
            k: newScale,
        };
        viewportRef.current = nextViewport;
        onViewportChange(nextViewport);
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom]")) return;
        if (target?.closest("[data-connection-create-menu]")) return;
        // antd 浮层 portal 到 body，事件会沿组件树冒泡到此容器；浮层内按下不能算画布背景点击，
        // 否则下面的 setPointerCapture 会把后续 pointerup/click 劫持到容器，弹层内点击全部失效。
        if (target?.closest(".ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown,.ant-modal,.ant-drawer")) return;
        // 视频/音频的原生控件只响应普通左键：普通左键让给播放器，中键/space/ctrl 手势仍走画布平移。
        if (target?.closest("[data-canvas-media]") && event.button === 0 && !event.ctrlKey && !isSpacePressed) return;
        const isBackgroundClick = !target?.closest("[data-node-id],[data-connection-id]");
        const temporaryTool = event.ctrlKey || isSpacePressed;
        const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
        const shouldPan = event.button === 1 || (event.button === 0 && activeTool === "pan" && (isBackgroundClick || !suppressNodePan));

        if (shouldPan) {
            event.preventDefault();
            // 从节点/连线上发起的左键平移不捕获指针：捕获会把后续 mouse 事件重定向到容器，
            // 节点上的原生 click/dblclick（查看大图、进入编辑）会失效；平移由 window 级监听驱动。
            if (isBackgroundClick || event.button === 1) event.currentTarget.setPointerCapture(event.pointerId);
            panState.current = {
                isPanning: true,
                startX: event.clientX,
                startY: event.clientY,
                initialX: viewport.x,
                initialY: viewport.y,
                hasMoved: false,
                startedOnBackground: isBackgroundClick,
                nodeId: event.button === 0 && !isBackgroundClick ? (target?.closest("[data-node-id]")?.getAttribute("data-node-id") ?? null) : null,
            };
            panGestureRef.current = true;
            setIsPanning(true);
            document.body.style.cursor = "grabbing";
            return;
        }

        if (event.button === 0 && isBackgroundClick) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onCanvasMouseDown?.(event);
        }
    };

    const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],[data-node-id],[data-connection-id]")) return;
        onCanvasDoubleClick?.(event);
    };

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            if (!panState.current.isPanning) return;

            const dx = event.clientX - panState.current.startX;
            const dy = event.clientY - panState.current.startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                panState.current.hasMoved = true;
            }

            nextViewportRef.current = {
                x: panState.current.initialX + dx,
                y: panState.current.initialY + dy,
                k: scaleRef.current,
            };
            if (frameRef.current) return;
            frameRef.current = requestAnimationFrame(() => {
                frameRef.current = null;
                if (nextViewportRef.current) onViewportChange(nextViewportRef.current);
            });
        };

        const handlePointerUp = (event: PointerEvent) => {
            if (!panState.current.isPanning) return;

            if (!panState.current.hasMoved) {
                // 手型工具接管了节点上的按下，无位移松手时在这里补做点击选中。
                if (panState.current.nodeId) onNodeClickSelect?.(event, panState.current.nodeId);
                else if (panState.current.startedOnBackground) onCanvasDeselect?.();
            }
            panState.current.isPanning = false;
            panGestureRef.current = false;
            setIsPanning(false);
            document.body.style.cursor = "";
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", handlePointerUp);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", handlePointerUp);
            document.body.style.cursor = "";
        };
    }, [onCanvasDeselect, onNodeClickSelect, onViewportChange, panGestureRef]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        // Prevent canvas scrolling from moving the page while preserving native scrolling inside overlays and dialogs.
        const preventWheelScroll = (event: WheelEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;
            event.preventDefault();
        };
        container.addEventListener("wheel", preventWheelScroll, { passive: false });
        return () => container.removeEventListener("wheel", preventWheelScroll);
    }, [containerRef]);

    const temporaryTool = isControlPressed || isSpacePressed;
    const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
    const cursor = isPanning ? "grabbing" : activeTool === "pan" ? "grab" : undefined;

    return (
        <div
            ref={containerRef}
            className="relative h-full w-full select-none overflow-hidden"
            style={{ background: theme.canvas.background, cursor }}
            onPointerDown={handlePointerDown}
            onDoubleClick={handleDoubleClick}
            onWheel={handleWheel}
            onContextMenu={onContextMenu}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
        >
            <CanvasGrid viewport={viewport} mode={backgroundMode} />
            <div
                className="absolute origin-top-left"
                style={{
                    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`,
                }}
            >
                {children}
            </div>
        </div>
    );
}

function CanvasGrid({ viewport, mode }: { viewport: ViewportTransform; mode: CanvasBackgroundMode }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (mode === "blank") return null;

    const gridSize = 48 * viewport.k;
    const x = viewport.x % gridSize;
    const y = viewport.y % gridSize;
    const dotSize = viewport.k < 0.12 ? 0.8 : 1.15;
    const backgroundImage =
        mode === "dots" ? `radial-gradient(circle, ${theme.canvas.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)` : `linear-gradient(${theme.canvas.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.canvas.line} 1px, transparent 1px)`;

    return (
        <div
            className="pointer-events-none absolute inset-0 opacity-40"
            style={{
                backgroundImage,
                backgroundSize: `${gridSize}px ${gridSize}px`,
                backgroundPosition: `${x}px ${y}px`,
            }}
        />
    );
}
