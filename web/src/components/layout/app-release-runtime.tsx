import { useEffect } from "react";
import { useAppReleaseStore } from "@/stores/use-app-release-store";

export function AppReleaseRuntime() {
    const initialize = useAppReleaseStore((state) => state.initialize);
    useEffect(() => { void initialize(); }, [initialize]);
    return null;
}
