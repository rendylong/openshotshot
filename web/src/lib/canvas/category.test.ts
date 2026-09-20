import { describe, expect, test } from "vitest";

import { canonicalCategory, filterProjectsByCategory, projectCategories, UNCATEGORIZED } from "@/lib/canvas/category";

describe("canonicalCategory", () => {
    test("normalizes undefined/null/empty to uncategorized", () => {
        expect(canonicalCategory(undefined)).toBe(UNCATEGORIZED);
        expect(canonicalCategory(null)).toBe(UNCATEGORIZED);
        expect(canonicalCategory("")).toBe(UNCATEGORIZED);
        expect(canonicalCategory("   ")).toBe(UNCATEGORIZED);
    });

    test("trims and lowercases a raw value", () => {
        expect(canonicalCategory("  3D 模型  ")).toBe("3d 模型");
        expect(canonicalCategory("Uncategorized")).toBe(UNCATEGORIZED);
    });

    test("coerces non-string values to uncategorized", () => {
        expect(canonicalCategory(42)).toBe(UNCATEGORIZED);
        expect(canonicalCategory({})).toBe(UNCATEGORIZED);
    });
});

describe("filterProjectsByCategory", () => {
    test("returns an empty array for an empty list", () => {
        expect(filterProjectsByCategory([], "uncategorized")).toEqual([]);
    });

    test("groups a missing category into uncategorized", () => {
        const projects = [{ id: "a" }, { id: "b", category: "3d 模型" }, { id: "c", category: "uncategorized" }];
        expect(filterProjectsByCategory(projects, "uncategorized").map((p) => p.id)).toEqual(["a", "c"]);
    });

    test("matches a named category case-insensitively", () => {
        const projects = [{ id: "a", category: "3D 模型" }, { id: "b", category: "video" }];
        expect(filterProjectsByCategory(projects, "3d 模型").map((p) => p.id)).toEqual(["a"]);
    });
});

describe("projectCategories", () => {
    test("always includes uncategorized even with no projects", () => {
        expect(projectCategories([])).toEqual([UNCATEGORIZED]);
    });

    test("returns sorted, de-duplicated categories", () => {
        const projects = [{ category: "3D 模型" }, { category: "3d 模型" }, { category: "video" }, {}];
        expect(projectCategories(projects)).toEqual(["3d 模型", "uncategorized", "video"]);
    });
});
