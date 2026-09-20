import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { deleteStoredImages, imageToDataUrl, uploadImage } from "@/services/image-storage";
import { getCanvasAssetBlob } from "@/services/project-asset-storage";
import { readFileAsDataUrl } from "@/lib/image-utils";
import type { Model3dCameraPose, Model3dViewId } from "@/lib/canvas/model-3d-camera";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";

export type Model3dCapturedView = { id: Model3dViewId; dataUrl: string };
export type Model3dResolvedView = Model3dCapturedView & { storageKey?: string; assetRef?: CanvasAssetRef };
export type Model3dPersistedView = { id: Model3dViewId; storageKey: string };
/** 节点元数据里的持久化视图（桌面 move 语义下可能只剩 assetRef，storageKey 已剥离）。 */
type Model3dStoredView = { id: Model3dViewId; storageKey?: string; assetRef?: CanvasAssetRef };

type CaptureResult = Model3dCapturedView[] | string[];

// WebGL pixels stay module-local. Persisted canvas data contains only storage keys, so neither
// canvas JSON nor Agent snapshots carry large Data URLs.
const viewCache = new Map<string, Model3dResolvedView[]>();
const captureFns = new Map<string, (camera?: Model3dCameraPose) => CaptureResult>();
const inFlight = new Map<string, Promise<Model3dResolvedView[]>>();
const VIEW_ORDER: Model3dViewId[] = ["primary", "left", "right", "top"];

export function isPluginNodeType(type: string) {
    return !(Object.values(CanvasNodeType) as string[]).includes(type);
}

export function registerCaptureFn(nodeId: string, fn: (camera?: Model3dCameraPose) => CaptureResult) {
    captureFns.set(nodeId, fn);
}

export function unregisterNodeSnapshots(nodeId: string) {
    captureFns.delete(nodeId);
    viewCache.delete(nodeId);
    inFlight.delete(nodeId);
}

export function getLiveModel3dViews(nodeId: string) {
    return viewCache.get(nodeId) ?? [];
}

export function setLiveModel3dViews(nodeId: string, views: Model3dCapturedView[]) {
    viewCache.set(nodeId, normalizeCapturedViews(views));
}

export function getLiveSnapshot(nodeId: string) {
    return getLiveModel3dViews(nodeId).find((view) => view.id === "primary")?.dataUrl ?? null;
}

export function setLiveSnapshot(nodeId: string, dataUrl: string) {
    const rest = getLiveModel3dViews(nodeId).filter((view) => view.id !== "primary");
    viewCache.set(nodeId, [{ id: "primary", dataUrl }, ...rest]);
}

export function clearModel3dSnapshots() {
    viewCache.clear();
    captureFns.clear();
    inFlight.clear();
}

export type PersistedSnapshot = { storageKey: string };

export async function persistSnapshot(dataUrl: string, previousKey?: string): Promise<PersistedSnapshot | null> {
    try {
        const uploaded = await uploadImage(dataUrl);
        if (!uploaded.storageKey) return null;
        if (previousKey && previousKey !== uploaded.storageKey) await deleteStoredImages([previousKey]);
        return { storageKey: uploaded.storageKey };
    } catch (error) {
        console.warn("[model3d] snapshot persist failed", error);
        return null;
    }
}

function normalizeCapturedViews(result: CaptureResult | undefined): Model3dCapturedView[] {
    if (!result?.length) return [];
    if (typeof result[0] === "string") {
        return (result as string[]).slice(0, VIEW_ORDER.length).map((dataUrl, index) => ({ id: VIEW_ORDER[index], dataUrl }));
    }
    const byId = new Map((result as Model3dCapturedView[]).map((view) => [view.id, view]));
    return VIEW_ORDER.map((id) => byId.get(id)).filter((view): view is Model3dCapturedView => Boolean(view?.dataUrl));
}

function persistedViewKeys(node: CanvasNodeData): Model3dStoredView[] {
    // 桌面 move 语义：迁移/采纳后的 views 只剩 project-file assetRef（storageKey 已剥离）——同样视为已物化，
    // 防止冷缓存读取时丢失视图、被重新 uploadImage 写回 IndexedDB（终审 I2）。
    const views = node.metadata?.model3d?.views ?? [];
    const byId = new Map(views.filter((view) => Boolean(view.storageKey || view.assetRef?.backend === "project-file")).map((view) => [view.id, view]));
    return VIEW_ORDER.map((id) => byId.get(id)).filter((view): view is Model3dStoredView => Boolean(view));
}

