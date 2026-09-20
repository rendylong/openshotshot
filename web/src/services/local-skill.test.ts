import { afterEach, describe, expect, it } from "vitest";

import {
    DEFAULT_SKILL_SOURCE_PREFERENCES,
    type SkillRuntimeSnapshot,
    type SkillsBridge,
} from "@/lib/skills/skill-types";
import { configureLocalSkillSources, scanLocalSkills } from "./local-skill";

const snapshot: SkillRuntimeSnapshot = {
    revision: 4,
    skills: [],
    sources: [],
    diagnostics: [],
};

afterEach(() => {
    delete (window as { shotshot?: unknown }).shotshot;
});

describe("local skill service", () => {
    it("forwards source preferences unchanged and returns the runtime refresh result", async () => {
        let received: typeof DEFAULT_SKILL_SOURCE_PREFERENCES | null = null;
        const result = { fresh: true as const, snapshot };
        const skills: SkillsBridge = {
            configure: async (preferences) => {
                received = preferences;
                return result;
            },
            scan: async () => result,
            read: async () => null,
            readFile: async () => ({ ok: false, error: "not found" }),
            write: async () => ({ ok: true }),
            importSkill: async () => null,
            remove: async () => ({ ok: true }),
            seed: async () => ({ ok: true }),
            pickFolder: async () => null,
        };
        (window as { shotshot?: { skills: SkillsBridge } }).shotshot = { skills };

        const preferences = { ...DEFAULT_SKILL_SOURCE_PREFERENCES, piGlobal: true };

        await expect(configureLocalSkillSources(preferences)).resolves.toBe(result);
        expect(received).toBe(preferences);
    });

    it("preserves a stale fallback snapshot and its refresh failure", async () => {
        const fallback = { ...snapshot, diagnostics: ["Skill 刷新失败：loader unavailable"] };
        const failed = { fresh: false as const, snapshot: fallback, error: "Skill 刷新失败：loader unavailable" };
        const recovered = { fresh: true as const, snapshot };
        let failing = true;
        const skills: SkillsBridge = {
            configure: async () => failing ? failed : recovered,
            scan: async () => failing ? failed : recovered,
            read: async () => null,
            readFile: async () => ({ ok: false, error: "not found" }),
            write: async () => ({ ok: true }),
            importSkill: async () => null,
            remove: async () => ({ ok: true }),
            seed: async () => ({ ok: true }),
            pickFolder: async () => null,
        };
        (window as { shotshot?: { skills: SkillsBridge } }).shotshot = { skills };

        await expect(scanLocalSkills()).resolves.toBe(failed);
        failing = false;
        await expect(scanLocalSkills()).resolves.toBe(recovered);
    });

    it("forwards an explicit forced scan through the renderer bridge", async () => {
        const result = { fresh: true as const, snapshot };
        const received: Array<boolean | undefined> = [];
        const skills: SkillsBridge = {
            configure: async () => result,
            scan: async (force) => {
                received.push(force);
                return result;
            },
            read: async () => null,
            readFile: async () => ({ ok: false, error: "not found" }),
            write: async () => ({ ok: true }),
            importSkill: async () => null,
            remove: async () => ({ ok: true }),
            seed: async () => ({ ok: true }),
            pickFolder: async () => null,
        };
        (window as { shotshot?: { skills: SkillsBridge } }).shotshot = { skills };

        await scanLocalSkills(true);

        expect(received).toEqual([true]);
    });
});
