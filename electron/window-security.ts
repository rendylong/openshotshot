export function isAllowedExternalUrl(
    rawUrl: string,
    allowedOrigins: ReadonlySet<string>,
    options: { allowLocalHttp?: boolean } = {},
): boolean {
    try {
        const url = new URL(rawUrl);
        const localHttp = Boolean(options.allowLocalHttp && url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "::1"].includes(url.hostname));
        return (url.protocol === "https:" || localHttp) && !url.username && !url.password && allowedOrigins.has(url.origin);
    } catch {
        return false;
    }
}

export function isTrustedRendererNavigation(
    rawUrl: string,
    options: { development: boolean; devRendererUrl: string; productionEntryUrl: string },
): boolean {
    try {
        const url = new URL(rawUrl);
        if (options.development) return url.origin === new URL(options.devRendererUrl).origin;
        const entry = new URL(options.productionEntryUrl);
        return url.protocol === "file:" && url.origin === entry.origin && url.pathname === entry.pathname;
    } catch {
        return false;
    }
}

export function isSafeDownloadUrl(rawUrl: string): boolean {
    try {
        const url = new URL(rawUrl);
        return url.protocol === "https:" && !url.username && !url.password;
    } catch {
        return false;
    }
}
