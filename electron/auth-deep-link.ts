export const DESKTOP_AUTH_CALLBACK_PROTOCOL = "ai.shotshot.desktop:";
export const DESKTOP_AUTH_CALLBACK_PATH = "/oauth/callback";

export type DesktopAuthCallback = {
    code: string;
    state: string;
};

export type DesktopAuthLifecycleApp = {
    requestSingleInstanceLock(): boolean;
    quit(): void;
    on(event: string, listener: (...args: any[]) => void): unknown;
};

export function parseDesktopAuthCallback(rawUrl: string): DesktopAuthCallback | null {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }

    if (
        url.protocol !== DESKTOP_AUTH_CALLBACK_PROTOCOL ||
        url.host !== "" ||
        url.username !== "" ||
        url.password !== "" ||
        url.pathname !== DESKTOP_AUTH_CALLBACK_PATH ||
        url.hash !== ""
    ) {
        return null;
    }

    const codeValues = url.searchParams.getAll("code");
    const stateValues = url.searchParams.getAll("state");
    const parameterNames = [...url.searchParams.keys()];
    if (
        parameterNames.length !== 2 ||
        codeValues.length !== 1 ||
        stateValues.length !== 1 ||
        !codeValues[0] ||
        !stateValues[0]
    ) {
        return null;
    }

    return { code: codeValues[0], state: stateValues[0] };
}

export class DesktopAuthCallbackRouter {
    private pending: DesktopAuthCallback | null = null;
    private listener: ((callback: DesktopAuthCallback) => void) | null = null;

    handleUrl(rawUrl: string): boolean {
        const callback = parseDesktopAuthCallback(rawUrl);
        if (!callback) return false;
        if (this.listener) this.listener(callback);
        else this.pending ??= callback;
        return true;
    }

    handleArguments(args: readonly string[]): boolean {
        const rawUrl = args.find((arg) => parseDesktopAuthCallback(arg) !== null);
        return rawUrl ? this.handleUrl(rawUrl) : false;
    }

    attach(listener: (callback: DesktopAuthCallback) => void): () => void {
        this.listener = listener;
        if (this.pending) {
            const callback = this.pending;
            this.pending = null;
            listener(callback);
        }
        return () => {
            if (this.listener === listener) this.listener = null;
        };
    }
}

export function registerDesktopAuthDeepLinks(
    app: DesktopAuthLifecycleApp,
    router: DesktopAuthCallbackRouter,
    initialArguments: readonly string[],
    focusExistingWindow: () => void,
): boolean {
    if (!app.requestSingleInstanceLock()) {
        app.quit();
        return false;
    }

    router.handleArguments(initialArguments);
    app.on("open-url", (event: { preventDefault(): void }, rawUrl: string) => {
        if (router.handleUrl(rawUrl)) event.preventDefault();
    });
    app.on("second-instance", (_event: unknown, commandLine: string[]) => {
        router.handleArguments(commandLine);
        focusExistingWindow();
    });
    return true;
}
