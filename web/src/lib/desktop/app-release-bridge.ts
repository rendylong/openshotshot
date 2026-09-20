export const APP_RELEASE_CHANNELS = {
    getState: "app-release:get-state",
    refresh: "app-release:refresh",
    openDownload: "app-release:open-download",
    changed: "app-release:state-changed",
} as const;

export type AppReleaseStatus = "idle" | "up_to_date" | "soft_update" | "force_update";

export type AppReleasePolicy = {
    minVersion: string;
    latestVersion: string;
    downloadUrl: string;
    notes: string;
    updatedAt: string | null;
};

export type AppReleaseState = {
    status: AppReleaseStatus;
    policy: AppReleasePolicy | null;
    checkedAt: string | null;
};

export type AppReleaseBridge = {
    getState(): Promise<AppReleaseState>;
    refresh(): Promise<AppReleaseState>;
    openDownload(): Promise<void>;
    onChanged(listener: (state: AppReleaseState) => void): () => void;
};

const STATUS_VALUES: readonly string[] = ["idle", "up_to_date", "soft_update", "force_update"];

export function assertAppReleaseState(value: unknown): asserts value is AppReleaseState {
    if (!value || typeof value !== "object") throw new Error("invalid_app_release_payload");
    const candidate = value as Partial<AppReleaseState>;
    if (typeof candidate.status !== "string" || !STATUS_VALUES.includes(candidate.status)) {
        throw new Error("invalid_app_release_payload");
    }
    if (candidate.checkedAt !== null && typeof candidate.checkedAt !== "string") {
        throw new Error("invalid_app_release_payload");
    }
    if (candidate.policy === null) return;
    if (!candidate.policy || typeof candidate.policy !== "object") {
        throw new Error("invalid_app_release_payload");
    }
    const policy = candidate.policy as Partial<AppReleasePolicy>;
    if (typeof policy.minVersion !== "string" || typeof policy.latestVersion !== "string" ||
        typeof policy.downloadUrl !== "string" || typeof policy.notes !== "string" ||
        (policy.updatedAt !== null && typeof policy.updatedAt !== "string")) {
        throw new Error("invalid_app_release_payload");
    }
}

type RendererIpc = {
    invoke(channel: string): Promise<unknown>;
    on(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
    removeListener(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
};

export function createAppReleaseBridge(ipc: RendererIpc): AppReleaseBridge {
    return {
        async getState() {
            const value = await ipc.invoke(APP_RELEASE_CHANNELS.getState);
            assertAppReleaseState(value);
            return value;
        },
        async refresh() {
            const value = await ipc.invoke(APP_RELEASE_CHANNELS.refresh);
            assertAppReleaseState(value);
            return value;
        },
        openDownload: () => ipc.invoke(APP_RELEASE_CHANNELS.openDownload).then(() => undefined),
        onChanged(listener) {
            const ipcListener = (_event: unknown, value: unknown) => {
                assertAppReleaseState(value);
                listener(value);
            };
            ipc.on(APP_RELEASE_CHANNELS.changed, ipcListener);
            return () => { ipc.removeListener(APP_RELEASE_CHANNELS.changed, ipcListener); };
        },
    };
}
