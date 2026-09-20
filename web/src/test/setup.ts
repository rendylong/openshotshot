import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// RTL auto-cleanup relies on a global afterEach, which Vitest does not expose
// unless `globals` is enabled. Register it explicitly so each render is torn
// down and DOM does not leak across tests in the same file.
afterEach(() => {
    cleanup();
    parkFocus();
});

// jsdom 30 focus fixup: when the focused element leaves the DOM during cleanup,
// jsdom re-targets its internal focus onto the Document (Node-impl
// `_removingSteps`). The next `focus()` then fires `blur` with the Document as
// target, which jsdom re-targets onto the window — and radix menus
// (legitimately) dismiss on window blur, so the first menu opened in a later
// test instantly closes itself. Park focus on a stable offscreen element after
// each cleanup so subsequent focus moves fire blur on that element instead.
function parkFocus() {
    let park = document.getElementById("vitest-focus-park") as HTMLElement | null;
    if (!park) {
        park = document.createElement("div");
        park.id = "vitest-focus-park";
        park.tabIndex = -1;
        park.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px;";
        document.body.appendChild(park);
    }
    park.focus();
}

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
