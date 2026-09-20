import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query and return whether it currently matches.
 * Returns `false` on the server or when `matchMedia` is unavailable (e.g. jsdom).
 */
export function useMediaQuery(query: string): boolean {
    const [matches, setMatches] = useState(() => {
        if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
        return window.matchMedia(query).matches;
    });

    useEffect(() => {
        if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
        const mql = window.matchMedia(query);
        const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
        setMatches(mql.matches);
        mql.addEventListener("change", onChange);
        return () => mql.removeEventListener("change", onChange);
    }, [query]);

    return matches;
}
