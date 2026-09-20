import { FileText, Group, Image as ImageIcon, Music2, ScrollText, Settings2, Video } from "lucide-react";

import i18n from "@/i18n";

import { NODE_SPECS } from "@/constant/canvas";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeDefinition, CanvasNodeResource } from "@/types/canvas-plugin";
import { SCRIPT_NODE_TYPE, createEmptyScriptData } from "@/types/script-node";
import { FileNodeContent } from "./file-node";
import { ScriptNodeContent } from "./script-node";

// Extensible metadata for built-in nodes, reusing NODE_SPECS for size and initial metadata.
// Rendering remains in canvas-node's internal renderer, so no Content component is provided.
function builtinResource(node: CanvasNodeData): CanvasNodeResource | null {
    if (node.type === CanvasNodeType.Image && node.metadata?.content) return { kind: "image", url: node.metadata.content };
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return { kind: "video", url: node.metadata.content };
    if (node.type === CanvasNodeType.Audio && node.metadata?.content) return { kind: "audio", url: node.metadata.content };
    if (node.type === CanvasNodeType.File && node.metadata?.content) return { kind: "text", text: node.title };
    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return { kind: "text", text: node.metadata.content || node.metadata.prompt };
    return null;
}

const iconClass = "size-5";

const BUILTIN_DEFINITIONS: CanvasNodeDefinition[] = [
    { type: CanvasNodeType.Text, title: i18n.t("assets.kinds.text"), icon: <FileText className={iconClass} />, resource: builtinResource },
    { type: CanvasNodeType.Image, title: i18n.t("assets.kinds.image"), icon: <ImageIcon className={iconClass} />, keepAspectRatio: (node: CanvasNodeData) => !node.metadata?.freeResize, resource: builtinResource },
    { type: CanvasNodeType.Video, title: i18n.t("assets.kinds.video"), icon: <Video className={iconClass} />, keepAspectRatio: () => true, resource: builtinResource },
    { type: CanvasNodeType.Audio, title: i18n.t("assets.kinds.audio"), icon: <Music2 className={iconClass} />, resource: builtinResource },
    { type: CanvasNodeType.File, title: i18n.t("canvas.nodeTypes.file"), icon: <FileText className={iconClass} />, Content: FileNodeContent },
    { type: CanvasNodeType.Config, title: i18n.t("canvas.configNode.title"), icon: <Settings2 className={iconClass} />, hasSourceHandle: false },
    { type: CanvasNodeType.Group, title: i18n.t("canvas.node.group"), icon: <Group className={iconClass} /> },
].map((def) => {
    const spec = NODE_SPECS[def.type];
    return { ...def, title: spec.title, defaultSize: { width: spec.width, height: spec.height }, defaultMetadata: spec.metadata };
});

// Script node is registered as an open-string builtin type (model3d precedent): it carries its
// own defaultSize/defaultMetadata, so it skips the NODE_SPECS mapping above.
const SCRIPT_NODE_DEFINITION: CanvasNodeDefinition = {
    type: SCRIPT_NODE_TYPE,
    title: i18n.t("canvas.scriptNode.title"),
    icon: <ScrollText className={iconClass} />,
    defaultSize: { width: 280, height: 190 },
    defaultMetadata: { script: createEmptyScriptData() },
    hidePanel: true, // v0.5：选中脚本节点不出现底部快捷输入栏
    Content: ScriptNodeContent,
    // 生成中也允许查看、编辑：studio 经 props 实时读节点，Agent 落库的镜头即时可见
    onDoubleClick: (ctx) => {
        ctx.emit("open-script-studio", { nodeId: ctx.node.id });
        return true;
    },
};

let registered = false;
export function registerBuiltinNodes() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions([...BUILTIN_DEFINITIONS, SCRIPT_NODE_DEFINITION], "builtin");
}
