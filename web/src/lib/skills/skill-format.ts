import type { LocalSkillDetail, SkillWriteInput } from "@/lib/skills/skill-types";
import { parse, stringify } from "yaml";

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSkillName(name: string): boolean {
    return SKILL_NAME_PATTERN.test(name);
}

export function normalizeSkillCommand(text: string): { text: string; skillName?: string } {
    const trimmed = text.trim();
    const command = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/.exec(trimmed);
    if (command) return { text: trimmed, skillName: command[1] };

    const legacy = /^\/skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/.exec(trimmed);
    if (legacy) return { text: `/${legacy[1]}${trimmed.slice(legacy[0].length)}`, skillName: legacy[1] };
    if (trimmed.startsWith("/skill:")) throw new Error("无效的 Skill 命令");

    const alias = /^\$([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/.exec(trimmed);
    if (!alias) return { text: trimmed };
    return {
        text: `/${alias[1]}${trimmed.slice(alias[0].length)}`,
        skillName: alias[1],
    };
}

export type ParsedSkill = Omit<LocalSkillDetail, "path" | "files">;

export function parseSkillMarkdown(raw: string): { ok: true; skill: ParsedSkill } | { ok: false; error: string } {
    const text = raw.replace(/^﻿/, "");
    const match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
    if (!match) return { ok: false, error: "missing frontmatter" };
    let front: Record<string, unknown>;
    try {
        const parsed = parse(match[1]);
        front = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
        return { ok: false, error: "invalid frontmatter" };
    }
    if (typeof front.name !== "string" || !isValidSkillName(front.name)) return { ok: false, error: "invalid or missing name" };
    if (typeof front.description !== "string" || !front.description.trim()) return { ok: false, error: "missing description" };
    if (/[<>]/.test(front.description)) return { ok: false, error: "description cannot contain angle brackets" };
    return {
        ok: true,
        skill: {
            name: front.name,
            description: front.description.trim(),
            displayName: typeof front.displayName === "string" ? front.displayName.trim() || null : null,
            shortDescription: typeof front.shortDescription === "string" ? front.shortDescription.trim() || null : null,
            instructions: match[2].trim(),
        },
    };
}

export function serializeSkillMarkdown(name: string, input: SkillWriteInput): string {
    const frontmatter: Record<string, string> = { name, description: input.description.trim() };
    if (input.displayName?.trim()) frontmatter.displayName = input.displayName.trim();
    if (input.shortDescription?.trim()) frontmatter.shortDescription = input.shortDescription.trim();
    return `---\n${stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${input.instructions.trim()}\n`;
}

/** Extract the first valid SKILL.md draft from fenced agent output or a whole frontmatter message. */
export function extractSkillMarkdown(text: string): string | null {
    const fences = /```[^\r\n]*\r?\n([\s\S]*?)\r?\n```/g;
    for (const fence of text.matchAll(fences)) {
        const candidate = fence[1].trim();
        if (candidate.startsWith("---") && parseSkillMarkdown(candidate).ok) return candidate;
    }
    const trimmed = text.trim();
    return trimmed.startsWith("---") && parseSkillMarkdown(trimmed).ok ? trimmed : null;
}
