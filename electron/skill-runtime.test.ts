import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SKILL_SOURCE_PREFERENCES, type SkillSourcePreferences } from "@/lib/skills/skill-types";
import { createSkillRuntime } from "./skill-runtime";

const allSourcesEnabled: SkillSourcePreferences = {
    piGlobal: true,
    agentsGlobal: true,
    piProject: true,
    agentsProject: true,
};

let tempRoot: string;
let home: string;
let cwd: string;
let appSkillsRoot: string;

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

async function writeSkill(root: string, name: string, body = `# ${name}`, manualOnly = false): Promise<string> {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(
        join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name} description${manualOnly ? "\ndisable-model-invocation: true" : ""}\n---\n\n${body}\n`,
    );
    return dir;
}

beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "skill-runtime-test-"));
    home = join(tempRoot, "home");
    cwd = join(tempRoot, "workspace");
    appSkillsRoot = join(tempRoot, "app-skills");
    await mkdir(home, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeSkill(appSkillsRoot, "app-skill", "# App Skill");
});

afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
});

describe("createSkillRuntime", () => {
    it("loads only the app source by default", async () => {
        await writeSkill(join(home, ".agents", "skills"), "home-agent-skill");
        await writeSkill(join(home, ".pi", "agent", "skills"), "home-pi-skill");
        const runtime = createSkillRuntime({ home, cwd, appSkillsRoot });
        const result = await runtime.configure(DEFAULT_SKILL_SOURCE_PREFERENCES);

        expect(result.skills.map((skill) => skill.name)).toEqual(["app-skill"]);
        expect(result.sources.find((source) => source.key === "piGlobal")?.enabled).toBe(false);
        expect(result.sources.find((source) => source.key === "agentsGlobal")?.enabled).toBe(false);
    });

    it("loads an optional source only after it is enabled", async () => {
        await writeSkill(join(home, ".pi", "agent", "skills"), "pi-global-skill");
        const runtime = createSkillRuntime({ home, cwd, appSkillsRoot });

        const result = await runtime.configure({ ...DEFAULT_SKILL_SOURCE_PREFERENCES, piGlobal: true });

        expect(result.skills.map((skill) => skill.name)).toEqual(["app-skill", "pi-global-skill"]);
    });

    it("returns every project Skill candidate through the nearest Git root, including missing paths", async () => {
        const projectRoot = join(tempRoot, "repo");
        const nestedCwd = join(projectRoot, "packages", "canvas");
        await mkdir(join(projectRoot, ".git"), { recursive: true });
        await mkdir(nestedCwd, { recursive: true });
        await writeSkill(join(projectRoot, ".agents", "skills"), "repo-agent-skill");
        await writeSkill(join(projectRoot, ".pi", "skills"), "repo-pi-skill");
        await writeSkill(join(tempRoot, ".agents", "skills"), "outside-agent-skill");
        const runtime = createSkillRuntime({ home, cwd: nestedCwd, appSkillsRoot });

        const result = await runtime.configure({ ...DEFAULT_SKILL_SOURCE_PREFERENCES, agentsProject: true, piProject: true });

        expect(result.skills.map((skill) => skill.name)).toEqual(["app-skill", "repo-pi-skill", "repo-agent-skill"]);
        expect(result.sources.find((source) => source.key === "piProject")?.paths).toEqual([
            join(nestedCwd, ".pi", "skills"),
            join(projectRoot, "packages", ".pi", "skills"),
            join(projectRoot, ".pi", "skills"),
        ]);
        expect(result.sources.find((source) => source.key === "agentsProject")?.paths).toEqual([
            join(nestedCwd, ".agents", "skills"),
            join(projectRoot, "packages", ".agents", "skills"),
            join(projectRoot, ".agents", "skills"),
        ]);
        expect(result.sources.find((source) => source.key === "agentsProject")?.exists).toBe(true);
    });

    it("keeps the highest-priority duplicate and reports the ignored path", async () => {
        await mkdir(join(cwd, ".git"));
        await writeSkill(appSkillsRoot, "duplicate", "app duplicate");
        await writeSkill(join(cwd, ".pi", "skills"), "duplicate", "pi project duplicate");
        await writeSkill(join(cwd, ".agents", "skills"), "duplicate", "agents project duplicate");
        await writeSkill(join(home, ".pi", "agent", "skills"), "duplicate", "pi global duplicate");
        await writeSkill(join(home, ".agents", "skills"), "duplicate", "agents global duplicate");
        const runtime = createSkillRuntime({ home, cwd, appSkillsRoot });

        const result = await runtime.configure(allSourcesEnabled);

        expect(result.skills.filter((skill) => skill.name === "duplicate")).toHaveLength(1);
        expect(result.skills.find((skill) => skill.name === "duplicate")?.source).toBe("app");
        expect(result.diagnostics.join("\n")).toContain("duplicate");
        expect(result.diagnostics.join("\n")).toContain(join(cwd, ".pi", "skills", "duplicate", "SKILL.md"));
        expect(result.sources.find((source) => source.key === "piProject")?.error).toBeNull();
    });

    it("allows automatic Skills but requires an exact same-turn explicit allowance for manual-only reads", async () => {
        await writeSkill(appSkillsRoot, "manual-skill", "manual", true);
        const runtime = createSkillRuntime({ home, cwd, appSkillsRoot });
        await runtime.configure(DEFAULT_SKILL_SOURCE_PREFERENCES);

        expect(await runtime.has("manual-skill")).toBe(true);
        expect(await runtime.systemPromptBlock()).not.toContain("manual-skill");
        await expect(runtime.readForAgent("app-skill")).resolves.toContain("# App Skill");
        await expect(runtime.readForAgent("manual-skill")).rejects.toThrow("仅允许在当前请求显式调用");
        await expect(runtime.readForAgent("manual-skill", undefined, "guessed-skill")).rejects.toThrow("仅允许在当前请求显式调用");
        await expect(runtime.readForAgent("manual-skill", undefined, "manual-skill")).resolves.toContain("manual");
    });

    it("reports invalid metadata without making the skill available", async () => {
        const invalidDir = join(appSkillsRoot, "invalid-skill");
        await mkdir(invalidDir, { recursive: true });
        await writeFile(join(invalidDir, "SKILL.md"), "---\nname: Wrong_Name\ndescription: invalid\n---\n\nbody\n");
        const runtime = createSkillRuntime({ home, cwd, appSkillsRoot });

        const result = await runtime.configure(DEFAULT_SKILL_SOURCE_PREFERENCES);

        expect(result.skills.map((skill) => skill.name)).toEqual(["app-skill"]);
        expect(result.diagnostics.join("\n")).toContain("invalid-skill");
        expect(await runtime.has("Wrong_Name")).toBe(false);
        expect(result.sources.find((source) => source.key === "app")?.error).toBeNull();
    });

    it("maps real Pi access diagnostics to the exact source error", async () => {
        const piGlobalRoot = join(home, ".pi", "agent", "skills");
        await mkdir(piGlobalRoot, { recursive: true });
        await symlink("loop", join(piGlobalRoot, "loop"));
        const runtime = createSkillRuntime({ home, cwd, appSkillsRoot });

        const result = await runtime.configure({ ...DEFAULT_SKILL_SOURCE_PREFERENCES, piGlobal: true });

        expect(result.sources.find((source) => source.key === "piGlobal")?.error).toContain("loop");
        expect(result.sources.find((source) => source.key === "app")?.error).toBeNull();
        expect(result.diagnostics.join("\n")).toContain("[piGlobal]");
    });

    it("reads only regular files inside the selected skill directory", async () => {
        const skillDir = join(appSkillsRoot, "app-skill");
        await mkdir(join(skillDir, "references"), { recursive: true });
        await writeFile(join(skillDir, "references", "guide.md"), "guide");
        await writeFile(join(appSkillsRoot, "secret.txt"), "secret");
        await symlink(join(appSkillsRoot, "secret.txt"), join(skillDir, "references", "link.md"));
        await writeSkill(join(home, ".agents", "skills"), "disabled-source-skill");
        const runtime = createSkillRuntime({ home, cwd, appSkillsRoot });
        await runtime.configure(DEFAULT_SKILL_SOURCE_PREFERENCES);

        await expect(runtime.readForUi("app-skill")).resolves.toContain("# App Skill");
        await expect(runtime.readForUi("app-skill", "references/guide.md")).resolves.toBe("guide");
        await expect(runtime.readForUi("app-skill", "../secret.txt")).rejects.toThrow("Skill 路径越界");
        await expect(runtime.readForUi("app-skill", "references/link.md")).rejects.toThrow("符号链接");
        await expect(runtime.readForUi("disabled-source-skill")).rejects.toThrow("找不到可用 Skill");
    });

    it("fails closed when an authorized Skill directory is swapped for an outside symlink", async () => {
        const runtime = createSkillRuntime({ home, cwd, appSkillsRoot });
        await runtime.configure(DEFAULT_SKILL_SOURCE_PREFERENCES);
        const original = join(appSkillsRoot, "app-skill");
        const moved = join(tempRoot, "moved-app-skill");
        const outside = join(tempRoot, "outside-skill");
        await rename(original, moved);
        await writeSkill(tempRoot, "outside-skill", "OUTSIDE CONTENT");
        await symlink(outside, original);

        await expect(runtime.readForAgent("app-skill")).rejects.toThrow("符号链接");
    });

    it("returns Pi-loaded detail with a recursive regular-file listing", async () => {
        const skillDir = join(appSkillsRoot, "app-skill");
        await mkdir(join(skillDir, "references"), { recursive: true });
        await writeFile(join(skillDir, "references", "guide.md"), "guide");
        await symlink(join(skillDir, "references", "guide.md"), join(skillDir, "references", "link.md"));
        const runtime = createSkillRuntime({ home, cwd, appSkillsRoot });
        await runtime.configure(DEFAULT_SKILL_SOURCE_PREFERENCES);

        await expect(runtime.detailForUi("app-skill")).resolves.toEqual(expect.objectContaining({
            name: "app-skill",
            description: "app-skill description",
            instructions: "# App Skill",
            path: skillDir,
            files: ["SKILL.md", "references/guide.md"],
        }));
        await expect(runtime.detailForUi("missing-skill")).resolves.toBeNull();
    });

    it("increments revision only for preference changes and invalidation", async () => {
        const runtime = createSkillRuntime({ home, cwd, appSkillsRoot });
        const initial = await runtime.configure(DEFAULT_SKILL_SOURCE_PREFERENCES);
        const unchanged = await runtime.configure({ ...DEFAULT_SKILL_SOURCE_PREFERENCES });
        const configured = await runtime.configure({ ...DEFAULT_SKILL_SOURCE_PREFERENCES, piGlobal: true });
        const forced = await runtime.snapshot(true);
        runtime.invalidate();
        const invalidated = await runtime.snapshot();

        expect(initial.revision).toBe(0);
        expect(unchanged.revision).toBe(0);
        expect(configured.revision).toBe(1);
        expect(forced.revision).toBe(1);
        expect(invalidated.revision).toBe(2);
    });

    it("reloads external filesystem edits only when a caller explicitly forces refresh", async () => {
        const piGlobalRoot = join(home, ".pi", "agent", "skills");
        await writeSkill(piGlobalRoot, "external-skill");
        const runtime = createSkillRuntime({ home, cwd, appSkillsRoot });
        await runtime.configure({ ...DEFAULT_SKILL_SOURCE_PREFERENCES, piGlobal: true });
        await writeFile(
            join(piGlobalRoot, "external-skill", "SKILL.md"),
            "---\nname: external-skill\ndescription: externally edited\n---\n\n# External edit\n",
        );

        expect((await runtime.snapshot()).skills.find((skill) => skill.name === "external-skill")?.description).toBe("external-skill description");
        expect((await runtime.snapshot(true)).skills.find((skill) => skill.name === "external-skill")?.description).toBe("externally edited");
    });

    it("returns the last successful snapshot with a diagnostic when refresh fails", async () => {
        let fail = false;
        const runtime = createSkillRuntime({
            home,
            cwd,
            appSkillsRoot,
            loadSkills: async (...args) => {
                if (fail) throw new Error("refresh unavailable");
                return loadSkills(...args);
            },
        });
        const initial = await runtime.configure(DEFAULT_SKILL_SOURCE_PREFERENCES);
        fail = true;
        runtime.invalidate();

        const fallbackResult = await runtime.snapshotResult();
        const fallback = fallbackResult.snapshot;

        expect(fallbackResult.fresh).toBe(false);
        if (!fallbackResult.fresh) expect(fallbackResult.error).toContain("refresh unavailable");
        expect(fallback.revision).toBe(initial.revision + 1);
        expect(fallback.skills).toEqual(initial.skills);
        expect(fallback.diagnostics.join("\n")).toContain("refresh unavailable");

        fail = false;
        const recovered = await runtime.snapshotResult();
        expect(recovered.fresh).toBe(true);
        expect(recovered.snapshot.skills).toEqual(initial.skills);
        expect(recovered.snapshot.diagnostics.join("\n")).not.toContain("refresh unavailable");
    });

    it("associates an enabled source loader failure with only that source", async () => {
        const piGlobalRoot = join(home, ".pi", "agent", "skills");
        const agentsGlobalRoot = join(home, ".agents", "skills");
        await writeSkill(piGlobalRoot, "pi-global-skill");
        await writeSkill(agentsGlobalRoot, "agents-global-skill");
        let failingRoot = "";
        const runtime = createSkillRuntime({
            home,
            cwd,
            appSkillsRoot,
            loadSkills: async (env, dirs) => {
                const paths = Array.isArray(dirs) ? dirs : [dirs];
                if (failingRoot && paths.includes(failingRoot)) throw new Error("source loader unavailable");
                return loadSkills(env, dirs);
            },
        });
        const preferences = { ...DEFAULT_SKILL_SOURCE_PREFERENCES, piGlobal: true, agentsGlobal: true };
        const initial = await runtime.configure(preferences);
        failingRoot = piGlobalRoot;
        runtime.invalidate();

        const fallback = await runtime.snapshot();

        expect(fallback.skills).toEqual(initial.skills);
        expect(fallback.sources.find((source) => source.key === "piGlobal")?.error).toContain("source loader unavailable");
        expect(fallback.sources.find((source) => source.key === "agentsGlobal")?.error).toBeNull();
        expect(fallback.sources.find((source) => source.key === "app")?.error).toBeNull();
        expect(fallback.diagnostics.join("\n")).toContain("[piGlobal]");
        expect(fallback.diagnostics.join("\n")).toContain("source loader unavailable");

        const disabled = await runtime.configure({ ...preferences, piGlobal: false });
        const disabledSource = disabled.sources.find((source) => source.key === "piGlobal");
        expect(disabledSource).toEqual(expect.objectContaining({ enabled: false, exists: true, error: null }));
        expect(disabled.skills.map((skill) => skill.name)).not.toContain("pi-global-skill");
        expect(disabled.skills.map((skill) => skill.name)).toContain("agents-global-skill");
    });

    it("keeps displayed cached Skill detail and files readable when refresh fails", async () => {
        let failRefresh = false;
        const runtime = createSkillRuntime({
            home,
            cwd,
            appSkillsRoot,
            loadSkills: async (...args) => {
                if (failRefresh) throw new Error("refresh unavailable");
                return loadSkills(...args);
            },
        });
        await runtime.configure(DEFAULT_SKILL_SOURCE_PREFERENCES);
        await rm(join(appSkillsRoot, "app-skill"), { recursive: true });
        failRefresh = true;
        runtime.invalidate();

        const fallback = await runtime.snapshot();

        expect(fallback.skills.map((skill) => skill.name)).toContain("app-skill");
        await expect(runtime.detailForUi("app-skill")).resolves.toEqual(expect.objectContaining({
            name: "app-skill",
            instructions: "# App Skill",
            files: ["SKILL.md"],
        }));
        await expect(runtime.readForUi("app-skill")).resolves.toContain("# App Skill");
    });

    it("keeps fresh Agent Skill reads unavailable when refresh fails", async () => {
        let failRefresh = false;
        const runtime = createSkillRuntime({
            home,
            cwd,
            appSkillsRoot,
            loadSkills: async (...args) => {
                if (failRefresh) throw new Error("refresh unavailable");
                return loadSkills(...args);
            },
        });
        await runtime.configure(DEFAULT_SKILL_SOURCE_PREFERENCES);
        failRefresh = true;
        runtime.invalidate();

        await expect(runtime.readForAgent("app-skill")).rejects.toThrow("找不到可用 Skill");
        await expect(runtime.agentSnapshot()).resolves.toEqual({ ok: false, error: expect.stringContaining("refresh unavailable") });
    });

    it("revokes a disabled source even when its refresh falls back to the previous snapshot", async () => {
        const piGlobalRoot = join(home, ".pi", "agent", "skills");
        await writeSkill(piGlobalRoot, "pi-global-skill");
        const reachedFailedRefresh = deferred();
        const releaseFailedRefresh = deferred();
        let failRefresh = false;
        let deferredFirstFailure = false;
        const runtime = createSkillRuntime({
            home,
            cwd,
            appSkillsRoot,
            loadSkills: async (env, dirs) => {
                const paths = Array.isArray(dirs) ? dirs : [dirs];
                if (failRefresh && paths.includes(appSkillsRoot)) {
                    if (!deferredFirstFailure) {
                        deferredFirstFailure = true;
                        reachedFailedRefresh.resolve();
                        await releaseFailedRefresh.promise;
                    }
                    throw new Error("disabled-source refresh failed");
                }
                return loadSkills(env, dirs);
            },
        });
        await runtime.configure({ ...DEFAULT_SKILL_SOURCE_PREFERENCES, piGlobal: true });
        failRefresh = true;

        const disabling = runtime.configure(DEFAULT_SKILL_SOURCE_PREFERENCES);
        await reachedFailedRefresh.promise;
        releaseFailedRefresh.resolve();
        const fallback = await disabling;

        expect(fallback.skills.map((skill) => skill.name)).toContain("pi-global-skill");
        expect(fallback.diagnostics.join("\n")).toContain("disabled-source refresh failed");
        expect(await runtime.has("pi-global-skill")).toBe(false);
        await expect(runtime.readForUi("pi-global-skill")).rejects.toThrow("找不到可用 Skill");
        await expect(runtime.readForAgent("pi-global-skill")).rejects.toThrow("找不到可用 Skill");
        expect(await runtime.systemPromptBlock()).not.toContain("pi-global-skill");
    });

    it("does not publish an older refresh after its optional source is disabled", async () => {
        const piGlobalRoot = join(home, ".pi", "agent", "skills");
        await writeSkill(piGlobalRoot, "pi-global-skill");
        const reachedPiGlobal = deferred();
        const releasePiGlobal = deferred();
        let holdPiGlobal = true;
        const runtime = createSkillRuntime({
            home,
            cwd,
            appSkillsRoot,
            loadSkills: async (env, dirs) => {
                const paths = Array.isArray(dirs) ? dirs : [dirs];
                if (holdPiGlobal && paths.includes(piGlobalRoot)) {
                    holdPiGlobal = false;
                    reachedPiGlobal.resolve();
                    await releasePiGlobal.promise;
                }
                return loadSkills(env, dirs);
            },
        });
        await runtime.configure(DEFAULT_SKILL_SOURCE_PREFERENCES);

        const enabling = runtime.configure({ ...DEFAULT_SKILL_SOURCE_PREFERENCES, piGlobal: true });
        await reachedPiGlobal.promise;
        const disabled = await runtime.configure(DEFAULT_SKILL_SOURCE_PREFERENCES);
        releasePiGlobal.resolve();
        const superseded = await enabling;

        expect(disabled.skills.map((skill) => skill.name)).toEqual(["app-skill"]);
        expect(superseded.skills.map((skill) => skill.name)).toEqual(["app-skill"]);
        expect(superseded.revision).toBe(disabled.revision);
        expect(await runtime.has("pi-global-skill")).toBe(false);
        expect(await runtime.systemPromptBlock()).not.toContain("pi-global-skill");
    });

    it("retries when app skills mutate during an in-flight refresh", async () => {
        const reachedAppLoad = deferred();
        const releaseAppLoad = deferred();
        let holdNextAppLoad = false;
        const runtime = createSkillRuntime({
            home,
            cwd,
            appSkillsRoot,
            loadSkills: async (env, dirs) => {
                const result = await loadSkills(env, dirs);
                const paths = Array.isArray(dirs) ? dirs : [dirs];
                if (holdNextAppLoad && paths.includes(appSkillsRoot)) {
                    holdNextAppLoad = false;
                    reachedAppLoad.resolve();
                    await releaseAppLoad.promise;
                }
                return result;
            },
        });
        const initial = await runtime.configure(DEFAULT_SKILL_SOURCE_PREFERENCES);
        holdNextAppLoad = true;

        const refreshing = runtime.snapshot(true);
        await reachedAppLoad.promise;
        await writeFile(
            join(appSkillsRoot, "app-skill", "SKILL.md"),
            "---\nname: app-skill\ndescription: updated description\n---\n\n# Updated\n",
        );
        runtime.invalidate();
        releaseAppLoad.resolve();
        const refreshed = await refreshing;

        expect(refreshed.revision).toBe(initial.revision + 1);
        expect(refreshed.skills.find((skill) => skill.name === "app-skill")?.description).toBe("updated description");
        expect((await runtime.snapshot()).skills.find((skill) => skill.name === "app-skill")?.description).toBe("updated description");
    });
});
