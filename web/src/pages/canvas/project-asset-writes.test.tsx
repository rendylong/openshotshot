import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App as AntApp } from "antd";

import i18n from "@/i18n";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";
import { useAgentStore } from "@/stores/use-agent-store";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import type { CanvasNodeData, CanvasNodeImage } from "@/types/canvas";
import type { AgentFileContent } from "@/lib/agent/pi-agent-types";
import CanvasPage from "./project";

const storeCanvasImage = vi.hoisted(() => vi.fn());
const storeCanvasMedia = vi.hoisted(() => vi.fn());
const captureVideoFrame = vi.hoisted(() => vi.fn());
const cropDataUrl = vi.hoisted(() => vi.fn());
const saveAs = vi.hoisted(() => vi.fn());

vi.mock("file-saver", () => ({ saveAs }));

// 只替换写入入口；URL 解析保持真实现（IndexedDB 回退/桥读取路径照常工作）。
vi.mock("@/services/project-asset-storage", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/services/project-asset-storage")>()),
    storeCanvasImage,
    storeCanvasMedia,
}));
vi.mock("@/lib/canvas/canvas-video-frame", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/canvas/canvas-video-frame")>()),
    captureVideoFrame,
}));
vi.mock("@/lib/canvas/canvas-image-data", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/canvas/canvas-image-data")>()),
    cropDataUrl,
}));
// 裁剪对话框是画布交互组件，jsdom 无法拖拽裁剪框：桩化确认按钮，页面仍持有 cropImageNode 全链路。
vi.mock("@/components/canvas/canvas-node-crop-dialog", () => ({
    CanvasNodeCropDialog: ({ open, onConfirm }: { open: boolean; onConfirm: (rect: { x: number; y: number; width: number; height: number }) => void }) =>
        open ? <button type="button" onClick={() => onConfirm({ x: 0, y: 0, width: 10, height: 10 })}>crop-confirm-stub</button> : null,
}));
// 资产选择器在 jsdom 中无法交互打开：桩化为一个直接触发插入的按钮（无 storageKey → 走门面上传）。
vi.mock("@/components/canvas/asset-picker-modal", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/components/canvas/asset-picker-modal")>()),
    AssetPickerModal: ({ onInsert }: { onInsert: (payload: { kind: string; dataUrl?: string; title?: string }) => void }) =>
        <button type="button" onClick={() => onInsert({ kind: "image", dataUrl: "data:image/png;base64,QUFB", title: "Assistant Image" })}>picker-insert-stub</button>,
}));

const projectAssetsBridge = vi.hoisted(() => ({
    write: vi.fn(),
    importPath: vi.fn(),
    read: vi.fn(),
    stat: vi.fn(),
    restore: vi.fn(),
    watch: vi.fn(),
    unwatch: vi.fn(),
    onChanged: vi.fn(() => () => undefined),
}));

const PROJECT_REF: CanvasAssetRef = { backend: "project-file", assetId: "asset-1", projectId: "project-1", relativePath: "assets/imported/out.png", revision: 1 };
const GLB_REF: CanvasAssetRef = { backend: "project-file", assetId: "asset-glb", projectId: "project-1", relativePath: "assets/imported/model.glb", revision: 1 };
const GLB_RECORD = {
    ...GLB_REF, originalName: "model.glb", kind: "model3d", mimeType: "model/gltf-binary", bytes: 3, sha256: "hash",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", source: { type: "canvas-import", canvasId: "canvas-1" },
};
const SECONDARY_REF: CanvasAssetRef = { backend: "project-file", assetId: "asset-2", projectId: "project-1", relativePath: "assets/generated/images/second--0000000a.png", revision: 1 };
const SECONDARY_RECORD = {
    ...SECONDARY_REF, originalName: "second.png", kind: "image", mimeType: "image/png", bytes: 3, sha256: "hash",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", source: { type: "generated", nodeId: "node-batch" },
};

