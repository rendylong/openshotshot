import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import type { AgentCanvasImageReadRequest, AgentCanvasImageReadResult } from "@/lib/agent/pi-agent-types";
import { createCanvasImageReaderSlot, requestCanvasImage } from "./agent-canvas-image";

class FakePort extends EventEmitter {
    start = vi.fn();
    close = vi.fn(() => this.emit("close"));
}

function success(nodeId: string): AgentCanvasImageReadResult {
    return {
        ok: true,
        image: {
            nodeId,
            title: nodeId,
            dataUrl: "data:image/png;base64,aW1hZ2U=",
            mimeType: "image/png",
            width: 2,
            height: 3,
            sizeBytes: 5,
        },
    };
}

function request(nodeId = "node-1"): AgentCanvasImageReadRequest {
    return { scope: { projectId: "project-1", canvasId: "canvas-1" }, nodeId };
}

function harness(reply: unknown) {
    const port1 = new FakePort();
    const port2 = { id: "renderer-port" };
    const postMessage = vi.fn(() => queueMicrotask(() => port1.emit("message", { data: reply })));
    return {
        port1,
        port2,
        postMessage,
        getWindow: () => ({ isDestroyed: () => false, webContents: { postMessage } }),
        createChannel: async () => ({ port1, port2 }),
    };
}

describe("requestCanvasImage", () => {
    it("resolves one validated renderer reply and closes its private port", async () => {
        const h = harness(success("node-1"));
        const result = await requestCanvasImage(h.getWindow, "agent:canvas-image-request", request(), undefined, h.createChannel);

        expect(result).toEqual(success("node-1"));
        expect(h.postMessage).toHaveBeenCalledWith("agent:canvas-image-request", request(), [h.port2]);
        expect(h.port1.start).toHaveBeenCalledOnce();
        expect(h.port1.close).toHaveBeenCalledOnce();
    });

    it("rejects malformed renderer payloads before they reach the image tool", async () => {
        const valid = success("node-1");
        if (!valid.ok) throw new Error("invalid test fixture");
        const h = harness({ ok: true, image: { ...valid.image, dataUrl: "data:text/plain;base64,bm8=" } });

        await expect(requestCanvasImage(h.getWindow, "channel", request(), undefined, h.createChannel)).resolves.toEqual({ ok: false, error: expect.stringContaining("非法") });
    });

    it("returns immediately when no live window can serve the canvas", async () => {
        const createChannel = vi.fn();

        await expect(requestCanvasImage(() => null, "channel", request(), undefined, createChannel)).resolves.toEqual({ ok: false, error: expect.stringContaining("窗口") });
        expect(createChannel).not.toHaveBeenCalled();
    });

    it("isolates two concurrent replies by their private ports", async () => {
        const first = harness(success("first"));
        const second = harness(success("second"));

        await expect(Promise.all([
            requestCanvasImage(first.getWindow, "channel", request("first"), undefined, first.createChannel),
            requestCanvasImage(second.getWindow, "channel", request("second"), undefined, second.createChannel),
        ])).resolves.toEqual([success("first"), success("second")]);
    });

    it("closes the port and reports an Agent abort", async () => {
        const port1 = new FakePort();
        const controller = new AbortController();
        const getWindow = () => ({ isDestroyed: () => false, webContents: { postMessage: vi.fn() } });
        const pending = requestCanvasImage(getWindow, "channel", request(), controller.signal, async () => ({ port1, port2: {} }));

        controller.abort();

        await expect(pending).resolves.toEqual({ ok: false, error: expect.stringContaining("停止") });
        expect(port1.close).toHaveBeenCalledOnce();
    });
});

describe("createCanvasImageReaderSlot", () => {
    it("does not let stale canvas cleanup remove a newer reader", async () => {
        const slot = createCanvasImageReaderSlot();
        const disposeFirst = slot.set(async () => ({ ok: false, error: "first" }));
        const disposeSecond = slot.set(async () => ({ ok: false, error: "second" }));

        disposeFirst();
        await expect(slot.read(request())).resolves.toEqual({ ok: false, error: "second" });

        disposeSecond();
        await expect(slot.read(request())).resolves.toEqual({ ok: false, error: expect.stringContaining("当前画布") });
    });
});
