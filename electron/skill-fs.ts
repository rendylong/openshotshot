import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve, sep } from "node:path";

import { isValidSkillName, parseSkillMarkdown, serializeSkillMarkdown } from "@/lib/skills/skill-format";
import type { LocalSkillDetail, LocalSkillSummary, SkillWriteInput } from "@/lib/skills/skill-types";

export type SkillsFs = {
    root: string;
    scan(): Promise<LocalSkillSummary[]>;
    read(name: string): Promise<LocalSkillDetail | null>;
    write(name: string, input: SkillWriteInput): Promise<{ ok: boolean; error?: string }>;
    importSkill(sourcePath: string): Promise<{ name: string; error?: string } | null>;
    remove(name: string): Promise<{ ok: boolean }>;
    seed(): Promise<{ ok: boolean; error?: string }>;
};

type TargetReservation = { path: string; dev: bigint; ino: bigint; token: string };

// 目录内凭证：Linux 会在删除后立即复用 inode，仅靠 dev/ino 判断所有权会把
// 并发方新建的同名目录误认为本请求所有而误删；marker 文件与随机 token 提供
// 平台无关的所有权证明。
const RESERVE_MARKER = ".skill-fs-reserve";

const targetMutationQueues = new Map<string, Promise<void>>();

async function withTargetMutation<T>(target: string, operation: () => Promise<T>): Promise<T> {
    const previous = targetMutationQueues.get(target) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const queued = previous.then(() => gate);
    targetMutationQueues.set(target, queued);
    await previous;
    try {
        return await operation();
    } finally {
        release();
        if (targetMutationQueues.get(target) === queued) targetMutationQueues.delete(target);
    }
}

