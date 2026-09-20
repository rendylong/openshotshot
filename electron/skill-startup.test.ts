import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_SKILL_SOURCE_PREFERENCES } from "@/lib/skills/skill-types";
import { dispatchAgentPrompt, type AgentPromptController } from "./agent-skill-request";
import { createSkillsFs } from "./skill-fs";
import { createSkillRuntime } from "./skill-runtime";
import { initializeAppSkills } from "./skill-startup";

describe("fresh-install Skill startup", () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it("seeds bundled skills and primes the shared runtime before the first Agent turn", async () => {
        const root = await mkdtemp(join(tmpdir(), "skill-startup-test-"));
        roots.push(root);
        const home = join(root, "home");
        const cwd = join(root, "workspace");
        const appSkillsRoot = join(root, "skills");
        const resources = join(process.cwd(), "electron", "resources");
        await mkdir(home, { recursive: true });
        await mkdir(cwd, { recursive: true });
        const runtime = createSkillRuntime({ home, cwd, appSkillsRoot });
        const skills = createSkillsFs(appSkillsRoot, {
            "skill-creator": join(resources, "skill-creator"),
            "shotshot-director": join(resources, "shotshot-director"),
        }, { onChanged: () => runtime.invalidate() });

        await expect(initializeAppSkills(skills, runtime, DEFAULT_SKILL_SOURCE_PREFERENCES)).resolves.toEqual({ ok: true });
        await expect(runtime.readForAgent("shotshot-director")).resolves.toContain("# ShotShot 导演总控");
        const controller: AgentPromptController = {
            prompt: async (_text, options) => {
                await expect(runtime.readForAgent("skill-creator", undefined, options?.explicitSkillName)).resolves.toContain("# Skill Creator");
            },
            waitForIdle: async () => undefined,
        };
        await expect(dispatchAgentPrompt({
            text: "/skill-creator create one",
            skillRuntime: runtime,
            tools: [],
            getController: () => controller,
            setSystemPrompt: () => undefined,
        })).resolves.toEqual({ ok: true });
    });

    it("returns a startup diagnostic instead of crashing when the bundled seed is unavailable", async () => {
        const root = await mkdtemp(join(tmpdir(), "skill-startup-failure-test-"));
        roots.push(root);
        const runtime = createSkillRuntime({ home: root, cwd: root, appSkillsRoot: join(root, "skills") });
        const skills = createSkillsFs(join(root, "skills"), { "skill-creator": join(root, "missing-seed.md") }, { onChanged: () => runtime.invalidate() });

        await expect(initializeAppSkills(skills, runtime, DEFAULT_SKILL_SOURCE_PREFERENCES)).resolves.toEqual({
            ok: false,
            error: expect.stringContaining("missing-seed.md"),
        });
    });
});
