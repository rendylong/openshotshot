import { FileText, Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import i18n from "@/i18n";
import { useProjectAssetUrl } from "@/hooks/use-project-asset-url";
import { resolveMediaUrl } from "@/services/file-storage";
import type { CanvasNodeContext } from "@/types/canvas-plugin";

export function FileNodeContent({ ctx }: { ctx: CanvasNodeContext }) {
    const assetRef = ctx.node.metadata?.assetRef;
    const fallback = ctx.node.metadata?.content || "";
    // 项目文件资产经 hook 解析（changed/missing 事件驱动）；无 assetRef 才走旧 IndexedDB 解析器。
    const projectAsset = useProjectAssetUrl(assetRef, fallback);
    const storageKey = ctx.node.metadata?.storageKey;
    const [legacy, setLegacy] = useState(() => ({ url: "", loading: Boolean(storageKey) && !assetRef, error: "" }));
    const mimeType = ctx.node.metadata?.mimeType || "application/octet-stream";

    useEffect(() => {
        if (assetRef || !storageKey) return;
        let disposed = false;
        setLegacy((current) => ({ ...current, loading: true }));
        void resolveMediaUrl(storageKey, fallback).then((resolved) => {
            if (disposed) return;
            setLegacy({ url: resolved, loading: false, error: resolved ? "" : i18n.t("canvas.fileNode.unavailable") });
        }).catch((reason) => {
            if (disposed) return;
            setLegacy({ url: "", loading: false, error: reason instanceof Error ? reason.message : String(reason) });
        });
        return () => { disposed = true; };
    }, [assetRef, fallback, storageKey]);

    const loading = assetRef ? projectAsset.status === "loading" : legacy.loading;
    const error = assetRef ? (projectAsset.status === "missing" ? i18n.t("canvas.fileNode.unavailable") : "") : legacy.error;
    const url = assetRef ? projectAsset.url : legacy.url || fallback;

    if (loading) return <div className="flex h-full items-center justify-center gap-2 text-xs opacity-70"><Loader2 className="size-4 animate-spin" />{i18n.t("canvas.fileNode.loading")}</div>;
    if (error) return <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center text-xs opacity-70"><TriangleAlert className="size-5" />{error}</div>;
    if (mimeType === "application/pdf" && url) return <iframe title={ctx.node.title} src={url} className="h-full w-full border-0" />;
    return <div className="flex h-full flex-col items-center justify-center gap-3 px-5 text-center"><FileText className="size-10 opacity-45" /><span className="max-w-full truncate text-sm">{ctx.node.title}</span><span className="text-xs opacity-60">{mimeType}</span></div>;
}
