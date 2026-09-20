import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App as AntApp } from "antd";

import i18n from "@/i18n";
import { emitCanvasEvent } from "@/lib/canvas/canvas-event-bus";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";
import { deliverRemoteTaskToProject } from "@/lib/canvas/remote-media-task-result";
import { useAgentStore } from "@/stores/use-agent-store";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { useRemoteMediaTaskStore } from "@/stores/use-remote-media-task-store";
import { useConfigStore, defaultConfig } from "@/stores/use-config-store";
import { useScriptEntityStore } from "@/stores/use-script-entity-store";
import { createEmptyScriptData, type ScriptNodeData, type ScriptShot } from "@/types/script-node";
import type { CanvasNodeData } from "@/types/canvas";
import CanvasPage from "./project";

const storeCanvasImage = vi.hoisted(() => vi.fn());
const storeCanvasMedia = vi.hoisted(() => vi.fn());
const requestGeneration = vi.hoisted(() => vi.fn());
const requestEdit = vi.hoisted(() => vi.fn());
const requestVideoGeneration = vi.hoisted(() => vi.fn());
const storeGeneratedVideo = vi.hoisted(() => vi.fn());
const storeRemoteGeneratedVideo = vi.hoisted(() => vi.fn());
const getMediaBlob = vi.hoisted(() => vi.fn());
const submitAdapterRemoteMediaTask = vi.hoisted(() => vi.fn());
// 直连伪装开关：默认保持旧行为（溯源断言只关心 source，不关心通道选择）；
// 远端任务用例置 false，让真实路由规划器按托管配置选择 remote_task。
const routeOverride = vi.hoisted(() => ({ forceDirect: true }));

// 只替换写入与请求入口；生成路由默认直连，远端任务用例走真实规划器。
vi.mock("@/services/project-asset-storage", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/services/project-asset-storage")>()),
    storeCanvasImage,
    storeCanvasMedia,
}));
vi.mock("@/services/api/image", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/services/api/image")>()),
    requestGeneration,
    requestEdit,
}));
vi.mock("@/services/api/video", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/services/api/video")>()),
    requestVideoGeneration,
    storeGeneratedVideo,
    storeRemoteGeneratedVideo,
}));
vi.mock("@/services/file-storage", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/services/file-storage")>()),
    getMediaBlob,
}));
vi.mock("@/services/api/remote-media-task", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/services/api/remote-media-task")>()),
    submitAdapterRemoteMediaTask,
}));
vi.mock("@/lib/canvas/canvas-media-generation-route", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/canvas/canvas-media-generation-route")>();
    return {
        ...actual,
        planCanvasMediaGeneration: (input: Parameters<typeof actual.planCanvasMediaGeneration>[0]) =>
            routeOverride.forceDirect
                ? { mode: "direct", capability: input.capability, phase: input.phase }
                : actual.planCanvasMediaGeneration(input),
    };
});

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

const STORED_IMAGE_REF: CanvasAssetRef = { backend: "project-file", assetId: "asset-sb", projectId: "project-1", relativePath: "assets/generated/images/sb.png", revision: 1 };
const STORED_AUDIO_REF: CanvasAssetRef = { backend: "project-file", assetId: "asset-audio", projectId: "project-1", relativePath: "assets/imported/line.wav", revision: 1 };
const STORED_VIDEO_REF: CanvasAssetRef = { backend: "project-file", assetId: "asset-video", projectId: "project-1", relativePath: "assets/generated/videos/v2.mp4", revision: 1 };

