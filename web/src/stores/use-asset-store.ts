import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";
import { localForageStorage } from "@/lib/localforage-storage";
import { cleanupUnusedImages, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { cleanupUnusedMedia, resolveMediaUrl } from "@/services/file-storage";
import { resolveCanvasAssetUrl } from "@/services/project-asset-storage";

export type AssetKind = "text" | "image" | "video";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string; assetRef?: CanvasAssetRef } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string; assetRef?: CanvasAssetRef } };
export type Asset = TextAsset | ImageAsset | VideoAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    hydrated: boolean;
    assets: Asset[];
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt"> & { id?: string }) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    replaceAssets: (assets: Asset[]) => void;
    cleanupImages: (extra?: unknown) => void;
};

export const ASSET_STORE_KEY = "shotshot:asset_store";

export async function migrateAssetMedia<T extends Asset>(asset: T): Promise<T> {
    if (asset.kind === "video") {
        if (asset.data.storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(asset.data.storageKey, asset.data.url) } };
        if (asset.data.assetRef) {
            const url = await resolveCanvasAssetUrl(asset.data.assetRef, asset.data.url);
            return url ? { ...asset, data: { ...asset.data, url } } : asset;
        }
        return asset;
    }
    if (asset.kind !== "image") return asset;
    if (asset.data.storageKey)
        return {
            ...asset,
            coverUrl: asset.coverUrl.startsWith("blob:") ? await resolveImageUrl(asset.data.storageKey, asset.coverUrl) : asset.coverUrl,
            data: { ...asset.data, dataUrl: await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl) },
        };
    // 桌面「存入素材库」的 assetRef-only 图：经项目资产解析复活（否则死 blob 永久失效）
    if (asset.data.assetRef) {
        const url = await resolveCanvasAssetUrl(asset.data.assetRef, "");
        return url ? { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? url : asset.coverUrl, data: { ...asset.data, dataUrl: url || asset.data.dataUrl } } : asset;
    }
    if (!asset.data.dataUrl.startsWith("data:image/")) return asset;
    const image = await uploadImage(asset.data.dataUrl);
    return { ...asset, coverUrl: asset.coverUrl.startsWith("data:image/") ? image.url : asset.coverUrl, data: { ...asset.data, dataUrl: image.url, storageKey: image.storageKey, bytes: image.bytes, mimeType: image.mimeType } };
}

const localForagePersistStorage: PersistStorage<AssetStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<AssetStore>;
        parsed.state.assets = await Promise.all(parsed.state.assets.map((asset) => migrateAssetMedia(asset)));
        return parsed;
    },
    setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => localForageStorage.removeItem(name),
};

// 桌面端素材库以 library manifest 为唯一真值：store 仅作内存 read-model，不再落 localforage（避免双真值）。
const memoryPersistStorage: PersistStorage<AssetStore> = {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
};

const assetStorage: PersistStorage<AssetStore> =
    typeof window !== "undefined" && window.shotshot?.libraryAssets ? memoryPersistStorage : localForagePersistStorage;

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            assets: [],
            addAsset: (asset) => {
                const now = new Date().toISOString();
                // 桌面素材库条目（带 storageRef）保留 buildLibraryAsset 给出的 library assetId，
                // 与 refreshLibraryAsset 的 presence 检查（item.id === assetId）对齐，避免 changed 事件先到时产生重复卡片。
                const id = asset.metadata?.storageRef && asset.id ? asset.id : nanoid();
                set((state) => (state.assets.some((item) => item.id === id) ? state : { assets: [{ ...asset, id, createdAt: now, updatedAt: now } as Asset, ...state.assets] }));
                return id;
            },
            updateAsset: (id, patch) =>
                set((state) => ({
                    assets: state.assets.map((asset) => (asset.id === id ? ({ ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset) : asset)),
                })),
            removeAsset: (id) =>
                set((state) => {
                    const assets = state.assets.filter((asset) => asset.id !== id);
                    get().cleanupImages({ assets });
                    return { assets };
                }),
            replaceAssets: (assets) => set({ assets }),
            cleanupImages: (extra) => {
                window.setTimeout(async () => {
                    const { useProjectStore } = await import("@/stores/canvas/use-project-store");
                    const latestReferences = () => ({ assets: get().assets, projects: useProjectStore.getState().projects, extra });
                    await cleanupUnusedImages(latestReferences(), latestReferences);
                    await cleanupUnusedMedia(latestReferences(), latestReferences);
                }, 0);
            },
        }),
        {
            name: ASSET_STORE_KEY,
            storage: assetStorage,
            partialize: (state) => ({ assets: state.assets }) as StorageValue<AssetStore>["state"],
            onRehydrateStorage: () => () => {
                useAssetStore.setState({ hydrated: true });
            },
        },
    ),
);
