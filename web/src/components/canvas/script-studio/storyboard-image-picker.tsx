import { useRef, useState } from "react";
import { Input, Modal } from "antd";
import { Image, Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/ui/empty-state";
import { MODAL_WIDTH } from "@/lib/design/modal";
import { useAssetStore } from "@/stores/use-asset-store";
import type { CanvasNodeData } from "@/types/canvas";

export type StoryboardImageSource = { kind: "canvas"; nodeId: string } | { kind: "library"; assetId: string };

type Props = {
    source: "canvas" | "library";
    canvasImageNodes: CanvasNodeData[];
    onSelect: (source: StoryboardImageSource) => Promise<void>;
    onClose: () => void;
};

export function StoryboardImagePicker({ source, canvasImageNodes, onSelect, onClose }: Props) {
    const { t } = useTranslation();
    const assets = useAssetStore((state) => state.assets);
    const [query, setQuery] = useState("");
    const [busy, setBusy] = useState(false);
    const selecting = useRef(false);
    const [error, setError] = useState(false);
    const candidates = source === "canvas"
        ? canvasImageNodes.filter((node) => node.metadata?.content && node.metadata.status !== "loading" && node.metadata.status !== "error")
            .map((node) => ({ id: node.id, title: node.title, url: node.metadata!.content! }))
        : assets.filter((asset) => asset.kind === "image")
            .map((asset) => ({ id: asset.id, title: asset.title, url: asset.coverUrl || asset.data.dataUrl }));
    const filtered = candidates.filter((item) => item.title.toLowerCase().includes(query.trim().toLowerCase()));
    const select = async (id: string) => {
        if (selecting.current) return;
        selecting.current = true;
        setBusy(true);
        setError(false);
        try {
            await onSelect(source === "canvas" ? { kind: source, nodeId: id } : { kind: source, assetId: id });
            onClose();
        } catch {
            setError(true);
        } finally {
            selecting.current = false;
            setBusy(false);
        }
    };
    return (
        <Modal open title={t(source === "canvas" ? "canvas.scriptAssets.fromCanvas" : "canvas.scriptAssets.fromLibrary")}
            onCancel={busy ? undefined : onClose} closable={!busy} mask={{ closable: !busy }} keyboard={!busy}
            footer={null} centered width={MODAL_WIDTH.lg}>
            <Input value={query} onChange={(event) => setQuery(event.target.value)} allowClear
                prefix={<Search className="size-4 text-muted-foreground" />} placeholder={t("canvas.assetPicker.search")} />
            {error && <p role="alert" className="mt-3 text-xs text-danger">{t("canvas.scriptCompose.sbSelectFailed")}</p>}
            <div aria-busy={busy} className="mt-4 max-h-[55vh] overflow-y-auto">
                {filtered.length ? <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                    {filtered.map((item) => <button key={item.id} type="button" disabled={busy} onClick={() => void select(item.id)}
                        className="overflow-hidden rounded-lg border border-border text-left transition-colors hover:bg-accent disabled:opacity-50">
                        <img src={item.url} alt="" className="aspect-[4/3] w-full object-contain" />
                        <span className="block truncate p-2 text-xs">{item.title}</span>
                    </button>)}
                </div> : <EmptyState icon={Image} title={t(source === "canvas" ? "canvas.scriptAssets.canvasEmpty" : "canvas.scriptAssets.libraryEmpty")} />}
            </div>
        </Modal>
    );
}
