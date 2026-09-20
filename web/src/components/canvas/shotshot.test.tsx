import { fireEvent, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { Shotshot } from "@/components/canvas/shotshot";

afterEach(() => vi.restoreAllMocks());

beforeAll(() => {
    // jsdom 未实现指针捕获，平移路径会调用；测试环境补 no-op。
    if (!Element.prototype.setPointerCapture) {
        Object.defineProperty(Element.prototype, "setPointerCapture", { configurable: true, writable: true, value: () => {} });
    }
});

function TestNode({ id, media = false }: { id: string; media?: boolean }) {
    return (
        <div data-node-id={id} data-canvas-media={media ? "" : undefined} style={{ width: 50, height: 50 }} data-testid={`node-${id}`}>
            body
        </div>
    );
}

function renderSurface(ui: React.ReactNode, props: Partial<React.ComponentProps<typeof Shotshot>> = {}) {
    const onViewportChange = vi.fn();
    const panGestureRef = { current: false };
    const utils = render(
        <Shotshot containerRef={createRef<HTMLDivElement>()} viewport={{ x: 0, y: 0, k: 1 }} tool="pan" onViewportChange={onViewportChange} panGestureRef={panGestureRef} {...props}>
            {ui}
        </Shotshot>,
    );
    return { ...utils, onViewportChange, panGestureRef, surface: utils.container.firstElementChild as HTMLElement };
}

function dragPointer(target: Element, from: [number, number], to: [number, number], init: Partial<MouseEventInit> = {}) {
    fireEvent.pointerDown(target, { button: 0, clientX: from[0], clientY: from[1], pointerId: 1, ...init });
    fireEvent.pointerMove(window, { clientX: to[0], clientY: to[1], pointerId: 1, ...init });
    fireEvent.pointerUp(window, { clientX: to[0], clientY: to[1], pointerId: 1, ...init });
}

describe("Shotshot zoom gestures", () => {
    test("pans on a plain wheel event without changing zoom", () => {
        const onViewportChange = vi.fn();
        const containerRef = createRef<HTMLDivElement>();
        const { container } = render(<Shotshot containerRef={containerRef} viewport={{ x: 0, y: 0, k: 1 }} tool="select" onViewportChange={onViewportChange} panGestureRef={{ current: false }} children={null} />);

        fireEvent.wheel(container.firstElementChild as HTMLElement, { deltaY: 100, clientX: 50, clientY: 50 });

        expect(onViewportChange).toHaveBeenCalledWith({ x: 0, y: -100, k: 1 });
    });

    test("zooms more responsively on a pinch wheel event", () => {
        const onViewportChange = vi.fn();
        const containerRef = createRef<HTMLDivElement>();
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => {} });
        const { container } = render(<Shotshot containerRef={containerRef} viewport={{ x: 0, y: 0, k: 1 }} tool="select" onViewportChange={onViewportChange} panGestureRef={{ current: false }} children={null} />);

        fireEvent.wheel(container.firstElementChild as HTMLElement, { ctrlKey: true, deltaY: -100, clientX: 50, clientY: 50 });

        expect(onViewportChange).toHaveBeenCalledWith(expect.objectContaining({ k: expect.closeTo(1.8) }));
    });

    test("wheel panning works over media elements", () => {
        const { surface, onViewportChange } = renderSurface(<TestNode id="video" media />);
        const node = surface.querySelector("[data-node-id='video']") as HTMLElement;

        fireEvent.wheel(node, { deltaY: 100, clientX: 10, clientY: 10 });

        expect(onViewportChange).toHaveBeenCalledWith({ x: 0, y: -100, k: 1 });
    });
});

describe("Shotshot pan gestures", () => {
    test("pan tool drags the canvas from the background", async () => {
        const { surface, onViewportChange } = renderSurface(null);

        dragPointer(surface, [10, 10], [40, 25]);

        await waitFor(() => expect(onViewportChange).toHaveBeenCalledWith({ x: 30, y: 15, k: 1 }));
    });

    test("pan tool drags the canvas from a node and leaves the node in place", async () => {
        const { surface, onViewportChange } = renderSurface(<TestNode id="img" />);
        const node = surface.querySelector("[data-node-id='img']") as HTMLElement;

        dragPointer(node, [20, 20], [60, 40]);

        await waitFor(() => expect(onViewportChange).toHaveBeenCalledWith({ x: 40, y: 20, k: 1 }));
    });

    test("a clean press on a node with the pan tool selects it", () => {
        const onNodeClickSelect = vi.fn();
        const { surface } = renderSurface(<TestNode id="img" />, { onNodeClickSelect });
        const node = surface.querySelector("[data-node-id='img']") as HTMLElement;

        fireEvent.pointerDown(node, { button: 0, clientX: 20, clientY: 20 });
        fireEvent.pointerUp(window, { clientX: 21, clientY: 21 });

        expect(onNodeClickSelect).toHaveBeenCalledWith(expect.objectContaining({ shiftKey: false }), "img");
    });

    test("a clean press on the background with the pan tool still deselects", () => {
        const onCanvasDeselect = vi.fn();
        const { surface } = renderSurface(<TestNode id="img" />, { onCanvasDeselect });

        dragPointer(surface, [200, 200], [202, 202]);

        expect(onCanvasDeselect).toHaveBeenCalledTimes(1);
    });

    test("select tool dragging from a node does not pan", async () => {
        const { surface, onViewportChange } = renderSurface(<TestNode id="img" />, { tool: "select" });
        const node = surface.querySelector("[data-node-id='img']") as HTMLElement;

        dragPointer(node, [20, 20], [80, 60]);
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(onViewportChange).not.toHaveBeenCalled();
    });

    test("media elements only yield plain left presses to the player", async () => {
        const { surface, onViewportChange } = renderSurface(<TestNode id="video" media />);
        const video = surface.querySelector("[data-canvas-media]") as HTMLElement;

        dragPointer(video, [10, 10], [50, 40]);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(onViewportChange).not.toHaveBeenCalled();

        dragPointer(video, [10, 10], [50, 40], { button: 1 });
        await waitFor(() => expect(onViewportChange).toHaveBeenCalledWith({ x: 40, y: 30, k: 1 }));
    });

    test("suppressNodePan keeps node presses off the pan gesture", async () => {
        const { surface, onViewportChange } = renderSurface(<TestNode id="img" />, { suppressNodePan: true });
        const node = surface.querySelector("[data-node-id='img']") as HTMLElement;

        dragPointer(node, [20, 20], [80, 60]);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(onViewportChange).not.toHaveBeenCalled();

        dragPointer(surface, [200, 200], [230, 215]);
        await waitFor(() => expect(onViewportChange).toHaveBeenCalledWith({ x: 30, y: 15, k: 1 }));
    });
});
