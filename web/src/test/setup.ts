import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// RTL auto-cleanup relies on a global afterEach, which Vitest does not expose
// unless `globals` is enabled. Register it explicitly so each render is torn
// down and DOM does not leak across tests in the same file.
afterEach(() => cleanup());

// antd (and its rc-* trigger/portal internals) expect browser APIs that jsdom
// does not provide. Polyfill minimally so component tests can render without
// a real browser. Guards keep the pure-function tests safe regardless of env.
if (typeof window !== "undefined") {
    if (!window.matchMedia) {
        window.matchMedia = ((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
    }

    if (!window.ResizeObserver) {
        window.ResizeObserver = class {
            observe() {}
            unobserve() {}
            disconnect() {}
        } as unknown as typeof ResizeObserver;
    }

    if (!HTMLElement.prototype.scrollIntoView) {
        HTMLElement.prototype.scrollIntoView = () => {};
    }
}
