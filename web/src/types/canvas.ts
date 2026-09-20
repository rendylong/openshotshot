import type { ProviderOptions } from "@/lib/models/provider-options";
import type { RemoteMediaTaskStatus, RemoteTaskPhase } from "@/types/remote-media-task";
import type { Model3dCameraPose, Model3dViewId } from "@/lib/canvas/model-3d-camera";
import type { ScriptNodeData } from "@/types/script-node";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";

export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Config = "config",
    Video = "video",
    Audio = "audio",
    File = "file",
    Group = "group",
}

// Node types are open strings: built-ins use CanvasNodeType and plugins use "<pluginId>:<name>".
export type CanvasNodeTypeId = CanvasNodeType | (string & {});

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasImageGenerationType = "generation" | "edit";

export type CanvasRemoteTaskMetadata = {
    recoveryPhase?: "confirming" | "fetching";
    id: string;
    status: RemoteMediaTaskStatus;
    phase?: RemoteTaskPhase;
    progress?: number;
    submittedAt: number;
    sourceNodeId?: string;
};

export type CanvasNodeImage = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
    storageKey?: string;
    assetRef?: CanvasAssetRef;
    naturalWidth: number;
    naturalHeight: number;
    bytes: number;
    mimeType: string;
    remoteTask?: CanvasRemoteTaskMetadata;
};

export type CanvasNodeText = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
};

export type CanvasNodeMetadata = {
    providerOptions?: ProviderOptions;
    content?: string;
    composerContent?: string;
    prompt?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    reasoningEffort?: "auto" | "low" | "medium" | "high" | "xhigh";
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
    textCount?: number;
    texts?: CanvasNodeText[];
    primaryTextId?: string;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    references?: string[];
    /** Agent-selected 3D reference views for this generation target. Missing means the manual/default all-view behavior. */
    reference3dViews?: Record<string, Model3dViewId | "all">;
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    images?: CanvasNodeImage[];
    primaryImageId?: string;
    storageKey?: string;
    assetRef?: CanvasAssetRef;
    sourceHandle?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    groupId?: string;
    interactive?: boolean; // Plugin node interaction/move state; see CanvasNodeDefinition.interactionToggle.
    remoteTask?: CanvasRemoteTaskMetadata;
    model3d?: {
        name?: string;
        storageKey?: string;
        assetRef?: CanvasAssetRef;
        content?: string;
        mimeType?: string;
        bytes?: number;
        camera?: Model3dCameraPose;
        views?: Array<{ id: Model3dViewId; storageKey?: string; assetRef?: CanvasAssetRef }>;
        // Persisted viewport snapshot used as the generation reference. Nested under a literal
        // `storageKey` field so collectImageStorageKeys keeps it during unused-image cleanup.
        snapshot?: { storageKey: string };
    };
    script?: ScriptNodeData;
    /** 图片生成节点完成后的实体参考图槽回写标记（脚本链路资产生成专用，v0.5 指向 refs[].id） */
    scriptEntityRef?: { entityId: string; refId: string };
    /** 分镜图节点归属标记（分镜图先行 v0.1，spec D6）：该图片节点是哪个脚本节点哪个镜头的分镜图 */
    shotStoryboardRef?: { scriptNodeId: string; shotId: string };
    /** 镜头视频节点血统标记（脚本同步打点）：画布侧/Agent 侧再生成时据此反推资产溯源 */
    shotVideoRef?: { scriptNodeId: string; shotId: string };
    /** 库来源实体参考复制节点的资产溯源标记（spec D1）：复用判定与错峰坐标按它收敛 */
    derivedFromAssetId?: string;
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    /** 生成血统边（to 节点由 from 节点再生成产生）：不是参考输入，参考收集与引用栏必须跳过。 */
    lineage?: boolean;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      }
    | {
          /** v0.6：Group 节点上下文菜单（组级批量生成视频等） */
          type: "group";
          x: number;
          y: number;
          nodeId: string;
      };
