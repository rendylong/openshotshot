import { FileText, Image as ImageIcon, Music2, Plus, Puzzle, Video, X } from "lucide-react";
import { Popover } from "antd";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { getGroupResourceNodes, isCanvasReferenceNode, nodePreviewImageUrl } from "@/lib/canvas/canvas-resource-references";
import { countNodeReferenceImages } from "@/components/canvas/canvas-node-generation";
import { useProjectAssetUrl } from "@/hooks/use-project-asset-url";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export function CanvasNodeReferenceBar({ nodeId, nodes, connectedNodes, onDisconnect, onStartSelection }: { nodeId: string; nodes: CanvasNodeData[]; connectedNodes: CanvasNodeData[]; onDisconnect?: (fromNodeId: string, toNodeId: string) => void; onStartSelection?: (nodeId: string) => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    // 与生成输入同源资格过滤（isCanvasReferenceNode）：脚本从属边、config 等非资源节点不是参考，不渲染芯片。
    // 取严格口径（strictReferences）：空图片虽被非严格生成忽略，但严格生成会对它报"参考素材不可用"，隐藏会让报错更难理解。
    const references = connectedNodes
        .filter((sourceNode) => isCanvasReferenceNode(sourceNode, nodes, { strictReferences: true }))
        .flatMap((sourceNode) => (sourceNode.type === CanvasNodeType.Group ? getGroupResourceNodes(sourceNode.id, nodes) : [sourceNode]).map((node) => ({ node, sourceNodeId: sourceNode.id })));
    return (
        <div className="mb-2">
            <div className="mb-1.5 text-[11px] font-medium" style={{ color: theme.node.muted }}>{t("canvas.references.title")}</div>
            <div className="thin-scrollbar flex min-h-12 gap-2 overflow-x-auto pb-1">
                {references.map(({ node, sourceNodeId }) => <ReferenceItem key={`${sourceNodeId}:${node.id}`} node={node} onRemove={() => onDisconnect?.(sourceNodeId, nodeId)} />)}
                <button type="button" className="grid size-12 shrink-0 place-items-center rounded-xl border bg-transparent transition hover:opacity-70" style={{ borderColor: theme.toolbar.border, color: theme.node.muted }} title={t("canvas.references.select")} onClick={() => onStartSelection?.(nodeId)}>
                    <Plus className="size-4" />
                </button>
            </div>
        </div>
    );
}

function ReferenceItem({ node, onRemove }: { node: CanvasNodeData; onRemove: () => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const resource = getNodeDefinition(node.type)?.resource?.(node);
    // 3d 等 plugin 节点的 metadata.content 是 GLB blob: URL（非图片），必须优先取 resource().url
    // 的视口截图快照，否则引用栏/预览会把 GLB 当图片渲染成破图。与 canvas-resource-references.ts 的
    // previewUrl 顺序保持一致。
    const preview = nodePreviewImageUrl(node);
    // 项目文件资产节点（桌面生成的图/视频）：重载后 content 是死 objectURL，须经 assetRef 解析
    // （对齐 canvas-node.tsx 显示层），否则参考芯片裂图。
    const project = useProjectAssetUrl(node.metadata?.assetRef, preview ?? "");
    const content = project.url || preview;
    // 3D 等多视角参考源会展开成多张参考图（如主/左/右/顶四视角），在芯片上标注实际张数，
    // 否则面板上看不出引用会被展开成几张。
    const imageCount = countNodeReferenceImages(node);
    const Icon = resource?.kind === "image" || node.type === CanvasNodeType.Image ? ImageIcon : resource?.kind === "video" || node.type === CanvasNodeType.Video ? Video : resource?.kind === "audio" || node.type === CanvasNodeType.Audio ? Music2 : resource?.kind === "text" || node.type === CanvasNodeType.Text ? FileText : Puzzle;
    return (
        <Popover placement="topLeft" mouseEnterDelay={0.15} content={<ReferencePreview node={node} content={content} />}>
            <div className="group relative grid size-12 shrink-0 place-items-center rounded-xl border" style={{ background: theme.toolbar.activeBg, borderColor: theme.toolbar.border }}>
                <span className="grid size-full place-items-center overflow-hidden rounded-[inherit]">
                    {(resource?.kind === "image" || node.type === CanvasNodeType.Image) && content ? <img src={content} alt="" className="size-full object-cover" /> : (resource?.kind === "video" || node.type === CanvasNodeType.Video) && content ? <video src={content} className="size-full object-cover" muted /> : <Icon className="size-4 opacity-65" />}
                </span>
                {imageCount > 1 ? (
                    <span className="absolute inset-x-0 bottom-0 rounded-b-[inherit] border-t px-0.5 text-center text-[9px] leading-3.5" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }} title={t("canvas.references.imageCount", { count: imageCount })}>
                        {t("canvas.references.imageCount", { count: imageCount })}
                    </span>
                ) : null}
                <button type="button" className="absolute right-0 top-0 grid size-5 place-items-center rounded-full border opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} aria-label={t("canvas.references.disconnect")} title={t("canvas.references.disconnect")} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onRemove(); }}><X className="size-3" /></button>
            </div>
        </Popover>
    );
}

function ReferencePreview({ node, content }: { node: CanvasNodeData; content?: string }) {
    const { t } = useTranslation();
    const resource = getNodeDefinition(node.type)?.resource?.(node);
    if ((resource?.kind === "image" || node.type === CanvasNodeType.Image) && content) return <img src={content} alt={node.title} className="max-h-52 w-72 rounded-lg object-contain" />;
    if ((resource?.kind === "video" || node.type === CanvasNodeType.Video) && content) return <video src={content} className="max-h-52 w-72 rounded-lg" muted controls />;
    if ((resource?.kind === "audio" || node.type === CanvasNodeType.Audio) && content) return <audio src={content} className="w-72" controls />;
    return <div className="max-h-52 w-72 overflow-auto whitespace-pre-wrap text-sm">{resource?.text || node.metadata?.content || node.metadata?.prompt || node.title || t("canvas.references.empty")}</div>;
}