let urlCount = 0;
beforeEach(() => {
    // jsdom 没有 createObjectURL：门面桥读取路径与组件解析都要用到。
    const UrlStub = class extends URL {};
    UrlStub.createObjectURL = vi.fn(() => `blob:url-${(urlCount += 1)}`);
    UrlStub.revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", UrlStub);

    window.shotshot = { agent: {}, projectAssets: projectAssetsBridge, platform: "darwin" } as unknown as typeof window.shotshot;
    projectAssetsBridge.watch.mockReset();
    projectAssetsBridge.unwatch.mockReset();
    projectAssetsBridge.watch.mockResolvedValue({ ok: true, value: true });
    projectAssetsBridge.read.mockReset();
    // 默认可读：组件（如 3D 内容）挂载后会经门面解析 assetRef 触发 bridge.read。
    projectAssetsBridge.read.mockResolvedValue({ ok: true, value: { bytes: new Uint8Array([1, 2, 3]), record: GLB_RECORD } });
    projectAssetsBridge.onChanged.mockClear();
    storeCanvasImage.mockReset();
    storeCanvasMedia.mockReset();
    captureVideoFrame.mockReset();
    cropDataUrl.mockReset();
    saveAs.mockReset();
    storeCanvasImage.mockResolvedValue({ url: "blob:stored-image", assetRef: PROJECT_REF, width: 320, height: 200, bytes: 4, mimeType: "image/png" });
    storeCanvasMedia.mockResolvedValue({ url: "blob:stored-glb", assetRef: GLB_REF, bytes: 3, mimeType: "model/gltf-binary" });
    useAgentStore.getState().setCanvasContext(null);
    useAgentStore.setState({ panelOpen: false });
});

afterEach(() => {
    vi.unstubAllGlobals();
    delete window.shotshot;
});

const canvasOf = () => useProjectStore.getState().findCanvas("canvas-1")!.canvas;
const nodesOf = (): CanvasNodeData[] => canvasOf().nodes;

const seedProject = (nodes: CanvasNodeData[]) => {
    useProjectStore.setState({
        hydrated: true,
        projects: [{
            id: "project-1",
            title: "Project One",
            category: "uncategorized",
            icon: "folder",
            color: "#6366f1",
            createdAt: "2026-08-31T00:00:00.000Z",
            updatedAt: "2026-08-31T00:00:00.000Z",
            workspacePath: "/ws/project-1",
            canvases: [{
                id: "canvas-1",
                title: "Canvas One",
                createdAt: "2026-08-31T00:00:00.000Z",
                updatedAt: "2026-08-31T00:00:00.000Z",
                nodes,
                connections: [],
                chatSessions: [],
                activeChatId: null,
                backgroundMode: "lines" as const,
                showImageInfo: false,
                viewport: { x: 0, y: 0, k: 1 },
            }],
        }],
    });
};

const mediaSeed = (id: string, type: CanvasNodeData["type"], storageKey: string): CanvasNodeData => ({
    id,
    type,
    title: id,
    position: { x: 120, y: 120 },
    width: 320,
    height: 240,
    metadata: { content: `blob:${id}`, storageKey, status: "success", mimeType: type === "video" ? "video/mp4" : "image/png", naturalWidth: 640, naturalHeight: 480 },
});

// 桌面重启后的批量图片：content 里的 blob: URL 已失效，图片仅剩 assetRef 可解析。
const batchImage = (id: string, over: Partial<CanvasNodeImage> = {}): CanvasNodeImage => ({
    id,
    status: "success",
    content: `blob:dead-${id}`,
    naturalWidth: 64,
    naturalHeight: 64,
    bytes: 4,
    mimeType: "image/png",
    ...over,
});

