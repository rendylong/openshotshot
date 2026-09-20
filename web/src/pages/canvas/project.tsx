import { createReferenceImageSession, withReferenceImageSession, type ReferenceImageSession } from "@/services/reference-image-preparation";
import { GenerateStoryboardDialog, type StoryboardSettings } from "@/components/canvas/script-studio/generate-storyboard-dialog";
import { resolveModelForCapability } from "@/stores/use-config-store";
import { falDefaultMetadata } from "@/lib/canvas/fal-settings";
import { assertFalGenerationOperationSupported, isConfiguredFalModel, prepareFalGenerationRequest } from "@/lib/canvas/fal-generation-input";
import { formatFalGenerationError } from "@/lib/models/fal/errors";
import { getConfiguredAutodlWorkflow, prepareAutodlGenerationRequest } from "@/lib/canvas/autodl-generation-input";
import { buildAutodlVideoBody } from "@/services/api/media-adapters/autodl";
import type { MediaGenerateRequest } from "@/services/api/media-adapters/types";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent as ReactChangeEvent, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Group, MousePointerClick, Video } from "lucide-react";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { requestEdit, requestGeneration, requestImageQuestion } from "@/services/api/image";
import { requestAudioGeneration, storeGeneratedAudio } from "@/services/api/audio";
import { requestVideoGeneration, storeGeneratedVideo } from "@/services/api/video";
import { interruptRemoteTasksForTarget, startRemoteCanvasMediaTask, retryRemoteMediaNodeResult } from "@/services/remote-media-task-runner";
import { defaultConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { onCanvasEvent } from "@/lib/canvas/canvas-event-bus";
import { entityWritebackFromNode, entityRefFailureFromNode, deriveConsumptionEdges, imageGenMetadataPatch, managedAudioNodeIds, nextShotVideoNo, planAudioMaterialization, planLibraryRefBackfill, planShotExpansion, planStoryboardExpansion, selectGroupVideoTargets, shouldApplyEntityWriteback, pushShotVideoVersion, selectShotVideoVersion, storyboardImageStateOf, videoGenMetadataPatch, composeStoryboardPrompt, composeEntityRefPrompt } from "@/lib/canvas/script-node-model";
import { SCRIPT_NODE_TYPE } from "@/types/script-node";
import { useScriptEntityStore } from "@/stores/use-script-entity-store";
import { createEmptyScriptData, type ScriptNodeData, type ShotAudioRef, type ShotAudioSlot, type ShotVideoVersion } from "@/types/script-node";
import { ScriptStudio } from "@/components/canvas/script-studio/script-studio";
import type { EntityDraft } from "@/components/canvas/script-studio/entity-drawer";
import { useRemoteMediaTaskStore } from "@/stores/use-remote-media-task-store";
import { resolveImageUrl } from "@/services/image-storage";
import type { StoryboardImageSource } from "@/components/canvas/script-studio/storyboard-image-picker";
import { resolveMediaUrl } from "@/services/file-storage";
import { storeCanvasImage, storeCanvasMedia, resolveCanvasAssetUrl } from "@/services/project-asset-storage";
import { buildLibraryAsset, libraryBlobFromMedia } from "@/services/library-asset-storage";
import type { CanvasAssetRef, ProjectAssetSource } from "@/lib/project-assets/project-asset-types";
import { nanoid } from "nanoid";
import { getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useAssetStore, type ImageAsset } from "@/stores/use-asset-store";
import { useAssetMentionCandidates, useAssetMentionResolver } from "@/hooks/use-asset-mention";
import { useThemeStore } from "@/stores/use-theme-store";
import { cropDataUrl, splitDataUrl, upscaleDataUrl } from "@/lib/canvas/canvas-image-data";
import { fitNodeSize, nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { captureVideoFrame, type VideoFramePosition } from "@/lib/canvas/canvas-video-frame";
import { ensurePasteFileName, extractPasteFiles, isEditablePasteTarget, isMediaFile } from "@/lib/canvas/clipboard-files";
import { App, Button, Modal } from "antd";
import { NODE_DEFAULT_SIZE, getNodeSpec } from "@/constant/canvas";
import { ActiveConnectionPath, ConnectionPath } from "@/components/canvas/canvas-connections";
import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { CanvasNodeContextMenu } from "@/components/canvas/canvas-context-menu";
import { CanvasNodeAngleDialog, type CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import { CanvasNodeCropDialog, type CanvasImageCropRect } from "@/components/canvas/canvas-node-crop-dialog";
import { CanvasNodeMaskEditDialog, type CanvasImageMaskEditPayload } from "@/components/canvas/canvas-node-mask-edit-dialog";
import { CanvasNodeSplitDialog, type CanvasImageSplitParams } from "@/components/canvas/canvas-node-split-dialog";
import { CanvasNodeUpscaleDialog, type CanvasImageUpscaleParams } from "@/components/canvas/canvas-node-upscale-dialog";
import { buildSourceImageReferences, buildNodeGenerationContext, buildNodeGenerationInputs, buildNodeResponseMessages, hydrateNodeGenerationContext, type NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeHoverToolbar, CanvasNodeInfoModal } from "@/components/canvas/canvas-node-hover-toolbar";
import { Shotshot } from "@/components/canvas/shotshot";
import { Minimap } from "@/components/canvas/canvas-mini-map";
import { CanvasNode } from "@/components/canvas/canvas-node";
import { CanvasNodePromptPanel, type CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { CanvasResourcesDrawer } from "@/components/canvas/canvas-resources-drawer";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { useAgentStore } from "@/stores/use-agent-store";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { useAgentBridge } from "@/pages/canvas/hooks/use-agent-bridge";
import { useLibraryAssetSync } from "@/pages/canvas/hooks/use-library-assets-sync";
import { usePluginHost } from "@/pages/canvas/hooks/use-plugin-host";
import { useLegacyAssetMigration } from "@/pages/canvas/hooks/use-legacy-asset-migration";
import { buildNodeMentionReferences, getGenerationResourceNodes, getGroupResourceNodes, isCanvasReferenceNode, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { agentAttachmentNodeType } from "@/lib/agent/agent-attachments";
import type { AgentFileContent } from "@/lib/agent/pi-agent-types";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { applyNodeConfigPatch, audioMetadata, buildAudioGenerationMetadata, buildImageGenerationMetadata, copyImageGenerationMetadata, createCanvasNode, imageMetadata, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { findContainingGroupId, findGroupDropTarget, getConnectionTargetAnchor, normalizeConnection, snapNodesIntoGroup } from "@/lib/canvas/canvas-node-geometry";
import {
    audioExtension,
    buildAngleLabel,
    buildAnglePrompt,
    buildGenerationConfig,
    buildVideoChildConnections,
    findRetrySourceNode,
    generationReferenceUrls,
    getGenerationCount,
    getInputSummary,
    hydrateAssistantImages,
    hydrateCanvasImages,
    imageExtension,
    imageModeSourceNodeTransform,
    isAudioFile,
    isGenerationCanceled,
    resetInterruptedGeneration,
    resolveMetadataReferences,
    shouldMarkSourceStatus,
    sourceNodeReferenceImages,
} from "@/lib/canvas/canvas-generation-helpers";
import { getNodeDefinition, isBuiltinNodeType as isBuiltinType, useNodeRegistryVersion } from "@/lib/canvas/node-registry";
import { registerBuiltinNodes } from "@/components/canvas/nodes/builtin-nodes";
import { MODEL_3D_NODE_TYPE, Model3dViewer, registerModel3dNode } from "@/components/canvas/nodes/model-3d";
import { ensureModel3dViews, ensureSnapshot, getLiveModel3dViews, isPluginNodeType } from "@/lib/canvas/model-3d-snapshot";
import { applyRemoteTaskEvent, applyRemoteTaskState, getEmbeddedRemoteTaskStatus, subscribeRemoteCanvasTaskEvents } from "@/lib/canvas/remote-media-task-result";
import { planCanvasMediaGeneration } from "@/lib/canvas/canvas-media-generation-route";
import { stripReasoningTags } from "@/lib/canvas/strip-reasoning-tags";
import { CanvasPluginManagerModal } from "@/components/canvas/canvas-plugin-manager-modal";
import { CanvasRefreshShell } from "@/components/canvas/canvas-refresh-shell";
import { CanvasTopBar } from "@/components/canvas/canvas-top-bar";
import { ConnectionCreateMenu, NodeCreateMenu, type PendingConnectionCreate } from "@/components/canvas/canvas-create-menus";
import {
    CanvasNodeType,
    type CanvasAssistantImage,
    type CanvasAssistantSession,
    type CanvasConnection,
    type CanvasNodeData,
    type CanvasNodeImage,
    type CanvasNodeText,
    type CanvasNodeMetadata,
    type CanvasNodeTypeId,
    type ConnectionHandle,
    type ContextMenuState,
    type Position,
    type SelectionBox,
    type ViewportTransform,
} from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio } from "@/types/media";

// Register built-in nodes in the shared registry once when the module loads.
registerBuiltinNodes();
registerModel3dNode();

type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

type ConnectionDropTarget = {
    nodeId: string | null;
    isNearNode: boolean;
};

type CanvasHistoryEntry = Pick<CanvasClipboard, "nodes" | "connections"> & {
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
};

type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

/** 脚本产物溯源（项目资产 source 的脚本侧字段）：Script 起源调用点显式传入，或由来源节点血统推导。 */
type ScriptAssetProvenance = Pick<ProjectAssetSource, "scriptNodeId" | "shotId" | "role" | "version">;

const VIDEO_NODE_MAX_WIDTH = 420;
const VIDEO_NODE_MAX_HEIGHT = 420;
// Stable empty reference array prevents `... || []` from invalidating CanvasNode's React.memo on every render.
const EMPTY_REFERENCES: CanvasResourceReference[] = [];
const CONNECTION_HANDLE_HIT_RADIUS = 40;
const CONNECTION_NODE_HIT_PADDING = 32;
const NODE_STATUS_IDLE = "idle" as const;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;
const ACTIVE_REMOTE_TASK_STATUSES = new Set(["submitting", "pending", "waiting_network", "waiting_configuration"]);
export default function CanvasPage() {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return <ShotshotPage />;
}

function ShotshotPage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    // Subscribe to the registry version so plugin registration changes rerender the canvas.
    const nodeRegistryVersion = useNodeRegistryVersion((state) => state.version);
    const params = useParams<{ projectId: string; canvasId: string }>();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const projectId = params.projectId || "";
    const canvasId = params.canvasId || "";
    const agentPanelOpen = useAgentStore((state) => state.panelOpen);
    const toggleAgentPanel = useAgentStore((state) => state.togglePanel);
    const openAgentPanel = useAgentStore((state) => state.openPanel);
    const submitAgentPrompt = useAgentStore((state) => state.submitPrompt);
    const containerRef = useRef<HTMLDivElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const uploadTargetRef = useRef<{ nodeId?: string; position?: Position } | null>(null);
    const clipboardRef = useRef<CanvasClipboard | null>(null);
    const historyRef = useRef<{ past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] }>({ past: [], future: [] });
    const lastHistoryRef = useRef<CanvasHistoryEntry | null>(null);
    const historyCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const applyingHistoryRef = useRef(false);
    const historyPausedRef = useRef(false);
    const didInitialCenterRef = useRef(false);
    const rafRef = useRef<number | null>(null);
    const nodeDraggingRef = useRef(false);
    // Shotshot 平移手势存续标记：手型工具从节点上发起平移时，节点侧选中/拖拽需让路。
    const panGestureRef = useRef(false);
    const dragRef = useRef<{
        isDraggingNode: boolean;
        hasMoved: boolean;
        startX: number;
        startY: number;
        initialSelectedNodes: { id: string; x: number; y: number }[];
    }>({
        isDraggingNode: false,
        hasMoved: false,
        startX: 0,
        startY: 0,
        initialSelectedNodes: [],
    });

    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const cleanupAssetImages = useAssetStore((state) => state.cleanupImages);
    const hydrated = useProjectStore((state) => state.hydrated);
    const createProject = useProjectStore((state) => state.createProject);
    const findCanvas = useProjectStore((state) => state.findCanvas);
    const updateCanvas = useProjectStore((state) => state.updateCanvas);
    const deleteProjects = useProjectStore((state) => state.deleteProjects);
    const pendingPrompt = useProjectStore((state) => state.pendingPrompt);
    const pendingProjectId = useProjectStore((state) => state.pendingProjectId);
    const pendingCanvasId = useProjectStore((state) => state.pendingCanvasId);
    const consumePendingPrompt = useProjectStore((state) => state.consumePendingPrompt);
    const currentProject = useProjectStore((state) => state.projects.find((project) => project.id === projectId));
    const projectWorkspacePath = currentProject?.workspacePath;

    // 资产写入上下文唯一来源：每次写入显式携带项目/画布/节点与来源，禁止在存储函数内读全局活动项目。
    const assetWriteContext = useCallback((source: ProjectAssetSource, nodeId?: string) => ({
        projectId,
        projectTitle: currentProject?.title ?? "",
        workspacePath: projectWorkspacePath,
        canvasId,
        nodeId,
        source: { ...source, canvasId, ...(nodeId ? { nodeId } : {}) },
    }), [projectId, currentProject?.title, projectWorkspacePath, canvasId]);

    // 存量 IDB 媒体迁移：项目打开后静默执行一次（Web 零执行，见 hook 注释）。
    useLegacyAssetMigration(projectId);

    // 桌面端监控项目工作区（外部/Agent 修改会以 changed/missing 事件广播）；纯 Web（无桥或无工作区）跳过。
    useEffect(() => {
        const bridge = window.shotshot?.projectAssets;
        if (!bridge || !projectId || !projectWorkspacePath) return;
        const warnWatchFailure = (reason: unknown) => console.warn("[project-assets] workspace watch failed:", reason instanceof Error ? reason.message : String(reason));
        bridge.watch(projectId, projectWorkspacePath).then((result) => {
            if (!result.ok) warnWatchFailure(result.error);
        }, warnWatchFailure);
        return () => { void bridge.unwatch(projectId); };
    }, [projectId, projectWorkspacePath]);

    const remoteTasks = useRemoteMediaTaskStore((state) => state.tasks);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [canvasTool, setCanvasTool] = useState<"select" | "pan">("pan");
    const [size, setSize] = useState({ width: 1200, height: 720 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [connectingParams, setConnectingParams] = useState<ConnectionHandle | null>(null);
    const [connectionTargetNodeId, setConnectionTargetNodeId] = useState<string | null>(null);
    const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
    const [mouseWorld, setMouseWorld] = useState<Position>({ x: 0, y: 0 });
    const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [nodeCreatePosition, setNodeCreatePosition] = useState<Position | null>(null);
    const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("lines");
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [projectLoaded, setProjectLoaded] = useState(false);
    const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
    const [storyboardRequest, setStoryboardRequest] = useState<{ scriptNodeId: string; shotId?: string } | null>(null);
    const [nodeImageSettingsOpen, setNodeImageSettingsOpen] = useState(false);
    const [dialogNodeId, setDialogNodeId] = useState<string | null>(null);
    const [infoNodeId, setInfoNodeId] = useState<string | null>(null);
    const [pluginManagerOpen, setPluginManagerOpen] = useState(false);
    const [cropNodeId, setCropNodeId] = useState<string | null>(null);
    const [maskEditNodeId, setMaskEditNodeId] = useState<string | null>(null);
    const [splitNodeId, setSplitNodeId] = useState<string | null>(null);
    const [upscaleNodeId, setUpscaleNodeId] = useState<string | null>(null);
    const [superResolveNodeId, setSuperResolveNodeId] = useState<string | null>(null);
    const [angleNodeId, setAngleNodeId] = useState<string | null>(null);
    const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
    const [previewImageId, setPreviewImageId] = useState<string | null>(null);
    const [preview3dNodeId, setPreview3dNodeId] = useState<string | null>(null);
    const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
    const [expandedBatchNodeIds, setExpandedBatchNodeIds] = useState<Set<string>>(new Set());
    const [isNodeDragging, setIsNodeDragging] = useState(false);
    const [isNodeResizing, setIsNodeResizing] = useState(false);
    const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);
    const [referencePickerNodeId, setReferencePickerNodeId] = useState<string | null>(null);

    const nodesRef = useRef(nodes);
    const connectionsRef = useRef(connections);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const viewportRef = useRef(viewport);
    const focusAnimRef = useRef<number | null>(null);
    const generateNodeRef = useRef<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, onVideoChild?: (childId: string) => void, onImageChild?: (childId: string) => void, managedImageModel?: string, referenceSession?: ReferenceImageSession, scriptSource?: ScriptAssetProvenance) => Promise<void>) | null>(null);
    const generateStoryboardRef = useRef<((scriptNodeId: string, shotId: string, settings: StoryboardSettings) => void) | null>(null);
    const connectingParamsRef = useRef(connectingParams);
    const connectionTargetNodeIdRef = useRef(connectionTargetNodeId);
    const selectionBoxRef = useRef(selectionBox);
    const pendingConnectionCreateRef = useRef(pendingConnectionCreate);
    const generationRequestsRef = useRef(new Map<string, CanvasGenerationRequest>());
    const activeRemoteNodeIds = useMemo(() => {
        const ids = new Set<string>();
        remoteTasks.forEach((task) => {
            if (task.target.projectId !== projectId || task.target.canvasId !== canvasId || !ACTIVE_REMOTE_TASK_STATUSES.has(task.status)) return;
            const embeddedStatus = getEmbeddedRemoteTaskStatus(task);
            if (embeddedStatus && !ACTIVE_REMOTE_TASK_STATUSES.has(embeddedStatus)) return;
            ids.add(task.target.nodeId);
            if (task.target.sourceNodeId) ids.add(task.target.sourceNodeId);
        });
        return ids;
    }, [canvasId, currentProject, projectId, remoteTasks]);

    const createHistoryEntry = useCallback(
        (): CanvasHistoryEntry => ({
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            chatSessions,
            activeChatId,
            backgroundMode,
            showImageInfo,
        }),
        [activeChatId, backgroundMode, chatSessions, showImageInfo],
    );

    const cleanupCanvasFiles = useCallback(
        (extra?: unknown) => {
            cleanupAssetImages({ extra, history: historyRef.current, lastHistory: lastHistoryRef.current });
        },
        [cleanupAssetImages],
    );

    const startGenerationRequest = useCallback((targetNodeId: string, originNodeId: string, runningId = originNodeId, controller = new AbortController()) => {
        const previous = generationRequestsRef.current.get(targetNodeId);
        if (previous?.controller !== controller) previous?.controller.abort();
        generationRequestsRef.current.set(targetNodeId, { targetNodeId, originNodeId, runningNodeId: runningId, controller });
        return controller;
    }, []);

    const finishGenerationRequest = useCallback((targetNodeId: string, controller: AbortController) => {
        const request = generationRequestsRef.current.get(targetNodeId);
        if (request?.controller === controller) generationRequestsRef.current.delete(targetNodeId);
    }, []);

    const stopGenerationByRunningId = useCallback(async (runningId: string) => {
        const affectedNodeIds = new Set<string>();
        generationRequestsRef.current.forEach((request) => {
            if (request.runningNodeId !== runningId) return;
            request.controller.abort();
            generationRequestsRef.current.delete(request.targetNodeId);
            affectedNodeIds.add(request.targetNodeId);
            affectedNodeIds.add(request.originNodeId);
        });
        setRunningNodeId((current) => (current === runningId ? null : current));
        const interruptedTasks = await interruptRemoteTasksForTarget(projectId, canvasId, runningId);
        interruptedTasks.forEach((task) => {
            affectedNodeIds.add(task.target.nodeId);
            if (task.target.sourceNodeId) affectedNodeIds.add(task.target.sourceNodeId);
        });
        if (!affectedNodeIds.size) return;
        setNodes((prev) => {
            const withRemoteState = interruptedTasks.reduce((current, task) => applyRemoteTaskState(current, task), prev);
            return withRemoteState.map((node) =>
                affectedNodeIds.has(node.id) && node.metadata?.status === NODE_STATUS_LOADING && !node.metadata.remoteTask && !node.metadata.images?.some((image) => image.remoteTask)
                    ? {
                          ...node,
                          metadata: {
                              ...node.metadata,
                              status: NODE_STATUS_IDLE,
                              errorDetails: undefined,
                              images: node.metadata.images?.map((image) => (image.status === NODE_STATUS_LOADING ? { ...image, status: NODE_STATUS_ERROR, errorDetails: t("common.requestCanceled") } : image)),
                              texts: node.metadata.texts?.map((text) => (text.status === NODE_STATUS_LOADING ? { ...text, status: NODE_STATUS_ERROR, errorDetails: t("common.requestCanceled") } : text)),
                          },
                      }
                    : node,
            );
        });
    }, [canvasId, projectId, t]);

    const confirmStopGeneration = useCallback(
        (nodeId: string) => {
            modal.confirm({
                title: t("canvas.projectPage.stopTitle"),
                content: t("canvas.projectPage.stopDescription"),
                okText: t("canvas.projectPage.stop"),
                cancelText: t("canvas.projectPage.continue"),
                okButtonProps: { danger: true },
                onOk: () => stopGenerationByRunningId(nodeId),
            });
        },
        [modal, stopGenerationByRunningId, t],
    );

    useEffect(() => {
        if (!hydrated) return;
        setProjectLoaded(false);
        const found = findCanvas(canvasId);
        if (!found || found.project.id !== projectId) {
            navigate("/projects", { replace: true });
            return;
        }
        const { canvas } = found;

        const restore = async () => {
            const restoredNodes = await hydrateCanvasImages(resetInterruptedGeneration(canvas.nodes));
            const restoredSessions = await hydrateAssistantImages(canvas.chatSessions || []);
            setNodes(restoredNodes);
            setConnections(canvas.connections);
            setChatSessions(restoredSessions);
            setActiveChatId(canvas.activeChatId || null);
            setBackgroundMode(canvas.backgroundMode);
            setShowImageInfo(canvas.showImageInfo || false);
            setViewport(canvas.viewport);
            historyRef.current = { past: [], future: [] };
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
            lastHistoryRef.current = {
                nodes: restoredNodes,
                connections: canvas.connections,
                chatSessions: restoredSessions,
                activeChatId: canvas.activeChatId || null,
                backgroundMode: canvas.backgroundMode,
                showImageInfo: canvas.showImageInfo || false,
            };
            setHistoryState({ canUndo: false, canRedo: false });
            setProjectLoaded(true);
        };
        void restore();
    }, [hydrated, navigate, findCanvas, canvasId, projectId]);

    useEffect(() => subscribeRemoteCanvasTaskEvents((event) => {
        if (event.projectId === projectId && event.canvasId === canvasId) setNodes((current) => applyRemoteTaskEvent(current, event));
    }), [canvasId, projectId]);

    useEffect(() => {
        if (!projectLoaded || !["new", "recent", "choose"].includes(searchParams.get("mode") || "")) return;
        openAgentPanel();
    }, [openAgentPanel, projectLoaded, searchParams]);

    // Consume a prompt handed off from the composer home: hand it to the Agent
    // (which queues it until connected + ready), then clear the handoff so a
    // second visit doesn't re-trigger generation.
    useEffect(() => {
        if (!projectLoaded || !pendingPrompt || pendingProjectId !== projectId || pendingCanvasId !== canvasId) return;
        submitAgentPrompt(pendingPrompt, useAgentStore.getState().pendingAttachments);
        consumePendingPrompt();
    }, [canvasId, consumePendingPrompt, pendingCanvasId, pendingProjectId, pendingPrompt, projectId, projectLoaded, submitAgentPrompt]);

    useEffect(() => {
        if (!projectLoaded || applyingHistoryRef.current || historyPausedRef.current) return;
        const next = createHistoryEntry();
        const previous = lastHistoryRef.current;
        if (
            previous?.nodes === next.nodes &&
            previous.connections === next.connections &&
            previous.chatSessions === next.chatSessions &&
            previous.activeChatId === next.activeChatId &&
            previous.backgroundMode === next.backgroundMode &&
            previous.showImageInfo === next.showImageInfo
        )
            return;

        if (historyCommitTimerRef.current) clearTimeout(historyCommitTimerRef.current);
        historyCommitTimerRef.current = setTimeout(() => {
            const current = createHistoryEntry();
            const last = lastHistoryRef.current;
            if (!last) return;
            historyRef.current.past = [...historyRef.current.past.slice(-49), last];
            historyRef.current.future = [];
            setHistoryState({ canUndo: true, canRedo: false });
            lastHistoryRef.current = current;
            historyCommitTimerRef.current = null;
        }, 180);

        return () => {
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
        };
    }, [activeChatId, backgroundMode, chatSessions, connections, createHistoryEntry, nodes, projectLoaded, showImageInfo]);

    useEffect(() => {
        if (!projectLoaded || historyPausedRef.current) return;
        updateCanvas(projectId, canvasId, { nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo });
    }, [activeChatId, backgroundMode, chatSessions, connections, nodes, projectId, canvasId, projectLoaded, showImageInfo, updateCanvas]);

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    useEffect(() => {
        if (!projectLoaded) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        viewportSaveTimerRef.current = setTimeout(() => {
            updateCanvas(projectId, canvasId, { viewport: viewportRef.current });
            viewportSaveTimerRef.current = null;
        }, 500);
        return () => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        };
    }, [projectId, canvasId, projectLoaded, updateCanvas, viewport]);

    useLayoutEffect(() => {
        nodesRef.current = nodes;
        connectionsRef.current = connections;
        selectedNodeIdsRef.current = selectedNodeIds;
        viewportRef.current = viewport;
        connectingParamsRef.current = connectingParams;
        connectionTargetNodeIdRef.current = connectionTargetNodeId;
        pendingConnectionCreateRef.current = pendingConnectionCreate;
    }, [nodes, connections, selectedNodeIds, viewport, connectingParams, connectionTargetNodeId, pendingConnectionCreate]);

    useLayoutEffect(() => {
        selectionBoxRef.current = selectionBox;
    }, [selectionBox]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            setSize({ width: rect.width, height: rect.height });
            if (!didInitialCenterRef.current) {
                didInitialCenterRef.current = true;
                setViewport({ x: rect.width / 2, y: rect.height / 2, k: 1 });
            }
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, []);

    const screenToCanvas = useCallback((clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const currentViewport = viewportRef.current;
        const localX = clientX - (rect?.left || 0);
        const localY = clientY - (rect?.top || 0);

        return {
            x: (localX - currentViewport.x) / currentViewport.k,
            y: (localY - currentViewport.y) / currentViewport.k,
        };
    }, []);

    const getCanvasCenter = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        return screenToCanvas((rect?.left || 0) + (rect?.width || size.width) / 2, (rect?.top || 0) + (rect?.height || size.height) / 2);
    }, [screenToCanvas, size.height, size.width]);

    const importAgentAttachment = useCallback(async (attachment: AgentFileContent) => {
        const existing = nodesRef.current.find((node) => node.metadata?.sourceHandle === attachment.handle);
        if (existing) return existing;
        const nodeType = agentAttachmentNodeType(attachment.kind) as CanvasNodeTypeId;
        // Task 5 起附件发送时已落库：有 assetRef 直接消费，不再把 Data URL 二次写入存储；
        // 旧消息无 assetRef 时经门面补一次画布导入写入（纯 Web 落 IndexedDB）。
        const stored: { url: string; assetRef?: CanvasAssetRef; storageKey?: string; mimeType?: string; bytes?: number; width?: number; height?: number; durationMs?: number } = attachment.assetRef
            ? { url: await resolveCanvasAssetUrl(attachment.assetRef, attachment.dataUrl), assetRef: attachment.assetRef, mimeType: attachment.mimeType, bytes: attachment.size }
            : await storeCanvasMedia(attachment.dataUrl, assetWriteContext({ type: "canvas-import" }));
        const metadata: CanvasNodeMetadata = {
            content: stored.url,
            storageKey: stored.storageKey,
            status: NODE_STATUS_SUCCESS,
            mimeType: stored.mimeType || attachment.mimeType,
            bytes: stored.bytes || attachment.size,
            sourceHandle: attachment.handle,
            ...(stored.assetRef ? { assetRef: stored.assetRef } : {}),
        };
        let width = NODE_DEFAULT_SIZE[CanvasNodeType.Image].width;
        let height = NODE_DEFAULT_SIZE[CanvasNodeType.Image].height;
        if (attachment.kind === "image") {
            const image = await readImageMeta(attachment.dataUrl);
            const size = fitNodeSize(image.width, image.height);
            width = size.width;
            height = size.height;
            metadata.naturalWidth = image.width;
            metadata.naturalHeight = image.height;
        } else if (attachment.kind === "video") {
            const size = fitNodeSize(stored.width || 1280, stored.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
            width = size.width;
            height = size.height;
            metadata.naturalWidth = stored.width;
            metadata.naturalHeight = stored.height;
            metadata.durationMs = stored.durationMs;
        } else if (attachment.kind === "glb") {
            const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            width = spec.width;
            height = spec.height;
            metadata.model3d = { name: attachment.name, content: stored.url, storageKey: stored.storageKey, mimeType: stored.mimeType || attachment.mimeType, bytes: stored.bytes || attachment.size, ...(stored.assetRef ? { assetRef: stored.assetRef } : {}) };
        } else {
            const spec = NODE_DEFAULT_SIZE[CanvasNodeType.File];
            width = spec.width;
            height = spec.height;
        }
        const center = getCanvasCenter();
        const node: CanvasNodeData = { id: `${nodeType}-${nanoid()}`, type: nodeType, title: attachment.name, position: { x: center.x - width / 2, y: center.y - height / 2 }, width, height, metadata };
        nodesRef.current = [...nodesRef.current, node];
        setNodes(nodesRef.current);
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
        return node;
    }, [assetWriteContext, getCanvasCenter]);

    const setConnecting = useCallback((next: ConnectionHandle | null) => {
        connectingParamsRef.current = next;
        setConnectingParams(next);
        if (!next) {
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
        }
    }, []);

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current || nodeImageSettingsOpen || !selectedNodeIdsRef.current.has(nodeId)) return;
            setToolbarNodeId(nodeId);
        },
        [nodeImageSettingsOpen],
    );

    const hideNodeToolbar = useCallback(() => {}, []);

    const connectNodes = useCallback(
        (current: ConnectionHandle, targetNodeId: string) => {
            if (current.nodeId === targetNodeId) return;

            const connection = normalizeConnection(current.nodeId, targetNodeId, nodesRef.current, current.handleType);
            if (!connection) {
                message.warning(t("canvas.projectPage.configConnection"));
                return;
            }
            const { fromNodeId, toNodeId } = connection;
            const exists = connectionsRef.current.some((conn) => conn.fromNodeId === fromNodeId && conn.toNodeId === toNodeId);
            if (!exists) {
                setConnections((prev) => [...prev, { id: `conn-${Date.now()}`, fromNodeId, toNodeId }]);
            }
            setContextMenu(null);
        },
        [message, t],
    );

    const createConnectedNode = useCallback(
        (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video | CanvasNodeType.Audio, pending: PendingConnectionCreate) => {
            const metadata = type === CanvasNodeType.Config ? { model: effectiveConfig.imageModel || effectiveConfig.model, size: effectiveConfig.size, count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count) } : undefined;
            const newNode = createCanvasNode(type, pending.position, metadata);
            if ([CanvasNodeType.Config, CanvasNodeType.Image, CanvasNodeType.Video].includes(type as CanvasNodeType)) Object.assign(newNode.metadata!, falDefaultMetadata({ ...effectiveConfig, model: resolveModelForCapability(effectiveConfig, undefined, type === CanvasNodeType.Video ? "video" : "image") }));
            const connection = normalizeConnection(pending.connection.nodeId, newNode.id, [...nodesRef.current, newNode], pending.connection.handleType);
            if (!connection) {
                message.warning(t("canvas.projectPage.configConnection"));
                return;
            }
            setNodes((prev) => [...prev, newNode]);
            setConnections((prev) => [...prev, { id: nanoid(), ...connection }]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio) setDialogNodeId(newNode.id);
            setPendingConnectionCreate(null);
            setConnecting(null);
        },
        [effectiveConfig, message, setConnecting, t],
    );

    const cancelPendingConnectionCreate = useCallback(() => {
        setPendingConnectionCreate(null);
        setConnecting(null);
    }, [setConnecting]);

    const getConnectionDropTarget = useCallback(
        (clientX: number, clientY: number, current: ConnectionHandle): ConnectionDropTarget => {
            const world = screenToCanvas(clientX, clientY);
            const scale = Math.max(viewportRef.current.k, 0.05);
            const padding = CONNECTION_NODE_HIT_PADDING / scale;
            const handleRadius = CONNECTION_HANDLE_HIT_RADIUS / scale;
            let isNearNode = false;
            let bestNodeId: string | null = null;
            let bestPriority = Number.POSITIVE_INFINITY;

            [...nodesRef.current]
                .reverse()
                .forEach((node) => {
                    const anchor = getConnectionTargetAnchor(node, current);
                    const dx = world.x - anchor.x;
                    const dy = world.y - anchor.y;
                    const hitsHandle = dx * dx + dy * dy <= handleRadius * handleRadius;
                    const hitsInside = world.x >= node.position.x && world.x <= node.position.x + node.width && world.y >= node.position.y && world.y <= node.position.y + node.height;
                    const hitsExpanded = world.x >= node.position.x - padding && world.x <= node.position.x + node.width + padding && world.y >= node.position.y - padding && world.y <= node.position.y + node.height + padding;

                    if (!hitsHandle && !hitsInside && !hitsExpanded) return;
                    isNearNode = true;
                    if (node.id === current.nodeId || !normalizeConnection(current.nodeId, node.id, nodesRef.current, current.handleType)) return;

                    const priority = hitsInside ? 0 : hitsHandle ? 1 : 2;
                    if (priority < bestPriority) {
                        bestNodeId = node.id;
                        bestPriority = priority;
                    }
                });

            return { nodeId: bestNodeId, isNearNode };
        },
        [screenToCanvas],
    );

    const visibleNodes = useMemo(() => {
        const padding = 280;
        const rect = containerRef.current?.getBoundingClientRect();
        const width = rect?.width || size.width;
        const height = rect?.height || size.height;
        const viewLeft = -viewport.x / viewport.k - padding;
        const viewTop = -viewport.y / viewport.k - padding;
        const viewRight = viewLeft + width / viewport.k + padding * 2;
        const viewBottom = viewTop + height / viewport.k + padding * 2;

        return nodes.filter((node) => node.position.x + node.width > viewLeft && node.position.x < viewRight && node.position.y + node.height > viewTop && node.position.y < viewBottom);
    }, [nodes, size.height, size.width, viewport.k, viewport.x, viewport.y]);

    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    // The toolbar follows a single selected node selected by click, creation, marquee, or keyboard.
    // It stays hidden for multi-selection and while isNodeDragging is true.
    const singleSelectedNodeId = selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null;
    const toolbarNode = (toolbarNodeId ? nodeById.get(toolbarNodeId) || null : null) || (singleSelectedNodeId ? nodeById.get(singleSelectedNodeId) || null : null);
    const infoNode = infoNodeId ? nodeById.get(infoNodeId) || null : null;
    const cropNode = cropNodeId ? nodeById.get(cropNodeId) || null : null;
    const maskEditNode = maskEditNodeId ? nodeById.get(maskEditNodeId) || null : null;
    const splitNode = splitNodeId ? nodeById.get(splitNodeId) || null : null;
    const upscaleNode = upscaleNodeId ? nodeById.get(upscaleNodeId) || null : null;
    const superResolveNode = superResolveNodeId ? nodeById.get(superResolveNodeId) || null : null;
    const angleNode = angleNodeId ? nodeById.get(angleNodeId) || null : null;
    const contextMenuNode = contextMenu?.type === "node" ? nodeById.get(contextMenu.nodeId) || null : null;
    const previewNode = previewNodeId ? nodeById.get(previewNodeId) || null : null;
    const preview3dNode = preview3dNodeId ? nodeById.get(preview3dNodeId) || null : null;
    const previewContent = previewImageId ? previewNode?.metadata?.images?.find((image) => image.id === previewImageId)?.content : previewNode?.metadata?.content;
    const hasMultipleSelectedNodes = selectedNodeIds.size > 1;
    const activeNodeId = hasMultipleSelectedNodes ? null : hoveredNodeId || (selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null);
    const groupChildCountById = useMemo(() => {
        const map = new Map<string, number>();
        nodes.forEach((node) => {
            const groupId = node.metadata?.groupId;
            if (groupId) map.set(groupId, (map.get(groupId) || 0) + 1);
        });
        return map;
    }, [nodes]);
    const relatedHighlight = useMemo(() => {
        const nodeIds = new Set<string>();
        const connectionIds = new Set<string>();

        if (!activeNodeId) return { nodeIds, connectionIds };

        const addNode = (nodeId: string) => {
            nodeIds.add(nodeId);
            if (nodeById.get(nodeId)?.type === CanvasNodeType.Group) nodes.forEach((node) => node.metadata?.groupId === nodeId && nodeIds.add(node.id));
        };
        addNode(activeNodeId);
        connections.forEach((connection) => {
            if (connection.fromNodeId !== activeNodeId && connection.toNodeId !== activeNodeId) return;
            connectionIds.add(connection.id);
            addNode(connection.fromNodeId);
            addNode(connection.toNodeId);
        });

        return { nodeIds, connectionIds };
    }, [activeNodeId, connections, nodeById, nodes]);

    const configInputsById = useMemo(() => {
        const map = new Map<string, NodeGenerationInput[]>();
        nodes.forEach((node) => {
            if (node.type !== CanvasNodeType.Config) return;
            map.set(node.id, buildNodeGenerationInputs(node.id, nodes, connections));
        });
        return map;
    }, [connections, nodes]);
    const mentionReferencesByNodeId = useMemo(() => {
        const map = new Map<string, ReturnType<typeof buildNodeMentionReferences>>();
        nodes.forEach((node) => map.set(node.id, buildNodeMentionReferences(node, nodes, connections)));
        return map;
    }, [connections, nodes]);
    const assetCandidates = useAssetMentionCandidates();
    const resolveAsset = useAssetMentionResolver();
    const connectedNodesByNodeId = useMemo(() => {
        const map = new Map<string, CanvasNodeData[]>();
        connections.forEach((connection) => {
            // 血统边（再生成来源）不是参考，不进引用栏/参考选择高亮
            if (connection.lineage) return;
            const source = nodeById.get(connection.fromNodeId);
            if (!source) return;
            const connected = map.get(connection.toNodeId);
            if (connected) connected.push(source);
            else map.set(connection.toNodeId, [source]);
        });
        return map;
    }, [connections, nodeById]);
    const referenceConnectedNodeIds = useMemo(() => new Set([referencePickerNodeId, ...(referencePickerNodeId ? connectedNodesByNodeId.get(referencePickerNodeId)?.filter((node) => isCanvasReferenceNode(node, nodes, { strictReferences: true })).flatMap((node) => node.type === CanvasNodeType.Group ? [node.id, ...getGroupResourceNodes(node.id, nodes).map((child) => child.id)] : [node.id]) || [] : [])].filter((id): id is string => Boolean(id))), [connectedNodesByNodeId, nodes, referencePickerNodeId]);
    const { applyAgentOps } = useAgentBridge({
        projectId,
        canvasId,
        title: currentProject?.title,
        nodes,
        connections,
        selectedNodeIds,
        viewport,
        viewportSize: size,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        viewportRef,
        generateNodeRef,
        generateStoryboardRef,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setViewport,
        setContextMenu,
        importAttachment: importAgentAttachment,
    });
    useLibraryAssetSync();

    const { pluginHost, renderPluginPanel, buildNodeToolbarItems } = usePluginHost({
        effectiveConfig,
        isAiConfigReady,
        openConfigDialog,
        theme,
        nodesRef,
        connectionsRef,
        viewportRef,
        setNodes,
        setDialogNodeId,
        applyAgentOps,
        open3dPreview: setPreview3dNodeId,
        assetWriteContext,
    });
    const createNode = useCallback(
        (type: CanvasNodeTypeId, position?: Position) => {
            const targetPosition = position || getCanvasCenter();
            const configMetadata =
                type === CanvasNodeType.Config
                    ? {
                          model: effectiveConfig.imageModel || effectiveConfig.model,
                          size: effectiveConfig.size,
                          count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                      }
                    : undefined;
            const newNode = createCanvasNode(type, targetPosition, configMetadata);
            if ([CanvasNodeType.Config, CanvasNodeType.Image, CanvasNodeType.Video].includes(type as CanvasNodeType)) Object.assign(newNode.metadata!, falDefaultMetadata({ ...effectiveConfig, model: resolveModelForCapability(effectiveConfig, undefined, type === CanvasNodeType.Video ? "video" : "image") }));

            setNodes((prev) => [...prev, newNode]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            const definition = getNodeDefinition(type);
            // Display-only plugin nodes with hidePanel do not open a panel; custom Panels require autoOpenPanel on creation.
            // Plugin nodes declaring useBuiltinPanel open the built-in generation panel on creation, like image nodes.
            // Built-in image, video, and config nodes retain their existing open-on-create behavior.
            const wantsPanel = definition?.hidePanel
                ? false
                : definition?.Panel
                  ? Boolean(definition.autoOpenPanel)
                  : definition?.useBuiltinPanel
                    ? true
                    : isBuiltinType(type) && type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio && type !== CanvasNodeType.Group;
            if (wantsPanel) setDialogNodeId(newNode.id);
        },
        [effectiveConfig, getCanvasCenter],
    );

    const deleteNodes = useCallback(
        (ids: Set<string>) => {
            if (!ids.size) return;
            const allIds = new Set(ids);
            setNodes((prev) => {
                const next = prev.filter((node) => !allIds.has(node.id));
                return next.map((node) => {
                    const groupId = node.metadata?.groupId;
                    if (groupId && allIds.has(groupId)) return { ...node, metadata: { ...node.metadata, groupId: undefined } };
                    return node;
                });
            });
            setConnections((prev) => prev.filter((conn) => !allIds.has(conn.fromNodeId) && !allIds.has(conn.toNodeId)));
            setSelectedNodeIds(new Set());
            setSelectedConnectionId(null);
            setHoveredNodeId((current) => (current && allIds.has(current) ? null : current));
            setToolbarNodeId((current) => (current && allIds.has(current) ? null : current));
            setDialogNodeId((current) => (current && allIds.has(current) ? null : current));
            setInfoNodeId((current) => (current && allIds.has(current) ? null : current));
            setCropNodeId((current) => (current && allIds.has(current) ? null : current));
            setMaskEditNodeId((current) => (current && allIds.has(current) ? null : current));
            setAngleNodeId((current) => (current && allIds.has(current) ? null : current));
            setPreviewNodeId((current) => (current && allIds.has(current) ? null : current));
            setRunningNodeId((current) => (current && allIds.has(current) ? null : current));
            setReferencePickerNodeId((current) => (current && allIds.has(current) ? null : current));
            setExpandedBatchNodeIds((current) => new Set([...current].filter((nodeId) => !allIds.has(nodeId))));
            setContextMenu((current) => (current?.type === "node" && allIds.has(current.nodeId) ? null : current));
            cleanupCanvasFiles({ projectId, nodes: nodesRef.current.filter((node) => !allIds.has(node.id)), chatSessions });
        },
        [chatSessions, cleanupCanvasFiles, projectId],
    );

    const deleteConnection = useCallback((connectionId: string) => {
        setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
        setSelectedConnectionId((current) => (current === connectionId ? null : current));
        setContextMenu((current) => (current?.type === "connection" && current.connectionId === connectionId ? null : current));
    }, []);

    const disconnectNodeReference = useCallback((fromNodeId: string, toNodeId: string) => {
        setConnections((prev) => prev.filter((connection) => connection.fromNodeId !== fromNodeId || connection.toNodeId !== toNodeId));
    }, []);

    const startNodeReferenceSelection = useCallback((nodeId: string) => {
        setReferencePickerNodeId(nodeId);
        setSelectedNodeIds(new Set([nodeId]));
        setSelectedConnectionId(null);
        setDialogNodeId(null);
    }, []);

    const exitNodeReferenceSelection = useCallback(() => {
        if (!referencePickerNodeId) return;
        setSelectedNodeIds(new Set([referencePickerNodeId]));
        setDialogNodeId(referencePickerNodeId);
        setReferencePickerNodeId(null);
    }, [referencePickerNodeId]);

    const selectNodeReference = useCallback((fromNodeId: string) => {
        if (!referencePickerNodeId || referenceConnectedNodeIds.has(fromNodeId)) return;
        const source = nodesRef.current.find((node) => node.id === fromNodeId);
        if (!source || !isCanvasReferenceNode(source, nodesRef.current)) return;
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId, toNodeId: referencePickerNodeId }]);
    }, [referenceConnectedNodeIds, referencePickerNodeId]);

    useEffect(() => {
        if (!referencePickerNodeId) return;
        const exit = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            exitNodeReferenceSelection();
        };
        window.addEventListener("keydown", exit, true);
        return () => window.removeEventListener("keydown", exit, true);
    }, [exitNodeReferenceSelection, referencePickerNodeId]);

    const deselectCanvas = useCallback(() => {
        cancelPendingConnectionCreate();
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setSelectionBox(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
    }, [cancelPendingConnectionCreate]);

    const duplicateNode = useCallback((nodeId: string) => {
        const source = nodesRef.current.find((node) => node.id === nodeId);
        if (!source) return;

        const id = `${source.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const next: CanvasNodeData = {
            ...source,
            id,
            title: `${source.title} Copy`,
            position: { x: source.position.x + 36, y: source.position.y + 36 },
        };

        setNodes((prev) => [...prev, next]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        if (next.type !== CanvasNodeType.Group) setDialogNodeId(id);
    }, []);

    const copySelectedNodes = useCallback(() => {
        const selectedIds = selectedNodeIdsRef.current;
        if (!selectedIds.size) return;

        const copiedNodes = nodesRef.current
            .filter((node) => selectedIds.has(node.id))
            .map((node) => ({
                ...node,
                position: { ...node.position },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            }));

        if (!copiedNodes.length) return;

        clipboardRef.current = {
            nodes: copiedNodes,
            connections: connectionsRef.current.filter((connection) => selectedIds.has(connection.fromNodeId) && selectedIds.has(connection.toNodeId)).map((connection) => ({ ...connection })),
        };
    }, []);

    const pasteCopiedNodes = useCallback(() => {
        const clipboard = clipboardRef.current;
        if (!clipboard?.nodes.length) return false;

        const center = getCanvasCenter();
        const bounds = clipboard.nodes.reduce(
            (acc, node) => ({
                left: Math.min(acc.left, node.position.x),
                top: Math.min(acc.top, node.position.y),
                right: Math.max(acc.right, node.position.x + node.width),
                bottom: Math.max(acc.bottom, node.position.y + node.height),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const dx = center.x - (bounds.left + bounds.right) / 2;
        const dy = center.y - (bounds.top + bounds.bottom) / 2;
        const idMap = new Map<string, string>();
        const nextNodes = clipboard.nodes.map((node, index) => {
            const id = `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
            idMap.set(node.id, id);
            return {
                ...node,
                id,
                title: node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`,
                position: {
                    x: node.position.x + dx,
                    y: node.position.y + dy,
                },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            };
        });

        const pastedNodes = nextNodes.map((node) => {
            const groupId = node.metadata?.groupId;
            if (!groupId) return node;
            return { ...node, metadata: { ...node.metadata, groupId: idMap.get(groupId) } };
        });

        const nextConnections = clipboard.connections.flatMap((connection, index) => {
            const fromNodeId = idMap.get(connection.fromNodeId);
            const toNodeId = idMap.get(connection.toNodeId);
            if (!fromNodeId || !toNodeId) return [];
            return [
                {
                    ...connection,
                    id: `conn-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
                    fromNodeId,
                    toNodeId,
                },
            ];
        });

        setNodes((prev) => [...prev, ...pastedNodes]);
        setConnections((prev) => [...prev, ...nextConnections]);
        setSelectedNodeIds(new Set(pastedNodes.map((node) => node.id)));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(pastedNodes[0]?.type === CanvasNodeType.Group ? null : pastedNodes[0]?.id || null);
        return true;
    }, [getCanvasCenter]);

    const resetViewport = useCallback(() => {
        setViewport({ x: size.width / 2, y: size.height / 2, k: 1 });
        setContextMenu(null);
    }, [size.height, size.width]);

    const focusNode = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node) return;
            const worldX = node.position.x + node.width / 2;
            const worldY = node.position.y + node.height / 2;
            const k = Math.min(Math.max(Math.min((size.width * 0.6) / node.width, (size.height * 0.6) / node.height), 0.05), 1);
            const target = { x: size.width / 2 - worldX * k, y: size.height / 2 - worldY * k, k };
            setSelectedNodeIds(new Set([nodeId]));
            setSelectedConnectionId(null);
            setContextMenu(null);

            if (focusAnimRef.current) cancelAnimationFrame(focusAnimRef.current);
            const start = { ...viewportRef.current };
            const duration = 450;
            const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
            let startTime: number | null = null;
            const step = (now: number) => {
                if (startTime === null) startTime = now;
                const progress = Math.min((now - startTime) / duration, 1);
                const t = easeOutCubic(progress);
                setViewport({ x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t, k: start.k + (target.k - start.k) * t });
                focusAnimRef.current = progress < 1 ? requestAnimationFrame(step) : null;
            };
            focusAnimRef.current = requestAnimationFrame(step);
        },
        [size.height, size.width],
    );

    useEffect(() => () => void (focusAnimRef.current && cancelAnimationFrame(focusAnimRef.current)), []);

    const applyHistory = useCallback((entry: CanvasHistoryEntry) => {
        if (historyCommitTimerRef.current) {
            clearTimeout(historyCommitTimerRef.current);
            historyCommitTimerRef.current = null;
        }
        applyingHistoryRef.current = true;
        setNodes(entry.nodes);
        setConnections(entry.connections);
        setChatSessions(entry.chatSessions);
        setActiveChatId(entry.activeChatId);
        setBackgroundMode(entry.backgroundMode);
        setShowImageInfo(entry.showImageInfo);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setTimeout(() => {
            lastHistoryRef.current = entry;
            applyingHistoryRef.current = false;
            setHistoryState({ canUndo: historyRef.current.past.length > 0, canRedo: historyRef.current.future.length > 0 });
        });
    }, []);

    const undoCanvas = useCallback(() => {
        const previous = historyRef.current.past.pop();
        const current = lastHistoryRef.current;
        if (!previous || !current) return;
        historyRef.current.future.push(current);
        applyHistory(previous);
    }, [applyHistory]);

    const redoCanvas = useCallback(() => {
        const next = historyRef.current.future.pop();
        const current = lastHistoryRef.current;
        if (!next || !current) return;
        historyRef.current.past.push(current);
        applyHistory(next);
    }, [applyHistory]);

    const createAndOpenProject = useCallback(() => {
        const { projectId, canvasId } = createProject(t("canvas.defaultTitle", { count: useProjectStore.getState().projects.length + 1 }));
        navigate(`/canvas/${projectId}/${canvasId}`);
    }, [createProject, navigate, t]);

    const deleteCurrentProject = useCallback(() => {
        deleteProjects([projectId]);
        cleanupAssetImages();
        navigate("/projects");
    }, [cleanupAssetImages, deleteProjects, navigate, projectId]);

    const exportCurrentProject = useCallback(async () => {
        const project = useProjectStore.getState().projects.find((item) => item.id === projectId);
        if (!project) return message.error(t("canvas.projectPage.notFound"));
        const hide = message.loading(t("canvas.projectPage.exporting"), 0);
        try {
            await exportCanvasProjects([project], project.title || t("canvas.title"));
            message.success(t("canvas.projectPage.exported"));
        } catch (error) {
            console.error(error);
            message.error(t("canvas.sidePanel.exportFailed"));
        } finally {
            hide();
        }
    }, [message, projectId, t]);

    const handleCanvasMouseDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            setContextMenu(null);
            setNodeCreatePosition(null);
            setHoveredNodeId(null);
            setToolbarNodeId(null);
            setDialogNodeId(null);
            if (pendingConnectionCreateRef.current) cancelPendingConnectionCreate();
            if (event.button !== 0) return;

            const world = screenToCanvas(event.clientX, event.clientY);
            const nextSelectionBox = {
                startWorldX: world.x,
                startWorldY: world.y,
                currentWorldX: world.x,
                currentWorldY: world.y,
                additive: event.shiftKey,
                initialSelectedNodeIds: event.shiftKey ? Array.from(selectedNodeIdsRef.current) : [],
            };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            if (!event.shiftKey) {
                setSelectedNodeIds(new Set());
            }

            setSelectedConnectionId(null);
        },
        [cancelPendingConnectionCreate, screenToCanvas],
    );

    // Selection-only logic shared by the bubbling drag entry point and outer capture handler.
    // Returns the single target ID after the click, or null for multi-selection or deselection, to sync the toolbar.
    const selectNodeByEvent = useCallback((event: Pick<ReactMouseEvent, "shiftKey" | "metaKey" | "ctrlKey">, nodeId: string) => {
        const nextSelected = new Set(selectedNodeIdsRef.current);
        if (event.shiftKey || event.metaKey || event.ctrlKey) {
            if (nextSelected.has(nodeId)) nextSelected.delete(nodeId);
            else nextSelected.add(nodeId);
        } else if (!nextSelected.has(nodeId)) {
            nextSelected.clear();
            nextSelected.add(nodeId);
        }
        setSelectedNodeIds(nextSelected);
        const soloId = nextSelected.size === 1 && nextSelected.has(nodeId) ? nodeId : null;
        setToolbarNodeId(soloId);
        return { nextSelected, soloId };
    }, []);

    // 手型工具从节点上发起的平移接管了按下事件，节点选择延迟到无位移松手时由 Shotshot 补做。
    const handleCanvasNodeClickSelect = useCallback((event: PointerEvent, nodeId: string) => {
        setContextMenu(null);
        setHoveredNodeId(null);
        setSelectedConnectionId(null);
        selectNodeByEvent(event, nodeId);
    }, [selectNodeByEvent]);

    // Capture-phase selection lets any inner element, including textarea or iframe, select the node and show its toolbar.
    // It only selects; body onMouseDown still starts dragging, so text selection inside editors does not drag the node.
    // Cache the capture result for the following bubbling drag handler to avoid applying shift-selection twice.
    const pendingSelectionRef = useRef<Set<string> | null>(null);
    const handleNodeSelectCapture = useCallback(
        (event: ReactMouseEvent, nodeId: string) => {
            if (panGestureRef.current) return;
            if (event.button !== 0) return;
            setContextMenu(null);
            setHoveredNodeId(null);
            setSelectedConnectionId(null);
            const { nextSelected } = selectNodeByEvent(event, nodeId);
            pendingSelectionRef.current = nextSelected;
        },
        [selectNodeByEvent],
    );

    const handleNodeMouseDown = useCallback((event: ReactMouseEvent, nodeId: string) => {
        if (panGestureRef.current) return;
        event.stopPropagation();
        // Capture already selected the node; this only starts dragging, with a fallback selection if capture did not run.
        const currentNodes = nodesRef.current;
        const nextSelected = pendingSelectionRef.current ?? selectNodeByEvent(event, nodeId).nextSelected;
        pendingSelectionRef.current = null;
        const dragIds = new Set(nextSelected);
        currentNodes.forEach((node) => {
            if (!nextSelected.has(node.id)) return;
            if (node.type === CanvasNodeType.Group) {
                currentNodes.forEach((child) => {
                    if (child.metadata?.groupId === node.id) dragIds.add(child.id);
                });
            }
        });
        dragRef.current = {
            isDraggingNode: true,
            hasMoved: false,
            startX: event.clientX,
            startY: event.clientY,
            initialSelectedNodes: currentNodes.filter((node) => dragIds.has(node.id)).map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })),
        };
        historyPausedRef.current = true;
        nodeDraggingRef.current = true;
        setIsNodeDragging(true);
    }, []);

    const finishNodeDrag = useCallback((clientX?: number, clientY?: number) => {
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        if (!dragRef.current.isDraggingNode) return;

        const wasClick = !dragRef.current.hasMoved && dragRef.current.initialSelectedNodes.length === 1;
        const clickedNodeId = dragRef.current.initialSelectedNodes[0]?.id;
        const currentViewport = viewportRef.current;
        const dx = clientX == null ? 0 : (clientX - dragRef.current.startX) / currentViewport.k;
        const dy = clientY == null ? 0 : (clientY - dragRef.current.startY) / currentViewport.k;
        const initialPositions = dragRef.current.initialSelectedNodes;

        historyPausedRef.current = false;
        nodeDraggingRef.current = false;
        setIsNodeDragging(false);
        setDropTargetGroupId(null);
        if (dragRef.current.hasMoved && clientX != null && clientY != null) {
            const movedIds = new Set(initialPositions.map((item) => item.id));
            setNodes((prev) => {
                const moved = prev.map((node) => {
                    const initial = initialPositions.find((item) => item.id === node.id);
                    return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                });
                const targetGroup = findGroupDropTarget(movedIds, moved);
                if (targetGroup) return snapNodesIntoGroup(movedIds, moved, targetGroup);
                return moved.map((node) => {
                    if (!movedIds.has(node.id) || node.type === CanvasNodeType.Group) return node;
                    const groupId = findContainingGroupId(node, moved);
                    if (node.metadata?.groupId === groupId) return node;
                    return { ...node, metadata: { ...node.metadata, groupId } };
                });
            });
        }

        dragRef.current.isDraggingNode = false;
        dragRef.current.hasMoved = false;
        dragRef.current.initialSelectedNodes = [];
        if (wasClick && clickedNodeId) {
            const clickedNode = nodesRef.current.find((node) => node.id === clickedNodeId);
            const clickedDefinition = clickedNode ? getNodeDefinition(clickedNode.type) : undefined;
            if (clickedDefinition?.hidePanel) {
                // Clicking a display-only plugin node selects it without opening a lower panel.
                setDialogNodeId((current) => (current === clickedNodeId ? current : null));
            } else if (clickedNode?.type !== CanvasNodeType.Group) {
                setDialogNodeId(clickedNodeId);
            }
        }
    }, []);

    const handleGlobalMouseMove = useCallback(
        (event: MouseEvent) => {
            const currentViewport = viewportRef.current;

            if (dragRef.current.isDraggingNode) {
                const dx = (event.clientX - dragRef.current.startX) / currentViewport.k;
                const dy = (event.clientY - dragRef.current.startY) / currentViewport.k;
                const initialPositions = dragRef.current.initialSelectedNodes;
                if (Math.abs(event.clientX - dragRef.current.startX) > 3 || Math.abs(event.clientY - dragRef.current.startY) > 3) {
                    dragRef.current.hasMoved = true;
                }

                const movedIds = new Set(initialPositions.map((item) => item.id));
                const previewNodes = nodesRef.current.map((node) => {
                    const initial = initialPositions.find((item) => item.id === node.id);
                    return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                });
                setDropTargetGroupId(findGroupDropTarget(movedIds, previewNodes)?.id || null);

                if (rafRef.current) cancelAnimationFrame(rafRef.current);
                rafRef.current = requestAnimationFrame(() => {
                    setNodes((prev) =>
                        prev.map((node) => {
                            const initial = initialPositions.find((item) => item.id === node.id);
                            return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                        }),
                    );
                    rafRef.current = null;
                });
                return;
            }

            if (connectingParamsRef.current && !pendingConnectionCreateRef.current) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, connectingParamsRef.current);
                connectionTargetNodeIdRef.current = dropTarget.nodeId;
                setConnectionTargetNodeId(dropTarget.nodeId);
                setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            }
        },
        [finishNodeDrag, getConnectionDropTarget, screenToCanvas],
    );

    const handleGlobalPointerMove = useCallback(
        (event: PointerEvent) => {
            const currentSelection = selectionBoxRef.current;
            if (!currentSelection) return;

            if (event.buttons === 0) {
                selectionBoxRef.current = null;
                setSelectionBox(null);
                return;
            }

            const world = screenToCanvas(event.clientX, event.clientY);
            const rectX = Math.min(currentSelection.startWorldX, world.x);
            const rectY = Math.min(currentSelection.startWorldY, world.y);
            const rectW = Math.abs(world.x - currentSelection.startWorldX);
            const rectH = Math.abs(world.y - currentSelection.startWorldY);
            const nextSelected = new Set<string>(currentSelection.additive ? currentSelection.initialSelectedNodeIds : []);

            nodesRef.current
                .forEach((node) => {
                    const intersects = rectX < node.position.x + node.width && rectX + rectW > node.position.x && rectY < node.position.y + node.height && rectY + rectH > node.position.y;

                    if (intersects) nextSelected.add(node.id);
                });

            const nextSelectionBox = { ...currentSelection, currentWorldX: world.x, currentWorldY: world.y };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            setSelectedNodeIds(nextSelected);
        },
        [screenToCanvas],
    );

    const handleGlobalMouseUp = useCallback(
        (event: MouseEvent) => {
            finishNodeDrag(event.clientX, event.clientY);

            selectionBoxRef.current = null;
            setSelectionBox(null);

            if (pendingConnectionCreateRef.current) return;

            const currentConnection = connectingParamsRef.current;
            if (currentConnection) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, currentConnection);
                if (dropTarget.nodeId) {
                    connectNodes(currentConnection, dropTarget.nodeId);
                    setConnecting(null);
                } else if (dropTarget.isNearNode) {
                    setConnecting(null);
                } else {
                    setMouseWorld(screenToCanvas(event.clientX, event.clientY));
                    setPendingConnectionCreate({ connection: currentConnection, position: screenToCanvas(event.clientX, event.clientY) });
                }
            }
        },
        [connectNodes, finishNodeDrag, getConnectionDropTarget, screenToCanvas, setConnecting],
    );

    useEffect(() => {
        const handlePointerUp = (event: PointerEvent) => finishNodeDrag(event.clientX, event.clientY);
        const cancelNodeDrag = () => finishNodeDrag();
        window.addEventListener("mousemove", handleGlobalMouseMove);
        window.addEventListener("mouseup", handleGlobalMouseUp);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", cancelNodeDrag);
        window.addEventListener("blur", cancelNodeDrag);
        window.addEventListener("pointermove", handleGlobalPointerMove);
        return () => {
            window.removeEventListener("mousemove", handleGlobalMouseMove);
            window.removeEventListener("mouseup", handleGlobalMouseUp);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", cancelNodeDrag);
            window.removeEventListener("blur", cancelNodeDrag);
            window.removeEventListener("pointermove", handleGlobalPointerMove);
        };
    }, [finishNodeDrag, handleGlobalMouseMove, handleGlobalMouseUp, handleGlobalPointerMove]);

    const createImageFileNode = useCallback(async (file: File, position: Position) => {
        const image = await storeCanvasImage(file, assetWriteContext({ type: "canvas-import" }));
        const size = fitNodeSize(image.width, image.height);
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: file.name,
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: imageMetadata(image),
        };

        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, [assetWriteContext]);

    const createVideoFileNode = useCallback(async (file: File, position: Position) => {
        const video = await storeCanvasMedia(file, assetWriteContext({ type: "canvas-import" }));
        const size = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
        const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Video,
                title: file.name,
                position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: videoMetadata(video),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, [assetWriteContext]);

    const createAudioFileNode = useCallback(async (file: File, position: Position) => {
        const audio = await storeCanvasMedia(file, assetWriteContext({ type: "canvas-import" }));
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
        const id = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Audio,
                title: file.name,
                position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
                width: spec.width,
                height: spec.height,
                metadata: audioMetadata(audio),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
    }, [assetWriteContext]);

    const createMediaFileNodes = useCallback((files: File[], basePosition: Position) => {
        const STAGGER = 40;
        return files.map((file, index) => {
            const position = { x: basePosition.x + index * STAGGER, y: basePosition.y + index * STAGGER };
            if (isAudioFile(file)) return createAudioFileNode(file, position);
            if (file.type.startsWith("video/")) return createVideoFileNode(file, position);
            return createImageFileNode(file, position);
        });
    }, [createAudioFileNode, createImageFileNode, createVideoFileNode]);

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || t("canvas.projectPage.clipboardText"),
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [getCanvasCenter, t],
    );

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (isEditablePasteTarget(event.target)) return;

            const key = event.key.toLowerCase();
            const isModifierShortcut = event.metaKey || event.ctrlKey;

            if (isModifierShortcut && key === "c" && window.getSelection()?.toString()) return;

            if (isModifierShortcut && !event.altKey && key === "z") {
                event.preventDefault();
                if (event.shiftKey) redoCanvas();
                else undoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "y") {
                event.preventDefault();
                redoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "a") {
                event.preventDefault();
                setSelectedNodeIds(new Set(nodesRef.current.map((node) => node.id)));
                setSelectedConnectionId(null);
                setContextMenu(null);
                setSelectionBox(null);
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "c") {
                event.preventDefault();
                copySelectedNodes();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "v") {
                if (pasteCopiedNodes()) event.preventDefault();
                return;
            }

            if (event.key === "Delete" || event.key === "Backspace") {
                if (selectedNodeIdsRef.current.size) {
                    deleteNodes(new Set(selectedNodeIdsRef.current));
                } else if (selectedConnectionId) {
                    deleteConnection(selectedConnectionId);
                }
            }

            if (event.key === "Escape") {
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                setContextMenu(null);
                setNodeCreatePosition(null);
                setSelectionBox(null);
                setConnecting(null);
                setHoveredNodeId(null);
                setToolbarNodeId(null);
                setDialogNodeId(null);
                setInfoNodeId(null);
                setCropNodeId(null);
                setMaskEditNodeId(null);
                setPendingConnectionCreate(null);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [copySelectedNodes, deleteConnection, deleteNodes, pasteCopiedNodes, redoCanvas, selectedConnectionId, setConnecting, undoCanvas]);

    useEffect(() => {
        const handlePaste = (event: ClipboardEvent) => {
            if (isEditablePasteTarget(event.target)) return;

            const files = extractPasteFiles(event).map(ensurePasteFileName);
            if (files.length) {
                event.preventDefault();
                void Promise.all(createMediaFileNodes(files, getCanvasCenter()))
                    .then(() => message.success(t("canvas.projectPage.clipboardImageAdded")))
                    .catch(() => message.error(t("canvas.projectPage.pasteFailed")));
                return;
            }

            const text = event.clipboardData?.getData("text/plain") || "";
            if (createTextNodeFromClipboard(text)) {
                event.preventDefault();
                message.success(t("canvas.projectPage.clipboardTextAdded"));
                return;
            }

            if (pasteCopiedNodes()) event.preventDefault();
        };

        window.addEventListener("paste", handlePaste);
        return () => window.removeEventListener("paste", handlePaste);
    }, [createMediaFileNodes, createTextNodeFromClipboard, getCanvasCenter, message, pasteCopiedNodes, t]);

    const handleConnectStart = useCallback(
        (event: ReactMouseEvent, nodeId: string, handleType: "source" | "target") => {
            event.stopPropagation();
            setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            setConnecting({ nodeId, handleType });
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
            setSelectedConnectionId(null);
        },
        [screenToCanvas, setConnecting],
    );

    const handleNodeResize = useCallback((nodeId: string, width: number, height: number, position?: Position) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, width, height, position: position || node.position } : node)));
    }, []);

    const handleNodeResizeStart = useCallback(() => {
        setIsNodeResizing(true);
    }, []);
    const handleNodeResizeEnd = useCallback(() => setIsNodeResizing(false), []);

    const toggleNodeFreeResize = useCallback((nodeId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const freeResize = !node.metadata?.freeResize;
                if (freeResize || node.type !== CanvasNodeType.Image) return { ...node, metadata: { ...node.metadata, freeResize } };
                const ratio = (node.metadata?.naturalWidth || node.width) / (node.metadata?.naturalHeight || node.height || 1);
                const height = node.width / ratio;
                return { ...node, height, position: { x: node.position.x, y: node.position.y + node.height / 2 - height / 2 }, metadata: { ...node.metadata, freeResize } };
            }),
        );
    }, []);

    const handleNodeContentChange = useCallback((nodeId: string, content: string) => {
        setNodes((prev) =>
            prev.map((node) =>
                node.id === nodeId
                    ? { ...node, metadata: { ...node.metadata, content, texts: node.metadata?.texts?.map((text) => (text.id === node.metadata?.primaryTextId ? { ...text, content } : text)) } }
                    : node,
            ),
        );
    }, []);

    const handleNodeTitleChange = useCallback((nodeId: string, title: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, title } : node)));
    }, []);

    const toggleBatchExpanded = useCallback((nodeId: string) => {
        setExpandedBatchNodeIds((current) => {
            const next = new Set(current);
            if (next.has(nodeId)) next.delete(nodeId);
            else next.add(nodeId);
            return next;
        });
    }, []);

    const setBatchPrimary = useCallback((nodeId: string, itemId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                if (node.type === CanvasNodeType.Text) {
                    const text = node.metadata?.texts?.find((item) => item.id === itemId);
                    return text?.content ? { ...node, metadata: { ...node.metadata, content: text.content, primaryTextId: text.id } } : node;
                }
                const image = node.metadata?.images?.find((item) => item.id === itemId);
                if (!image?.content) return node;
                const edge = Math.max(node.width, node.height);
                const size = node.metadata?.freeResize ? { width: node.width, height: node.height } : fitNodeSize(image.naturalWidth, image.naturalHeight, edge, edge);
                return {
                    ...node,
                    position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 },
                    ...size,
                    metadata: {
                        ...node.metadata,
                        content: image.content,
                        storageKey: image.storageKey,
                        // 节点级资产身份跟随新主图（content 里的运行时 URL 重启即失效，消费方靠 assetRef 重解析）。
                        assetRef: image.assetRef,
                        naturalWidth: image.naturalWidth,
                        naturalHeight: image.naturalHeight,
                        bytes: image.bytes,
                        mimeType: image.mimeType,
                        primaryImageId: image.id,
                    },
                };
            }),
        );
    }, []);

    const duplicateBatchImage = useCallback((node: CanvasNodeData, imageId: string) => {
        const image = node.metadata?.images?.find((item) => item.id === imageId);
        if (!image?.content) return;
        const id = nanoid();
        const edge = Math.max(node.width, node.height);
        const size = fitNodeSize(image.naturalWidth, image.naturalHeight, edge, edge);
        const copy: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: node.title,
            position: { x: node.position.x + node.width * 2 + 96, y: node.position.y + node.height / 2 - size.height / 2 },
            ...size,
            metadata: {
                content: image.content,
                storageKey: image.storageKey,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                bytes: image.bytes,
                mimeType: image.mimeType,
                status: NODE_STATUS_SUCCESS,
                ...copyImageGenerationMetadata(node.metadata),
            },
        };
        setNodes((prev) => [...prev, copy]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const handleNodePromptChange = useCallback((nodeId: string, prompt: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt } } : node)));
    }, []);

    const handleConfigNodeChange = useCallback((nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? applyNodeConfigPatch(node, patch) : node)));
    }, []);

    const downloadNodeImage = useCallback((node: CanvasNodeData) => {
        if ((node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) || !node.metadata?.content) return;
        saveAs(node.metadata.content, `canvas-${node.type}-${node.id}.${node.type === CanvasNodeType.Video ? "mp4" : node.type === CanvasNodeType.Audio ? audioExtension(node.metadata.mimeType) : imageExtension(node.metadata.content)}`);
    }, []);

    const downloadBatchImage = useCallback((node: CanvasNodeData, imageId: string) => {
        const image = node.metadata?.images?.find((item) => item.id === imageId);
        if (!image?.content) return;
        // 项目文件资产先经门面解析（重启后 content 里的 blob: URL 已失效）；无 assetRef 时原样下载。
        void resolveCanvasAssetUrl(image.assetRef, image.content).then((url) => saveAs(url, `canvas-image-${node.id}-${image.id}.${imageExtension(url)}`));
    }, []);

    const captureVideoNodeFrame = useCallback(
        async (nodeId: string, position: VideoFramePosition) => {
            setContextMenu(null);
            const node = nodesRef.current.find((item) => item.id === nodeId);
            const video = Array.from(containerRef.current!.querySelectorAll<HTMLVideoElement>("video[data-canvas-video]")).find((item) => item.dataset.canvasVideo === nodeId);
            if (node?.type !== CanvasNodeType.Video || !node.metadata?.content || !video) return message.error(t("canvas.videoFrames.failed"));
            try {
                const image = await storeCanvasImage(await captureVideoFrame(node.metadata.content, position, video.currentTime), assetWriteContext({ type: "derived" }, node.id));
                const size = fitNodeSize(image.width, image.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                const id = nanoid();
                const x = node.position.x + node.width + 96;
                let y = node.position.y + node.height / 2 - size.height / 2;
                while (nodesRef.current.some((item) => item.id !== node.id && item.position.x < x + size.width && item.position.x + item.width > x && item.position.y < y + size.height && item.position.y + item.height > y)) y += size.height + 24;
                const child: CanvasNodeData = {
                    id,
                    type: CanvasNodeType.Image,
                    title: t(`canvas.videoFrames.${position}Title`, { name: node.title || t("assets.kinds.video") }),
                    position: { x, y },
                    ...size,
                    metadata: imageMetadata(image),
                };
                setNodes((prev) => [...prev, child]);
                setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: id }]);
                setSelectedNodeIds(new Set([id]));
                setSelectedConnectionId(null);
                setDialogNodeId(id);
                message.success(t("canvas.videoFrames.captured"));
            } catch {
                message.error(t("canvas.videoFrames.failed"));
            }
        },
        [assetWriteContext, message, t],
    );

    const saveNodeAsset = useCallback(
        async (node: CanvasNodeData) => {
            const library = window.shotshot?.libraryAssets;
            if (node.type === CanvasNodeType.Text) {
                const content = node.metadata?.content?.trim();
                if (!content) return message.error(t("canvas.projectPage.noTextToSave"));
                if (library) {
                    try {
                        addAsset(await buildLibraryAsset(new Blob([content], { type: "text/markdown" }), { title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasText"), source: "Canvas" }));
                    } catch {
                        return message.error(t("canvas.sidePanel.addFailed"));
                    }
                } else {
                    addAsset({ kind: "text", title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasText"), coverUrl: "", tags: [], source: "Canvas", data: { content }, metadata: { source: "canvas", nodeId: node.id } });
                }
                message.success(t("common.addedToAssets"));
                return;
            }
            if (node.type === CanvasNodeType.Video) {
                if (!node.metadata?.content) return message.error(t("canvas.projectPage.noVideoToSave"));
                if (library) {
                    try {
                        const blob = await libraryBlobFromMedia({ content: node.metadata.content, storageKey: node.metadata.storageKey, assetRef: node.metadata.assetRef });
                        if (!blob) return message.error(t("canvas.projectPage.noVideoToSave"));
                        addAsset(await buildLibraryAsset(blob, { title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasVideo"), source: "Canvas" }));
                    } catch {
                        return message.error(t("canvas.sidePanel.addFailed"));
                    }
                } else {
                    addAsset({
                        kind: "video",
                        title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasVideo"),
                        coverUrl: "",
                        tags: [],
                        source: "Canvas",
                        data: { url: node.metadata.content, storageKey: node.metadata.storageKey, width: node.width, height: node.height, bytes: node.metadata.bytes || 0, mimeType: node.metadata.mimeType || "video/mp4", ...(node.metadata.assetRef ? { assetRef: node.metadata.assetRef } : {}) },
                        metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
                    });
                }
                message.success(t("common.addedToAssets"));
                return;
            }
            if (!node.metadata?.content) return message.error(t("canvas.projectPage.noImageToSave"));
            if (library) {
                try {
                    const blob = await libraryBlobFromMedia({ content: node.metadata.content, storageKey: node.metadata.storageKey, assetRef: node.metadata.assetRef });
                    if (!blob) return message.error(t("canvas.projectPage.noImageToSave"));
                    addAsset(await buildLibraryAsset(blob, { title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasImage"), source: "Canvas" }));
                } catch {
                    return message.error(t("canvas.sidePanel.addFailed"));
                }
                message.success(t("common.addedToAssets"));
                return;
            }
            const dataUrl = node.metadata.storageKey ? "" : node.metadata.content;
            addAsset({
                kind: "image",
                title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasImage"),
                coverUrl: node.metadata.content,
                tags: [],
                source: "Canvas",
                data: {
                    dataUrl,
                    storageKey: node.metadata.storageKey,
                    width: node.metadata.naturalWidth || node.width,
                    height: node.metadata.naturalHeight || node.height,
                    bytes: node.metadata.bytes || getDataUrlByteSize(dataUrl),
                    mimeType: node.metadata.mimeType || "image/png",
                    ...(node.metadata.assetRef ? { assetRef: node.metadata.assetRef } : {}),
                },
                metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
            });
            message.success(t("common.addedToAssets"));
        },
        [addAsset, message, t],
    );

    const createImageReversePromptNodes = useCallback(
        (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Image || !node.metadata?.content) {
                message.warning(t("canvas.projectPage.emptyReverse"));
                return;
            }

            const gap = 96;
            const textSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
            const configSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
            const centerY = node.position.y + node.height / 2;
            const textNode = {
                ...createCanvasNode(CanvasNodeType.Text, { x: node.position.x + node.width + gap + textSpec.width / 2, y: centerY }, { content: t("canvas.projectPage.reversePreset"), prompt: t("canvas.projectPage.reversePreset"), status: NODE_STATUS_SUCCESS, fontSize: 14 }),
                title: t("canvas.projectPage.reverseTitle"),
            };
            const configNode = {
                ...createCanvasNode(
                    CanvasNodeType.Config,
                    { x: textNode.position.x + textNode.width + gap + configSpec.width / 2, y: centerY },
                    {
                        generationMode: "text",
                        model: effectiveConfig.textModel || effectiveConfig.model || defaultConfig.textModel,
                        count: 1,
                        composerContent: t("canvas.reverseComposer", { imageId: node.id, textId: textNode.id }),
                    },
                ),
                title: t("canvas.projectPage.reverseConfigTitle"),
            };

            setNodes((prev) => [...prev, textNode, configNode]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: configNode.id }, { id: nanoid(), fromNodeId: textNode.id, toNodeId: configNode.id }]);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
            setContextMenu(null);
        },
        [effectiveConfig.model, effectiveConfig.textModel, message, t],
    );

    const cropImageNode = useCallback(async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
        if (!node.metadata?.content) return;
        const cropped = await cropDataUrl(node.metadata.content, crop);
        const image = await storeCanvasImage(cropped, assetWriteContext({ type: "derived" }, node.id));
        const width = Math.min(node.width, Math.max(220, image.width));
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Cropped Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width,
            height: width * (image.height / image.width),
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
        setCropNodeId(null);
    }, [assetWriteContext]);

    const splitImageNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageSplitParams) => {
            if (!node.metadata?.content) return;
            setSplitNodeId(null);
            const pieces = await splitDataUrl(node.metadata.content, params);
            const gap = 16;
            const cellWidth = node.width / params.columns;
            const cellHeight = node.height / params.rows;
            const startX = node.position.x + node.width + 96;
            const startY = node.position.y;
            const childNodes = await Promise.all(
                pieces.map(async (piece) => {
                    const image = await storeCanvasImage(piece.dataUrl, assetWriteContext({ type: "derived" }, node.id));
                    const id = nanoid();
                    return {
                        id,
                        type: CanvasNodeType.Image,
                        title: t("canvas.projectPage.splitTitle", { name: node.title || t("assets.kinds.image"), row: piece.row + 1, column: piece.column + 1 }),
                        position: { x: startX + piece.column * (cellWidth + gap), y: startY + piece.row * (cellHeight + gap) },
                        width: cellWidth,
                        height: cellHeight,
                        metadata: {
                            ...imageMetadata(image),
                            prompt: node.metadata?.prompt,
                        },
                    } satisfies CanvasNodeData;
                }),
            );
            setNodes((prev) => [...prev, ...childNodes]);
            setConnections((prev) => [...prev, ...childNodes.map((child) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: child.id }))]);
            setSelectedNodeIds(new Set(childNodes.map((child) => child.id)));
            setSelectedConnectionId(null);
            setDialogNodeId(null);
            message.success(t("canvas.projectPage.splitSuccess", { count: childNodes.length }));
        },
        [assetWriteContext, message, t],
    );

    const maskEditImageNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1", size: node.metadata?.size || "auto" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            try { assertFalGenerationOperationSupported(generationConfig, "mask"); }
            catch (error) { message.error(formatFalGenerationError(error)); return; }
            const userPrompt = payload.prompt.trim();
            const prompt = t("canvas.projectPage.maskPrompt", { prompt: userPrompt });
            const childId = nanoid();
            const source = { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey };
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [source]);
            setMaskEditNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: userPrompt.slice(0, 32) || t("canvas.projectPage.maskResult"),
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: node.width,
                    height: node.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await requestEdit(generationConfig, prompt, [source], { id: `${node.id}-mask`, name: "mask.png", type: "image/png", dataUrl: payload.maskDataUrl }, { signal: controller.signal }).then((items) => items[0]);
                const uploaded = await storeCanvasImage(image.dataUrl, assetWriteContext({ type: "generated" }, childId));
                const size = fitNodeSize(uploaded.width, uploaded.height, node.width, node.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt, ...generationMetadata } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.maskFailed");
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [assetWriteContext, effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startGenerationRequest, t],
    );

    const upscaleImageNode = useCallback(async (node: CanvasNodeData, params: CanvasImageUpscaleParams) => {
        if (!node.metadata?.content) return;
        setUpscaleNodeId(null);
        const upscaled = await upscaleDataUrl(node.metadata.content, params);
        const image = await storeCanvasImage(upscaled, assetWriteContext({ type: "derived" }, node.id));
        const size = fitNodeSize(image.width, image.height);
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Upscaled Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width: size.width,
            height: size.height,
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
    }, [assetWriteContext]);

    /** 脚本产物溯源（来源节点血统推导）：分镜图节点带 shotStoryboardRef，实体参考图节点带 scriptEntityRef，
     *  镜头视频节点带 shotVideoRef（同步打点，Agent/画布侧再生成无显式来源可传，靠血统反推）。
     *  依赖 canvas_script_asset 的 bind op 先于 run_generation 落库；视频 version 取版本表中来源节点条目
     *  （再生成产物沿袭来源版本；不在表内则不标版本）。非脚本产物返回 undefined。 */
    const deriveScriptProvenance = useCallback((originNodeId: string): ScriptAssetProvenance | undefined => {
        const origin = nodesRef.current.find((node) => node.id === originNodeId);
        const storyboard = origin?.metadata?.shotStoryboardRef;
        if (storyboard) return { scriptNodeId: storyboard.scriptNodeId, shotId: storyboard.shotId, role: "storyboard" };
        const entity = origin?.metadata?.scriptEntityRef;
        if (entity) {
            const scriptNode = nodesRef.current.find((node) => node.metadata?.script?.entityIds.includes(entity.entityId));
            return scriptNode ? { scriptNodeId: scriptNode.id, role: "entity-reference" } : undefined;
        }
        const shotVideo = origin?.metadata?.shotVideoRef;
        if (shotVideo) {
            const versionNo = nodesRef.current.find((node) => node.id === shotVideo.scriptNodeId)?.metadata?.script?.output.shotVideoVersions?.[shotVideo.shotId]?.find((version) => version.nodeId === originNodeId)?.no;
            return { scriptNodeId: shotVideo.scriptNodeId, shotId: shotVideo.shotId, role: "video", ...(versionNo !== undefined ? { version: versionNo } : {}) };
        }
        return undefined;
    }, []);

    const generateAngleNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageAngleParams) => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const childId = nanoid();
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const title = buildAngleLabel(params);
            const prompt = buildAnglePrompt(params);
            // 多角度产物沿用来源节点血统（来源是分镜图/实体参考图时继承脚本溯源）。
            const angleProvenance = deriveScriptProvenance(node.id);
            const source = { id: node.metadata.primaryImageId ? `${node.id}:${node.metadata.primaryImageId}` : node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey };
            const generationMetadata = { ...buildImageGenerationMetadata("edit", generationConfig, 1, [source]), ...(node.metadata.providerOptions ? { providerOptions: node.metadata.providerOptions } : {}) };
            let falRequest: MediaGenerateRequest | undefined;
            if (isConfiguredFalModel(generationConfig)) {
                try {
                    falRequest = await prepareFalGenerationRequest(generationConfig, { prompt, referenceImages: [source], referenceAudios: [], referenceVideos: [], textCount: 0, imageCount: 1, audioCount: 0, videoCount: 0 }, node.metadata.providerOptions);
                } catch (error) { message.error(formatFalGenerationError(error)); return; }
            }
            setAngleNodeId(null);
            setRunningNodeId(childId);
            const stagedNodes = [
                ...nodesRef.current,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                } satisfies CanvasNodeData,
            ];
            const stagedConnections = [...connectionsRef.current, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }];
            setNodes(stagedNodes);
            setConnections(stagedConnections);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                if (falRequest) {
                    updateCanvas(projectId, canvasId, { nodes: stagedNodes, connections: stagedConnections });
                    await startRemoteCanvasMediaTask({ config: generationConfig, capability: "image", prompt, references: [source], preparedGeneration: falRequest, ...(angleProvenance ? { scriptSource: angleProvenance } : {}), target: { projectId, canvasId, nodeId: childId, sourceNodeId: node.id } });
                    return;
                }
                const image = await requestEdit(
                    generationConfig,
                    prompt,
                    [{ id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey }],
                    undefined,
                    { signal: controller.signal },
                ).then((items) => items[0]);
                const uploaded = await storeCanvasImage(image.dataUrl, assetWriteContext({ type: "generated", ...angleProvenance }, childId));
                const size = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt, ...generationMetadata } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? formatFalGenerationError(error) : t("canvas.projectPage.generationFailed");
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [assetWriteContext, canvasId, deriveScriptProvenance, effectiveConfig, finishGenerationRequest, message, openConfigDialog, projectId, startGenerationRequest, t, updateCanvas],
    );

    const handleFontSizeChange = useCallback((nodeId: string, fontSize: number) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, fontSize } } : node)));
    }, []);

    const handleUploadRequest = useCallback((nodeId?: string, position?: Position) => {
        uploadTargetRef.current = { nodeId, position };
        imageInputRef.current?.click();
    }, []);

    const handleImageInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            const files = Array.from(event.target.files || []).filter(
                (f) => f.type.startsWith("image/") || f.type.startsWith("video/") || isAudioFile(f),
            );
            if (!files.length) {
                uploadTargetRef.current = null;
                event.target.value = "";
                return;
            }

            const target = uploadTargetRef.current;
            const basePosition =
                target?.position ||
                screenToCanvas(
                    (containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2,
                    (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2,
                );
            const STAGGER = 40; // Offset between multiple imported files.

            // When replacing a target node, use the first file as the replacement and create the rest nearby.
            if (target?.nodeId) {
                const [first, ...rest] = files;

                // Replace the target node with the first file.
                if (isAudioFile(first)) {
                    const audio = await storeCanvasMedia(first, assetWriteContext({ type: "canvas-import" }, target.nodeId));
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Audio,
                                      title: first.name,
                                      position: { x: node.position.x + node.width / 2 - spec.width / 2, y: node.position.y + node.height / 2 - spec.height / 2 },
                                      width: spec.width,
                                      height: spec.height,
                                      metadata: { ...node.metadata, ...audioMetadata(audio), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                } else if (first.type.startsWith("video/")) {
                    const video = await storeCanvasMedia(first, assetWriteContext({ type: "canvas-import" }, target.nodeId));
                    const nextSize = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Video,
                                      title: first.name,
                                      position: { x: node.position.x + node.width / 2 - nextSize.width / 2, y: node.position.y + node.height / 2 - nextSize.height / 2 },
                                      width: nextSize.width,
                                      height: nextSize.height,
                                      metadata: { ...node.metadata, ...videoMetadata(video), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                } else {
                    const image = await storeCanvasImage(first, assetWriteContext({ type: "canvas-import" }, target.nodeId));
                    const s = fitNodeSize(image.width, image.height);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Image,
                                      title: first.name,
                                      width: s.width,
                                      height: s.height,
                                      metadata: {
                                          ...node.metadata,
                                          ...imageMetadata(image),
                                          errorDetails: undefined,
                                          freeResize: false,
                                          images: undefined,
                                          generationType: undefined,
                                          model: undefined,
                                          size: undefined,
                                          quality: undefined,
                                          count: undefined,
                                          references: undefined,
                                          primaryImageId: undefined,
                                      },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                }

                // Create the remaining files near the target node.
                for (let i = 0; i < rest.length; i++) {
                    const offsetPos = { x: basePosition.x + (i + 1) * STAGGER, y: basePosition.y + (i + 1) * STAGGER };
                    const f = rest[i];
                    if (isAudioFile(f)) {
                        void createAudioFileNode(f, offsetPos);
                    } else if (f.type.startsWith("video/")) {
                        void createVideoFileNode(f, offsetPos);
                    } else {
                        void createImageFileNode(f, offsetPos);
                    }
                }
            } else {
                // Without a replacement target, create all files near the canvas center.
                for (let i = 0; i < files.length; i++) {
                    const offsetPos = { x: basePosition.x + i * STAGGER, y: basePosition.y + i * STAGGER };
                    const f = files[i];
                    if (isAudioFile(f)) {
                        void createAudioFileNode(f, offsetPos);
                    } else if (f.type.startsWith("video/")) {
                        void createVideoFileNode(f, offsetPos);
                    } else {
                        void createImageFileNode(f, offsetPos);
                    }
                }
            }

            uploadTargetRef.current = null;
            event.target.value = "";
        },
        [assetWriteContext, createAudioFileNode, createImageFileNode, createVideoFileNode, screenToCanvas, size.height, size.width],
    );

    const handleDrop = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();
            const files = Array.from(event.dataTransfer.files).filter(isMediaFile);
            if (!files.length) return;

            void Promise.all(createMediaFileNodes(files, screenToCanvas(event.clientX, event.clientY)));
        },
        [createMediaFileNodes, screenToCanvas],
    );

    const preventCanvasContextMenu = useCallback((event: ReactMouseEvent) => {
        if ((event.target as HTMLElement).closest("[data-node-id]")) return;
        event.preventDefault();
        setContextMenu(null);
    }, []);

    const handleGenerateNode = useCallback(
        async (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, onVideoChild?: (childId: string) => void, onImageChild?: (childId: string) => void, managedImageModel?: string, referenceSession?: ReferenceImageSession, scriptSource?: ScriptAssetProvenance) => {
            const sourceNode = nodesRef.current.find((node) => node.id === nodeId);
            // 生成产物的项目资产 source 脚本侧标注：显式来源（镜头视频版本，见 handleGenerateShotVideo）优先，
            // 其余从来源节点血统推导（分镜图 / 实体参考图，含 Agent 路径）。
            const scriptProvenance = scriptSource ?? deriveScriptProvenance(nodeId);
            const generationConfig = withReferenceImageSession(buildGenerationConfig(effectiveConfig, sourceNode, mode, managedImageModel), referenceSession);
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            // 已生成视频节点重新生成时，参考来源沿连线向上追溯 Config 祖先（与 retry 同源）：
            // 生成链上的视频节点一跳上游只有 config（非资源节点，会被参考资格过滤剔除），
            // 不追溯会让原先的多个参考静默丢失，重新生成退化成文生视频。config 自身发起生成不回溯。
            const referenceSourceNodeId = mode === "video" && sourceNode?.type !== CanvasNodeType.Config ? findRetrySourceNode(nodeId, nodesRef.current, connectionsRef.current)?.id : undefined;

            // Warm plugin-node reference snapshots (e.g. 3D viewport captures) before the generation context
            // resolves them. Returns false when a required snapshot is unavailable — callers must abort with a
            // visible error rather than silently degrading the run to text-to-image.
            const warmPluginSnapshots = async (includeSelf: boolean) => {
                const upstream = getGenerationResourceNodes(referenceSourceNodeId ?? nodeId, nodesRef.current, connectionsRef.current);
                const self = includeSelf ? nodesRef.current.find((node) => node.id === nodeId) : undefined;
                const targets = [...(self ? [self] : []), ...upstream].filter((node) => isPluginNodeType(node.type) && getNodeDefinition(node.type)?.referenceKind === "image");
                for (const target of targets) {
                    if (target.type === MODEL_3D_NODE_TYPE) {
                        const views = await ensureModel3dViews(target, {
                            onPersisted: (persisted) => {
                                const primary = persisted.find((view) => view.id === "primary");
                                setNodes((prev) =>
                                    prev.map((node) =>
                                        node.id === target.id
                                            ? { ...node, metadata: { ...node.metadata, model3d: { ...node.metadata?.model3d, views: persisted, ...(primary ? { snapshot: { storageKey: primary.storageKey } } : {}) } } }
                                            : node,
                                    ),
                                );
                            },
                        });
                        if (views.length) continue;
                        message.error(t("canvas.model3d.snapshotMissing"));
                        setNodes((prev) => prev.map((node) => (node.id === target.id ? { ...node, metadata: { ...node.metadata, status: "error", errorDetails: t("canvas.model3d.snapshotMissing") } } : node)));
                        return false;
                    }
                    const snapshot = await ensureSnapshot(target, {
                        onPersisted: (storageKey) =>
                            setNodes((prev) =>
                                prev.map((node) => (node.id === target.id ? { ...node, metadata: { ...node.metadata, model3d: { ...node.metadata?.model3d, snapshot: { storageKey } } } } : node)),
                            ),
                    });
                    if (!snapshot) {
                        message.error(t("canvas.model3d.snapshotMissing"));
                        setNodes((prev) => prev.map((node) => (node.id === target.id ? { ...node, metadata: { ...node.metadata, status: "error", errorDetails: t("canvas.model3d.snapshotMissing") } } : node)));
                        return false;
                    }
                }
                return true;
            };

            // useBuiltinPanel.writeBackToSelf reuses built-in generation while writing the result back to the plugin node.
            // Image mode currently supports display-only nodes such as panoramas, with a useBuiltinPanel.promptPrefix.
            // Plugin-host generation stays direct: plugin targets do not expose a durable canvas media-task target contract.
            const builtinPanel = sourceNode ? getNodeDefinition(sourceNode.type)?.useBuiltinPanel : undefined;
            if (sourceNode && builtinPanel?.writeBackToSelf && builtinPanel.mode === "image") {
                try { assertFalGenerationOperationSupported(generationConfig, "plugin-self"); }
                catch (error) { message.error(formatFalGenerationError(error)); return; }
                const scene = prompt.trim();
                if (!scene) return;
                setRunningNodeId(nodeId);
                const controller = startGenerationRequest(nodeId, nodeId, nodeId);
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt: scene, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));
                try {
                    const fullPrompt = (builtinPanel.promptPrefix || "") + scene;
                    if (!(await warmPluginSnapshots(false))) {
                        finishGenerationRequest(nodeId, controller);
                        setRunningNodeId(null);
                        return;
                    }
                    const context = await hydrateNodeGenerationContext(buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, fullPrompt, { resolveAsset }));
                    const refs = context.referenceImages;
                    const image = refs.length
                        ? await requestEdit({ ...generationConfig, count: "1" }, context.prompt, refs, undefined, { signal: controller.signal }).then((items) => items[0])
                        : await requestGeneration({ ...generationConfig, count: "1" }, context.prompt, { signal: controller.signal }).then((items) => items[0]);
                    const uploaded = await storeCanvasImage(image.dataUrl, assetWriteContext({ type: "generated" }, nodeId));
                    setNodes((prev) =>
                        prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...imageMetadata(uploaded), prompt: scene, model: generationConfig.model, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)),
                    );
                    setDialogNodeId(null);
                } catch (error) {
                    if (!isGenerationCanceled(error)) {
                        const errorDetails = error instanceof Error ? formatFalGenerationError(error) : t("canvas.projectPage.generationFailed");
                        message.error(errorDetails);
                        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node)));
                    }
                } finally {
                    finishGenerationRequest(nodeId, controller);
                }
                return;
            }

            let mediaExecution = planCanvasMediaGeneration({ config: generationConfig, capability: "text", phase: "first" });
            try {
                mediaExecution = planCanvasMediaGeneration({ config: generationConfig, capability: mode, phase: "first", pluginHost: !isConfiguredFalModel(generationConfig) && Boolean(sourceNode && isPluginNodeType(sourceNode.type)) });
            } catch (error) {
                message.error(error instanceof Error ? formatFalGenerationError(error) : t("canvas.projectPage.generationFailed"));
                return;
            }

            setRunningNodeId(nodeId);
            const runController = startGenerationRequest(nodeId, nodeId, nodeId);
            const sourceTextContent = sourceNode?.type === CanvasNodeType.Text ? sourceNode.metadata?.content?.trim() || "" : "";
            const editingTextNode = mode === "text" && Boolean(sourceTextContent);
            if (!(await warmPluginSnapshots(true))) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                return;
            }
            let generationContext: Awaited<ReturnType<typeof hydrateNodeGenerationContext>>;
            let autodlRequest: MediaGenerateRequest | undefined;
            let falRequest: MediaGenerateRequest | undefined;
            try {
                const autodl = getConfiguredAutodlWorkflow(generationConfig);
                const fal = isConfiguredFalModel(generationConfig);
                const sourceImages = fal && mode === "image" && sourceNode && (sourceNode.type === CanvasNodeType.Image || getNodeDefinition(sourceNode.type)?.referenceKind === "image") ? buildSourceImageReferences(sourceNode) : [];
                const context = buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, editingTextNode ? t("canvas.projectPage.editTextPrompt", { source: sourceTextContent, prompt }) : prompt, { strictReferences: Boolean(autodl) || fal, sourceImages, inputsSourceNodeId: referenceSourceNodeId, resolveAsset });
                generationContext = autodl || fal ? context : await hydrateNodeGenerationContext(context);
                if (fal && mode === "video") falRequest = await prepareFalGenerationRequest(generationConfig, context, sourceNode?.metadata?.providerOptions, runController.signal);
                if (autodl) {
                    autodlRequest = await prepareAutodlGenerationRequest(generationConfig, context, runController.signal);
                    buildAutodlVideoBody(autodlRequest);
                }
            } catch (error) {
                if (!runController.signal.aborted) message.error(error instanceof Error ? formatFalGenerationError(error) : t("canvas.projectPage.generationFailed"));
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                return;
            }
            const effectivePrompt = generationContext.prompt.trim();
            if (runController.signal.aborted) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                return;
            }
            // Plugin nodes (e.g. 3d) skip the source loading marker: NodeContent renders LoadingContent over
            // plugin content while loading, which would blank the 3D preview for the whole run.
            const markSourceStatus = sourceNode ? sourceNode.type !== CanvasNodeType.Image && !editingTextNode && shouldMarkSourceStatus(sourceNode) : false;
            if (!effectivePrompt && (mode === "text" || mode === "audio")) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                return;
            }
            let pendingChildIds: string[] = [];
            if (markSourceStatus) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...(node.type === CanvasNodeType.Config ? {} : { prompt }), status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));

            try {
                if (mode === "image") {
                    const count = getGenerationCount(generationConfig.count);
                    const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                    const isImageNode = sourceNode?.type === CanvasNodeType.Image;
                    const isEmptyImageNode = isImageNode && !sourceNode?.metadata?.content;
                    const sourceReference =
                        isConfiguredFalModel(generationConfig)
                            ? []
                            : isImageNode && sourceNode?.metadata?.content
                            ? [{ id: sourceNode.id, name: `${sourceNode.title || sourceNode.id}.png`, type: sourceNode.metadata.mimeType || "image/png", dataUrl: sourceNode.metadata.content, storageKey: sourceNode.metadata.storageKey }]
                            : sourceNode && isPluginNodeType(sourceNode.type) && getNodeDefinition(sourceNode.type)?.referenceKind === "image"
                              ? (() => {
                                    if (sourceNode.type === MODEL_3D_NODE_TYPE) {
                                        return getLiveModel3dViews(sourceNode.id).map((view) => ({
                                            id: `${sourceNode.id}:${view.id}`,
                                            name: `${sourceNode.title || sourceNode.id}-${view.id}.png`,
                                            type: "image/png",
                                            dataUrl: view.dataUrl,
                                            storageKey: view.storageKey,
                                        }));
                                    }
                                    // Plugin image-reference sources (e.g. 3d) contribute their warmed viewport
                                    // snapshot as the edit reference — run_generation on the node itself is the
                                    // "generate from this 3D part" affordance.
                                    const resource = getNodeDefinition(sourceNode.type)?.resource?.(nodesRef.current.find((node) => node.id === nodeId) || sourceNode);
                                    return resource?.kind === "image" && resource.url
                                        ? [{ id: sourceNode.id, name: `${sourceNode.title || sourceNode.id}.png`, type: sourceNode.metadata?.mimeType || "image/png", dataUrl: resource.url, storageKey: sourceNode.metadata?.model3d?.snapshot?.storageKey }]
                                        : [];
                                })()
                              : [];
                    const referenceImages = isConfiguredFalModel(generationConfig)
                        ? generationContext.referenceImages
                        : [...new Map([...sourceReference, ...generationContext.referenceImages].map((image) => [`${image.id}:${image.storageKey || ""}`, image])).values()];
                    if (isConfiguredFalModel(generationConfig)) falRequest = await prepareFalGenerationRequest(generationConfig, { ...generationContext, referenceImages }, sourceNode?.metadata?.providerOptions, runController.signal);
                    const generationType = referenceImages.length ? ("edit" as const) : ("generation" as const);
                    const generationMetadata = { ...buildImageGenerationMetadata(generationType, generationConfig, count, referenceImages), ...(sourceNode?.metadata?.providerOptions ? { providerOptions: sourceNode.metadata.providerOptions } : {}) };
                    const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : isImageNode ? CanvasNodeType.Image : CanvasNodeType.Text];
                    const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                    const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                    const rootId = isEmptyImageNode ? nodeId : `image-${nanoid()}`;
                    const imageIds = Array.from({ length: count }, () => nanoid());
                    pendingChildIds = [rootId];
                    const rootNode: CanvasNodeData = {
                        id: rootId,
                        type: CanvasNodeType.Image,
                        title: effectivePrompt.slice(0, 32) || "Generated Image",
                        position: {
                            x: isEmptyImageNode ? parentPosition.x : parentPosition.x + parentConfig.width + 96,
                            y: parentPosition.y + parentConfig.height / 2 - imageConfig.height / 2,
                        },
                        width: isEmptyImageNode ? sourceNode?.width || imageConfig.width : imageConfig.width,
                        height: isEmptyImageNode ? sourceNode?.height || imageConfig.height : imageConfig.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            ...(sourceNode?.metadata?.reference3dViews ? { reference3dViews: sourceNode.metadata.reference3dViews } : {}),
                            images: imageIds.map((id) => ({ id, status: NODE_STATUS_LOADING, content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" })),
                            ...generationMetadata,
                        },
                    };

                    setNodes((prev) => [
                        ...prev.map((node) =>
                            node.id === nodeId
                                ? imageModeSourceNodeTransform(node, { isConfigNode, isEmptyImageNode, isImageNode, rootNode, prompt, parentConfig })
                                : node,
                        ),
                        ...(isEmptyImageNode ? [] : [rootNode]),
                    ]);
                    if (!isEmptyImageNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: rootId }]);
                    setSelectedNodeIds(new Set([nodeId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(nodeId);

                    if (mediaExecution.mode === "remote_task") {
                        const stagedNodes = [
                            ...nodesRef.current.map((node) =>
                                node.id === nodeId
                                    ? imageModeSourceNodeTransform(node, { isConfigNode, isEmptyImageNode, isImageNode, rootNode, prompt, parentConfig })
                                    : node,
                            ),
                            ...(isEmptyImageNode ? [] : [rootNode]),
                        ];
                        const stagedConnections = isEmptyImageNode ? connectionsRef.current : [...connectionsRef.current, { id: nanoid(), fromNodeId: nodeId, toNodeId: rootId }];
                        setNodes(stagedNodes);
                        setConnections(stagedConnections);
                        // onImageChild 必须排在上面两个 staged 值更新之后入队（同 video 分支 onVideoChild 的次序约束）
                        if (!isEmptyImageNode) onImageChild?.(rootId);
                        updateCanvas(projectId, canvasId, { nodes: stagedNodes, connections: stagedConnections });
                        await Promise.all(imageIds.map((imageId) => startRemoteCanvasMediaTask({
                            config: { ...generationConfig, count: "1" },
                            capability: "image",
                            prompt: effectivePrompt,
                            references: referenceImages,
                            preparedGeneration: falRequest,
                            ...(scriptProvenance ? { scriptSource: scriptProvenance } : {}),
                            target: { projectId, canvasId, nodeId: rootId, itemId: imageId, sourceNodeId: nodeId },
                        })));
                        return;
                    }
                    // 已有产出节点再生成 → 新建子节点：经 onImageChild 通知调用方重映射归属
                    // （形状同 video 分支 :2577 的 onVideoChild——remote 块内一次 / direct 路径一次，每路径恰好一次）
                    if (!isEmptyImageNode) onImageChild?.(rootId);
                    const controller = rootId === nodeId ? runController : startGenerationRequest(rootId, nodeId, nodeId, runController);
                    let hasSuccess = false;
                    let hasFailure = false;
                    let firstError = "";
                    await Promise.all(
                        imageIds.map(async (imageId) => {
                            try {
                                const image = referenceImages.length
                                    ? await requestEdit({ ...generationConfig, count: "1" }, effectivePrompt, referenceImages, undefined, { signal: controller.signal }).then((items) => items[0])
                                    : await requestGeneration({ ...generationConfig, count: "1" }, effectivePrompt, { signal: controller.signal }).then((items) => items[0]);
                                const uploaded = await storeCanvasImage(image.dataUrl, assetWriteContext({ type: "generated", ...scriptProvenance }, rootId));
                                const imageSize = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                                const item: CanvasNodeImage = { id: imageId, status: NODE_STATUS_SUCCESS, content: uploaded.url, storageKey: uploaded.storageKey, ...(uploaded.assetRef ? { assetRef: uploaded.assetRef } : {}), naturalWidth: uploaded.width, naturalHeight: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType };
                                setNodes((prev) =>
                                    prev.map((node) => {
                                        if (node.id !== rootId) return node;
                                        const images = node.metadata?.images?.map((image) => (image.id === imageId ? item : image)) || [];
                                        if (node.metadata?.primaryImageId) return { ...node, metadata: { ...node.metadata, images } };
                                        const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
                                        return {
                                            ...node,
                                            position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                            ...imageSize,
                                            metadata: {
                                                ...node.metadata,
                                                content: item.content,
                                                storageKey: item.storageKey,
                                                naturalWidth: item.naturalWidth,
                                                naturalHeight: item.naturalHeight,
                                                bytes: item.bytes,
                                                mimeType: item.mimeType,
                                                images,
                                                primaryImageId: imageId,
                                            },
                                        };
                                    }),
                                );
                                hasSuccess = true;
                                if (isConfigNode) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)));
                                return true;
                            } catch (error) {
                                if (isGenerationCanceled(error)) return false;
                                const errorDetails = error instanceof Error ? formatFalGenerationError(error) : t("canvas.projectPage.generationFailed");
                                if (!firstError) firstError = errorDetails;
                                hasFailure = true;
                                setNodes((prev) => prev.map((node) => (node.id === rootId ? { ...node, metadata: { ...node.metadata, images: node.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image)) } } : node)));
                            }
                            return false;
                        }),
                    );
                    if (rootId !== nodeId) finishGenerationRequest(rootId, controller);
                    if (controller.signal.aborted) {
                        setNodes((prev) => prev.map((node) => (node.id === nodeId && isConfigNode && node.metadata?.status === NODE_STATUS_LOADING ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined } } : node)));
                        return;
                    }
                    if (hasFailure) {
                        message.error(hasSuccess ? t("canvas.projectPage.partialFailed") : firstError || t("canvas.projectPage.generationFailed"));
                    }
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === nodeId && isConfigNode
                                ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : t("canvas.projectPage.generationFailed") } }
                                : node.id === rootId
                                  ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : t("canvas.projectPage.allFailed") } }
                                    : node,
                        ),
                    );
                    return;
                }

                if (mode === "video") {
                    const spec = nodeSizeFromRatio(generationConfig.size, NODE_DEFAULT_SIZE[CanvasNodeType.Video].width, NODE_DEFAULT_SIZE[CanvasNodeType.Video].height) || NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                    const isEmptyVideoNode = sourceNode?.type === CanvasNodeType.Video && !sourceNode.metadata?.content;
                    const videoId = isEmptyVideoNode ? nodeId : `video-${nanoid()}`;
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const videoNode: CanvasNodeData = {
                        id: videoId,
                        type: CanvasNodeType.Video,
                        title: effectivePrompt.slice(0, 32) || "Generated Video",
                        position: isEmptyVideoNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y },
                        width: isEmptyVideoNode ? sourceNode.width : spec.width,
                        height: isEmptyVideoNode ? sourceNode.height : spec.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            ...(sourceNode?.metadata?.reference3dViews ? { reference3dViews: sourceNode.metadata.reference3dViews } : {}),
                            model: generationConfig.model,
                            size: generationConfig.size,
                            seconds: generationConfig.videoSeconds,
                            vquality: generationConfig.vquality,
                            generateAudio: generationConfig.videoGenerateAudio,
                            watermark: generationConfig.videoWatermark,
                            references: generationReferenceUrls(generationContext),
                            ...(sourceNode?.metadata?.providerOptions ? { providerOptions: sourceNode.metadata.providerOptions } : {}),
                        },
                    };
                    pendingChildIds = [videoId];
                    // 血统边（lineage）+ 直接参考流的参考继承，见 buildVideoChildConnections
                    const childConnections = isEmptyVideoNode ? [] : buildVideoChildConnections(nodeId, videoId, nodesRef.current, connectionsRef.current);
                    setNodes((prev) =>
                        isEmptyVideoNode
                            ? prev.map((node) => (node.id === nodeId ? { ...node, ...videoNode } : node))
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), videoNode],
                    );
                    if (!isEmptyVideoNode) setConnections((prev) => [...prev, ...childConnections]);
                    if (mediaExecution.mode === "remote_task") {
                        const stagedNodes = isEmptyVideoNode
                            ? nodesRef.current.map((node) => (node.id === nodeId ? { ...node, ...videoNode } : node))
                            : [...nodesRef.current.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), videoNode];
                        const stagedConnections = isEmptyVideoNode ? connectionsRef.current : [...connectionsRef.current, ...childConnections];
                        setNodes(stagedNodes);
                        setConnections(stagedConnections);
                        // onVideoChild 必须排在上面两个 staged 值更新之后入队，否则脚本版本链的函数式更新会被 stagedNodes 值更新整体覆盖
                        if (!isEmptyVideoNode) onVideoChild?.(videoId);
                        updateCanvas(projectId, canvasId, { nodes: stagedNodes, connections: stagedConnections });
                        await startRemoteCanvasMediaTask({
                            config: { ...generationConfig, count: "1" },
                            capability: "video",
                            prompt: autodlRequest?.prompt ?? effectivePrompt,
                            references: generationContext.referenceImages,
                            audioReferences: generationContext.referenceAudios,
                            videoReferences: generationContext.referenceVideos,
                            preparedMedia: autodlRequest,
                            preparedGeneration: falRequest,
                            ...(scriptProvenance ? { scriptSource: scriptProvenance } : {}),
                            target: { projectId, canvasId, nodeId: videoId, sourceNodeId: nodeId },
                        });
                        return;
                    }
                    if (!isEmptyVideoNode) onVideoChild?.(videoId);
                    const controller = startGenerationRequest(videoId, nodeId, nodeId, runController);
                    try {
                        const video = await storeGeneratedVideo(
                            await requestVideoGeneration(generationConfig, effectivePrompt, generationContext.referenceImages, { signal: controller.signal }),
                            assetWriteContext({ type: "generated", ...scriptProvenance }, videoId),
                        );
                        const videoSize = fitNodeSize(video.width || spec.width, video.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                        setNodes((prev) =>
                            prev.map((node) =>
                                node.id === videoId
                                    ? {
                                          ...node,
                                          width: videoSize.width,
                                          height: videoSize.height,
                                          position: { x: node.position.x + node.width / 2 - videoSize.width / 2, y: node.position.y + node.height / 2 - videoSize.height / 2 },
                                          metadata: {
                                              ...node.metadata,
                                              ...videoMetadata(video),
                                              prompt: effectivePrompt,
                                              model: generationConfig.model,
                                              size: generationConfig.size,
                                              seconds: generationConfig.videoSeconds,
                                              vquality: generationConfig.vquality,
                                              generateAudio: generationConfig.videoGenerateAudio,
                                              watermark: generationConfig.videoWatermark,
                                              references: generationReferenceUrls(generationContext),
                                          },
                                      }
                                    : node,
                            ),
                        );
                    } finally {
                        finishGenerationRequest(videoId, controller);
                    }
                    return;
                }

                if (mode === "audio") {
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    const isEmptyAudioNode = sourceNode?.type === CanvasNodeType.Audio && !sourceNode.metadata?.content;
                    const audioId = isEmptyAudioNode ? nodeId : `audio-${nanoid()}`;
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const audioNode: CanvasNodeData = {
                        id: audioId,
                        type: CanvasNodeType.Audio,
                        title: effectivePrompt.slice(0, 32) || "Generated Audio",
                        position: isEmptyAudioNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y + ((sourceNode?.height || spec.height) - spec.height) / 2 },
                        width: isEmptyAudioNode ? sourceNode.width : spec.width,
                        height: isEmptyAudioNode ? sourceNode.height : spec.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, ...buildAudioGenerationMetadata(generationConfig) },
                    };
                    pendingChildIds = [audioId];
                    setNodes((prev) =>
                        isEmptyAudioNode
                            ? prev.map((node) => (node.id === nodeId ? { ...node, ...audioNode } : node))
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), audioNode],
                    );
                    if (!isEmptyAudioNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: audioId }]);
                    if (mediaExecution.mode === "remote_task") {
                        const stagedNodes = isEmptyAudioNode
                            ? nodesRef.current.map((node) => (node.id === nodeId ? { ...node, ...audioNode } : node))
                            : [...nodesRef.current.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), audioNode];
                        const stagedConnections = isEmptyAudioNode ? connectionsRef.current : [...connectionsRef.current, { id: nanoid(), fromNodeId: nodeId, toNodeId: audioId }];
                        setNodes(stagedNodes);
                        setConnections(stagedConnections);
                        updateCanvas(projectId, canvasId, { nodes: stagedNodes, connections: stagedConnections });
                        await startRemoteCanvasMediaTask({
                            config: { ...generationConfig, count: "1" },
                            capability: "audio",
                            prompt: effectivePrompt,
                            references: generationContext.referenceImages,
                            ...(scriptProvenance ? { scriptSource: scriptProvenance } : {}),
                            target: { projectId, canvasId, nodeId: audioId, sourceNodeId: nodeId },
                        });
                        return;
                    }
                    const controller = startGenerationRequest(audioId, nodeId, nodeId, runController);
                    try {
                        const audio = await storeGeneratedAudio(await requestAudioGeneration(generationConfig, effectivePrompt, { signal: controller.signal }), generationConfig.audioFormat, assetWriteContext({ type: "generated" }, audioId));
                        setNodes((prev) => prev.map((node) => (node.id === audioId ? { ...node, metadata: { ...node.metadata, ...audioMetadata(audio), prompt: effectivePrompt, ...buildAudioGenerationMetadata(generationConfig) } } : node)));
                    } finally {
                        finishGenerationRequest(audioId, controller);
                    }
                    return;
                }

                const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                const textCount = getGenerationCount(String(generationConfig.textCount || 1));
                const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : CanvasNodeType.Text];
                const textConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
                const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                const isEmptyTextNode = sourceNode?.type === CanvasNodeType.Text && !sourceTextContent;
                const rootId = isEmptyTextNode ? nodeId : `text-${nanoid()}`;
                const textIds = Array.from({ length: textCount }, () => `text-${nanoid()}`);
                const rootNode: CanvasNodeData = {
                    id: rootId,
                    type: CanvasNodeType.Text,
                    title: effectivePrompt.slice(0, 32) || "Generated Text",
                    position: isEmptyTextNode ? sourceNode.position : { x: parentPosition.x + parentConfig.width + 96, y: parentPosition.y + parentConfig.height / 2 - textConfig.height / 2 },
                    width: isEmptyTextNode ? sourceNode.width : textConfig.width,
                    height: isEmptyTextNode ? sourceNode.height : textConfig.height,
                    metadata: {
                        prompt: effectivePrompt,
                        status: NODE_STATUS_LOADING,
                        fontSize: 14,
                        model: generationConfig.model,
                        reasoningEffort: generationConfig.reasoningEffort,
                        textCount,
                        texts: textIds.map((id) => ({ id, status: NODE_STATUS_LOADING, content: "" })),
                        primaryTextId: textIds[0],
                    },
                };
                pendingChildIds = [rootId];
                setNodes((prev) =>
                    isEmptyTextNode
                        ? prev.map((node) => (node.id === nodeId ? { ...node, ...rootNode } : node))
                        : [...prev.map((node) => (node.id === nodeId && isConfigNode ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)), rootNode],
                );
                if (!isEmptyTextNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: rootId }]);
                setSelectedNodeIds(new Set([nodeId]));
                setSelectedConnectionId(null);
                setDialogNodeId(nodeId);

                const controller = rootId === nodeId ? runController : startGenerationRequest(rootId, nodeId, nodeId, runController);
                const results = await Promise.all(
                    textIds.map(async (textId): Promise<CanvasNodeText | null> => {
                        let streamed = "";
                        try {
                            const answer = await requestImageQuestion(
                                generationConfig,
                                buildNodeResponseMessages({ ...generationContext, prompt: effectivePrompt }),
                                (text) => {
                                    streamed = text;
                                    setNodes((prev) =>
                                        prev.map((node) =>
                                            node.id === rootId
                                                ? {
                                                      ...node,
                                                      metadata: {
                                                          ...node.metadata,
                                                          ...(node.metadata?.primaryTextId === textId ? { content: text } : {}),
                                                          texts: node.metadata?.texts?.map((item) => (item.id === textId ? { ...item, content: text } : item)),
                                                      },
                                                  }
                                                : node,
                                        ),
                                    );
                                },
                                { signal: controller.signal },
                            );
                            const content = stripReasoningTags(answer || streamed);
                            setNodes((prev) =>
                                prev.map((node) =>
                                    node.id === rootId
                                        ? {
                                              ...node,
                                              metadata: {
                                                  ...node.metadata,
                                                  ...(node.metadata?.primaryTextId === textId ? { content } : {}),
                                                  texts: node.metadata?.texts?.map((item) => (item.id === textId ? { ...item, content, status: NODE_STATUS_SUCCESS } : item)),
                                              },
                                          }
                                        : node,
                                ),
                            );
                            return { id: textId, status: NODE_STATUS_SUCCESS, content } satisfies CanvasNodeText;
                        } catch (error) {
                            if (isGenerationCanceled(error)) return null;
                            const errorDetails = error instanceof Error ? formatFalGenerationError(error) : t("canvas.projectPage.generationFailed");
                            setNodes((prev) => prev.map((node) => (node.id === rootId ? { ...node, metadata: { ...node.metadata, texts: node.metadata?.texts?.map((item) => (item.id === textId ? { ...item, status: NODE_STATUS_ERROR, errorDetails } : item)) } } : node)));
                            return { id: textId, status: NODE_STATUS_ERROR, content: "", errorDetails } satisfies CanvasNodeText;
                        }
                    }),
                );
                if (rootId !== nodeId) finishGenerationRequest(rootId, controller);
                if (controller.signal.aborted) return;
                const completedTexts = results.flatMap((item) => (item?.status === NODE_STATUS_SUCCESS ? [item] : []));
                const failedTexts = results.filter((item) => item?.status === NODE_STATUS_ERROR);
                const firstText = completedTexts[0];
                if (completedTexts.length <= 1) setExpandedBatchNodeIds((current) => new Set([...current].filter((id) => id !== rootId)));
                if (failedTexts.length) message.error(firstText ? t("canvas.projectPage.partialTextFailed") : failedTexts[0]?.errorDetails || t("canvas.projectPage.generationFailed"));
                setNodes((prev) =>
                    prev.map((node) => {
                        if (node.id === rootId) {
                            const primaryText = completedTexts.find((text) => text.id === node.metadata?.primaryTextId) || firstText;
                            return {
                                ...node,
                                metadata: {
                                    ...node.metadata,
                                    content: primaryText?.content || "",
                                    texts: completedTexts,
                                    primaryTextId: primaryText?.id,
                                    status: primaryText ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                    errorDetails: primaryText ? undefined : t("canvas.projectPage.generationFailed"),
                                },
                            };
                        }
                        return node.id === nodeId && isConfigNode ? { ...node, metadata: { ...node.metadata, status: firstText ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: firstText ? undefined : t("canvas.projectPage.generationFailed") } } : node;
                    }),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? formatFalGenerationError(error) : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((node) => (node.id === nodeId || pendingChildIds.includes(node.id) ? (node.id === nodeId && !markSourceStatus ? node : { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } }) : node)),
                );
            } finally {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
            }
        },
        [assetWriteContext, canvasId, deriveScriptProvenance, effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, projectId, resolveAsset, startGenerationRequest, t, updateCanvas],
    );
    useEffect(() => {
        generateNodeRef.current = handleGenerateNode;
    }, [handleGenerateNode]);

    // ===== 脚本节点：studio 打开状态、生成入口A、updateScript =====
    const [scriptStudioNodeId, setScriptStudioNodeId] = useState<string | null>(null);
    const scriptStudioNode = useMemo(() => nodes.find((n) => n.id === scriptStudioNodeId) ?? null, [nodes, scriptStudioNodeId]);

    // 分镜图就绪派生（spec §6 / 评审修正 3）：shotId → {state, thumbUrl}，双形态读取；
    // thumbUrl 只在 ready 时取节点已被 hydrateCanvasImages 水合的 metadata.content
    const storyboardImageState = useMemo(() => {
        const script = scriptStudioNode?.metadata?.script;
        if (!script) return {};
        return Object.fromEntries(Object.entries(script.output.storyboardNodes ?? {}).map(([shotId, nodeId]) => {
            const node = nodes.find((n) => n.id === nodeId);
            const state = storyboardImageStateOf(node);
            return [shotId, { state, thumbUrl: state === "ready" ? node?.metadata?.content : undefined }];
        }));
    }, [nodes, scriptStudioNode]);

    useEffect(() => {
        const off = onCanvasEvent("open-script-studio", (payload) => {
            const nodeId = (payload as { nodeId?: string } | undefined)?.nodeId;
            if (nodeId) setScriptStudioNodeId(nodeId);
        });
        return () => {
            off();
        };
    }, []);

    const updateScriptNodeData = useCallback((nodeId: string, updater: (data: ScriptNodeData) => ScriptNodeData) => {
        setNodes((prev) =>
            prev.map((n) => (n.id === nodeId ? { ...n, metadata: { ...n.metadata, script: updater(n.metadata?.script ?? createEmptyScriptData()) } } : n)),
        );
    }, []);

    /** 资产参考图生成请求（弹窗草稿，spec 2026-09-17 D1-D3）：「生成」先入此状态，确认后落生图节点。 */
    type AssetRefGenRequest = { scriptNodeId: string; draft: EntityDraft; entityId: string; refId: string };
    const [assetRefGen, setAssetRefGen] = useState<AssetRefGenRequest | null>(null);

    /** 槽级资产参考图生成：先弹通用生图设置弹窗，确认后经 handleConfirmEntityRef 落生图节点执行。 */
    const handleGenerateEntityRef = useCallback(
        (scriptNodeId: string, draft: EntityDraft, entityId: string, refId: string) => {
            if (!isAiConfigReady) {
                openConfigDialog(true);
                return;
            }
            if (!nodesRef.current.some((n) => n.id === scriptNodeId)) return;
            setAssetRefGen({ scriptNodeId, draft, entityId, refId });
        },
        [isAiConfigReady, openConfigDialog],
    );

    /** 弹窗确认：新建生图节点（弹窗参数写入 metadata）、槽置 queued 并立即执行。
     *  D4：同槽重复生成一律新建节点，旧节点保留产物；槽归属由回写守卫按 nodeId 收敛。 */
    const handleConfirmEntityRef = useCallback(
        (request: AssetRefGenRequest, settings: StoryboardSettings) => {
            setAssetRefGen(null);
            const scriptNode = nodesRef.current.find((n) => n.id === request.scriptNodeId);
            if (!scriptNode) return;
            const prompt = composeEntityRefPrompt(request.draft);
            // 纵向错峰按该实体画布上的既有生成节点数（节点删除自然收敛，对齐分镜图 %5 粒度）
            const generatedCount = nodesRef.current.filter((n) => n.metadata?.scriptEntityRef?.entityId === request.entityId).length;
            const imageNode = createCanvasNode(CanvasNodeType.Image, { x: scriptNode.position.x + scriptNode.width + 96, y: scriptNode.position.y + 40 * (generatedCount % 5) }, {
                prompt,
                scriptEntityRef: { entityId: request.entityId, refId: request.refId },
                ...settings.metadata,
            });
            const edge = { id: nanoid(), fromNodeId: scriptNode.id, toNodeId: imageNode.id };
            // nodeId 兼作在途生成归属标记：回写守卫按它丢弃过期结果
            useScriptEntityStore.getState().assignRefSource(request.entityId, request.refId, { state: "queued", source: "generated", nodeId: imageNode.id });
            // 急切同步 ref（仓库既定模式，同 handleGenerateStoryboard）：确认回调同步进入 handleGenerateNode，
            // setNodes 的 DefaultLane 提交晚于其微任务延续里的上下文构建
            nodesRef.current = [...nodesRef.current, imageNode];
            connectionsRef.current = [...connectionsRef.current, edge];
            setNodes((prev) => [...prev, imageNode]);
            setConnections((prev) => [...prev, edge]);
            void handleGenerateNode(imageNode.id, "image", prompt, undefined, undefined, settings.managedImageModel);
        },
        [handleGenerateNode, setConnections, setNodes],
    );

    /** 库来源实体参考物化（spec D1）：复用优先（无条件，含带归属标记节点——参考归属槽位，槽位可重绑恢复），
        否则复制为派生节点。落槽前校验槽位意图仍是本资产（防用户中途换绑被晚到结果覆盖）。 */
    const resolveEntityRefNodeId = useCallback(async (scriptNodeId: string, assetId: string): Promise<string | undefined> => {
        const scriptNode = nodesRef.current.find((n) => n.id === scriptNodeId);
        const asset = useAssetStore.getState().assets.find((a): a is ImageAsset => a.id === assetId && a.kind === "image");
        if (!scriptNode || !asset) return undefined;
        const data = asset.data;
        const reused = nodesRef.current.find((n) =>
            n.type === CanvasNodeType.Image && n.metadata?.content &&
            ((data.storageKey && n.metadata.storageKey === data.storageKey) ||
                (data.assetRef?.backend === "project-file" && n.metadata.assetRef?.backend === "project-file" && n.metadata.assetRef.projectId === data.assetRef.projectId && n.metadata.assetRef.assetId === data.assetRef.assetId)));
        if (reused) return reused.id;
        const sourceUrl = data.storageKey ? await resolveImageUrl(data.storageKey, "") : data.assetRef ? await resolveCanvasAssetUrl(data.assetRef, "") : data.dataUrl;
        if (!sourceUrl) return undefined;
        const image = await storeCanvasImage(sourceUrl, assetWriteContext({ type: "derived", scriptNodeId }));
        const imageNode = createCanvasNode(CanvasNodeType.Image, { x: scriptNode.position.x + scriptNode.width + 96, y: scriptNode.position.y + 40 * (nodesRef.current.filter((n) => n.metadata?.derivedFromAssetId === assetId).length % 5) }, { ...imageMetadata(image), status: NODE_STATUS_SUCCESS, derivedFromAssetId: assetId });
        Object.assign(imageNode, fitNodeSize(image.width, image.height));
        imageNode.title = asset.title;
        const edge = { id: nanoid(), fromNodeId: scriptNodeId, toNodeId: imageNode.id };
        // 急切同步（评审硬约束）：planShotExpansion 与生成上下文都读 nodesRef/connectionsRef
        nodesRef.current = [...nodesRef.current, imageNode];
        connectionsRef.current = [...connectionsRef.current, edge];
        setNodes((prev) => [...prev, imageNode]);
        setConnections((prev) => [...prev, edge]);
        return imageNode.id;
    }, [assetWriteContext, setConnections, setNodes]);

    const handlePickEntityRefLibrary = useCallback((scriptNodeId: string, draft: EntityDraft, entityId: string, refId: string, assetId: string, storageKey?: string, assetRef?: CanvasAssetRef) => {
        const id = entityId || useScriptEntityStore.getState().upsertEntity({ ...draft, projectId });
        // 先写 queued 意图（抽屉进「生成中」态；并发防护的比对锚点），物化完成后转 ready
        useScriptEntityStore.getState().assignRefSource(id, refId, { state: "queued", source: "library", assetId });
        void (async () => {
            let nodeId: string | undefined;
            try {
                nodeId = await resolveEntityRefNodeId(scriptNodeId, assetId);
            } catch (error) {
                console.warn("[entity-ref] 库来源参考物化失败", error instanceof Error ? error.message : typeof error);
            }
            const slot = useScriptEntityStore.getState().entities.find((e) => e.id === id)?.refs.find((r) => r.id === refId);
            if (nodeId && slot?.assetId === assetId) {
                useScriptEntityStore.getState().assignRefSource(id, refId, { state: "ready", source: "library", assetId, nodeId, ...(storageKey ? { storageKey } : {}), ...(assetRef ? { assetRef } : {}) });
                return;
            }
            // 物化失败（解析为空或抛错）：槽仍归属本次资产才退回空槽（对齐 entityRefFailureFromNode 清理语义），
            // 否则整槽替换写下的 queued 会永久卡住抽屉「生成中」；用户已换绑其它资产则不动
            if (!nodeId && slot?.assetId === assetId) useScriptEntityStore.getState().assignRefSource(id, refId, { state: "empty" });
        })();
    }, [projectId, resolveEntityRefNodeId]);

    const materializingEntityRefsRef = useRef(new Set<string>());
    /** 生成前置回填（spec D1）：批量与单镜入口在读取实体前调用；物化经 Task 6 同一链路（含急切同步与并发防护）。
        同批去重 = materializingEntityRefsRef 在途集合 + 物化后的复用判定。 */
    const ensureEntityRefNodes = useCallback(async (scriptNodeId: string, entityIds: string[]) => {
        const entities = useScriptEntityStore.getState().entities.filter((e) => entityIds.includes(e.id));
        const canvasNodeIds = new Set(nodesRef.current.map((n) => n.id));
        for (const item of planLibraryRefBackfill(entities, canvasNodeIds)) {
            const key = `${item.entityId}:${item.refId}`;
            if (materializingEntityRefsRef.current.has(key)) continue;
            materializingEntityRefsRef.current.add(key);
            try {
                const slot = useScriptEntityStore.getState().entities.find((e) => e.id === item.entityId)?.refs.find((r) => r.id === item.refId);
                const live = slot?.nodeId ? nodesRef.current.some((n) => n.id === slot.nodeId) : false;
                if (live) continue;
                const nodeId = await resolveEntityRefNodeId(scriptNodeId, item.assetId);
                if (!nodeId) continue;
                const current = useScriptEntityStore.getState().entities.find((e) => e.id === item.entityId)?.refs.find((r) => r.id === item.refId);
                if (current?.assetId !== item.assetId) continue;
                useScriptEntityStore.getState().assignRefSource(item.entityId, item.refId, { state: "ready", source: "library", assetId: item.assetId, nodeId, ...(current.storageKey ? { storageKey: current.storageKey } : {}), ...(current.assetRef ? { assetRef: current.assetRef } : {}) });
            } catch {
                // 单条物化失败只跳过该槽（提示但不阻断同批其它槽，也不阻断用户显式发起的生成整体流程）
                message.warning(t("canvas.projectPage.generationFailed"));
                continue;
            } finally {
                materializingEntityRefsRef.current.delete(key);
            }
        }
    }, [message, resolveEntityRefNodeId, t]);

    const handleSelectStoryboard = useCallback(async (scriptNodeId: string, shotId: string, source: StoryboardImageSource) => {
        const sourceNode = source.kind === "canvas" ? nodesRef.current.find((node) => node.id === source.nodeId && node.type === CanvasNodeType.Image) : undefined;
        const asset = source.kind === "library" ? useAssetStore.getState().assets.find((item) => item.id === source.assetId && item.kind === "image") : undefined;
        const imageSource = sourceNode?.metadata ?? (asset?.kind === "image" ? { content: asset.data.dataUrl, storageKey: asset.data.storageKey } : undefined);
        if (!imageSource) throw new Error("Storyboard image source unavailable");
        const url = await resolveImageUrl(imageSource.storageKey, imageSource.content);
        if (!url) throw new Error("Storyboard image unavailable");
        // 选中分镜图复制为独立节点：派生产物落项目存储（新 assetId，不改源文件）；画布来源携带 nodeId 溯源。
        // 复制件按分镜图归属标注脚本侧 source（scriptNodeId/shotId/role=storyboard）。
        const image = await storeCanvasImage(url, assetWriteContext({ type: "derived", scriptNodeId, shotId, role: "storyboard" }, sourceNode?.id));
        // 上传结束后重新读取镜头；创建独立节点，脚本孤儿清理和重新生成不会改动来源图。
        const scriptNode = nodesRef.current.find((node) => node.id === scriptNodeId);
        const script = scriptNode?.metadata?.script;
        const shot = script?.output.shots.find((item) => item.shotId === shotId);
        if (!scriptNode || !script || !shot) throw new Error("Storyboard shot unavailable");
        const count = Object.keys(script.output.storyboardNodes ?? {}).length;
        const imageNode = createCanvasNode(CanvasNodeType.Image, {
            x: scriptNode.position.x + scriptNode.width + 96,
            y: scriptNode.position.y + 520 + (count % 5) * 40,
        }, { ...imageMetadata(image), status: NODE_STATUS_SUCCESS, shotStoryboardRef: { scriptNodeId, shotId } });
        Object.assign(imageNode, fitNodeSize(image.width, image.height));
        imageNode.title = t("canvas.scriptCompose.sbImageTitle", { no: shot.no });
        const edge = { id: nanoid(), fromNodeId: scriptNodeId, toNodeId: imageNode.id };
        nodesRef.current = [...nodesRef.current, imageNode];
        connectionsRef.current = [...connectionsRef.current, edge];
        setNodes((prev) => [...prev, imageNode]);
        setConnections((prev) => [...prev, edge]);
        updateScriptNodeData(scriptNodeId, (data) => ({ ...data, output: { ...data.output, storyboardNodes: { ...data.output.storyboardNodes, [shotId]: imageNode.id } } }));
    }, [assetWriteContext, setNodes, setConnections, t, updateScriptNodeData]);

    /** 生成/重新生成单镜分镜图（spec §6 / 评审修正 4）：新建节点坐标按既有分镜图数量错峰；
     *  输入边 = 脚本从属边 + 该镜全部 ready 资产参考图边；重新生成复用映射（见 existing 分支）。 */
    const handleGenerateStoryboard = useCallback(async (scriptNodeId: string, shotId: string, settings: StoryboardSettings, referenceSession?: ReferenceImageSession) => {
        if (!isAiConfigReady) { openConfigDialog(true); return; }
        const scriptNode = nodesRef.current.find((n) => n.id === scriptNodeId);
        const scriptData = scriptNode?.metadata?.script;
        const shot = scriptData?.output.shots.find((s) => s.shotId === shotId);
        if (!scriptNode || !scriptData || !shot) return;
        // legacy 回填（spec D1）：先物化缺节点的库来源槽位（急切同步），再收集实体与参考
        await ensureEntityRefNodes(scriptNodeId, scriptData.entityIds);
        const entities = useScriptEntityStore.getState().entities.filter((e) => scriptData.entityIds.includes(e.id));
        const referenceNodeIds = [...new Set(shot.entityRefs.flatMap((id) =>
            (useScriptEntityStore.getState().entities.find((e) => e.id === id)?.refs ?? [])
                .filter((r) => r.state === "ready" && r.nodeId).map((r) => r.nodeId!),
        ))];
        if (!referenceNodeIds.length) { message.info(t("canvas.scriptCompose.sbAssetsNotReady")); return; }
        const prompt = composeStoryboardPrompt(shot, entities, scriptData.globalStyle);
        const imageGenPatch = settings.metadata;
        const existingId = scriptData.output.storyboardNodes?.[shotId];
        const existing = existingId ? nodesRef.current.find((n) => n.id === existingId) : undefined;
        if (existing) {
            // 重新生成：复用节点（更新 prompt + 重跑），不动映射。已验证：handleGenerateNode 的 image
            // 分支对已有产出的图片节点同样走「新建子节点」分支（isEmptyImageNode=false → rootId=nanoid()），
            // 且 onVideoChild 回调只在 video 分支生效——故对齐 handleGenerateShotVideo 的 onVideoChild 模式，
            // 经 onImageChild 把 storyboardNodes[shotId] 重映射到子节点，否则首帧会指到旧图。
            const updated = { ...existing, metadata: { ...existing.metadata, prompt, status: NODE_STATUS_IDLE, ...imageGenPatch } };
            nodesRef.current = nodesRef.current.map((n) => n.id === existing.id ? updated : n);
            setNodes((prev) => prev.map((n) => n.id === existing.id ? updated : n));
            void handleGenerateNode(existing.id, "image", prompt, undefined, (childId) => {
                // 子节点继承分镜图归属标记 + 语义输入边（脚本从属 + 该镜 ready 资产图），保证再次生成时参考收集不漂移；
                // 旧图→子图的血统边由 handleGenerateNode image 分支自建
                setNodes((prev) => prev.map((n) => (n.id === childId ? { ...n, metadata: { ...n.metadata, shotStoryboardRef: { scriptNodeId, shotId } } } : n)));
                setConnections((prev) => [
                    ...prev,
                    { id: nanoid(), fromNodeId: scriptNode.id, toNodeId: childId },
                    ...referenceNodeIds.map((refNodeId) => ({ id: nanoid(), fromNodeId: refNodeId, toNodeId: childId })),
                ]);
                updateScriptNodeData(scriptNodeId, (data) => ({ ...data, output: { ...data.output, storyboardNodes: { ...data.output.storyboardNodes, [shotId]: childId } } }));
            }, settings.managedImageModel, referenceSession);
            return;
        }
        const sbCount = Object.keys(scriptData.output.storyboardNodes ?? {}).length;
        const imageNode = createCanvasNode(CanvasNodeType.Image, { x: scriptNode.position.x + scriptNode.width + 96, y: scriptNode.position.y + 520 + (sbCount % 5) * 40 }, {
            prompt, shotStoryboardRef: { scriptNodeId, shotId }, ...imageGenPatch,
        });
        imageNode.title = `分镜图 ${shot.no}`;
        const sbEdges = [
            { id: nanoid(), fromNodeId: scriptNode.id, toNodeId: imageNode.id },
            ...referenceNodeIds.map((refNodeId) => ({ id: nanoid(), fromNodeId: refNodeId, toNodeId: imageNode.id })),
        ];
        // 急切同步 ref（仓库既定模式，同 :580 / handleBatchGenerateScriptVideos）：批量入口经 setTimeout 宏任务触发，
        // setNodes 的 DefaultLane 提交（Scheduler 宏任务）晚于 handleGenerateNode 微任务延续里的上下文构建——
        // 不同步会让 sourceNode=undefined（imageModeSourceNodeTransform 落 Text 分支把节点改写掉）、生成上下文无参考
        nodesRef.current = [...nodesRef.current, imageNode];
        connectionsRef.current = [...connectionsRef.current, ...sbEdges];
        setNodes((prev) => [...prev, imageNode]);
        setConnections((prev) => [...prev, ...sbEdges]);
        updateScriptNodeData(scriptNodeId, (data) => ({ ...data, output: { ...data.output, storyboardNodes: { ...data.output.storyboardNodes, [shotId]: imageNode.id } } }));
        void handleGenerateNode(imageNode.id, "image", prompt, undefined, undefined, settings.managedImageModel, referenceSession);
    }, [ensureEntityRefNodes, handleGenerateNode, isAiConfigReady, message, openConfigDialog, setConnections, setNodes, t, updateScriptNodeData]);
    useEffect(() => {
        generateStoryboardRef.current = handleGenerateStoryboard;
    }, [handleGenerateStoryboard]);

    /** 批量分镜图铺图（spec §6）：为全部未 ready 且未在生成的镜头铺图节点，800ms 错峰（对齐组批量）。 */
    const handleBatchGenerateStoryboards = useCallback((scriptNodeId: string, settings: StoryboardSettings) => {
        const scriptData = nodesRef.current.find((n) => n.id === scriptNodeId)?.metadata?.script;
        if (!scriptData) return;
        const pending = scriptData.output.shots.filter((s) => {
            const nodeId = scriptData.output.storyboardNodes?.[s.shotId];
            const node = nodeId ? nodesRef.current.find((n) => n.id === nodeId) : undefined;
            const state = storyboardImageStateOf(node ? { metadata: node.metadata } : undefined);
            return state !== "ready" && state !== "generating";
        });
        const referenceSession = createReferenceImageSession(effectiveConfig.compressReferenceImages);
        pending.forEach((s, i) => { window.setTimeout(() => void handleGenerateStoryboard(scriptNodeId, s.shotId, settings, referenceSession), i * 800); });
        if (pending.length) message.info(t("canvas.scriptCompose.sbBatchQueued", { count: pending.length }));
    }, [effectiveConfig.compressReferenceImages, handleGenerateStoryboard, message, t]);

    // 图片生成节点完成 → 实体槽位回写：每节点每槽只写一次；过期归属（已被更新节点接管或用户已显式换图）作废。
    // 失败清理（spec 2026-09-17 D5）：error 且无成功图的生成节点把仍归属它的 queued 槽退回空槽。
    const writtenEntitySlotsRef = useRef(new Set<string>());
    useEffect(() => {
        for (const node of nodes) {
            const writeback = entityWritebackFromNode(node);
            const failure = writeback ? null : entityRefFailureFromNode(node);
            const intent = writeback ?? failure;
            if (!intent) continue;
            const key = `${node.id}:${intent.refId}`;
            if (writtenEntitySlotsRef.current.has(key)) continue;
            writtenEntitySlotsRef.current.add(key);
            const slot = useScriptEntityStore
                .getState()
                .entities.find((e) => e.id === intent.entityId)
                ?.refs.find((r) => r.id === intent.refId);
            if (writeback) {
                if (shouldApplyEntityWriteback(slot, node)) useScriptEntityStore.getState().assignRefSource(writeback.entityId, writeback.refId, writeback.patch);
            } else if (slot && slot.state === "queued" && slot.nodeId === node.id) {
                // 槽仍归属该在途节点才退回空槽；assignRefSource 整组替换语义顺带清空 source/nodeId
                useScriptEntityStore.getState().assignRefSource(intent.entityId, intent.refId, { state: "empty" });
            }
        }
    }, [nodes]);

    const canvasImageNodes = useMemo(() => nodes.filter((n) => n.type === CanvasNodeType.Image && n.metadata?.content), [nodes]);

    // 桌面导入的音频节点只有 assetRef（无 storageKey），同样进入脚本可选集合。
    const audioNodes = useMemo(() => nodes.filter((n) => n.type === CanvasNodeType.Audio && (n.metadata?.storageKey || n.metadata?.assetRef)).map((n) => ({ id: n.id, title: n.title, storageKey: n.metadata?.storageKey, assetRef: n.metadata?.assetRef })), [nodes]);

    /** 单元格内上传本地音频：只落存储并返回快照，不立即建节点（spec D3，物化在完成编辑时）。
     *  上传写入按槽位溯源（role=sfx/dialogue + shotId + 当前脚本节点）。 */
    const handleImportAudio = useCallback(async (file: File, origin?: { shotId: string; slot: ShotAudioSlot }): Promise<ShotAudioRef> => {
        const uploaded = await storeCanvasMedia(file, assetWriteContext({
            type: "canvas-import",
            ...(scriptStudioNodeId ? { scriptNodeId: scriptStudioNodeId } : {}),
            ...(origin ? { shotId: origin.shotId, role: origin.slot } : {}),
        }));
        return { name: file.name, storageKey: uploaded.storageKey, assetRef: uploaded.assetRef, mimeType: uploaded.mimeType, durationMs: uploaded.durationMs };
    }, [assetWriteContext, scriptStudioNodeId]);

    /** 分镜图血统反向索引（expandedShotNodes）：视频节点 id → {script, shotId}；视频节点 metadata 无持久血统字段。 */
    const findScriptLineageOf = useCallback((videoNodeId: string): { script: ScriptNodeData; shotId: string } | undefined => {
        for (const n of nodesRef.current) {
            const script = n.metadata?.script;
            if (!script) continue;
            for (const [shotId, videoId] of Object.entries(script.output.expandedShotNodes ?? {})) {
                if (videoId === videoNodeId) return { script, shotId };
            }
        }
        return undefined;
    }, []);

    /** 分镜图先行生成守卫（spec §13.2）：storyboard 血统且分镜图未 ready 的视频节点不允许 direct 直出
     *  （finalPrompt 已是「从首帧开始：」形态，直出必劣化）。组批量与画布通用入口共用本判定。 */
    const storyboardWaitBlocked = useCallback((videoNodeId: string): boolean => {
        const lineage = findScriptLineageOf(videoNodeId);
        if (!lineage?.script.template?.storyboardFirst) return false;
        const sbNodeId = lineage.script.output.storyboardNodes?.[lineage.shotId];
        const sbNode = sbNodeId ? nodesRef.current.find((n) => n.id === sbNodeId) : undefined;
        return storyboardImageStateOf(sbNode ? { metadata: sbNode.metadata } : undefined) !== "ready";
    }, [findScriptLineageOf]);

    /** 组级批量生成视频（v0.6）：仅对组内待生成节点发起（跳过已有成片），800ms 错峰。 */
    const handleGroupBatchGenerate = useCallback(
        (groupNodeId: string) => {
            const members = nodesRef.current.filter((n) => n.metadata?.groupId === groupNodeId);
            const { start, skipped } = selectGroupVideoTargets(members);
            if (!start.length) {
                message.info(t("canvas.groupBatch.none"));
                return;
            }
            // 分镜图先行守卫（final-review Critical 1）：storyboard 血统且分镜图未 ready 的镜头从 start 剔除，
            // 不允许 direct 直出（spec §13.2）；已 success 的节点在 selectGroupVideoTargets 已剔除，不受影响
            const pending = start.filter((node) => !storyboardWaitBlocked(node.id));
            const waitCount = start.length - pending.length;
            if (waitCount > 0) message.warning(t("canvas.scriptCompose.waitStoryboardSkipped", { count: waitCount }));
            if (!pending.length) return;
            pending.forEach((node, i) => {
                window.setTimeout(() => {
                    void handleGenerateNode(node.id, "video", node.metadata?.prompt ?? "");
                }, i * 800);
            });
            message.info(t("canvas.groupBatch.started", { started: pending.length, skipped }));
        },
        [handleGenerateNode, message, storyboardWaitBlocked, t],
    );

    /** 完成脚本编辑（v0.6）：幂等同步展开节点（复用/更新/新建），不自动触发生成；生成由用户在画布手动或组菜单批量发起。 */
    const handleBatchGenerateScriptVideos = useCallback(
        async (scriptNodeId: string, options: { shotIds?: string[]; closeAfter?: boolean } = {}): Promise<Record<string, string>> => {
            const scriptNode = nodesRef.current.find((n) => n.id === scriptNodeId);
            const scriptData = scriptNode?.metadata?.script;
            if (!scriptNode || !scriptData) return {};
            // legacy 回填（spec D1）：先物化缺节点的库来源槽位（急切同步），必须在下方实体读取与 preSyncNodeIds/nodesNext 快照构建之前
            await ensureEntityRefNodes(scriptNodeId, scriptData.entityIds);
            const entities = useScriptEntityStore.getState().entities.filter((e) => scriptData.entityIds.includes(e.id));
            const readyShots = scriptData.output.shots.filter((s) => s.composed && s.finalPrompt && (!options.shotIds || options.shotIds.includes(s.shotId)));
            const videoGenPatch = videoGenMetadataPatch(scriptData.template?.videoGen);
            const preSyncNodeIds = new Set(nodesRef.current.map((n) => n.id));

            // 1. 音频物化（spec D3）：上传来源的镜头音频先物化为画布 Audio 节点；映射与 expandedShotNodes 同一次持久化合并（D21）
            const existingMapping = scriptData.output.shotAudioNodes ?? {};
            const audioPlan = planAudioMaterialization({
                shots: readyShots,
                shotAudioNodes: existingMapping,
                canvasNodeIds: preSyncNodeIds,
                audioNodeStorageKeys: Object.fromEntries(nodesRef.current.filter((n) => n.type === CanvasNodeType.Audio).map((n) => [n.id, n.metadata?.storageKey])),
            });
            const audioMappingNext: Record<string, Partial<Record<ShotAudioSlot, { id: string; materialized: boolean }>>> = Object.fromEntries(Object.entries(existingMapping).map(([shotId, slots]) => [shotId, { ...slots }]));
            for (const { shotId, slot } of audioPlan.prune) delete audioMappingNext[shotId]?.[slot];

            // 内容水合（D22）：全部 await 在快照前完成，避免快照与写回之间的异步窗口吞掉并发 setNodes（lost update）。
            // 桌面导入快照只有 assetRef（无 storageKey）：经门面解析播放 URL 并随物化节点落 assetRef。
            const audioContentByStorageKey = new Map<string, string>();
            const audioContentByAssetId = new Map<string, string>();
            for (const item of [...audioPlan.create, ...audioPlan.update]) {
                const assetRef = item.snapshot.assetRef;
                if (assetRef?.backend === "project-file" && !audioContentByAssetId.has(assetRef.assetId)) {
                    audioContentByAssetId.set(assetRef.assetId, await resolveCanvasAssetUrl(assetRef, ""));
                }
                const storageKey = item.snapshot.storageKey;
                if (!storageKey || audioContentByStorageKey.has(storageKey)) continue;
                audioContentByStorageKey.set(storageKey, await resolveMediaUrl(storageKey));
            }
            const audioSnapshotContent = (snapshot: ShotAudioRef) =>
                snapshot.assetRef?.backend === "project-file"
                    ? audioContentByAssetId.get(snapshot.assetRef.assetId) ?? ""
                    : snapshot.storageKey
                        ? audioContentByStorageKey.get(snapshot.storageKey) ?? ""
                        : "";

            const nodesNext = [...nodesRef.current];
            for (const item of audioPlan.create) {
                // 物化位置：已展开的视频节点旁，缺则脚本节点右缘（D3）
                const anchor = nodesRef.current.find((n) => n.id === scriptData.output.expandedShotNodes?.[item.shotId]) ?? scriptNode;
                const audioNode = createCanvasNode(CanvasNodeType.Audio, { x: anchor.position.x + anchor.width + 96, y: anchor.position.y + 360 }, {
                    content: audioSnapshotContent(item.snapshot),
                    storageKey: item.snapshot.storageKey,
                    status: NODE_STATUS_IDLE,
                    mimeType: item.snapshot.mimeType,
                    durationMs: item.snapshot.durationMs,
                    ...(item.snapshot.assetRef ? { assetRef: item.snapshot.assetRef } : {}),
                });
                audioNode.title = item.snapshot.name;
                nodesNext.push(audioNode);
                (audioMappingNext[item.shotId] ??= {})[item.slot] = { id: audioNode.id, materialized: true };
            }
            for (const item of audioPlan.update) {
                const content = audioSnapshotContent(item.snapshot);
                for (let i = 0; i < nodesNext.length; i++) {
                    if (nodesNext[i].id !== item.nodeId) continue;
                    nodesNext[i] = { ...nodesNext[i], title: item.snapshot.name, metadata: { ...nodesNext[i].metadata, content, storageKey: item.snapshot.storageKey, mimeType: item.snapshot.mimeType, durationMs: item.snapshot.durationMs, ...(item.snapshot.assetRef ? { assetRef: item.snapshot.assetRef } : {}) } };
                }
            }

            // 画布选择的音频在同步时记录映射记忆（materialized: false）：之后清除/换源时该节点仍会进入 pre-prune 受管集合，幽灵边可被清扫（spec D20/D21）
            for (const shot of readyShots) {
                for (const slot of ["sfx", "dialogue"] as const) {
                    const ref = slot === "sfx" ? shot.sfxAudio : shot.dialogueAudio;
                    if (ref?.audioNodeId) (audioMappingNext[shot.shotId] ??= {})[slot] = { id: ref.audioNodeId, materialized: false };
                }
            }

            const canvasNodeIds = new Set(nodesNext.map((n) => n.id));

            // 展开应用的累积容器（上移声明：分镜图阶段 prune 也要同步清理连线，先于「既有引用收集」可用）
            const connectionsNext = [...connectionsRef.current];
            const shotNodeIds: Record<string, string> = { ...(scriptData.output.expandedShotNodes ?? {}) };
            const videoVersionsNext: Record<string, ShotVideoVersion[]> = { ...(scriptData.output.shotVideoVersions ?? {}) };

            // 2. 既有引用收集（D20）：Image 来源 + 该镜头受管音频来源边（映射 ∪ 画布选择）；手动连的第三方音频边不收集不破坏
            // 受管集合读物化前的 existingMapping（pre-prune）：清除/换源后的旧物化节点仍在集合内，其幽灵边会被同步删除
            const existingReferences: Record<string, string[]> = {};
            for (const shot of readyShots) {
                const nodeId = scriptData.output.expandedShotNodes?.[shot.shotId];
                if (!nodeId || !canvasNodeIds.has(nodeId)) continue;
                const managed = managedAudioNodeIds(shot, existingMapping, shot.shotId);
                existingReferences[shot.shotId] = connectionsRef.current
                    .filter((conn) => conn.toNodeId === nodeId && nodesRef.current.some((n) => n.id === conn.fromNodeId && (n.type === CanvasNodeType.Image || managed.has(conn.fromNodeId))))
                    .map((conn) => conn.fromNodeId);
                existingReferences[`__prompt__${shot.shotId}`] = [nodesNext.find((n) => n.id === nodeId)?.metadata?.prompt ?? ""];
            }

            // 2.5 分镜图阶段（分镜图先行 spec §6 / 评审 D-A）：幂等规划孤儿 prune 与 ready 首帧派生；
            // 分镜图未 ready 的镜头不在此拦截——按 direct 展开（引用资产图），补图后再次完成编辑自动切换首帧引用
            const storyboardFirst = scriptData.template?.storyboardFirst ?? false;
            const storyboardNodesNext: Record<string, string> = { ...(scriptData.output.storyboardNodes ?? {}) };
            let storyboardFirstFrameIds: Record<string, string> | undefined;
            if (storyboardFirst) {
                const sbPlan = planStoryboardExpansion({
                    // 分镜图属于镜头，尚未确认视频提示词不代表镜头已删除。
                    shots: scriptData.output.shots,
                    storyboardNodes: storyboardNodesNext,
                    canvasNodeIds,
                    readyStoryboardNodeIds: new Set(nodesNext.filter((n) => storyboardImageStateOf(n) === "ready").map((n) => n.id)),
                });
                // 应用 prune：删节点 + 同步清理其全部关联边（从属边 + 参考输入边），防幽灵边
                for (const item of sbPlan.prune) {
                    for (let i = nodesNext.length - 1; i >= 0; i--) if (nodesNext[i].id === item.nodeId) { nodesNext.splice(i, 1); break; }
                    for (let j = connectionsNext.length - 1; j >= 0; j--) {
                        if (connectionsNext[j].fromNodeId === item.nodeId || connectionsNext[j].toNodeId === item.nodeId) connectionsNext.splice(j, 1);
                    }
                    delete storyboardNodesNext[item.shotId];
                }
                storyboardFirstFrameIds = sbPlan.firstFrames;
            }
            const skippedStoryboard = storyboardFirst ? readyShots.length - Object.keys(storyboardFirstFrameIds ?? {}).length : 0;

            // 3. 展开规划（plan 拥有全部连线写入权，spec D3）
            const plan = planShotExpansion({
                shots: readyShots,
                expandedShotNodes: scriptData.output.expandedShotNodes ?? {},
                canvasNodeIds,
                entities,
                globalStyle: scriptData.globalStyle,
                existingReferences,
                shotAudioNodes: audioMappingNext,
                firstFrameNodeIds: storyboardFirstFrameIds,
            });

            // update：更新既有节点的 prompt/引用（E2：实体来源边整体重建；不动 position/status）
            for (const item of plan.update) {
                // legacy 存量镜头（有映射无版本表）首次同步回填 V1，避免重生成时旧节点被踢出版本列表
                if (!videoVersionsNext[item.shotId]) videoVersionsNext[item.shotId] = [{ nodeId: item.nodeId, no: 1 }];
                for (let i = 0; i < nodesNext.length; i++) {
                    if (nodesNext[i].id !== item.nodeId) continue;
                    nodesNext[i] = { ...nodesNext[i], metadata: { ...nodesNext[i].metadata, prompt: item.prompt, ...videoGenPatch, shotVideoRef: { scriptNodeId, shotId: item.shotId } } };
                }
                const shot = readyShots.find((s) => s.shotId === item.shotId);
                const managed = shot ? managedAudioNodeIds(shot, existingMapping, shot.shotId) : new Set<string>();
                const imageSourceIds = new Set(nodesRef.current.filter((n) => n.type === CanvasNodeType.Image).map((n) => n.id));
                for (let i = connectionsNext.length - 1; i >= 0; i--) {
                    if (connectionsNext[i].toNodeId !== item.nodeId) continue;
                    const from = connectionsNext[i].fromNodeId;
                    if (imageSourceIds.has(from) || managed.has(from)) connectionsNext.splice(i, 1);
                }
                for (const refNodeId of item.referenceNodeIds) connectionsNext.push({ id: nanoid(), fromNodeId: refNodeId, toNodeId: item.nodeId });
            }
            // create：新建视频节点（title 带镜号；不触发生成）
            let createIndex = 0;
            for (const item of plan.create) {
                const videoNode = createCanvasNode(CanvasNodeType.Video, { x: scriptNode.position.x + scriptNode.width + 96 + createIndex * 40, y: scriptNode.position.y + createIndex * 260 }, {
                    generationMode: "video",
                    prompt: item.prompt,
                    references: item.referenceNodeIds,
                    status: NODE_STATUS_IDLE,
                    shotVideoRef: { scriptNodeId, shotId: item.shotId },
                    ...videoGenPatch,
                });
                videoNode.title = item.title;
                shotNodeIds[item.shotId] = videoNode.id;
                videoVersionsNext[item.shotId] = pushShotVideoVersion(videoVersionsNext[item.shotId], videoNode.id);
                nodesNext.push(videoNode);
                connectionsNext.push({ id: nanoid(), fromNodeId: scriptNode.id, toNodeId: videoNode.id });
                for (const refNodeId of item.referenceNodeIds) connectionsNext.push({ id: nanoid(), fromNodeId: refNodeId, toNodeId: videoNode.id });
                createIndex++;
            }
            // reuse：仅同步标题（重排后镜号刷新）
            for (const item of plan.reuse) {
                // legacy 存量镜头（有映射无版本表）首次同步回填 V1，避免重生成时旧节点被踢出版本列表
                if (!videoVersionsNext[item.shotId]) videoVersionsNext[item.shotId] = [{ nodeId: item.nodeId, no: 1 }];
                for (let i = 0; i < nodesNext.length; i++) {
                    if (nodesNext[i].id !== item.nodeId) continue;
                    nodesNext[i] = { ...nodesNext[i], title: item.title, metadata: { ...nodesNext[i].metadata, shotVideoRef: { scriptNodeId, shotId: item.shotId } } };
                }
            }

            nodesRef.current = nodesNext;
            connectionsRef.current = connectionsNext;
            setNodes(nodesNext);
            setConnections(connectionsNext);
            updateScriptNodeData(scriptNodeId, (data) => ({ ...data, output: { ...data.output, expandedShotNodes: shotNodeIds, shotAudioNodes: audioMappingNext, shotVideoVersions: videoVersionsNext, storyboardNodes: storyboardNodesNext } }));
            const audioSynced = audioPlan.create.length + audioPlan.update.length;
            if (options.closeAfter !== false) {
                message.info(t("canvas.scriptStudio.syncSummary", { updated: plan.update.length + plan.reuse.length, created: plan.create.length }) + (audioSynced > 0 ? t("canvas.scriptStudio.syncAudioSummary", { audio: audioSynced }) : ""));
                // 分镜图先行收尾提示（评审 D-A）：未 ready 分镜图的镜头按 direct 展开，提示用户补图
                if (skippedStoryboard > 0) message.warning(t("canvas.scriptCompose.sbSkipped", { count: skippedStoryboard }));
                setScriptStudioNodeId(null);
            }
            return { ...shotNodeIds };
        },
        [ensureEntityRefNodes, message, setConnections, setNodes, t, updateScriptNodeData],
    );

    /** 单镜生成/重新生成视频（spec v2 D7/D10）：先同步单镜（复用批量规划），再按版本状态三路触发；不关 studio。
     *  有产出 → 走 handleGenerateNode 原生"新建子节点"分支（旧→新连线，参考上下文=当前版本的上游资产），
     *    经 onVideoChild 拿到子节点 id 后立即把映射与版本表指向它（预览随即显示生成中）。
     *  无产出（首生成/失败节点）→ 就地写回，不新增版本。 */
    const handleGenerateShotVideo = useCallback(
        async (scriptNodeId: string, shotId: string, settings?: Partial<CanvasNodeMetadata>) => {
            const scriptNode = nodesRef.current.find((n) => n.id === scriptNodeId);
            const shot = scriptNode?.metadata?.script?.output.shots.find((s) => s.shotId === shotId);
            if (!scriptNode || !shot?.composed || !shot.finalPrompt) return;
            // 本次生成落库的版本号 = 版本表 max(no)+1（首生成=1；再生成与 onVideoChild 的 pushShotVideoVersion 同值）。
            // 在同步前读取：同步对既有版本表无增删，读到的即本次新版本号。
            const scriptProvenance: ScriptAssetProvenance = { scriptNodeId, shotId, role: "video", version: nextShotVideoNo(scriptNode.metadata?.script?.output.shotVideoVersions?.[shotId]) };
            // 分镜图先行守卫（spec §6）：分镜图未 ready 不生成该镜视频（首帧还没有着落）
            if (scriptNode.metadata?.script?.template?.storyboardFirst) {
                const sbNodeId = scriptNode.metadata.script.output.storyboardNodes?.[shotId];
                const sbNode = sbNodeId ? nodesRef.current.find((n) => n.id === sbNodeId) : undefined;
                if (storyboardImageStateOf(sbNode ? { metadata: sbNode.metadata } : undefined) !== "ready") {
                    message.warning(t("canvas.scriptCompose.waitStoryboard"));
                    return;
                }
            }
            const nodeIdByShot = await handleBatchGenerateScriptVideos(scriptNodeId, { shotIds: [shotId], closeAfter: false });
            const currentNodeId = nodeIdByShot[shotId];
            if (settings && Object.keys(settings).length && currentNodeId) {
                // 弹窗确认的模型/尺寸等设置写入镜头视频节点（spec D13）：函数式更新叠加在 sync 的脚本写入之上（不可用值更新，会回滚版本链）
                nodesRef.current = nodesRef.current.map((n) => (n.id === currentNodeId ? { ...n, metadata: { ...n.metadata, ...settings } } : n));
                setNodes((prev) => prev.map((n) => (n.id === currentNodeId ? { ...n, metadata: { ...n.metadata, ...settings } } : n)));
            }
            const current = currentNodeId ? nodesRef.current.find((n) => n.id === currentNodeId) : undefined;
            if (!current || current.type !== CanvasNodeType.Video) return;
            if (current.metadata?.content) {
                generateNodeRef.current?.(current.id, "video", shot.finalPrompt, (childId) => {
                    updateScriptNodeData(scriptNodeId, (data) => ({
                        ...data,
                        output: {
                            ...data.output,
                            expandedShotNodes: { ...data.output.expandedShotNodes, [shotId]: childId },
                            shotVideoVersions: { ...data.output.shotVideoVersions, [shotId]: pushShotVideoVersion(data.output.shotVideoVersions?.[shotId], childId) },
                        },
                    }));
                }, undefined, undefined, undefined, scriptProvenance);
            } else {
                generateNodeRef.current?.(current.id, "video", shot.finalPrompt, undefined, undefined, undefined, undefined, scriptProvenance);
            }
        },
        [handleBatchGenerateScriptVideos, message, t, updateScriptNodeData],
    );

    /** 切换镜头当前视频版本（spec D9）：版本表重排（no 不变）+ 映射指向选中节点，一次落库；不触发生成。 */
    const handleSwitchShotVideo = useCallback(
        (scriptNodeId: string, shotId: string, nodeId: string) => {
            updateScriptNodeData(scriptNodeId, (data) => {
                const next = selectShotVideoVersion(data.output.shotVideoVersions?.[shotId], nodeId);
                if (!next) return data;
                return {
                    ...data,
                    output: {
                        ...data.output,
                        expandedShotNodes: { ...data.output.expandedShotNodes, [shotId]: nodeId },
                        shotVideoVersions: { ...data.output.shotVideoVersions, [shotId]: next },
                    },
                };
            });
        },
        [updateScriptNodeData],
    );


    const handleRetryNode = useCallback(
        async (node: CanvasNodeData, imageId?: string) => {
            const retryItemId = imageId || node.metadata?.primaryImageId || node.metadata?.images?.[0]?.id;
            try {
                if (await retryRemoteMediaNodeResult(node, { projectId, canvasId }, imageId)) return;
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("canvas.remoteTask.retryUnavailable"));
                return;
            }
            const sourceNode = findRetrySourceNode(node.id, nodesRef.current, connectionsRef.current) || node;
            // 重试产物沿用同一溯源：失败节点自带脚本血统（镜头视频/分镜图/实体参考图）时反推；普通节点为 undefined，行为不变。
            const retryProvenance = deriveScriptProvenance(node.id);
            const savedImageMetadata = node.type === CanvasNodeType.Image ? node.metadata : undefined;
            const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, hasSavedImageMetadata ? node : sourceNode, node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            if (isPluginNodeType(node.type)) {
                try { assertFalGenerationOperationSupported(generationConfig, "plugin-self"); }
                catch (error) { message.error(formatFalGenerationError(error)); return; }
            }
            const autodl = getConfiguredAutodlWorkflow(generationConfig);
            let context: Awaited<ReturnType<typeof hydrateNodeGenerationContext>> | null = null;
            let autodlRequest: MediaGenerateRequest | undefined;
            let falRequest: MediaGenerateRequest | undefined;
            try {
                if (!hasSavedImageMetadata) {
                    const raw = buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, sourceNode.metadata?.composerContent ?? sourceNode.metadata?.prompt ?? node.metadata?.prompt ?? "", { strictReferences: Boolean(autodl) || isConfiguredFalModel(generationConfig), resolveAsset });
                    context = autodl || isConfiguredFalModel(generationConfig) ? raw : await hydrateNodeGenerationContext(raw);
                    if (autodl) {
                        autodlRequest = await prepareAutodlGenerationRequest(generationConfig, raw);
                        buildAutodlVideoBody(autodlRequest);
                    }
                }
            } catch (error) {
                message.error(error instanceof Error ? formatFalGenerationError(error) : t("canvas.projectPage.generationFailed"));
                return;
            }
            const prompt = autodlRequest?.prompt ?? (savedImageMetadata?.prompt || context?.prompt || "").trim();
            if (!prompt && (!autodl || autodl.prompt)) {
                message.warning(t("canvas.projectPage.retryPromptMissing"));
                return;
            }
            const generationType = savedImageMetadata?.generationType;
            const useReferenceImages = generationType ? generationType === "edit" : Boolean(context?.referenceImages.length);
            const retryReferenceImages =
                hasSavedImageMetadata && savedImageMetadata ? await resolveMetadataReferences(savedImageMetadata) : useReferenceImages ? (context?.referenceImages.length ? context.referenceImages : sourceNodeReferenceImages(sourceNode)) : [];
            if (useReferenceImages && !retryReferenceImages) {
                message.error(t("canvas.projectPage.referenceMissing"));
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: item.metadata?.content ? undefined : t("canvas.projectPage.referenceMissing"), images: item.metadata?.images?.map((image) => (image.id === retryItemId ? { ...image, status: NODE_STATUS_ERROR, errorDetails: t("canvas.projectPage.referenceMissing") } : image)) } } : item)));
                return;
            }
            const retryImages = retryReferenceImages || [];
            if (isConfiguredFalModel(generationConfig)) {
                try {
                    falRequest = await prepareFalGenerationRequest(generationConfig, {
                        prompt, referenceImages: retryReferenceImages || [], referenceAudios: context?.referenceAudios || [], referenceVideos: context?.referenceVideos || [],
                        textCount: context?.textCount || 0, imageCount: retryImages.length, audioCount: context?.audioCount || 0, videoCount: context?.videoCount || 0,
                    }, node.metadata?.providerOptions ?? sourceNode.metadata?.providerOptions);
                } catch (error) { message.error(formatFalGenerationError(error)); return; }
            }

            const retryCapability = node.type === CanvasNodeType.Image ? "image" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : null;
            let retryExecution = planCanvasMediaGeneration({ config: generationConfig, capability: "text", phase: "retry" });
            try {
                if (retryCapability) retryExecution = planCanvasMediaGeneration({ config: generationConfig, capability: retryCapability, phase: "retry", pluginHost: !isConfiguredFalModel(generationConfig) && isPluginNodeType(sourceNode.type) });
            } catch (error) {
                message.error(error instanceof Error ? formatFalGenerationError(error) : t("canvas.projectPage.generationFailed"));
                return;
            }

            setRunningNodeId(node.id);
            const retryNodes = nodesRef.current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined, remoteTask: undefined, images: item.metadata?.images?.map((image) => image.id === retryItemId ? { ...image, status: NODE_STATUS_LOADING, errorDetails: undefined, remoteTask: undefined } : image) } } : item));
            setNodes(retryNodes);
            const controller = startGenerationRequest(node.id, sourceNode.id, node.id);

            try {
                if (retryCapability && retryExecution.mode === "remote_task") {
                    updateCanvas(projectId, canvasId, { nodes: retryNodes });
                    await startRemoteCanvasMediaTask({
                        config: { ...generationConfig, count: "1" },
                        capability: retryCapability,
                        prompt,
                        references: retryImages,
                        audioReferences: context?.referenceAudios,
                        videoReferences: context?.referenceVideos,
                        preparedMedia: autodlRequest,
                        preparedGeneration: falRequest,
                        ...(retryProvenance ? { scriptSource: retryProvenance } : {}),
                        target: { projectId, canvasId, nodeId: node.id, itemId: retryCapability === "image" ? retryItemId : undefined, sourceNodeId: sourceNode.id },
                    });
                    return;
                }
                if (node.type === CanvasNodeType.Text) {
                    if (!context) return;
                    let streamed = "";
                    const answer = await requestImageQuestion(
                        generationConfig,
                        buildNodeResponseMessages({ ...context, prompt }),
                        (text) => {
                            streamed = text;
                            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: text, status: NODE_STATUS_LOADING } } : item)));
                        },
                        { signal: controller.signal },
                    );
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: stripReasoningTags(answer || streamed), prompt, status: NODE_STATUS_SUCCESS } } : item)));
                    return;
                }
                if (node.type === CanvasNodeType.Video) {
                    const video = await storeGeneratedVideo(await requestVideoGeneration(generationConfig, prompt, retryImages, { signal: controller.signal }), assetWriteContext({ type: "generated", ...retryProvenance }, node.id));
                    const videoSize = fitNodeSize(video.width || node.width, video.height || node.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id
                                ? {
                                      ...item,
                                      width: videoSize.width,
                                      height: videoSize.height,
                                      position: { x: item.position.x + item.width / 2 - videoSize.width / 2, y: item.position.y + item.height / 2 - videoSize.height / 2 },
                                      metadata: {
                                          ...item.metadata,
                                          ...videoMetadata(video),
                                          prompt,
                                          model: generationConfig.model,
                                          size: generationConfig.size,
                                          seconds: generationConfig.videoSeconds,
                                          vquality: generationConfig.vquality,
                                          generateAudio: generationConfig.videoGenerateAudio,
                                          watermark: generationConfig.videoWatermark,
                                      },
                                  }
                                : item,
                        ),
                    );
                    return;
                }
                if (node.type === CanvasNodeType.Audio) {
                    const audio = await storeGeneratedAudio(await requestAudioGeneration(generationConfig, prompt, { signal: controller.signal }), generationConfig.audioFormat, assetWriteContext({ type: "generated", ...retryProvenance }, node.id));
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, ...audioMetadata(audio), prompt, ...buildAudioGenerationMetadata(generationConfig) } } : item)));
                    return;
                }

                const image = useReferenceImages
                    ? await requestEdit(generationConfig, prompt, retryImages, undefined, { signal: controller.signal }).then((items) => items[0])
                    : await requestGeneration(generationConfig, prompt, { signal: controller.signal }).then((items) => items[0]);
                const uploadedImage = await storeCanvasImage(image.dataUrl, assetWriteContext({ type: "generated", ...retryProvenance }, node.id));
                const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                const retryImage: CanvasNodeImage = {
                    id: retryItemId || nanoid(),
                    status: NODE_STATUS_SUCCESS,
                    content: uploadedImage.url,
                    storageKey: uploadedImage.storageKey,
                    ...(uploadedImage.assetRef ? { assetRef: uploadedImage.assetRef } : {}),
                    naturalWidth: uploadedImage.width,
                    naturalHeight: uploadedImage.height,
                    bytes: uploadedImage.bytes,
                    mimeType: uploadedImage.mimeType,
                };
                const generationMetadata = savedImageMetadata?.generationType
                    ? {
                          generationType: savedImageMetadata.generationType,
                          model: generationConfig.model,
                          size: generationConfig.size,
                          quality: generationConfig.quality,
                          vquality: generationConfig.vquality,
                          ...(generationConfig.background ? { background: generationConfig.background } : {}),
                          count: savedImageMetadata.count || 1,
                          references: savedImageMetadata.references,
                      }
                    : buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, 1, retryImages);
                setNodes((prev) =>
                    prev.map((item) => {
                        if (item.id !== node.id) return item;
                        const makePrimary = !imageId || !item.metadata?.content;
                        const edge = imageId ? Math.max(item.width, item.height) : 0;
                        const imageSize = imageId && item.metadata?.freeResize ? { width: item.width, height: item.height } : imageId ? fitNodeSize(uploadedImage.width, uploadedImage.height, edge, edge) : fitNodeSize(uploadedImage.width, uploadedImage.height, imageConfig.width, imageConfig.height);
                        return {
                            ...item,
                            type: CanvasNodeType.Image,
                            ...(makePrimary ? { width: imageSize.width, height: imageSize.height, ...(imageId ? { position: { x: item.position.x + item.width / 2 - imageSize.width / 2, y: item.position.y + item.height / 2 - imageSize.height / 2 } } : {}) } : {}),
                            metadata: {
                                ...item.metadata,
                                ...(makePrimary ? imageMetadata(uploadedImage) : { status: NODE_STATUS_SUCCESS }),
                                images: item.metadata?.images?.map((current) => (current.id === retryImage.id ? retryImage : current)),
                                primaryImageId: makePrimary ? retryImage.id : item.metadata?.primaryImageId,
                                prompt,
                                ...generationMetadata,
                            },
                        };
                    }),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? formatFalGenerationError(error) : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: item.metadata?.content ? undefined : errorDetails, images: item.metadata?.images?.map((image) => (image.id === retryItemId ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image)) } } : item)));
            } finally {
                finishGenerationRequest(node.id, controller);
                setRunningNodeId(null);
            }
        },
        [assetWriteContext, canvasId, deriveScriptProvenance, effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, projectId, resolveAsset, startGenerationRequest, t, updateCanvas],
    );

    const deleteBatchImage = useCallback((nodeId: string, imageId: string) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if ((node?.metadata?.images?.length || 0) <= 2) setExpandedBatchNodeIds((current) => new Set([...current].filter((id) => id !== nodeId)));
        setNodes((prev) =>
            prev.map((item) => {
                if (item.id !== nodeId) return item;
                const images = item.metadata?.images?.filter((image) => image.id !== imageId) || [];
                return { ...item, metadata: { ...item.metadata, images, count: images.length, primaryImageId: item.metadata?.primaryImageId === imageId ? images[0]?.id : item.metadata?.primaryImageId } };
            }),
        );
    }, []);

    const retryBatchImage = useCallback((node: CanvasNodeData, imageId: string) => void handleRetryNode(node, imageId), [handleRetryNode]);

    const generateImageFromTextNode = useCallback(
        (node: CanvasNodeData) => {
            const prompt = (node.metadata?.content || node.metadata?.prompt || "").trim();
            if (!prompt) {
                message.warning(t("canvas.projectPage.emptyTextImage"));
                return;
            }
            const sourceNode = nodesRef.current.find((item) => item.id === node.id);
            if (!sourceNode) return;
            const nodeSize = getNodeSpec(CanvasNodeType.Config);
            const configNode = createCanvasNode(
                CanvasNodeType.Config,
                {
                    x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2,
                    y: sourceNode.position.y + sourceNode.height / 2,
                },
                {
                    prompt: "",
                    model: effectiveConfig.imageModel || effectiveConfig.model,
                    size: effectiveConfig.size,
                    count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                },
            );
            const connection = { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: configNode.id };
            const nextNodes = nodesRef.current.map((item) => (item.id === sourceNode.id ? { ...item, metadata: { ...item.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS } } : item)).concat(configNode);
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message, t],
    );

    const insertAssistantImage = useCallback(
        async (image: CanvasAssistantImage) => {
            // 助手插入的生成图经项目资产门面落项目工作区（携带 assetRef）；已带 storageKey 的沿用旧引用。
            const storedImage = image.storageKey
                ? { url: image.dataUrl, storageKey: image.storageKey, width: 1, height: 1, bytes: 0, mimeType: "image/png" }
                : await storeCanvasImage(image.dataUrl, assetWriteContext({ type: "generated" }));
            const meta = storedImage.width === 1 && storedImage.height === 1 ? await readImageMeta(storedImage.url) : storedImage;
            const config = fitNodeSize(meta.width, meta.height);
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const node: CanvasNodeData = {
                id,
                type: CanvasNodeType.Image,
                title: image.prompt.slice(0, 32) || "Generated Image",
                position: { x: center.x - config.width / 2, y: center.y - config.height / 2 },
                width: config.width,
                height: config.height,
                metadata: { ...imageMetadata({ ...storedImage, width: meta.width, height: meta.height }), prompt: image.prompt },
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            setDialogNodeId(id);
        },
        [assetWriteContext, screenToCanvas, size.height, size.width],
    );

    const insertAssistantText = useCallback(
        (text: string, title?: string) => {
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const node = {
                ...createCanvasNode(CanvasNodeType.Text, center, { content: text, status: NODE_STATUS_SUCCESS }),
                title: title || text.slice(0, 32) || "Assistant Text",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
        },
        [screenToCanvas, size.height, size.width],
    );

    const handleAssetInsert = useCallback(
        async (payload: InsertAssetPayload) => {
            if (payload.kind === "text") {
                insertAssistantText(payload.content, payload.title);
            } else if (payload.kind === "video") {
                let url = payload.url;
                let storageKey = payload.storageKey;
                let insertedAssetRef: CanvasAssetRef | undefined;
                // 素材库直插（blob: URL 无本地 storageKey）：经项目资产门面落项目工作区，保证跨会话可播。
                // Web 上传素材始终带 IndexedDB storageKey，走不到这里，行为不变。
                if (!storageKey) {
                    try {
                        const stored = await storeCanvasMedia(url, assetWriteContext({ type: "derived" }));
                        url = stored.url;
                        storageKey = stored.storageKey;
                        insertedAssetRef = stored.assetRef;
                    } catch {
                        // 素材库直插落盘失败：提示并中止，不创建无法跨会话播放的节点。
                        message.error(t("canvas.sidePanel.addFailed"));
                        return;
                    }
                }
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                const nextSize = fitNodeSize(payload.width || spec.width, payload.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                setNodes((prev) => [
                    ...prev,
                    {
                        id,
                        type: CanvasNodeType.Video,
                        title: payload.title,
                        position: { x: center.x - nextSize.width / 2, y: center.y - nextSize.height / 2 },
                        width: nextSize.width,
                        height: nextSize.height,
                        metadata: { content: url, storageKey, status: NODE_STATUS_SUCCESS, naturalWidth: payload.width, naturalHeight: payload.height, ...(insertedAssetRef ? { assetRef: insertedAssetRef } : {}) },
                    },
                ]);
                setSelectedNodeIds(new Set([id]));
            } else {
                insertAssistantImage({ id: `asset-${Date.now()}`, prompt: payload.title, dataUrl: payload.dataUrl, storageKey: payload.storageKey });
            }
            setAssetPickerOpen(false);
        },
        [assetWriteContext, insertAssistantImage, insertAssistantText, screenToCanvas, size.height, size.width],
    );

    // Memoize every callback and render function passed to CanvasNode.
    // CanvasNode uses React.memo, but new prop references would invalidate it on every render and rerender every node
    // during click, hover, or viewport changes, which is especially expensive for Markdown. These useCallback values
    // and their memoized map/handler dependencies remain stable during interaction, so unchanged nodes do not rerender.
    const handleNodeHoverStart = useCallback((nodeId: string) => {
        if (nodeDraggingRef.current) return;
        setHoveredNodeId(nodeId);
    }, []);
    const handleNodeHoverEnd = useCallback((nodeId: string) => {
        setHoveredNodeId((current) => (current === nodeId ? null : current));
    }, []);
    const handleNodeViewImage = useCallback((node: CanvasNodeData, imageId?: string) => {
        setPreviewNodeId(node.id);
        setPreviewImageId(imageId || null);
    }, []);
    const handleNodeRetry = useCallback(
        (node: CanvasNodeData) => {
            if (node.type === CanvasNodeType.Text && (node.metadata?.textCount || 1) > 1) {
                void generateNodeRef.current?.(node.id, "text", node.metadata?.prompt || "");
                return;
            }
            void handleRetryNode(node);
        },
        [handleRetryNode],
    );
    const handleNodeContextMenu = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.preventDefault();
        event.stopPropagation();
        // v0.6：Group 节点走组级菜单（组内批量生成视频）
        if (nodeById.get(nodeId)?.type === CanvasNodeType.Group) {
            setContextMenu({ type: "group", x: event.clientX, y: event.clientY, nodeId });
            return;
        }
        setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId });
    }, []);

    /** 画布通用提示词面板生成入口（final-review Critical 1）：面板 onGenerate 直通 handleGenerateNode 无守卫，
     *  在回调处包一层分镜图先行判定（spec §13.2）——storyboard 血统且分镜图未 ready 的视频节点 toast 阻止。 */
    const handlePanelGenerate = useCallback(
        (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => {
            if (mode === "video" && storyboardWaitBlocked(nodeId)) {
                message.warning(t("canvas.scriptCompose.waitStoryboard"));
                return;
            }
            void handleGenerateNode(nodeId, mode, prompt);
        },
        [handleGenerateNode, message, storyboardWaitBlocked, t],
    );

    const renderNodePanel = useCallback(
        (panelNode: CanvasNodeData) =>
            getNodeDefinition(panelNode.type)?.Panel ? (
                renderPluginPanel(panelNode)
            ) : panelNode.type === CanvasNodeType.Config ? (
                <CanvasConfigComposer
                    nodeId={panelNode.id}
                    nodes={nodes}
                    value={panelNode.metadata?.composerContent ?? panelNode.metadata?.prompt ?? ""}
                    falConfig={buildGenerationConfig(effectiveConfig, panelNode, panelNode.metadata?.generationMode || "image")}
                    providerOptions={panelNode.metadata?.providerOptions}
                    workflowId={getConfiguredAutodlWorkflow(buildGenerationConfig(effectiveConfig, panelNode, panelNode.metadata?.generationMode || "image"))?.id}
                    composerMode={Boolean(panelNode.metadata?.composerContent?.trim())}
                    inputs={(isConfiguredFalModel(buildGenerationConfig(effectiveConfig, panelNode, panelNode.metadata?.generationMode || "image")) || getConfiguredAutodlWorkflow(buildGenerationConfig(effectiveConfig, panelNode, panelNode.metadata?.generationMode || "image")))
                        ? buildNodeGenerationInputs(panelNode.id, nodes, connections, { strictReferences: true })
                        : configInputsById.get(panelNode.id) || []}
                    connectedNodes={connectedNodesByNodeId.get(panelNode.id) || []}
                    onChange={(composerContent) => handleConfigNodeChange(panelNode.id, { composerContent })}
                    onClose={() => setDialogNodeId(null)}
                    onDisconnectReference={disconnectNodeReference}
                    onStartReferenceSelection={startNodeReferenceSelection}
                />
            ) : (
                <CanvasNodePromptPanel
                    node={panelNode}
                    nodes={nodes}
                    connections={connections}
                    isRunning={runningNodeId === panelNode.id || activeRemoteNodeIds.has(panelNode.id)}
                    mentionReferences={mentionReferencesByNodeId.get(panelNode.id) || EMPTY_REFERENCES}
                    assetCandidates={assetCandidates}
                    connectedNodes={connectedNodesByNodeId.get(panelNode.id) || []}
                    onPromptChange={handleNodePromptChange}
                    onConfigChange={handleConfigNodeChange}
                    onGenerate={handlePanelGenerate}
                    onStop={confirmStopGeneration}
                    onDisconnectReference={disconnectNodeReference}
                    onStartReferenceSelection={startNodeReferenceSelection}
                    modeOverride={getNodeDefinition(panelNode.type)?.useBuiltinPanel?.mode}
                    onImageSettingsOpenChange={(open) => {
                        setNodeImageSettingsOpen(open);
                        if (open) setToolbarNodeId(null);
                    }}
                />
            ),
        [activeRemoteNodeIds, assetCandidates, configInputsById, confirmStopGeneration, connectedNodesByNodeId, connections, effectiveConfig, disconnectNodeReference, handleConfigNodeChange, handleNodePromptChange, handlePanelGenerate, mentionReferencesByNodeId, nodes, renderPluginPanel, runningNodeId, startNodeReferenceSelection],
    );

    const renderNodeContentPanel = useCallback(
        (contentNode: CanvasNodeData) => (
            <CanvasConfigNodePanel
                node={contentNode}
                isRunning={runningNodeId === contentNode.id || activeRemoteNodeIds.has(contentNode.id)}
                inputSummary={getInputSummary(configInputsById.get(contentNode.id) || [])}
                inputs={configInputsById.get(contentNode.id) || []}
                onConfigChange={handleConfigNodeChange}
                onComposerToggle={() => setDialogNodeId((current) => (current === contentNode.id ? null : contentNode.id))}
                onStop={confirmStopGeneration}
                onGenerate={(nodeId) => {
                    const target = nodesRef.current.find((item) => item.id === nodeId);
                    void handleGenerateNode(nodeId, target?.metadata?.generationMode || "image", target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                }}
            />
        ),
        [activeRemoteNodeIds, configInputsById, confirmStopGeneration, handleConfigNodeChange, handleGenerateNode, runningNodeId],
    );

    if (!projectLoaded) return <CanvasRefreshShell />;

    return (
        <main className="relative flex h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <CanvasResourcesDrawer nodes={nodes} selectedNodeIds={selectedNodeIds} onFocusNode={focusNode} onPreviewNode={setPreviewNodeId} onInsertAsset={handleAssetInsert} />
            <section className="relative min-w-0 flex-1 overflow-hidden">
                <CanvasTopBar
                    agentOpen={agentPanelOpen}
                    onToggleAgent={toggleAgentPanel}
                    viewportControls={(
                        <CanvasZoomControls
                            scale={viewport.k}
                            onReset={resetViewport}
                            isMiniMapOpen={isMiniMapOpen}
                            onToggleMiniMap={() => setIsMiniMapOpen((value) => !value)}
                            backgroundMode={backgroundMode}
                            showImageInfo={showImageInfo}
                            onBackgroundModeChange={setBackgroundMode}
                            onShowImageInfoChange={setShowImageInfo}
                        />
                    )}
                />

                {nodes.length === 0 && !nodeCreatePosition ? (
                    <div className="pointer-events-none absolute inset-0 z-[5] flex flex-col items-center justify-center gap-4 text-center">
                        {/* Subtle visual anchor: a dashed card outline gives the eye somewhere to land
                            in the otherwise empty canvas without contradicting the flat/minimal brief. */}
                        <div
                            className="grid size-44 place-items-center rounded-3xl border-2 border-dashed"
                            style={{ borderColor: theme.node.faint }}
                        >
                            <MousePointerClick className="size-7" style={{ color: theme.node.muted }} />
                        </div>
                        <div className="space-y-1" style={{ color: theme.node.faint }}>
                            <p className="text-sm">{t("canvas.emptyCanvasHint")}</p>
                            <p className="text-xs opacity-70">{t("canvas.emptyCanvasHintSub")}</p>
                        </div>
                    </div>
                ) : null}

                <Shotshot
                    containerRef={containerRef}
                    viewport={viewport}
                    tool={canvasTool}
                    backgroundMode={backgroundMode}
                    onViewportChange={(next) => {
                        setViewport(next);
                        setContextMenu(null);
                    }}
                    onCanvasMouseDown={(event) => {
                        if (!referencePickerNodeId) handleCanvasMouseDown(event);
                    }}
                    onCanvasDeselect={referencePickerNodeId ? undefined : deselectCanvas}
                    onNodeClickSelect={handleCanvasNodeClickSelect}
                    panGestureRef={panGestureRef}
                    suppressNodePan={Boolean(referencePickerNodeId)}
                    onCanvasDoubleClick={(event) => {
                        if (referencePickerNodeId) return;
                        setContextMenu(null);
                        setNodeCreatePosition(screenToCanvas(event.clientX, event.clientY));
                    }}
                    onContextMenu={preventCanvasContextMenu}
                    onDrop={handleDrop}
                >
                    <svg className="absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible" style={{ pointerEvents: "none", transform: "translateZ(0)", zIndex: 0 }}>
                        {connections
                            .map((connection) => {
                                const from = nodeById.get(connection.fromNodeId);
                                const to = nodeById.get(connection.toNodeId);
                                if (!from || !to) return null;

                                return (
                                    <ConnectionPath
                                        key={connection.id}
                                        connection={connection}
                                        from={from}
                                        to={to}
                                        active={selectedConnectionId === connection.id || relatedHighlight.connectionIds.has(connection.id)}
                                        onSelect={() => {
                                            setSelectedConnectionId(connection.id);
                                            setSelectedNodeIds(new Set());
                                            setContextMenu(null);
                                        }}
                                        onContextMenu={(event) => {
                                            setSelectedConnectionId(connection.id);
                                            setSelectedNodeIds(new Set());
                                            setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId: connection.id });
                                        }}
                                    />
                                );
                            })}
                        {/* 消费边：资产参考图节点 → 引用它的镜头生成节点。由 shots[].entityRefs 派生渲染，
                            不落库（避免与 CanvasConnection 双份 source of truth）。 */}
                        {(() => {
                            const entityIndex = useScriptEntityStore.getState().entities;
                            const resolveSlotNodeId = (entityId: string) => {
                                const entity = entityIndex.find((e) => e.id === entityId);
                                return entity?.refs.find((r) => r.state === "ready")?.nodeId;
                            };
                            const derivedEdges = nodes
                                .filter((node) => node.type === SCRIPT_NODE_TYPE && node.metadata?.script)
                                .flatMap((node) =>
                                    deriveConsumptionEdges(node.metadata!.script!, resolveSlotNodeId)
                                        .map((edge, index) => ({ ...edge, id: `derived-${node.id}-${index}` })),
                                )
                                .filter((edge) => !connections.some((conn) => conn.fromNodeId === edge.fromNodeId && conn.toNodeId === edge.toNodeId));
                            return derivedEdges.map((edge) => {
                                const from = nodeById.get(edge.fromNodeId);
                                const to = nodeById.get(edge.toNodeId);
                                if (!from || !to) return null;
                                return <ConnectionPath key={edge.id} connection={edge} from={from} to={to} active={false} derived />;
                            });
                        })()}
                        {connectingParams ? <ActiveConnectionPath node={nodeById.get(connectingParams.nodeId)} handle={connectingParams} mouseWorld={mouseWorld} target={connectionTargetNodeId ? nodeById.get(connectionTargetNodeId) : undefined} /> : null}
                    </svg>

                    {visibleNodes.map((node) => (
                        <CanvasNode
                            key={node.id}
                            data={node}
                            scale={viewport.k}
                            isSelected={selectedNodeIds.has(node.id)}
                            isRelated={relatedHighlight.nodeIds.has(node.id)}
                            isFocusRelated={activeNodeId === node.id}
                            isConnectionTarget={connectionTargetNodeId === node.id}
                            isConnecting={Boolean(connectingParams)}
                            referenceSelectionState={!referencePickerNodeId ? undefined : node.id === referencePickerNodeId ? "target" : referenceConnectedNodeIds.has(node.id) || !isCanvasReferenceNode(node, nodes) ? "disabled" : "available"}
                            showPanel={!isNodeResizing && dialogNodeId === node.id && !selectionBox && !getNodeDefinition(node.type)?.hidePanel}
                            groupChildCount={groupChildCountById.get(node.id) || 0}
                            isGroupDropTarget={dropTargetGroupId === node.id}
                            batchExpanded={expandedBatchNodeIds.has(node.id)}
                            showImageInfo={showImageInfo}
                            mentionReferences={mentionReferencesByNodeId.get(node.id) || EMPTY_REFERENCES}
                            pluginHost={pluginHost}
                            registryVersion={nodeRegistryVersion}
                            renderPanel={renderNodePanel}
                            renderNodeContent={renderNodeContentPanel}
                            onMouseDown={handleNodeMouseDown}
                            onSelectCapture={handleNodeSelectCapture}
                            onHoverStart={handleNodeHoverStart}
                            onHoverEnd={handleNodeHoverEnd}
                            onConnectStart={handleConnectStart}
                            onResizeStart={handleNodeResizeStart}
                            onResize={handleNodeResize}
                            onResizeEnd={handleNodeResizeEnd}
                            onContentChange={handleNodeContentChange}
                            onTitleChange={handleNodeTitleChange}
                            onToggleBatch={toggleBatchExpanded}
                            onSetBatchPrimary={setBatchPrimary}
                            onDuplicateBatchImage={duplicateBatchImage}
                            onDownloadBatchImage={downloadBatchImage}
                            onRetryBatchImage={retryBatchImage}
                            onDeleteBatchImage={deleteBatchImage}
                            onRetry={handleNodeRetry}
                            onViewImage={handleNodeViewImage}
                            onSelectReference={selectNodeReference}
                            onContextMenu={handleNodeContextMenu}
                        />
                    ))}

                    {selectionBox ? (
                        <svg
                            className="pointer-events-none absolute z-[100] overflow-visible"
                            style={{
                                left: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
                                top: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
                                width: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
                                height: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY),
                            }}
                        >
                            <rect width="100%" height="100%" fill={theme.canvas.selectionFill} stroke={theme.canvas.selectionStroke} strokeOpacity={0.55} strokeWidth={1 / viewport.k} strokeDasharray={`${6 / viewport.k} ${4 / viewport.k}`} />
                        </svg>
                    ) : null}
                    {pendingConnectionCreate ? <ConnectionCreateMenu pending={pendingConnectionCreate} onCreate={(type) => createConnectedNode(type, pendingConnectionCreate)} onClose={cancelPendingConnectionCreate} /> : null}
                    {nodeCreatePosition ? (
                        <NodeCreateMenu
                            position={nodeCreatePosition}
                            onCreate={(type) => {
                                createNode(type, nodeCreatePosition);
                                setNodeCreatePosition(null);
                            }}
                            onClose={() => setNodeCreatePosition(null)}
                        />
                    ) : null}
                </Shotshot>

                {/* 提示胶囊挂在视口层：Shotshot 内的变换层没有宽度，absolute 按钮会被压成一字宽竖排。 */}
                {referencePickerNodeId ? <button type="button" className="absolute left-1/2 top-4 z-[90] -translate-x-1/2 rounded-full border px-4 py-2 text-sm font-medium shadow-lg backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} onClick={exitNodeReferenceSelection}>{t("canvas.references.selectingHint")}</button> : null}

                <CanvasNodeHoverToolbar
                    node={isNodeDragging || isNodeResizing || nodeImageSettingsOpen || expandedBatchNodeIds.has(toolbarNode?.id || "") ? null : toolbarNode}
                    viewport={viewport}
                    extraTools={toolbarNode ? buildNodeToolbarItems(toolbarNode) : undefined}
                    onKeep={keepNodeToolbar}
                    onLeave={hideNodeToolbar}
                    onInfo={(node) => setInfoNodeId(node.id)}
                    onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                    onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                    onToggleDialog={(node) => setDialogNodeId((current) => (current === node.id ? null : node.id))}
                    onGenerateImage={generateImageFromTextNode}
                    onUpload={(node) => handleUploadRequest(node.id)}
                    onDownload={downloadNodeImage}
                    onSaveAsset={(node) => void saveNodeAsset(node)}
                    onMaskEdit={(node) => setMaskEditNodeId(node.id)}
                    onCrop={(node) => setCropNodeId(node.id)}
                    onSplit={(node) => setSplitNodeId(node.id)}
                    onUpscale={(node) => setUpscaleNodeId(node.id)}
                    onSuperResolve={(node) => setSuperResolveNodeId(node.id)}
                    onAngle={(node) => setAngleNodeId(node.id)}
                    onViewImage={handleNodeViewImage}
                    onReversePrompt={createImageReversePromptNodes}
                    onRetry={(node) => void handleRetryNode(node)}
                    onToggleFreeResize={(node) => toggleNodeFreeResize(node.id)}
                    onDelete={(node) => deleteNodes(new Set([node.id]))}
                />

                <CanvasToolbar
                    canvasTool={canvasTool}
                    onAddImage={() => createNode(CanvasNodeType.Image)}
                    onAddVideo={() => createNode(CanvasNodeType.Video)}
                    onAddModel3d={() => createNode(MODEL_3D_NODE_TYPE)}
                    onAddAudio={() => createNode(CanvasNodeType.Audio)}
                    onAddText={() => createNode(CanvasNodeType.Text)}
                    onAddScript={() => createNode(SCRIPT_NODE_TYPE)}
                    onAddExtensionNode={(type) => createNode(type)}
                    onUpload={() => handleUploadRequest()}
                    onCanvasToolChange={setCanvasTool}
                />

                {isMiniMapOpen ? <Minimap nodes={nodes} viewport={viewport} viewportSize={size} onViewportChange={setViewport} /> : null}

                {contextMenu ? (
                    <CanvasNodeContextMenu
                        menu={contextMenu}
                        node={contextMenuNode}
                        canCaptureVideoFrame={contextMenuNode?.type === CanvasNodeType.Video && Boolean(contextMenuNode.metadata?.content)}
                        groupBatch={contextMenu.type === "group" ? (() => {
                            const members = nodes.filter((n) => n.metadata?.groupId === contextMenu.nodeId);
                            const { start, skipped } = selectGroupVideoTargets(members);
                            return { start: start.length, skipped, onGenerate: () => handleGroupBatchGenerate(contextMenu.nodeId) };
                        })() : undefined}
                        onClose={() => setContextMenu(null)}
                        onCaptureVideoFrame={(position) => {
                            if (contextMenu.type !== "node") return;
                            void captureVideoNodeFrame(contextMenu.nodeId, position);
                        }}
                        onView={() => {
                            if (contextMenu.type !== "node") return;
                            handleNodeViewImage(contextMenuNode);
                            setContextMenu(null);
                        }}
                        onDownload={() => {
                            if (contextMenu.type !== "node") return;
                            downloadNodeImage(contextMenuNode);
                            setContextMenu(null);
                        }}
                        onDuplicate={() => {
                            if (contextMenu.type !== "node") return;
                            duplicateNode(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onDelete={() => {
                            if (contextMenu.type === "node") {
                                deleteNodes(new Set([contextMenu.nodeId]));
                            } else {
                                deleteConnection(contextMenu.connectionId);
                            }
                            setContextMenu(null);
                        }}
                    />
                ) : null}

                <input ref={imageInputRef} type="file" multiple accept="image/*,video/*,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" className="hidden" onChange={handleImageInputChange} />

                <CanvasNodeInfoModal node={infoNode} open={Boolean(infoNode)} onClose={() => setInfoNodeId(null)} />
                <CanvasPluginManagerModal open={pluginManagerOpen} onClose={() => setPluginManagerOpen(false)} />

                {cropNode?.metadata?.content ? <CanvasNodeCropDialog dataUrl={cropNode.metadata.content} open={Boolean(cropNode)} onClose={() => setCropNodeId(null)} onConfirm={(crop) => void cropImageNode(cropNode!, crop)} /> : null}

                {maskEditNode?.metadata?.content ? (
                    <CanvasNodeMaskEditDialog dataUrl={maskEditNode.metadata.content} open={Boolean(maskEditNode)} onClose={() => setMaskEditNodeId(null)} onConfirm={(payload) => void maskEditImageNode(maskEditNode!, payload)} />
                ) : null}

                {splitNode?.metadata?.content ? <CanvasNodeSplitDialog dataUrl={splitNode.metadata.content} open={Boolean(splitNode)} onClose={() => setSplitNodeId(null)} onConfirm={(params) => void splitImageNode(splitNode!, params)} /> : null}

                {upscaleNode?.metadata?.content ? (
                    <CanvasNodeUpscaleDialog dataUrl={upscaleNode.metadata.content} open={Boolean(upscaleNode)} onClose={() => setUpscaleNodeId(null)} onConfirm={(params) => void upscaleImageNode(upscaleNode!, params)} />
                ) : null}

                <Modal title={t("canvas.projectPage.superResolve")} open={Boolean(superResolveNode?.metadata?.content)} centered footer={null} onCancel={() => setSuperResolveNodeId(null)}>
                    <div className="py-8 text-center text-base font-medium">{t("canvas.projectPage.notImplemented")}</div>
                </Modal>

                {angleNode?.metadata?.content ? <CanvasNodeAngleDialog dataUrl={angleNode.metadata.content} open={Boolean(angleNode)} onClose={() => setAngleNodeId(null)} onConfirm={(params) => void generateAngleNode(angleNode!, params)} /> : null}

                <Modal
                    title={t("canvas.projectPage.imageDetails")}
                    open={Boolean(previewContent)}
                    centered
                    onCancel={() => setPreviewNodeId(null)}
                    footer={null}
                    width="auto"
                    styles={{ body: { padding: 0, display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "80vh" } }}
                >
                    {previewContent ? <img src={previewContent} alt={previewNode?.title || t("assets.kinds.image")} style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }} /> : null}
                </Modal>

                {preview3dNode ? (
                    <Model3dViewer
                        node={preview3dNode}
                        onClose={() => setPreview3dNodeId(null)}
                        onCameraChange={(camera) =>
                            setNodes((prev) =>
                                prev.map((node) =>
                                    node.id === preview3dNode.id ? { ...node, metadata: { ...node.metadata, model3d: { ...node.metadata?.model3d, camera } } } : node,
                                ),
                            )
                        }
                    />
                ) : null}

                <AssetPickerModal open={assetPickerOpen} onInsert={handleAssetInsert} onClose={() => setAssetPickerOpen(false)} />
            </section>
            {storyboardRequest && (() => {
                const scriptNode = nodes.find((node) => node.id === storyboardRequest.scriptNodeId);
                const script = scriptNode?.metadata?.script;
                if (!scriptNode || !script) return null;
                const count = storyboardRequest.shotId ? 1 : script.output.shots.filter((shot) => {
                    const state = storyboardImageStateOf(nodes.find((node) => node.id === script.output.storyboardNodes?.[shot.shotId]));
                    return state !== "ready" && state !== "generating";
                }).length;
                return <GenerateStoryboardDialog node={{ ...scriptNode, metadata: imageGenMetadataPatch(script.template?.imageGen) }} count={count}
                    onCancel={() => setStoryboardRequest(null)} onConfirm={(settings) => {
                        setStoryboardRequest(null);
                        if (storyboardRequest.shotId) void handleGenerateStoryboard(storyboardRequest.scriptNodeId, storyboardRequest.shotId, settings);
                        else handleBatchGenerateStoryboards(storyboardRequest.scriptNodeId, settings);
                    }} />;
            })()}
            {assetRefGen ? (
                <GenerateStoryboardDialog
                    node={{ id: `asset-ref-${assetRefGen.entityId}-${assetRefGen.refId}`, type: CanvasNodeType.Image, title: "", position: scriptStudioNode?.position ?? { x: 0, y: 0 }, width: 340, height: 240, metadata: {} }}
                    count={1}
                    title={t("canvas.scriptAssets.genDialogTitle")}
                    hint={t("canvas.scriptAssets.genDialogHint", { name: assetRefGen.draft.name })}
                    promptPreview={composeEntityRefPrompt(assetRefGen.draft)}
                    maxCount={1}
                    countLocked
                    onConfirm={(settings) => handleConfirmEntityRef(assetRefGen, settings)}
                    onCancel={() => setAssetRefGen(null)}
                />
            ) : null}
            {scriptStudioNode ? (
                <ScriptStudio
                    node={scriptStudioNode}
                    projectId={projectId}
                    canvasImageNodes={canvasImageNodes}
                    audioNodes={audioNodes}
                    onImportAudio={handleImportAudio}
                    onClose={() => setScriptStudioNodeId(null)}
                    onUpdateScript={updateScriptNodeData}
                    onGenerateRef={handleGenerateEntityRef}
                    onPickEntityRefLibrary={handlePickEntityRefLibrary}
                    onBatchGenerate={handleBatchGenerateScriptVideos}
                    onComposeWithAgent={() => {
                        setScriptStudioNodeId(null);
                        openAgentPanel();
                    }}
                    canvasVideoNodes={nodes.filter((n) => n.type === CanvasNodeType.Video)}
                    onGenerateShotVideo={handleGenerateShotVideo}
                    onSwitchShotVideo={handleSwitchShotVideo}
                    storyboardFirst={scriptStudioNode.metadata?.script?.template?.storyboardFirst ?? false}
                    storyboardImageState={storyboardImageState}
                    assetCandidates={assetCandidates}
                    onSelectStoryboard={(shotId, source) => handleSelectStoryboard(scriptStudioNode.id, shotId, source)}
                    onGenerateStoryboard={(shotId) => setStoryboardRequest({ scriptNodeId: scriptStudioNodeId!, shotId })}
                    onBatchGenerateStoryboards={() => setStoryboardRequest({ scriptNodeId: scriptStudioNodeId! })}
                    onToast={(msg) => message.info(msg)}
                />
            ) : null}
        </main>
    );
}
