import type {
    LocalSkillDetail,
    SkillRuntimeRefreshResult,
    SkillsBridge,
    SkillSourcePreferences,
    SkillWriteInput,
} from "@/lib/skills/skill-types";

export function isElectron(): boolean {
    return typeof window !== "undefined" && Boolean((window as { shotshot?: unknown }).shotshot);
}

export function skillsBridge(): SkillsBridge | null {
    const w = window as { shotshot?: { skills?: SkillsBridge } };
    return w.shotshot?.skills ?? null;
}

export async function configureLocalSkillSources(preferences: SkillSourcePreferences): Promise<SkillRuntimeRefreshResult | null> {
    return (await skillsBridge()?.configure(preferences)) ?? null;
}

export async function scanLocalSkills(force?: boolean): Promise<SkillRuntimeRefreshResult | null> {
    return (await skillsBridge()?.scan(force)) ?? null;
}

export async function readLocalSkill(name: string): Promise<LocalSkillDetail | null> {
    return (await skillsBridge()?.read(name)) ?? null;
}

export async function readLocalSkillFile(name: string, relativePath?: string): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
    return (await skillsBridge()?.readFile(name, relativePath)) ?? { ok: false, error: "desktop-only" };
}

export async function writeLocalSkill(name: string, input: SkillWriteInput): Promise<{ ok: boolean; error?: string }> {
    return (await skillsBridge()?.write(name, input)) ?? { ok: false, error: "desktop-only" };
}

export async function importLocalSkill(sourcePath: string): Promise<{ name: string; error?: string } | null> {
    return skillsBridge() ? skillsBridge()!.importSkill(sourcePath) : null;
}

export async function removeLocalSkill(name: string): Promise<{ ok: boolean }> {
    return (await skillsBridge()?.remove(name)) ?? { ok: false };
}

export async function seedLocalSkills(): Promise<{ ok: boolean; error?: string }> {
    return (await skillsBridge()?.seed()) ?? { ok: false };
}

export async function pickLocalFolder(): Promise<string | null> {
    return (await skillsBridge()?.pickFolder()) ?? null;
}