const batchNode = (images: CanvasNodeImage[]): CanvasNodeData => ({
    id: "node-batch",
    type: "image",
    title: "Batch",
    position: { x: 0, y: 0 },
    width: 320,
    height: 240,
    metadata: { content: images[0]?.content, status: "success", primaryImageId: images[0]?.id, images },
});

// 展开批量卡片（DOM 中展开卡片先于主图渲染）。
const expandBatch = async () => {
    await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: i18n.t("canvas.node.batchCollapsed") }));
    });
};

const batchCardImages = () => Array.from(document.querySelectorAll<HTMLImageElement>('[data-node-id="node-batch"] img'));

async function renderPage() {
    const view = render(
        <I18nextProvider i18n={i18n}>
            <AntApp>
                <MemoryRouter initialEntries={["/canvas/project-1/canvas-1"]}>
                    <Routes>
                        <Route path="/canvas/:projectId/:canvasId" element={<CanvasPage />} />
                    </Routes>
                </MemoryRouter>
            </AntApp>
        </I18nextProvider>,
    );
    // 恢复 effect 异步完成后才渲染画布主体；顶部工具栏出现即代表 projectLoaded。
    await screen.findByRole("toolbar", { name: i18n.t("canvas.topControls") });
    return view;
}

const importAttachment = async (attachment: AgentFileContent) => {
    const context = useAgentStore.getState().canvasContext;
    if (!context?.importAttachment) throw new Error("canvas import bridge missing");
    await act(async () => {
        await context.importAttachment?.(attachment);
    });
};

