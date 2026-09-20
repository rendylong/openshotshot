import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSkillsFs } from "./skill-fs";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "skills-test-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("createSkillsFs", () => {
    it("notifies after successful mutations only", async () => {
        let changes = 0;
        const seedSource = join(root, "seed-source.md");
        const importRoot = join(root, "import-source");
        await writeFile(seedSource, "---\nname: skill-creator\ndescription: guide\n---\n\nbody\n");
        await mkdir(importRoot, { recursive: true });
        await writeFile(join(importRoot, "SKILL.md"), "---\nname: imported-skill\ndescription: guide\n---\n\nbody\n");
        const skills = createSkillsFs(root, { "skill-creator": seedSource }, { onChanged: () => { changes += 1; } });

        await expect(skills.seed()).resolves.toEqual({ ok: true });
        expect(changes).toBe(1);
        await expect(skills.write("written-skill", { description: "d", instructions: "i" })).resolves.toEqual({ ok: true });
        expect(changes).toBe(2);
        await expect(skills.write("written-skill", { description: "d", instructions: "i" })).resolves.toEqual({ ok: false, error: "skill already exists" });
        expect(changes).toBe(2);
        await expect(skills.importSkill(importRoot)).resolves.toEqual({ name: "imported-skill" });
        expect(changes).toBe(3);
        await expect(skills.remove("imported-skill")).resolves.toEqual({ ok: true });
        expect(changes).toBe(4);
        await expect(skills.remove("../invalid")).resolves.toEqual({ ok: false });
        expect(changes).toBe(4);
    });

    it("seeds skill-creator from a source path", async () => {
        const src = await mkdtemp(join(tmpdir(), "seed-src-"));
        await mkdir(join(src, "references"));
        await writeFile(join(src, "SKILL.md"), "---\nname: skill-creator\ndescription: guide\n\n---\n\nbody\n");
        await writeFile(join(src, "references", "guide.md"), "bundled reference");
        const skills = createSkillsFs(root, { "skill-creator": src });
        await expect(skills.seed()).resolves.toEqual({ ok: true });
        await expect(skills.scan()).resolves.toContainEqual(expect.objectContaining({ name: "skill-creator", valid: true }));
        await expect(readFile(join(root, "skill-creator", "references", "guide.md"), "utf8")).resolves.toBe("bundled reference");

        await writeFile(join(src, "SKILL.md"), "---\nname: skill-creator\ndescription: updated guide\n---\n\nupdated body\n");
        await expect(skills.seed()).resolves.toEqual({ ok: true });
        await expect(readFile(join(root, "skill-creator", "SKILL.md"), "utf8")).resolves.toContain("updated body");
    });

    it("seeds multiple bundled skills and reports per-skill failures", async () => {
        const srcCreator = await mkdtemp(join(tmpdir(), "seed-creator-"));
        const srcDirector = await mkdtemp(join(tmpdir(), "seed-director-"));
        await writeFile(join(srcCreator, "SKILL.md"), "---\nname: skill-creator\ndescription: guide\n---\n\nbody\n");
        await writeFile(join(srcDirector, "SKILL.md"), "---\nname: shotshot-director\ndescription: director guide\n---\n\nbody\n");

        const skills = createSkillsFs(root, { "skill-creator": srcCreator, "shotshot-director": srcDirector });
        await expect(skills.seed()).resolves.toEqual({ ok: true });
        const scanned = await skills.scan();
        await expect(scanned).toContainEqual(expect.objectContaining({ name: "skill-creator", valid: true }));
        await expect(scanned).toContainEqual(expect.objectContaining({ name: "shotshot-director", valid: true }));

        const broken = createSkillsFs(root, { "skill-creator": srcCreator, "shotshot-director": join(root, "missing-seed") });
        await expect(broken.seed()).resolves.toEqual({
            ok: false,
            error: expect.stringContaining("shotshot-director"),
        });
    });

    it("rejects invalid names on write (path traversal)", async () => {
        const skills = createSkillsFs(root);
        const res = await skills.write("../evil", { description: "d", instructions: "i" });
        expect(res.ok).toBe(false);
        expect(res.error).toContain("invalid skill name");
    });

    it("rejects name collision on import", async () => {
        const src = await mkdtemp(join(tmpdir(), "import-src-"));
        await writeFile(join(src, "SKILL.md"), "---\nname: dup-skill\ndescription: d\n---\n\nbody\n");
        const skills = createSkillsFs(root);
        await skills.write("dup-skill", { description: "d", instructions: "i" });
        await expect(skills.importSkill(src)).resolves.toEqual({ name: "dup-skill", error: "skill already exists" });
    });

    it("rejects same-name write without overwriting existing skill", async () => {
        const skills = createSkillsFs(root);
        await skills.write("keep-skill", { description: "original", instructions: "i" });
        const before = await readFile(join(root, "keep-skill", "SKILL.md"), "utf8");
        await expect(skills.write("keep-skill", { description: "changed", instructions: "i" })).resolves.toEqual({ ok: false, error: "skill already exists" });
        const after = await readFile(join(root, "keep-skill", "SKILL.md"), "utf8");
        expect(after).toBe(before);
    });

    it("allows only one of two concurrent same-name writes to reserve the target", async () => {
        const skills = createSkillsFs(root);

        const results = await Promise.all([
            skills.write("racing-skill", { description: "first", instructions: "first body" }),
            skills.write("racing-skill", { description: "second", instructions: "second body" }),
        ]);

        expect(results.filter((result) => result.ok)).toHaveLength(1);
        expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, error: "skill already exists" }]);
        const saved = await readFile(join(root, "racing-skill", "SKILL.md"), "utf8");
        expect(["first body", "second body"].some((body) => saved.includes(body))).toBe(true);
    });

    it("does not clean up a replacement directory after its reserved target is swapped before failure", async () => {
        const skills = createSkillsFs(root);
        const target = join(root, "replaced-skill");
        const replacement = "---\nname: replaced-skill\ndescription: replacement\n---\n\nreplacement body\n";
        const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async () => {
            await rm(target, { recursive: true, force: true });
            await mkdir(target);
            await writeFile(join(target, "SKILL.md"), replacement);
            throw new Error("injected write failure");
        });

        try {
            await expect(skills.write("replaced-skill", { description: "original", instructions: "original body" })).resolves.toEqual({
                ok: false,
                error: "injected write failure",
            });
        } finally {
            writeSpy.mockRestore();
        }

        await expect(readFile(join(target, "SKILL.md"), "utf8")).resolves.toBe(replacement);
    });

    it("serializes remove then create across SkillsFs instances for the same name", async () => {
        const remover = createSkillsFs(root);
        const creator = createSkillsFs(root);
        await creator.write("replace-after-remove", { description: "old", instructions: "old body" });

        const [removed, created] = await Promise.all([
            remover.remove("replace-after-remove"),
            creator.write("replace-after-remove", { description: "new", instructions: "new body" }),
        ]);

        expect(removed).toEqual({ ok: true });
        expect(created).toEqual({ ok: true });
        await expect(readFile(join(root, "replace-after-remove", "SKILL.md"), "utf8")).resolves.toContain("new body");
    });

    it("allows only one of two concurrent same-name imports without deleting the winner", async () => {
        const src = await mkdtemp(join(tmpdir(), "import-race-src-"));
        await writeFile(join(src, "SKILL.md"), "---\nname: imported-race\ndescription: d\n---\n\nbody\n");
        const skills = createSkillsFs(root);

        const results = await Promise.all([skills.importSkill(src), skills.importSkill(src)]);

        expect(results.filter((result) => result && !result.error)).toHaveLength(1);
        expect(results.filter((result) => result?.error === "skill already exists")).toHaveLength(1);
        await expect(readFile(join(root, "imported-race", "SKILL.md"), "utf8")).resolves.toContain("body");
    });

    it("serializes remove then import for the same name", async () => {
        const src = await mkdtemp(join(tmpdir(), "import-after-remove-src-"));
        await writeFile(join(src, "SKILL.md"), "---\nname: imported-after-remove\ndescription: new\n---\n\nnew imported body\n");
        const remover = createSkillsFs(root);
        const importer = createSkillsFs(root);
        await importer.write("imported-after-remove", { description: "old", instructions: "old body" });

        const [removed, imported] = await Promise.all([
            remover.remove("imported-after-remove"),
            importer.importSkill(src),
        ]);

        expect(removed).toEqual({ ok: true });
        expect(imported).toEqual({ name: "imported-after-remove" });
        await expect(readFile(join(root, "imported-after-remove", "SKILL.md"), "utf8")).resolves.toContain("new imported body");
    });

    it("serializes remove then seed for skill-creator", async () => {
        const seedSource = join(root, "seed-after-remove.md");
        await writeFile(seedSource, "---\nname: skill-creator\ndescription: bundled\n---\n\nbundled body\n");
        const remover = createSkillsFs(root);
        const seeder = createSkillsFs(root, { "skill-creator": seedSource });
        await seeder.seed();

        const [removed, seeded] = await Promise.all([
            remover.remove("skill-creator"),
            seeder.seed(),
        ]);

        expect(removed).toEqual({ ok: true });
        expect(seeded).toEqual({ ok: true });
        await expect(readFile(join(root, "skill-creator", "SKILL.md"), "utf8")).resolves.toContain("bundled body");
    });

    it("imports a valid skill folder", async () => {
        const src = await mkdtemp(join(tmpdir(), "import-src-"));
        await writeFile(join(src, "SKILL.md"), "---\nname: new-skill\ndescription: d\n---\n\nbody\n");
        const skills = createSkillsFs(root);
        await expect(skills.importSkill(src)).resolves.toEqual({ name: "new-skill" });
        await expect(skills.scan()).resolves.toContainEqual(expect.objectContaining({ name: "new-skill", valid: true }));
    });

    it("marks invalid skills as invalid on scan", async () => {
        await mkdir(join(root, "bad-skill"), { recursive: true });
        await writeFile(join(root, "bad-skill", "SKILL.md"), "no frontmatter");
        const skills = createSkillsFs(root);
        await expect(skills.scan()).resolves.toContainEqual(expect.objectContaining({ name: "bad-skill", valid: false }));
    });
});
