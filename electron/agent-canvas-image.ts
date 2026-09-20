import type { AgentCanvasImageReadRequest, AgentCanvasImageReadResult } from "@/lib/agent/pi-agent-types";

type MessageEventLike = { data: unknown };

type CanvasImagePort = {
    on(event: "message", listener: (event: MessageEventLike) => void): unknown;
    once(event: "close", listener: () => void): unknown;
    off(event: "message", listener: (event: MessageEventLike) => void): unknown;
    off(event: "close", listener: () => void): unknown;
    start(): void;
    close(): void;
};

type CanvasImageWindow = {
    isDestroyed(): boolean;
    webContents: { postMessage(channel: string, message: unknown, transfer?: any[]): void };
};

type MessageChannelFactory = () => Promise<{ port1: CanvasImagePort; port2: unknown }>;
type CanvasImageReader = (request: AgentCanvasImageReadRequest) => Promise<AgentCanvasImageReadResult>;

export function createCanvasImageReaderSlot() {
    let current: { token: symbol; reader: CanvasImageReader } | null = null;
    return {
        set(reader: CanvasImageReader) {
            const token = Symbol("canvas-image-reader");
            current = { token, reader };
            return () => {
                if (current?.token === token) current = null;
            };
        },
        read(request: AgentCanvasImageReadRequest) {
            return current?.reader(request) ?? Promise.resolve({ ok: false as const, error: "当前画布没有可用的图片读取器" });
        },
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseCanvasImageReadResult(raw: unknown): AgentCanvasImageReadResult | null {
    if (!isRecord(raw) || typeof raw.ok !== "boolean") return null;
    if (!raw.ok) return typeof raw.error === "string" && raw.error.trim() ? { ok: false, error: raw.error } : null;
    if (!isRecord(raw.image)) return null;
    const image = raw.image;
    if (
        typeof image.nodeId !== "string" || !image.nodeId.trim()
        || typeof image.title !== "string"
        || typeof image.dataUrl !== "string" || !/^data:image\/[^;,]+;base64,[A-Za-z0-9+/=]+$/.test(image.dataUrl)
        || typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")
        || typeof image.width !== "number" || !Number.isFinite(image.width) || image.width < 0
        || typeof image.height !== "number" || !Number.isFinite(image.height) || image.height < 0
        || typeof image.sizeBytes !== "number" || !Number.isSafeInteger(image.sizeBytes) || image.sizeBytes < 0
        || (image.imageId !== undefined && typeof image.imageId !== "string")
    ) return null;
    return {
        ok: true,
        image: {
            nodeId: image.nodeId,
            ...(typeof image.imageId === "string" ? { imageId: image.imageId } : {}),
            title: image.title,
            dataUrl: image.dataUrl,
            mimeType: image.mimeType,
            width: image.width,
            height: image.height,
            sizeBytes: image.sizeBytes,
        },
    };
}

async function createMessageChannel(): Promise<{ port1: CanvasImagePort; port2: unknown }> {
    const { MessageChannelMain } = await import("electron");
    return new MessageChannelMain();
}

/**
 * Main -> renderer request/reply pipeline. Each read owns one MessagePort, so
 * concurrent Agent tool calls cannot consume one another's response.
 */
export async function requestCanvasImage(
    getWindow: () => CanvasImageWindow | null,
    channel: string,
    request: AgentCanvasImageReadRequest,
    signal?: AbortSignal,
    createChannel: MessageChannelFactory = createMessageChannel,
): Promise<AgentCanvasImageReadResult> {
    const win = getWindow();
    if (!win || win.isDestroyed()) return { ok: false, error: "当前没有可读取画布图片的窗口" };
    if (signal?.aborted) return { ok: false, error: "画布图片读取已停止" };

    const { port1, port2 } = await createChannel();
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result: AgentCanvasImageReadResult) => {
            if (settled) return;
            settled = true;
            port1.off("message", onMessage);
            port1.off("close", onClose);
            signal?.removeEventListener("abort", onAbort);
            port1.close();
            resolve(result);
        };
        const onMessage = (event: MessageEventLike) => finish(parseCanvasImageReadResult(event.data) ?? { ok: false, error: "renderer 返回了非法画布图片数据" });
        const onClose = () => finish({ ok: false, error: "画布图片读取通道已关闭" });
        const onAbort = () => finish({ ok: false, error: "画布图片读取已停止" });

        port1.on("message", onMessage);
        port1.once("close", onClose);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) return onAbort();

        port1.start();
        try {
            win.webContents.postMessage(channel, request, [port2]);
        } catch (error) {
            finish({ ok: false, error: `无法请求画布图片：${error instanceof Error ? error.message : String(error)}` });
        }
    });
}
