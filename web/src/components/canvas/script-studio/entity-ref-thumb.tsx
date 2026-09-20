import { useEffect, useState } from "react";
import { Image as ImageIcon, Plus } from "lucide-react";

import { useProjectAssetUrl } from "@/hooks/use-project-asset-url";
import { resolveImageUrl } from "@/services/image-storage";
import type { ScriptEntityRefSlot } from "@/stores/use-script-entity-store";
import type { CanvasNodeData } from "@/types/canvas";

type Props = {
    refSlot: ScriptEntityRefSlot;
    canvasImageNodes: CanvasNodeData[];
    /** 解析失败回退图标的尺寸类（默认 size-3.5，适配列表槽位盒） */
    iconClassName?: string;
};

/** 槽位缩略内容：ready 时渲染真实参考图（nodeId → 画布节点 dataURL；assetRef → 项目资产；
    storageKey → 异步 objectURL，勿 revoke），解析失败回退通用图标。 */
export function EntityRefThumb({ refSlot, canvasImageNodes, iconClassName = "size-3.5" }: Props) {
    const node = refSlot.nodeId ? canvasImageNodes.find((n) => n.id === refSlot.nodeId) : undefined;
    // 节点 content 可能是重载即死的 objectURL：带 assetRef 的节点走项目资产解析（对齐 canvas-node.tsx 显示层）
    const nodeProject = useProjectAssetUrl(node?.metadata?.assetRef, node?.metadata?.content || "");
    const nodeDataUrl = node ? nodeProject.url : undefined;
    const [storageUrl, setStorageUrl] = useState("");
    // 桌面项目资产：挂载/changed 事件驱动解析；无 assetRef 才走旧 IndexedDB 解析器。
    const ready = refSlot.state === "ready" && !refSlot.nodeId;
    const project = useProjectAssetUrl(ready ? refSlot.assetRef : undefined, "");
    const storageKey = ready && !refSlot.assetRef ? refSlot.storageKey : undefined;

    useEffect(() => {
        if (!storageKey) {
            setStorageUrl("");
            return;
        }
        let active = true;
        setStorageUrl(""); // 换源时先清掉旧 objectURL，避免解析期间/失败后残留上一张图
        resolveImageUrl(storageKey)
            .then((url) => {
                if (active) setStorageUrl(url);
            })
            .catch(() => {
                if (active) setStorageUrl("");
            });
        return () => {
            active = false;
        };
    }, [storageKey]);

    if (refSlot.state === "queued") return <>…</>;
    if (refSlot.state === "empty") return <Plus className="size-3 opacity-60" aria-hidden />;
    const src = nodeDataUrl || (refSlot.assetRef && ready ? project.url : "") || storageUrl;
    return src ? <img src={src} alt="" className="h-full w-full rounded object-cover" /> : <ImageIcon className={iconClassName} aria-hidden />;
}
