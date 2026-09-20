import { useEffect } from "react";
import { useUserStore } from "@/stores/use-user-store";

export function AccountRuntime() {
    useEffect(() => {
        void useUserStore.getState().initialize();
        return () => useUserStore.getState().dispose();
    }, []);
    return null;
}
