import { useEffect, useSyncExternalStore } from "react";
import { ensureManagedCatalog, managedCatalogSnapshot, subscribeManagedCatalog, type ManagedCatalogSnapshot } from "./managed-catalog-cache";

export function useManagedCatalog(enabled = true): ManagedCatalogSnapshot | null {
    useEffect(() => {
        if (!enabled) return;
        void ensureManagedCatalog().catch(() => undefined);
    }, [enabled]);
    return useSyncExternalStore(subscribeManagedCatalog, managedCatalogSnapshot);
}
