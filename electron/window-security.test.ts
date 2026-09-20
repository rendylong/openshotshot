import { describe, expect, it, test } from "vitest";
import { isAllowedExternalUrl, isSafeDownloadUrl, isTrustedRendererNavigation } from "./window-security";

describe("window security policy", () => {
    test("opens only HTTPS URLs from exact allowlisted origins", () => {
        const origins = new Set(["https://shotshot.ai", "https://github.com"]);
        expect(isAllowedExternalUrl("https://shotshot.ai/account", origins)).toBe(true);
        expect(isAllowedExternalUrl("https://github.com/rendylong/shotshot", origins)).toBe(true);
        expect(isAllowedExternalUrl("http://shotshot.ai/account", origins)).toBe(false);
        expect(isAllowedExternalUrl("https://shotshot.ai.evil.example/account", origins)).toBe(false);
        expect(isAllowedExternalUrl("https://user:secret@shotshot.ai/account", origins)).toBe(false);
        expect(isAllowedExternalUrl("http://localhost:4321/auth/desktop", new Set(["http://localhost:4321"]), { allowLocalHttp: true })).toBe(true);
        expect(isAllowedExternalUrl("http://example.com/auth/desktop", new Set(["http://example.com"]), { allowLocalHttp: true })).toBe(false);
    });

    test("permits only the configured renderer origin during development", () => {
        const options = {
            development: true,
            devRendererUrl: "http://localhost:3000",
            productionEntryUrl: "file:///Applications/ShotShot/resources/app/web/dist/index.html",
        };
        expect(isTrustedRendererNavigation("http://localhost:3000/canvas/1", options)).toBe(true);
        expect(isTrustedRendererNavigation("http://127.0.0.1:3000", options)).toBe(false);
        expect(isTrustedRendererNavigation("https://shotshot.ai", options)).toBe(false);
    });

    test("permits only the packaged renderer entry file", () => {
        const options = {
            development: false,
            devRendererUrl: "http://localhost:3000",
            productionEntryUrl: "file:///Applications/ShotShot/resources/app/web/dist/index.html",
        };
        expect(isTrustedRendererNavigation("file:///Applications/ShotShot/resources/app/web/dist/index.html#/canvas/1", options)).toBe(true);
        expect(isTrustedRendererNavigation("file:///tmp/evil.html", options)).toBe(false);
        expect(isTrustedRendererNavigation("https://shotshot.ai", options)).toBe(false);
    });
});

describe("isSafeDownloadUrl", () => {
    it("allows plain https urls", () => {
        expect(isSafeDownloadUrl("https://shotshot.ai/download")).toBe(true);
    });
    it("rejects non-https, credentials and garbage", () => {
        expect(isSafeDownloadUrl("http://shotshot.ai/download")).toBe(false);
        expect(isSafeDownloadUrl("https://user:pass@shotshot.ai/download")).toBe(false);
        expect(isSafeDownloadUrl("file:///etc/passwd")).toBe(false);
        expect(isSafeDownloadUrl("not a url")).toBe(false);
    });
});