let urlCount = 0;
beforeEach(() => {
    const UrlStub = class extends URL {};
    UrlStub.createObjectURL = vi.fn(() => `blob:url-${(urlCount += 1)}`);
    UrlStub.revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", UrlStub);

    window.shotshot = { agent: {}, projectAssets: projectAssetsBridge, platform: "darwin" } as unknown as typeof window.shotshot;
    routeOverride.forceDirect = true;
    useRemoteMediaTaskStore.getState().resetForTests();
    submitAdapterRemoteMediaTask.mockReset();
    storeRemoteGeneratedVideo.mockReset();
    getMediaBlob.mockReset();
    projectAssetsBridge.watch.mockReset();
    projectAssetsBridge.watch.mockResolvedValue({ ok: true, value: true });
    projectAssetsBridge.read.mockReset();
    projectAssetsBridge.read.mockResolvedValue({ ok: true, value: { bytes: new Uint8Array([1, 2, 3]), record: { ...STORED_IMAGE_REF, originalName: "sb.png", kind: "image", mimeType: "image/png", bytes: 3, sha256: "hash", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", source: { type: "generated", canvasId: "canvas-1" } } } });
    projectAssetsBridge.onChanged.mockClear();
    storeCanvasImage.mockReset();
    storeCanvasImage.mockResolvedValue({ url: "blob:stored-image", assetRef: STORED_IMAGE_REF, width: 320, height: 200, bytes: 4, mimeType: "image/png", storageKey: "image:stored-sb" });
    storeCanvasMedia.mockReset();
    storeCanvasMedia.mockResolvedValue({ url: "blob:stored-audio", assetRef: STORED_AUDIO_REF, bytes: 4, mimeType: "audio/wav", durationMs: 1200, storageKey: "audio:stored" });
    requestGeneration.mockReset();
    requestGeneration.mockResolvedValue([{ dataUrl: "data:image/png;base64,QUFB", width: 320, height: 200 }]);
    requestEdit.mockReset();
    requestEdit.mockResolvedValue([{ dataUrl: "data:image/png;base64,QUFB", width: 320, height: 200 }]);
    requestVideoGeneration.mockReset();
    requestVideoGeneration.mockResolvedValue({ url: "data:video/mp4;base64,AAAA", width: 640, height: 360 });
    storeGeneratedVideo.mockReset();
    storeGeneratedVideo.mockResolvedValue({ url: "blob:stored-video", assetRef: STORED_VIDEO_REF, width: 640, height: 360, bytes: 4, mimeType: "video/mp4", durationMs: 4000, storageKey: "video:stored" });

    useConfigStore.setState({
        // canvasImageCount 钳到 1：默认 3 张/次会让单次生成产生 3 个写入调用，干扰逐调用断言。
        config: { ...defaultConfig, canvasImageCount: "1", channels: [{ ...defaultConfig.channels[0]!, apiKey: "test-key" }] },
    });
    useScriptEntityStore.setState({ entities: [] });
    useAgentStore.getState().setCanvasContext(null);
    useAgentStore.setState({ panelOpen: false });
});

afterEach(() => {
    vi.unstubAllGlobals();
    delete window.shotshot;
});

const canvasOf = () => useProjectStore.getState().findCanvas("canvas-1")!.canvas;
const nodesOf = (): CanvasNodeData[] => canvasOf().nodes;
const scriptNodeOf = (): CanvasNodeData => nodesOf().find((node) => node.id === "script-1")!;

const seedShot = (over: Partial<ScriptShot>): ScriptShot => ({
    shotId: "shot-1",
    no: 1,
    origin: "generated",
    shotSize: "中景",
    angle: "平视",
    movement: "固定",
    duration: 4,
    mood: "温暖",
    sfx: "",
    dialogue: "",
    descriptionRich: [{ t: "text", v: "猫在厨房" }],
    description: "猫在厨房",
    entityRefs: [],
    composed: true,
    finalPrompt: "镜头一",
    ...over,
});

const seedScript = (script: ScriptNodeData): CanvasNodeData => ({
    id: "script-1",
    type: "script",
    title: "脚本",
    position: { x: 0, y: 0 },
    width: 250,
    height: 170,
    metadata: { script },
});

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
    await screen.findByRole("toolbar", { name: i18n.t("canvas.topControls") });
    return view;
}

const openScriptStudio = () => {
    act(() => {
        emitCanvasEvent("open-script-studio", { nodeId: "script-1" });
    });
};

// 远端任务 BYOK 配置：zhipu 视频与 hiapi 图片模型经真实路由规划器解析为 remote_task 适配器。
const useRemoteChannelConfig = () => {
    const zhipu = { ...defaultConfig.channels[0]!, id: "zhipu", name: "Zhipu", provider: "zhipu" as const, apiKey: "test-key", models: [{ name: "cogvideox-3", capability: "video" as const }] };
    const hiapi = { ...defaultConfig.channels[0]!, id: "hiapi", name: "HiAPI", provider: "hiapi" as const, apiKey: "test-key", models: [{ name: "gpt-image-2/image-to-image", capability: "image" as const }] };
    useConfigStore.setState({
        config: {
            ...defaultConfig,
            canvasImageCount: "1",
            channels: [zhipu, hiapi],
            model: "zhipu::cogvideox-3",
            videoModel: "zhipu::cogvideox-3",
            imageModel: "hiapi::gpt-image-2/image-to-image",
        },
    });
};

const gotoComposeStep = async () => {
    openScriptStudio();
    const stepButton = await screen.findByText(i18n.t("canvas.scriptStudio.stepCompose"));
    await act(async () => {
        (stepButton.closest("button") as HTMLButtonElement).click();
    });
};

describe("script project asset attribution", () => {
    it("stores a storyboard image with Script provenance but keeps Script state in metadata", async () => {
        const script = createEmptyScriptData();
        script.entityIds = ["ent-1"];
        script.template = { storyboardFirst: true };
        script.output.shots = [seedShot({ entityRefs: ["ent-1"] })];
        const entityImage: CanvasNodeData = {
            id: "image-ent", type: "image", title: "参考图", position: { x: 400, y: 0 }, width: 320, height: 240,
            // data: 而非 blob:：jsdom 无 blob: fetch，参考图水合（imageToDataUrl）才能直通。
            metadata: { content: "data:image/png;base64,iVBORw0KGgo=", storageKey: "image:ent", status: "success", mimeType: "image/png" },
        };
        seedProject([seedScript(script), entityImage]);
        useScriptEntityStore.setState({
            entities: [{
                id: "ent-1", projectId: "project-1", group: "character", name: "狸花猫",
                refs: [{ id: "ref-1", label: "sheet", state: "ready", source: "generated", nodeId: "image-ent", storageKey: "image:ent" }],
                createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z",
            }],
        });
        await renderPage();
        await gotoComposeStep();

        // 分镜图先行模式：舞台空态提供「生成分镜图」入口 → 设置弹窗确认。
        await act(async () => {
            fireEvent.click(await screen.findByRole("button", { name: i18n.t("canvas.scriptCompose.sbGenerate") }));
        });
        await act(async () => {
            fireEvent.click(await screen.findByRole("button", { name: i18n.t("canvas.scriptCompose.confirmGenerate") }));
        });

        await waitFor(() => expect(storeCanvasImage).toHaveBeenCalledTimes(1));
        expect(storeCanvasImage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            projectId: "project-1",
            canvasId: "canvas-1",
            source: expect.objectContaining({
                type: "generated", scriptNodeId: "script-1", shotId: "shot-1", role: "storyboard",
            }),
        }));
        // 结构化数据仍在 metadata.script（节点 id 映射），不出现第二份文件型脚本状态。
        await waitFor(() => expect(scriptNodeOf().metadata?.script?.output.storyboardNodes?.["shot-1"]).toBeDefined());
        const sbNodeId = scriptNodeOf().metadata?.script?.output.storyboardNodes?.["shot-1"]!;
        const sbNode = nodesOf().find((node) => node.id === sbNodeId);
        expect(sbNode?.metadata?.shotStoryboardRef).toMatchObject({ scriptNodeId: "script-1", shotId: "shot-1" });
        expect(scriptNodeOf().metadata).not.toHaveProperty("scriptFilePath");
        expect(scriptNodeOf().metadata).not.toHaveProperty("scriptFile");
    });

    it("increments video provenance version without overwriting the prior asset", async () => {
        const script = createEmptyScriptData();
        script.output.shots = [seedShot({})];
        script.output.expandedShotNodes = { "shot-1": "video-1" };
        script.output.shotVideoVersions = { "shot-1": [{ nodeId: "video-1", no: 1 }] };
        const videoV1: CanvasNodeData = {
            id: "video-1", type: "video", title: "镜头 1", position: { x: 400, y: 0 }, width: 420, height: 240,
            metadata: { content: "blob:v1", storageKey: "video:v1", status: "success", mimeType: "video/mp4", generationMode: "video", prompt: "镜头一" },
        };
        seedProject([seedScript(script), videoV1]);
        await renderPage();
        await gotoComposeStep();

        // 已有 V1 成片 → 版本控件「重新生成」→ 设置弹窗确认。
        await act(async () => {
            fireEvent.click(await screen.findByRole("button", { name: i18n.t("canvas.scriptCompose.regenerateVideo") }));
        });
        await act(async () => {
            fireEvent.click(await screen.findByRole("button", { name: i18n.t("canvas.scriptCompose.confirmRegenerate") }));
        });

        await waitFor(() => expect(storeGeneratedVideo).toHaveBeenCalledTimes(1));
        const writeContext = storeGeneratedVideo.mock.calls[0]![1] as { source: Record<string, unknown> };
        expect(writeContext.source).toMatchObject({ type: "generated", scriptNodeId: "script-1", shotId: "shot-1", role: "video", version: 2 });
        // 版本表追加 V2，V1 的条目与资产指针原样保留。
        const versions = scriptNodeOf().metadata?.script?.output.shotVideoVersions?.["shot-1"] ?? [];
        expect(versions).toHaveLength(2);
        expect(versions.map((version) => version.no).sort()).toEqual([1, 2]);
        expect(versions.some((version) => version.nodeId === "video-1" && version.no === 1)).toBe(true);
        expect(nodesOf().find((node) => node.id === "video-1")?.metadata?.content).toBe("blob:v1");
    });

    it("attributes agent-generated entity reference images and writes the assetRef back to the slot", async () => {
        const script = createEmptyScriptData();
        script.entityIds = ["ent-1"];
        script.output.shots = [seedShot({ composed: false, finalPrompt: undefined })];
        seedProject([seedScript(script)]);
        useScriptEntityStore.setState({
            entities: [{
                id: "ent-1", projectId: "project-1", group: "character", name: "狸花猫",
                refs: [{ id: "ref-1", label: "sheet", state: "empty" }],
                createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z",
            }],
        });
        await renderPage();

        // Agent 路径（canvas_script_asset 的产出）：add_node(scriptEntityRef) + run_generation，经画布生成。
        const context = useAgentStore.getState().canvasContext;
        if (!context?.applyOps) throw new Error("canvas agent bridge missing");
        await act(async () => {
            context.applyOps([
                { type: "add_node", id: "image-refgen", nodeType: "image", title: "参考图", position: { x: 400, y: 0 }, metadata: { prompt: "tabby chef", scriptEntityRef: { entityId: "ent-1", refId: "ref-1" } } },
                { type: "connect_nodes", fromNodeId: "script-1", toNodeId: "image-refgen" },
                { type: "run_generation", nodeId: "image-refgen", mode: "image", prompt: "tabby chef" },
            ]);
        });

        await waitFor(() => expect(storeCanvasImage).toHaveBeenCalledTimes(1));
        expect(storeCanvasImage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            projectId: "project-1",
            canvasId: "canvas-1",
            nodeId: "image-refgen",
            source: expect.objectContaining({
                type: "generated", scriptNodeId: "script-1", role: "entity-reference",
            }),
        }));
        // 回写槽位携带生成的项目资产 assetRef（预览经 useProjectAssetUrl 消费）。
        await waitFor(() => {
            const slot = useScriptEntityStore.getState().entities.find((entity) => entity.id === "ent-1")!.refs.find((ref) => ref.id === "ref-1");
            expect(slot?.state).toBe("ready");
            expect(slot?.nodeId).toBe("image-refgen");
            expect(slot?.assetRef).toEqual(STORED_IMAGE_REF);
        });
    });

    it("stores an uploaded shot sfx with slot provenance and keeps the assetRef on the shot", async () => {
        const script = createEmptyScriptData();
        script.output.shots = [seedShot({ composed: false, finalPrompt: undefined })];
        seedProject([seedScript(script)]);
        await renderPage();
        openScriptStudio();

        // 镜头表第一行 = 音效列：打开音频选择浮层并上传本地文件。
        const addButtons = await screen.findAllByRole("button", { name: i18n.t("canvas.scriptStudio.audioAdd") });
        await act(async () => {
            fireEvent.click(addButtons[0]!);
        });
        const picker = await screen.findByRole("dialog", { name: i18n.t("canvas.scriptStudio.audioAdd") });
        const fileInput = picker.querySelector('input[type="file"]') as HTMLInputElement;
        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [new File([new Uint8Array([1])], "line.wav", { type: "audio/wav" })] } });
        });

        await waitFor(() => expect(storeCanvasMedia).toHaveBeenCalledTimes(1));
        expect(storeCanvasMedia).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            projectId: "project-1",
            canvasId: "canvas-1",
            source: expect.objectContaining({
                type: "canvas-import", scriptNodeId: "script-1", shotId: "shot-1", role: "sfx",
            }),
        }));
        await waitFor(() => expect(scriptNodeOf().metadata?.script?.output.shots[0]?.sfxAudio?.assetRef).toEqual(STORED_AUDIO_REF));
    });

    it("carries video lineage through the remote_task adapter channel into the project asset source", async () => {
        // 远端任务链路（视频恒走 remote_task 适配器）：真实路由规划器 + 真实任务记录 + 真实交付。
        routeOverride.forceDirect = false;
        useRemoteChannelConfig();
        submitAdapterRemoteMediaTask.mockResolvedValue({ taskId: "remote-video-1" });
        storeRemoteGeneratedVideo.mockResolvedValue({ url: "blob:remote-video", storageKey: "video:remote", width: 640, height: 360, bytes: 4, mimeType: "video/mp4", durationMs: 4000 });
        getMediaBlob.mockResolvedValue(new Blob([new Uint8Array([1])], { type: "video/mp4" }));
        storeCanvasMedia.mockResolvedValue({ url: "blob:stored-video-remote", assetRef: STORED_VIDEO_REF, bytes: 4, mimeType: "video/mp4", durationMs: 4000 });
        const script = createEmptyScriptData();
        script.output.shots = [seedShot({})];
        script.output.expandedShotNodes = { "shot-1": "video-1" };
        script.output.shotVideoVersions = { "shot-1": [{ nodeId: "video-1", no: 1 }] };
        const videoV1: CanvasNodeData = {
            id: "video-1", type: "video", title: "镜头 1", position: { x: 400, y: 0 }, width: 420, height: 240,
            metadata: { content: "blob:v1", storageKey: "video:v1", status: "success", mimeType: "video/mp4", generationMode: "video", prompt: "镜头一" },
        };
        seedProject([seedScript(script), videoV1]);
        await renderPage();
        await gotoComposeStep();
        await act(async () => {
            fireEvent.click(await screen.findByRole("button", { name: i18n.t("canvas.scriptCompose.regenerateVideo") }));
        });
        await act(async () => {
            fireEvent.click(await screen.findByRole("button", { name: i18n.t("canvas.scriptCompose.confirmRegenerate") }));
        });

        // 任务记录携带脚本溯源；adapterId 证明这是真实规划器选出的远端视频任务。
        const task = await waitFor(() => {
            const saved = useRemoteMediaTaskStore.getState().tasks.find((item) => item.capability === "video");
            expect(saved?.remoteTaskId).toBe("remote-video-1");
            return saved!;
        });
        expect(task.adapterId).toBe("zhipu.video");
        expect(task.target.nodeId).not.toBe("video-1");
        expect(task.scriptSource).toEqual({ scriptNodeId: "script-1", shotId: "shot-1", role: "video", version: 2 });
        // 同步在既有视频节点上打点镜头血统（画布侧再生成靠它反推溯源）。
        expect(nodesOf().find((node) => node.id === "video-1")?.metadata?.shotVideoRef).toEqual({ scriptNodeId: "script-1", shotId: "shot-1" });

        // 交付：清单 source 由任务记录血统合成，canvasId/nodeId 不丢失。
        await act(async () => {
            await deliverRemoteTaskToProject(task, { url: "https://cdn.example.test/v2.mp4" }, { signal: new AbortController().signal, isActive: () => true });
        });
        expect(storeCanvasMedia).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            projectId: "project-1",
            canvasId: "canvas-1",
            source: { type: "generated", canvasId: "canvas-1", nodeId: task.target.nodeId, scriptNodeId: "script-1", shotId: "shot-1", role: "video", version: 2 },
        }));
        await waitFor(() => {
            const child = nodesOf().find((node) => node.id === task.target.nodeId);
            expect(child?.metadata?.assetRef).toEqual(STORED_VIDEO_REF);
        });
    });

    it("carries storyboard provenance through a remote_task image model", async () => {
        routeOverride.forceDirect = false;
        useRemoteChannelConfig();
        submitAdapterRemoteMediaTask.mockResolvedValue({ taskId: "remote-sb-1" });
        const script = createEmptyScriptData();
        script.entityIds = ["ent-1"];
        script.template = { storyboardFirst: true };
        script.output.shots = [seedShot({ entityRefs: ["ent-1"] })];
        const entityImage: CanvasNodeData = {
            id: "image-ent", type: "image", title: "参考图", position: { x: 400, y: 0 }, width: 320, height: 240,
            metadata: { content: "data:image/png;base64,iVBORw0KGgo=", storageKey: "image:ent", status: "success", mimeType: "image/png" },
        };
        seedProject([seedScript(script), entityImage]);
        useScriptEntityStore.setState({
            entities: [{
                id: "ent-1", projectId: "project-1", group: "character", name: "狸花猫",
                refs: [{ id: "ref-1", label: "sheet", state: "ready", source: "generated", nodeId: "image-ent", storageKey: "image:ent" }],
                createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z",
            }],
        });
        await renderPage();
        await gotoComposeStep();
        await act(async () => {
            fireEvent.click(await screen.findByRole("button", { name: i18n.t("canvas.scriptCompose.sbGenerate") }));
        });
        await act(async () => {
            fireEvent.click(await screen.findByRole("button", { name: i18n.t("canvas.scriptCompose.confirmGenerate") }));
        });

        const task = await waitFor(() => {
            const saved = useRemoteMediaTaskStore.getState().tasks.find((item) => item.capability === "image");
            expect(saved?.remoteTaskId).toBe("remote-sb-1");
            return saved!;
        });
        expect(task.adapterId).toBe("hiapi.image");
        expect(task.scriptSource).toEqual({ scriptNodeId: "script-1", shotId: "shot-1", role: "storyboard" });

        // 同步 create 路径同样给新视频节点打上镜头血统（生成视图动作条「批量生成剩余视频」→ 幂等同步展开）。
        await act(async () => {
            fireEvent.click(await screen.findByRole("button", { name: i18n.t("canvas.scriptCompose.batchRemaining") }));
        });
        await waitFor(() => expect(nodesOf().some((node) => node.type === "video")).toBe(true));
        const createdVideo = nodesOf().find((node) => node.type === "video");
        expect(createdVideo?.metadata?.shotVideoRef).toEqual({ scriptNodeId: "script-1", shotId: "shot-1" });
    });

    it("derives video lineage from the node stamp on canvas-initiated regeneration", async () => {
        const script = createEmptyScriptData();
        script.output.shots = [seedShot({})];
        script.output.expandedShotNodes = { "shot-1": "video-1" };
        script.output.shotVideoVersions = { "shot-1": [{ nodeId: "video-1", no: 1 }] };
        const videoV1: CanvasNodeData = {
            id: "video-1", type: "video", title: "镜头 1", position: { x: 400, y: 0 }, width: 420, height: 240,
            metadata: {
                content: "blob:v1", storageKey: "video:v1", status: "success", mimeType: "video/mp4", generationMode: "video", prompt: "镜头一",
                shotVideoRef: { scriptNodeId: "script-1", shotId: "shot-1" },
            },
        };
        seedProject([seedScript(script), videoV1]);
        await renderPage();

        // 画布侧再生成（无 studio 上下文）：run_generation 不带显式来源，靠节点血统反推。
        const context = useAgentStore.getState().canvasContext;
        if (!context?.applyOps) throw new Error("canvas agent bridge missing");
        await act(async () => {
            context.applyOps([{ type: "run_generation", nodeId: "video-1", mode: "video", prompt: "镜头一" }]);
        });

        await waitFor(() => expect(storeGeneratedVideo).toHaveBeenCalledTimes(1));
        const writeContext = storeGeneratedVideo.mock.calls[0]![1] as { source: Record<string, unknown>; nodeId: string };
        expect(writeContext.nodeId).not.toBe("video-1");
        expect(writeContext.source).toEqual({ type: "generated", canvasId: "canvas-1", nodeId: writeContext.nodeId, scriptNodeId: "script-1", shotId: "shot-1", role: "video", version: 1 });
    });

    it("carries lineage when a failed script shot video is retried through the remote_task channel", async () => {
        routeOverride.forceDirect = false;
        useRemoteChannelConfig();
        submitAdapterRemoteMediaTask.mockResolvedValue({ taskId: "remote-retry-1" });
        storeRemoteGeneratedVideo.mockResolvedValue({ url: "blob:remote-retry", storageKey: "video:remote-retry", width: 640, height: 360, bytes: 4, mimeType: "video/mp4", durationMs: 4000 });
        getMediaBlob.mockResolvedValue(new Blob([new Uint8Array([1])], { type: "video/mp4" }));
        storeCanvasMedia.mockResolvedValue({ url: "blob:stored-retry", assetRef: STORED_VIDEO_REF, bytes: 4, mimeType: "video/mp4", durationMs: 4000 });
        const script = createEmptyScriptData();
        script.output.shots = [seedShot({})];
        script.output.expandedShotNodes = { "shot-1": "video-1" };
        script.output.shotVideoVersions = { "shot-1": [{ nodeId: "video-1", no: 1 }] };
        const failedVideo: CanvasNodeData = {
            id: "video-1", type: "video", title: "镜头 1", position: { x: 400, y: 0 }, width: 420, height: 240,
            metadata: { status: "error", errorDetails: "boom", mimeType: "video/mp4", generationMode: "video", prompt: "镜头一", shotVideoRef: { scriptNodeId: "script-1", shotId: "shot-1" } },
        };
        seedProject([seedScript(script), failedVideo]);
        await renderPage();

        // 选中失败节点 → 悬浮工具栏 Retry；无已存远端任务 → 走全新重试分发（真实路由规划器）。
        const videoNode = document.querySelector('[data-node-id="video-1"]') as HTMLElement;
        await act(async () => {
            fireEvent.mouseDown(videoNode, { button: 0 });
            fireEvent.mouseUp(videoNode);
        });
        await act(async () => {
            fireEvent.click(await screen.findByRole("button", { name: i18n.t("canvas.nodeToolbar.retryTitle") }));
        });

        const task = await waitFor(() => {
            const saved = useRemoteMediaTaskStore.getState().tasks.find((item) => item.capability === "video");
            expect(saved?.remoteTaskId).toBe("remote-retry-1");
            return saved!;
        });
        expect(task.adapterId).toBe("zhipu.video");
        expect(task.scriptSource).toEqual({ scriptNodeId: "script-1", shotId: "shot-1", role: "video", version: 1 });

        await act(async () => {
            await deliverRemoteTaskToProject(task, { url: "https://cdn.example.test/retry.mp4" }, { signal: new AbortController().signal, isActive: () => true });
        });
        expect(storeCanvasMedia).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            projectId: "project-1",
            canvasId: "canvas-1",
            source: { type: "generated", canvasId: "canvas-1", nodeId: "video-1", scriptNodeId: "script-1", shotId: "shot-1", role: "video", version: 1 },
        }));
    });

    it("attributes an in-place direct retry of a script shot video via the node lineage stamp", async () => {
        const script = createEmptyScriptData();
        script.output.shots = [seedShot({})];
        script.output.expandedShotNodes = { "shot-1": "video-1" };
        script.output.shotVideoVersions = { "shot-1": [{ nodeId: "video-1", no: 1 }] };
        const failedVideo: CanvasNodeData = {
            id: "video-1", type: "video", title: "镜头 1", position: { x: 400, y: 0 }, width: 420, height: 240,
            metadata: { status: "error", errorDetails: "boom", mimeType: "video/mp4", generationMode: "video", prompt: "镜头一", shotVideoRef: { scriptNodeId: "script-1", shotId: "shot-1" } },
        };
        seedProject([seedScript(script), failedVideo]);
        await renderPage();

        const videoNode = document.querySelector('[data-node-id="video-1"]') as HTMLElement;
        await act(async () => {
            fireEvent.mouseDown(videoNode, { button: 0 });
            fireEvent.mouseUp(videoNode);
        });
        await act(async () => {
            fireEvent.click(await screen.findByRole("button", { name: i18n.t("canvas.nodeToolbar.retryTitle") }));
        });

        await waitFor(() => expect(storeGeneratedVideo).toHaveBeenCalledTimes(1));
        const writeContext = storeGeneratedVideo.mock.calls[0]![1] as { source: Record<string, unknown> };
        expect(writeContext.source).toEqual({ type: "generated", canvasId: "canvas-1", nodeId: "video-1", scriptNodeId: "script-1", shotId: "shot-1", role: "video", version: 1 });
        // 原节点就地重试：版本表不被画布侧重试改动。
        expect(scriptNodeOf().metadata?.script?.output.shotVideoVersions?.["shot-1"]).toHaveLength(1);
    });
});
