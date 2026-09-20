import {
    DEFAULT_SKILL_SOURCE_PREFERENCES,
    type SkillSourcePreferences,
} from "@/lib/skills/skill-types";
import type { SkillsFs } from "./skill-fs";
import type { SkillRuntime } from "./skill-runtime";

export async function initializeAppSkills(
    skills: SkillsFs,
    runtime: SkillRuntime,
    preferences: SkillSourcePreferences = DEFAULT_SKILL_SOURCE_PREFERENCES,
): Promise<{ ok: true } | { ok: false; error: string }> {
    const seeded = await skills.seed();
    if (!seeded.ok) return { ok: false, error: `内置 skill 初始化失败：${seeded.error || "未知错误"}` };
    const refreshed = await runtime.configureResult(preferences);
    return refreshed.fresh ? { ok: true } : { ok: false, error: refreshed.error };
}