export function createSkillsFs(root: string, bundledSkills?: Record<string, string>, options?: { onChanged?: () => void }): SkillsFs {
    const skillDir = (name: string): string => resolve(root, name);
    const assertSafeName = (name: string): void => {
        if (!isValidSkillName(name)) throw new Error("invalid skill name");
        if (!skillDir(name).startsWith(root + sep)) throw new Error("skill path escapes root");
    };
    const ensureRoot = async (): Promise<void> => { await fs.mkdir(root, { recursive: true }); };
    const reserveTarget = async (dir: string): Promise<TargetReservation | null> => {
        try {
            await fs.mkdir(dir);
            const info = await fs.lstat(dir, { bigint: true });
            if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("reserved Skill target is not a directory");
            const token = randomUUID();
            await fs.writeFile(join(dir, RESERVE_MARKER), token, "utf8");
            return { path: dir, dev: info.dev, ino: info.ino, token };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
            throw error;
        }
    };
    const releaseReservation = async (reservation: TargetReservation): Promise<void> => {
        await fs.rm(join(reservation.path, RESERVE_MARKER), { force: true });
    };
    const cleanupReservation = async (reservation: TargetReservation): Promise<void> => {
        try {
            const current = await fs.lstat(reservation.path, { bigint: true });
            if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== reservation.dev || current.ino !== reservation.ino) return;
            const marker = await fs.readFile(join(reservation.path, RESERVE_MARKER), "utf8").catch(() => null);
            if (marker !== reservation.token) return;
            await fs.rm(reservation.path, { recursive: true, force: true });
        } catch {
            // Missing or replaced targets are no longer owned by this request and must be preserved.
        }
    };
    const readSkillMd = async (dir: string): Promise<string | null> => {
        try { return await fs.readFile(join(dir, "SKILL.md"), "utf8"); } catch { return null; }
    };

    const scan = async (): Promise<LocalSkillSummary[]> => {
        await ensureRoot();
        const entries = await fs.readdir(root, { withFileTypes: true });
        const out: LocalSkillSummary[] = [];
        for (const entry of entries) {
            if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
            const raw = await readSkillMd(join(root, entry.name));
            if (raw == null) continue;
            const parsed = parseSkillMarkdown(raw);
            const base = {
                name: entry.name,
                path: join(root, entry.name),
                source: "app" as const,
                manualOnly: false,
                readonly: false,
                valid: parsed.ok,
                error: parsed.ok ? null : parsed.error,
            };
            if (parsed.ok) {
                out.push({ ...base, description: parsed.skill.description, displayName: parsed.skill.displayName, shortDescription: parsed.skill.shortDescription });
            } else {
                out.push({ ...base, description: "", error: parsed.error });
            }
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    };

    const read = async (name: string): Promise<LocalSkillDetail | null> => {
        assertSafeName(name);
        const raw = await readSkillMd(skillDir(name));
        if (raw == null) return null;
        const parsed = parseSkillMarkdown(raw);
        if (!parsed.ok) return null;
        return { ...parsed.skill, path: skillDir(name), files: [] };
    };

    const write = async (name: string, input: SkillWriteInput): Promise<{ ok: boolean; error?: string }> => {
        try {
            assertSafeName(name);
            const dir = skillDir(name);
            return await withTargetMutation(dir, async () => {
                let reservation: TargetReservation | null = null;
                let committed = false;
                try {
                    await ensureRoot();
                    reservation = await reserveTarget(dir);
                    if (!reservation) return { ok: false, error: "skill already exists" };
                    await fs.writeFile(join(dir, "SKILL.md"), serializeSkillMarkdown(name, input), { encoding: "utf8", flag: "wx" });
                    await releaseReservation(reservation);
                    committed = true;
                    options?.onChanged?.();
                    return { ok: true };
                } catch (error) {
                    if (reservation && !committed) await cleanupReservation(reservation);
                    return { ok: false, error: error instanceof Error ? error.message : String(error) };
                }
            });
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    };

    const importSkill = async (sourcePath: string): Promise<{ name: string; error?: string } | null> => {
        const src = resolve(sourcePath);
        const raw = await readSkillMd(src);
        if (raw == null) return null;
        const parsed = parseSkillMarkdown(raw);
        if (!parsed.ok) return { name: "", error: parsed.error };
        const target = skillDir(parsed.skill.name);
        try {
            assertSafeName(parsed.skill.name);
            return await withTargetMutation(target, async () => {
                let reservation: TargetReservation | null = null;
                let committed = false;
                try {
                    await ensureRoot();
                    reservation = await reserveTarget(target);
                    if (!reservation) return { name: parsed.skill.name, error: "skill already exists" };
                    for (const entry of await fs.readdir(src)) {
                        await fs.cp(join(src, entry), join(target, entry), { recursive: true, force: false, errorOnExist: true });
                    }
                    await releaseReservation(reservation);
                    committed = true;
                    options?.onChanged?.();
                    return { name: parsed.skill.name };
                } catch (error) {
                    if (reservation && !committed) await cleanupReservation(reservation);
                    return { name: parsed.skill.name, error: error instanceof Error ? error.message : String(error) };
                }
            });
        } catch (error) {
            return { name: parsed.skill.name, error: error instanceof Error ? error.message : String(error) };
        }
    };

    const remove = async (name: string): Promise<{ ok: boolean }> => {
        try {
            assertSafeName(name);
            const target = skillDir(name);
            return await withTargetMutation(target, async () => {
                await fs.rm(target, { recursive: true, force: true });
                options?.onChanged?.();
                return { ok: true };
            });
        } catch {
            return { ok: false };
        }
    };

    const seedOne = async (name: string, sourcePath: string): Promise<{ ok: boolean; error?: string }> => {
        const target = skillDir(name);
        return withTargetMutation(target, async () => {
            let reservation: TargetReservation | null = null;
            let committed = false;
            try {
                const sourceInfo = await fs.stat(sourcePath);
                const content = sourceInfo.isDirectory() ? null : await fs.readFile(sourcePath, "utf8");
                if (sourceInfo.isDirectory()) await fs.readFile(join(sourcePath, "SKILL.md"), "utf8");
                await ensureRoot();
                if (await readSkillMd(target) != null) {
                    if (content == null) {
                        for (const entry of await fs.readdir(sourcePath)) {
                            await fs.cp(join(sourcePath, entry), join(target, entry), { recursive: true, force: true });
                        }
                    } else await fs.writeFile(join(target, "SKILL.md"), content, "utf8");
                    options?.onChanged?.();
                    return { ok: true };
                }
                reservation = await reserveTarget(target);
                if (!reservation) return await readSkillMd(target) == null
                    ? { ok: false, error: `${name} target already exists without SKILL.md` }
                    : { ok: true };
                if (content == null) {
                    for (const entry of await fs.readdir(sourcePath)) {
                        await fs.cp(join(sourcePath, entry), join(target, entry), { recursive: true, force: false, errorOnExist: true });
                    }
                } else await fs.writeFile(join(target, "SKILL.md"), content, { encoding: "utf8", flag: "wx" });
                await releaseReservation(reservation);
                committed = true;
                options?.onChanged?.();
                return { ok: true };
            } catch (error) {
                if (reservation && !committed) await cleanupReservation(reservation);
                return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
        });
    };

    const seed = async (): Promise<{ ok: boolean; error?: string }> => {
        const entries = Object.entries(bundledSkills ?? {});
        if (entries.length === 0) return { ok: false, error: "no bundled skills are configured" };
        const failures: string[] = [];
        for (const [name, sourcePath] of entries) {
            const result = await seedOne(name, sourcePath);
            if (!result.ok) failures.push(`${name}: ${result.error ?? "unknown error"}`);
        }
        return failures.length === 0 ? { ok: true } : { ok: false, error: failures.join("; ") };
    };

    return { root, scan, read, write, importSkill, remove, seed };
}
