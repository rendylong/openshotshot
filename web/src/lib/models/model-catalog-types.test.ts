import { describe, expect, it } from "vitest";

import type { CatalogPage, CatalogQuery } from "./model-catalog-types";

describe("model catalog contracts", () => {
    it("represents a network page whose cache write was unavailable", () => {
        const page: CatalogPage = {
            entries: [],
            nextCursor: null,
            hasMore: false,
            source: "network",
            cacheUnavailable: true,
        };
        const query: CatalogQuery = { q: "vendor/model:free", cursor: "next/page:2" };

        expect(page).toEqual({ entries: [], nextCursor: null, hasMore: false, source: "network", cacheUnavailable: true });
        expect(query).toEqual({ q: "vendor/model:free", cursor: "next/page:2" });
    });
});
