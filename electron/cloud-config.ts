const DEFAULT_CLOUD_ORIGIN = "https://api.shotshot.ai";
const DEFAULT_WEB_ORIGIN = "https://shotshot.ai";
const DEFAULT_GATEWAY_ORIGIN = "https://key-mgmt.shotshot.ai";

export type ShotshotCloudConfig = {
    accountEnabled: boolean;
    managedEnabled: boolean;
    cloudOrigin: string;
    webOrigin: string;
    gatewayOrigin: string | null;
    diagnostic: "invalid_cloud_origin" | "invalid_web_origin" | "invalid_gateway_origin" | "gateway_not_configured" | null;
};

function exactOrigin(value: string, development: boolean): string | null {
    try {
        const url = new URL(value);
        const localHttp = development && url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
        if ((url.protocol !== "https:" && !localHttp) || url.username || url.password ||
            (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
        return url.origin;
    } catch {
        return null;
    }
}

export function loadShotshotCloudConfig(
    env: NodeJS.ProcessEnv = process.env,
    options: { development?: boolean } = {},
): ShotshotCloudConfig {
    const development = options.development ?? false;
    const cloudOrigin = exactOrigin(env.SHOTSHOT_CLOUD_URL ?? DEFAULT_CLOUD_ORIGIN, development);
    const webOrigin = exactOrigin(env.SHOTSHOT_WEB_URL ?? DEFAULT_WEB_ORIGIN, development);
    if (!cloudOrigin) {
        return {
            accountEnabled: false,
            managedEnabled: false,
            cloudOrigin: DEFAULT_CLOUD_ORIGIN,
            webOrigin: webOrigin ?? DEFAULT_WEB_ORIGIN,
            gatewayOrigin: null,
            diagnostic: "invalid_cloud_origin",
        };
    }
    if (!webOrigin) {
        return {
            accountEnabled: false,
            managedEnabled: false,
            cloudOrigin,
            webOrigin: DEFAULT_WEB_ORIGIN,
            gatewayOrigin: null,
            diagnostic: "invalid_web_origin",
        };
    }
    const rawGatewayOrigin = env.SHOTSHOT_GATEWAY_URL?.trim() || DEFAULT_GATEWAY_ORIGIN;
    const gatewayOrigin = exactOrigin(rawGatewayOrigin, development);
    return {
        accountEnabled: true,
        managedEnabled: Boolean(gatewayOrigin),
        cloudOrigin,
        webOrigin,
        gatewayOrigin,
        diagnostic: gatewayOrigin ? null : "invalid_gateway_origin",
    };
}
