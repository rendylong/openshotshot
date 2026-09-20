import type { AppReleasePolicy, AppReleaseState, AppReleaseStatus } from "../web/src/lib/desktop/app-release-bridge";
import { compareVersions } from "../web/src/lib/version-compare";
import { isSafeDownloadUrl } from "./window-security";

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const DEFAULT_DOWNLOAD_URL = "https://shotshot.ai/download";
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export function platformToken(platform: NodeJS.Platform): "mac" | "win" | "linux" {
    if (platform === "darwin") return "mac";
    if (platform === "win32") return "win";
    return "linux";
}

export function sanitizePolicyVersion(value: unknown): string {
    return typeof value === "string" && VERSION_PATTERN.test(value.trim()) ? value.trim() : "";
}

export function parseReleasePolicy(value: unknown): AppReleasePolicy | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    const downloadUrl = typeof candidate.downloadUrl === "string" && /^https:\/\/\S+$/.test(candidate.downloadUrl.trim())
        ? candidate.downloadUrl.trim()
        : DEFAULT_DOWNLOAD_URL;
    return {
        minVersion: sanitizePolicyVersion(candidate.minVersion),
        latestVersion: sanitizePolicyVersion(candidate.latestVersion),
        downloadUrl,
        notes: typeof candidate.notes === "string" ? candidate.notes : "",
        updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : null,
    };
}

export function computeReleaseStatus(
    localVersion: string,
    policy: AppReleasePolicy | null,
    options: { enforceForce: boolean },
): { status: AppReleaseStatus; policy: AppReleasePolicy | null } {
    if (!policy) return { status: "idle", policy: null };
    let min = policy.minVersion;
    const latest = policy.latestVersion;
    if (!min && !latest) return { status: "idle", policy };
    if (min && latest && compareVersions(min, latest) > 0) {
        console.warn("[app-release] min_version exceeds latest_version; ignoring min_version");
        min = "";
    }
    if (min && compareVersions(localVersion, min) < 0) {
        return { status: options.enforceForce ? "force_update" : "soft_update", policy };
    }
    if (latest && compareVersions(localVersion, latest) < 0) return { status: "soft_update", policy };
    return { status: "up_to_date", policy };
}

export type AppReleaseController = {
    getState(): AppReleaseState;
    refresh(): Promise<AppReleaseState>;
    openDownload(): Promise<void>;
    subscribe(listener: (state: AppReleaseState) => void): () => void;
    start(): Promise<void>;
    dispose(): void;
};

export function createAppReleaseController(options: {
    baseUrl: string;
    localVersion: string;
    packaged: boolean;
    openExternal: (url: string) => Promise<void>;
    fetch?: typeof fetch;
    intervalMs?: number;
    platform?: NodeJS.Platform;
}): AppReleaseController {
    const doFetch = options.fetch ?? globalThis.fetch;
    const platform = options.platform ?? process.platform;
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    let state: AppReleaseState = { status: "idle", policy: null, checkedAt: null };
    let timer: ReturnType<typeof setInterval> | null = null;
    let inFlight: Promise<AppReleaseState> | null = null;
    let disposed = false;
    const listeners = new Set<(state: AppReleaseState) => void>();

    function publish() {
        for (const listener of listeners) listener(state);
    }

    async function check(): Promise<AppReleaseState> {
        if (inFlight) return inFlight;
        inFlight = (async () => {
            try {
                const response = await doFetch(`${options.baseUrl}/v1/app/release-policy?platform=${platformToken(platform)}`, {
                    headers: { accept: "application/json" },
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                });
                if (response.ok) {
                    const policy = parseReleasePolicy(await response.json());
                    const { status, policy: safePolicy } = computeReleaseStatus(options.localVersion, policy, {
                        enforceForce: options.packaged,
                    });
                    state = { status, policy: safePolicy, checkedAt: new Date().toISOString() };
                    publish();
                }
            } catch (error) {
                console.warn("[app-release] policy check failed:", error instanceof Error ? error.message : String(error));
            } finally {
                inFlight = null;
            }
            return state;
        })();
        return inFlight;
    }

    return {
        getState: () => state,
        refresh: () => check(),
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async openDownload() {
            const url = state.policy?.downloadUrl ?? DEFAULT_DOWNLOAD_URL;
            if (!isSafeDownloadUrl(url)) throw new Error("untrusted_download_url");
            await options.openExternal(url);
        },
        async start() {
            if (disposed) return;
            await check();
            if (!timer && !disposed) timer = setInterval(() => void check(), intervalMs);
        },
        dispose() {
            disposed = true;
            if (timer) clearInterval(timer);
            timer = null;
            listeners.clear();
        },
    };
}