describe("canvas page project asset writes", () => {
    it("watches the project workspace while open and unwatches on unmount", async () => {
        seedProject([]);
        const { unmount } = await renderPage();
        expect(projectAssetsBridge.watch).toHaveBeenCalledWith("project-1", "/ws/project-1");
        unmount();
        expect(projectAssetsBridge.unwatch).toHaveBeenCalledWith("project-1");
    });

    it("skips the watch lifecycle on pure web without the bridge", async () => {
        seedProject([]);
        delete (window as { shotshot?: unknown }).shotshot;
        await renderPage();
        expect(projectAssetsBridge.watch).not.toHaveBeenCalled();
    });

    it("imports an uploaded GLB through the project asset facade", async () => {
        seedProject([]);
        await renderPage();
        await importAttachment({ handle: "h-glb", name: "model.glb", kind: "glb", mimeType: "model/gltf-binary", size: 3, dataUrl: "data:model/gltf-binary;base64,Z2xi" });
        expect(storeCanvasMedia).toHaveBeenCalledWith("data:model/gltf-binary;base64,Z2xi", expect.objectContaining({
            projectId: "project-1",
            canvasId: "canvas-1",
            source: expect.objectContaining({ type: "canvas-import" }),
        }));
        const node = nodesOf()[0];
        expect(node.metadata?.model3d?.assetRef).toMatchObject({ backend: "project-file", assetId: "asset-glb" });
    });

    it("creates the canvas node from an already stored attachment without a second write", async () => {
        seedProject([]);
        projectAssetsBridge.read.mockResolvedValue({ ok: true, value: { bytes: new Uint8Array([1, 2, 3]), record: GLB_RECORD } });
        await renderPage();
        await importAttachment({ handle: "asset-glb", name: "model.glb", kind: "glb", mimeType: "model/gltf-binary", size: 3, dataUrl: "data:model/gltf-binary;base64,Z2xi", assetRef: GLB_REF });
        expect(storeCanvasMedia).not.toHaveBeenCalled();
        const node = nodesOf()[0];
        expect(node.metadata?.model3d?.assetRef).toEqual(GLB_REF);
        expect(node.metadata?.model3d?.content).toMatch(/^blob:/);
    });

    it("stores toolbar image uploads as canvas imports", async () => {
        seedProject([]);
        await renderPage();
        const file = new File([new Uint8Array([1])], "pic.png", { type: "image/png" });
        const input = document.querySelector('input[type="file"]') as HTMLInputElement;
        await act(async () => {
            fireEvent.change(input, { target: { files: [file] } });
        });
        expect(storeCanvasImage).toHaveBeenCalledWith(file, expect.objectContaining({
            projectId: "project-1",
            canvasId: "canvas-1",
            source: expect.objectContaining({ type: "canvas-import" }),
        }));
        expect(nodesOf()[0]?.metadata?.assetRef).toMatchObject({ backend: "project-file" });
    });

    it("re-resolves imported image content from the asset ref after reload", async () => {
        // 重启后 content 里的 blob: URL 已失效（无 storageKey 可水合）：渲染器须从 assetRef 读回。
        seedProject([{ id: "image-1", type: "image", title: "Imported", position: { x: 100, y: 100 }, width: 320, height: 240, metadata: { content: "blob:dead-after-reload", assetRef: PROJECT_REF, status: "success", mimeType: "image/png" } }]);
        await renderPage();
        const image = document.querySelector('[data-node-id="image-1"] img') as HTMLImageElement;
        await waitFor(() => expect(image?.getAttribute("src")).toMatch(/^blob:url-/));
        expect(image.getAttribute("src")).not.toBe("blob:dead-after-reload");
    });

    it("stores assistant-inserted images through the project asset facade", async () => {
        seedProject([]);
        await renderPage();
        await act(async () => {
            fireEvent.click(await screen.findByRole("button", { name: "picker-insert-stub" }));
        });
        expect(storeCanvasImage).toHaveBeenCalledWith("data:image/png;base64,QUFB", expect.objectContaining({
            projectId: "project-1",
            canvasId: "canvas-1",
            source: expect.objectContaining({ type: "generated", canvasId: "canvas-1" }),
        }));
        const node = nodesOf().find((item) => item.type === "image");
        expect(node?.metadata?.assetRef).toMatchObject({ backend: "project-file", assetId: "asset-1" });
    });

    it("stores crop and frame-capture results as derived assets", async () => {
        cropDataUrl.mockResolvedValue("data:image/png;base64,Q1JPUHBlZA==");
        captureVideoFrame.mockResolvedValue("data:image/png;base64,RlJBTUU=");
        seedProject([mediaSeed("image-1", "image", "image:seed-1"), mediaSeed("video-1", "video", "video:seed-1")]);
        await renderPage();

        // 裁剪：选中图片节点 → 悬浮工具栏裁剪按钮 → 确认。
        const imageNode = document.querySelector('[data-node-id="image-1"]') as HTMLElement;
        await act(async () => {
            fireEvent.mouseDown(imageNode, { button: 0 });
            fireEvent.mouseUp(imageNode);
        });
        const cropButton = await screen.findByRole("button", { name: i18n.t("canvas.imageTools.cropTitle") });
        await act(async () => {
            fireEvent.click(cropButton);
        });
        const confirm = await screen.findByRole("button", { name: "crop-confirm-stub" });
        await act(async () => {
            fireEvent.click(confirm);
        });
        await waitFor(() => expect(storeCanvasImage).toHaveBeenCalledTimes(1));
        expect(storeCanvasImage).toHaveBeenCalledWith("data:image/png;base64,Q1JPUHBlZA==", expect.objectContaining({
            projectId: "project-1",
            canvasId: "canvas-1",
            nodeId: "image-1",
            source: expect.objectContaining({ type: "derived", nodeId: "image-1" }),
        }));

        // 抽帧：右键视频节点 → 上下文菜单当前帧。
        const videoNode = document.querySelector('[data-node-id="video-1"]') as HTMLElement;
        await act(async () => {
            fireEvent.contextMenu(videoNode);
        });
        const frameItem = await screen.findByRole("button", { name: i18n.t("canvas.videoFrames.current") });
        await act(async () => {
            fireEvent.click(frameItem);
        });
        await waitFor(() => expect(storeCanvasImage).toHaveBeenCalledTimes(2));
        expect(storeCanvasImage).toHaveBeenLastCalledWith("data:image/png;base64,RlJBTUU=", expect.objectContaining({
            projectId: "project-1",
            canvasId: "canvas-1",
            nodeId: "video-1",
            source: expect.objectContaining({ type: "derived", nodeId: "video-1" }),
        }));
    });

    it("resolves expanded batch card images from the asset ref after reload", async () => {
        // 重启后 content 里的 blob: URL 已失效（无 storageKey 可水合）：展开卡片须从 assetRef 读回。
        projectAssetsBridge.read.mockResolvedValue({ ok: true, value: { bytes: new Uint8Array([1, 2, 3]), record: SECONDARY_RECORD } });
        seedProject([batchNode([batchImage("img-1"), batchImage("img-2", { assetRef: SECONDARY_REF })])]);
        await renderPage();
        await expandBatch();
        const images = batchCardImages();
        expect(images).toHaveLength(2);
        const cardImage = images[0];
        await waitFor(() => expect(cardImage.getAttribute("src")).toMatch(/^blob:url-/));
        expect(cardImage.getAttribute("src")).not.toBe("blob:dead-img-2");
        expect(projectAssetsBridge.read).toHaveBeenCalledWith({ workspacePath: "/ws/project-1", ref: SECONDARY_REF });
        // 主图（无 assetRef 的旧图）保持存储内容，失效 URL 不再作为任何 img 的 src。
        expect(images[1].getAttribute("src")).toBe("blob:dead-img-1");
        expect(images.map((image) => image.getAttribute("src"))).not.toContain("blob:dead-img-2");
    });

    it("keeps legacy batch cards on stored content without asset refs", async () => {
        seedProject([batchNode([batchImage("img-1", { content: "blob:legacy-1" }), batchImage("img-2", { content: "blob:legacy-2" })])]);
        await renderPage();
        await expandBatch();
        const srcs = batchCardImages().map((image) => image.getAttribute("src"));
        expect(srcs).toContain("blob:legacy-1");
        expect(srcs).toContain("blob:legacy-2");
        expect(projectAssetsBridge.read).not.toHaveBeenCalled();
    });

    it("downloads an expanded batch card image through the resolved asset url", async () => {
        projectAssetsBridge.read.mockResolvedValue({ ok: true, value: { bytes: new Uint8Array([1, 2, 3]), record: SECONDARY_RECORD } });
        seedProject([batchNode([batchImage("img-1"), batchImage("img-2", { assetRef: SECONDARY_REF })])]);
        await renderPage();
        await expandBatch();
        // 卡片下载按钮在 DOM 中先于主图下载按钮。
        await act(async () => {
            fireEvent.click(screen.getAllByTitle(i18n.t("common.download"))[0]);
        });
        await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(1));
        const [url, name] = saveAs.mock.calls[0];
        expect(url).toMatch(/^blob:url-/);
        expect(url).not.toBe("blob:dead-img-2");
        expect(name).toBe("canvas-image-node-batch-img-2.png");
    });

    it("copies the promoted card image's asset ref when setting batch primary", async () => {
        projectAssetsBridge.read.mockResolvedValue({ ok: true, value: { bytes: new Uint8Array([1, 2, 3]), record: SECONDARY_RECORD } });
        seedProject([batchNode([batchImage("img-1"), batchImage("img-2", { assetRef: SECONDARY_REF })])]);
        await renderPage();
        await expandBatch();
        await act(async () => {
            fireEvent.click(screen.getByTitle(i18n.t("canvas.node.setPrimary")));
        });
        const metadata = nodesOf()[0]?.metadata;
        expect(metadata?.primaryImageId).toBe("img-2");
        expect(metadata?.assetRef).toEqual(SECONDARY_REF);
        expect(metadata?.content).toBe("blob:dead-img-2");
    });
});
