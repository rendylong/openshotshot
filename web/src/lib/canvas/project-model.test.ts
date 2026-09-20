import { describe, expect, it } from "vitest";
import {
    addCanvasToProject, compareCanvasByActivity, createProjectWithCanvas, findCanvas, findProject,
    migrateLegacyProject, removeCanvasFromProject, renameCanvasInProject, updateCanvasInProject,
} from "./project-model";

const now = "2026-08-31T00:00:00.000Z";

describe("project-model", () => {
    it("creates a project with one empty canvas", () => {
        const p = createProjectWithCanvas("P1", now);
        expect(p.title).toBe("P1");
        expect(p.category).toBe("uncategorized");
        expect(p.canvases).toHaveLength(1);
        expect(p.canvases[0].nodes).toEqual([]);
        expect(p.canvases[0].backgroundMode).toBe("lines");
    });

    it("adds and renames canvases", () => {
        const p = addCanvasToProject(createProjectWithCanvas("P1", now), "C2", now);
        expect(p.canvases).toHaveLength(2);
        const renamed = renameCanvasInProject(p, p.canvases[1].id, "Second");
        expect(renamed.canvases[1].title).toBe("Second");
    });

    it("refuses to remove the last canvas", () => {
        const p = createProjectWithCanvas("P1", now);
        expect(removeCanvasFromProject(p, p.canvases[0].id).canvases).toHaveLength(1);
    });

    it("removes the last canvas when allowLast is set", () => {
        const p = createProjectWithCanvas("P1", now);
        expect(removeCanvasFromProject(p, p.canvases[0].id, now, { allowLast: true }).canvases).toHaveLength(0);
    });

    it("updates canvas patch fields", () => {
        const p = createProjectWithCanvas("P1", now);
        const updated = updateCanvasInProject(p, p.canvases[0].id, { showImageInfo: true, viewport: { x: 1, y: 2, k: 3 } });
        expect(updated.canvases[0].showImageInfo).toBe(true);
        expect(updated.canvases[0].viewport).toEqual({ x: 1, y: 2, k: 3 });
    });

    it("compareCanvasByActivity orders by last activity descending", () => {
        expect(compareCanvasByActivity({ updatedAt: "2026-09-01T00:00:00.000Z" }, { updatedAt: "2026-09-10T00:00:00.000Z" })).toBeGreaterThan(0);
        expect(compareCanvasByActivity({ updatedAt: "2026-09-10T00:00:00.000Z" }, { updatedAt: "2026-09-01T00:00:00.000Z" })).toBeLessThan(0);
        expect(compareCanvasByActivity({ updatedAt: now }, { updatedAt: now })).toBe(0);
    });

    it("sorts canvases so the most recently active comes first", () => {
        // 更早创建的画布后来被编辑/对话触碰 → 排到追加序更晚的画布前面
        const p = addCanvasToProject(createProjectWithCanvas("P1", "2026-09-01T00:00:00.000Z"), "C2", "2026-09-02T00:00:00.000Z");
        const touched = updateCanvasInProject(p, p.canvases[0].id, {}, "2026-09-09T00:00:00.000Z");
        const sorted = [...touched.canvases].sort(compareCanvasByActivity);
        expect(sorted.map((c) => c.id)).toEqual([p.canvases[0].id, p.canvases[1].id]);
    });

    it("finds project and canvas", () => {
        const p = createProjectWithCanvas("P1", now);
        expect(findProject([p], p.id)?.title).toBe("P1");
        expect(findCanvas([p], p.canvases[0].id)?.project.id).toBe(p.id);
        expect(findCanvas([p], "missing")).toBeNull();
    });

    it("migrates a legacy project (top-level nodes) into one canvas", () => {
        const legacy = { id: "a", title: "Old", category: "uncategorized", createdAt: now, updatedAt: now, nodes: [{ id: "n1" }], connections: [{ id: "c1" }] };
        const migrated = migrateLegacyProject(legacy)!;
        expect(migrated.id).toBe("a");
        expect(migrated.canvases).toHaveLength(1);
        expect(migrated.canvases[0].nodes).toEqual([{ id: "n1" }]);
        expect(migrated.canvases[0].connections).toEqual([{ id: "c1" }]);
    });

    it("canonicalizes a legacy project category", () => {
        const trimmed = migrateLegacyProject({ id: "a", title: "Old", category: "  Work  ", createdAt: now, updatedAt: now, nodes: [] })!;
        expect(trimmed.category).toBe("work");
        const blank = migrateLegacyProject({ id: "b", title: "Old", category: "  ", createdAt: now, updatedAt: now, nodes: [] })!;
        expect(blank.category).toBe("uncategorized");
    });

    it("returns legacy project untouched if already nested", () => {
        const p = createProjectWithCanvas("P1", now);
        expect(migrateLegacyProject(p)).toBe(p);
    });
});
