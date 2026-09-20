import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";

import {
    DesktopAuthCallbackRouter,
    parseDesktopAuthCallback,
    registerDesktopAuthDeepLinks,
} from "./auth-deep-link";

const VALID_CALLBACK = "ai.shotshot.desktop:/oauth/callback?code=grant-code&state=expected-state";

class FakeAppLifecycle {
    readonly listeners = new Map<string, (...args: unknown[]) => void>();
    readonly calls: string[] = [];
    readonly quit = vi.fn();

    constructor(private readonly lockAvailable = true) {}

    requestSingleInstanceLock() {
        this.calls.push("lock");
        return this.lockAvailable;
    }

    on(event: string, listener: (...args: unknown[]) => void) {
        this.calls.push(`on:${event}`);
        this.listeners.set(event, listener);
        return this;
    }

    emit(event: string, ...args: unknown[]) {
        this.listeners.get(event)?.(...args);
    }
}

describe("desktop OAuth deep links", () => {
    test("parses only the exact callback shape", () => {
        expect(parseDesktopAuthCallback(VALID_CALLBACK)).toEqual({
            code: "grant-code",
            state: "expected-state",
        });

        for (const invalid of [
            "shotshot:/oauth/callback?code=grant-code&state=expected-state",
            "ai.shotshot.desktop://oauth/callback?code=grant-code&state=expected-state",
            "ai.shotshot.desktop:/oauth/callback/extra?code=grant-code&state=expected-state",
            "ai.shotshot.desktop:/oauth/callback?code=&state=expected-state",
            "ai.shotshot.desktop:/oauth/callback?code=grant-code&state=",
            "ai.shotshot.desktop:/oauth/callback?code=one&code=two&state=expected-state",
            "ai.shotshot.desktop:/oauth/callback?code=grant-code&state=one&state=two",
            "ai.shotshot.desktop:/oauth/callback?code=grant-code&state=expected-state&extra=value",
            "ai.shotshot.desktop:/oauth/callback?code=grant-code&state=expected-state#fragment",
        ]) {
            expect(parseDesktopAuthCallback(invalid), invalid).toBeNull();
        }
    });

    test("queues one cold-start callback until the auth controller attaches", () => {
        const router = new DesktopAuthCallbackRouter();
        const received = vi.fn();

        expect(router.handleArguments(["ShotShot", VALID_CALLBACK])).toBe(true);
        const detach = router.attach(received);

        expect(received).toHaveBeenCalledOnce();
        expect(received).toHaveBeenCalledWith({ code: "grant-code", state: "expected-state" });
        detach();
        router.attach(received);
        expect(received).toHaveBeenCalledOnce();
    });

    test("registers macOS open-url before readiness and prevents valid callbacks", () => {
        const app = new FakeAppLifecycle();
        const router = new DesktopAuthCallbackRouter();
        const received = vi.fn();
        router.attach(received);

        expect(registerDesktopAuthDeepLinks(app, router, [], vi.fn())).toBe(true);
        expect(app.calls).toEqual(["lock", "on:open-url", "on:second-instance"]);

        const event = { preventDefault: vi.fn() };
        app.emit("open-url", event, VALID_CALLBACK);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(received).toHaveBeenCalledWith({ code: "grant-code", state: "expected-state" });
    });

    test("routes a second-instance callback and focuses the existing window", () => {
        const app = new FakeAppLifecycle();
        const router = new DesktopAuthCallbackRouter();
        const received = vi.fn();
        const focus = vi.fn();
        router.attach(received);
        registerDesktopAuthDeepLinks(app, router, [], focus);

        app.emit("second-instance", {}, ["ShotShot", "--flag", VALID_CALLBACK], "/tmp");

        expect(focus).toHaveBeenCalledOnce();
        expect(received).toHaveBeenCalledWith({ code: "grant-code", state: "expected-state" });
    });

    test("quits before registering listeners when another instance owns the lock", () => {
        const app = new FakeAppLifecycle(false);

        expect(registerDesktopAuthDeepLinks(app, new DesktopAuthCallbackRouter(), [], vi.fn())).toBe(false);
        expect(app.quit).toHaveBeenCalledOnce();
        expect(app.calls).toEqual(["lock"]);
    });

    test("declares the packaged protocol handler", () => {
        const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"));

        expect(packageJson.build.protocols).toEqual({
            name: "ShotShot OAuth callback",
            schemes: ["ai.shotshot.desktop"],
        });
    });
});
