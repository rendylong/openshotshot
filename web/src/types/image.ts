import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";

export type ReferenceImage = {
    id: string;
    name: string;
    type: string;
    dataUrl: string;
    url?: string;
    storageKey?: string;
    assetRef?: CanvasAssetRef;
};