async function hydratePersistedViews(node: CanvasNodeData): Promise<Model3dResolvedView[]> {
    const persisted = persistedViewKeys(node);
    if (persisted.length) {
        const hydrated = await Promise.all(
            persisted.map(async (view): Promise<Model3dResolvedView | null> => {
                try {
                    // assetRef 优先走项目工作区字节；storageKey 仅作未迁移旧数据的回退。
                    let dataUrl = "";
                    if (view.assetRef) {
                        const blob = await getCanvasAssetBlob(view.assetRef);
                        if (blob) dataUrl = await readFileAsDataUrl(new File([blob], "view", { type: blob.type }));
                    }
                    if (!dataUrl.startsWith("data:image/") && view.storageKey) {
                        dataUrl = await imageToDataUrl({ storageKey: view.storageKey });
                    }
                    return dataUrl.startsWith("data:image/") ? { ...view, dataUrl } : null;
                } catch (error) {
                    console.warn(`[model3d] ${view.id} view resolve failed`, error);
                    return null;
                }
            }),
        );
        const resolved = hydrated.filter((view): view is Model3dResolvedView => view !== null);
        if (resolved.length) return resolved;
    }

    const legacyKey = node.metadata?.model3d?.snapshot?.storageKey;
    if (!legacyKey) return [];
    try {
        const dataUrl = await imageToDataUrl({ storageKey: legacyKey });
        return dataUrl.startsWith("data:image/") ? [{ id: "primary", dataUrl, storageKey: legacyKey }] : [];
    } catch (error) {
        console.warn("[model3d] snapshot resolve failed", error);
        return [];
    }
}

export type EnsureModel3dViewsOptions = {
    onPersisted?: (views: Model3dPersistedView[]) => void;
};

/** Resolve semantic 3D references without exposing their pixels through canvas persistence. */
export async function ensureModel3dViews(node: CanvasNodeData, options?: EnsureModel3dViewsOptions): Promise<Model3dResolvedView[]> {
    const existing = inFlight.get(node.id);
    if (existing) return existing;

    const promise = (async () => {
        const live = normalizeCapturedViews(captureFns.get(node.id)?.(node.metadata?.model3d?.camera));
        if (live.length) {
            setLiveModel3dViews(node.id, live);
            const uploaded = await Promise.all(
                live.map(async (view) => {
                    try {
                        const result = await uploadImage(view.dataUrl);
                        return result.storageKey ? { id: view.id, storageKey: result.storageKey } : null;
                    } catch (error) {
                        console.warn(`[model3d] ${view.id} view upload failed`, error);
                        return null;
                    }
                }),
            );
            const persisted = uploaded.filter((view): view is Model3dPersistedView => Boolean(view));
            if (persisted.length === live.length && options?.onPersisted) {
                options.onPersisted(persisted);
                const adoptedKeys = new Set(persisted.map((view) => view.storageKey));
                const oldKeys = [
                    // assetRef-only 的持久化视图没有 storageKey：无可回收的 IDB 键，必须剔除 undefined
                    ...persistedViewKeys(node).map((view) => view.storageKey).filter((key): key is string => Boolean(key)),
                    ...(node.metadata?.model3d?.snapshot?.storageKey ? [node.metadata.model3d.snapshot.storageKey] : []),
                ].filter((key) => !adoptedKeys.has(key));
                if (oldKeys.length) await deleteStoredImages(Array.from(new Set(oldKeys)));
            }
            return live.map((view) => ({ ...view, storageKey: persisted.find((item) => item.id === view.id)?.storageKey }));
        }

        const stored = await hydratePersistedViews(node);
        if (stored.length) {
            viewCache.set(node.id, stored);
            return stored;
        }
        return getLiveModel3dViews(node.id);
    })().finally(() => {
        if (inFlight.get(node.id) === promise) inFlight.delete(node.id);
    });
    inFlight.set(node.id, promise);
    return promise;
}

export type EnsureSnapshotOptions = {
    onPersisted?: (storageKey: string) => void;
};

/** Backward-compatible primary-view wrapper for existing resource and generation callers. */
export async function ensureSnapshot(node: CanvasNodeData, options?: EnsureSnapshotOptions): Promise<string | null> {
    const views = await ensureModel3dViews(node, {
        onPersisted: options?.onPersisted
            ? (persisted) => {
                  const primary = persisted.find((view) => view.id === "primary");
                  if (primary) options.onPersisted?.(primary.storageKey);
              }
            : undefined,
    });
    return views.find((view) => view.id === "primary")?.dataUrl ?? null;
}
