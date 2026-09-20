import { useEffect } from "react";

import { hydrateLibraryAssets, markLibraryAssetMissing, onLibraryAssetChanged, refreshLibraryAsset } from "@/services/library-asset-storage";
import { migrateLegacyAssetsToLibrary } from "@/lib/library-assets/library-asset-migration";
import { useAssetStore } from "@/stores/use-asset-store";

export function useLibraryAssetSync(): void {
    useEffect(() => {
        if (!window.shotshot?.libraryAssets) return;
        let disposed = false;
        void (async () => {
            const migration = await migrateLegacyAssetsToLibrary();
            if (migration.migrated > 0 || migration.missing > 0) console.info("[library-assets] legacy migration:", migration);
            if (disposed) return;
            useAssetStore.getState().replaceAssets(await hydrateLibraryAssets());
        })().catch((error) => {
            console.error("[library-assets] init failed:", error);
        });
        const unsubscribe = onLibraryAssetChanged((event) => {
            if (event.type === "changed") void refreshLibraryAsset(event.record.assetId);
            else markLibraryAssetMissing(event.ref.assetId);
        });
        return () => {
            disposed = true;
            unsubscribe();
        };
    }, []);
}
