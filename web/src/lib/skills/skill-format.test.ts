import { describe, expect, it } from "vitest";
import { extractSkillMarkdown, isValidSkillName, normalizeSkillCommand, parseSkillMarkdown, serializeSkillMarkdown } from "@/lib/skills/skill-format";

describe("normalizeSkillCommand", () => {
    it("extracts a direct slash command without expanding its content", () => {
        expect(normalizeSkillCommand("/cosmetic-label 做一个方案")).toEqual({
            text: "/cosmetic-label 做一个方案",
            skillName: "cosmetic-label",
        });
    });

    it("normalizes compatibility aliases to the direct slash form", () => {
        expect(normalizeSkillCommand("$cosmetic-label 做一个方案")).toEqual({
            text: "/cosmetic-label 做一个方案",
            skillName: "cosmetic-label",
        });
        expect(normalizeSkillCommand("/skill:cosmetic-label 做一个方案")).toEqual({
            text: "/cosmetic-label 做一个方案",
            skillName: "cosmetic-label",
        });
    });

    it("leaves ordinary text unchanged", () => {
        expect(normalizeSkillCommand("普通文本")).toEqual({ text: "普通文本" });
    });

    it("rejects a malformed /skill command", () => {
        expect(() => normalizeSkillCommand("/skill:Bad Name 做一个方案")).toThrow("无效的 Skill 命令");
    });
});

describe("parseSkillMarkdown", () => {
    it("parses valid frontmatter + body", () => {
        const raw = "---\nname: my-skill\ndescription: Does a thing\n---\n\nStep one.\n";
        const r = parseSkillMarkdown(raw);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.skill).toMatchObject({ name: "my-skill", description: "Does a thing", instructions: "Step one." });
    });
    it("rejects missing frontmatter", () => {
        expect(parseSkillMarkdown("no frontmatter here").ok).toBe(false);
    });
    it("rejects invalid name", () => {
        expect(parseSkillMarkdown("---\nname: Bad Name!\ndescription: x\n---\nbody").ok).toBe(false);
    });
    it("rejects missing description", () => {
        expect(parseSkillMarkdown("---\nname: ok-skill\n---\nbody").ok).toBe(false);
    });
});

describe("serializeSkillMarkdown", () => {
    it("round-trips through parse", () => {
        const raw = serializeSkillMarkdown("a-skill", { description: "d", instructions: "i", displayName: "A", shortDescription: "s" });
        const r = parseSkillMarkdown(raw);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.skill).toMatchObject({ name: "a-skill", description: "d", instructions: "i", displayName: "A" });
    });
    it("round-trips YAML-sensitive and multiline creator metadata without changing the body", () => {
        const input = {
            description: "Use when a value contains: colon, # hash, and \"quotes\".\nKeep the second line.",
            displayName: "Quoted: # display",
            shortDescription: "It's still YAML",
            instructions: "# Instructions\n\nKeep: # body text \"exactly\".",
        };

        const raw = serializeSkillMarkdown("yaml-safe", input);
        const parsed = parseSkillMarkdown(raw);

        expect(raw.startsWith("---\n")).toBe(true);
        expect(raw).toContain("\n---\n\n# Instructions");
        expect(parsed).toEqual({ ok: true, skill: { name: "yaml-safe", ...input } });
    });
});

describe("extractSkillMarkdown", () => {
    it("extracts a fenced markdown block", () => {
        const text = "Here it is:\n```markdown\n---\nname: x-skill\ndescription: d\n---\n\nbody\n```\n";
        expect(extractSkillMarkdown(text)).toBe("---\nname: x-skill\ndescription: d\n---\n\nbody");
    });
    it("extracts a whole message starting with frontmatter", () => {
        const text = "---\nname: x-skill\ndescription: d\n---\n\nbody\n";
        expect(extractSkillMarkdown(text)).toBe(text.trim());
    });
    it("skips earlier fences and returns the first valid Skill draft", () => {
        const text = "```json\n{}\n```\n\n```markdown\n---\nname: useful-skill\ndescription: useful\n---\n\nDo the work.\n```";
        expect(extractSkillMarkdown(text)).toBe("---\nname: useful-skill\ndescription: useful\n---\n\nDo the work.");
    });
    it("skips a frontmatter fence that is not a valid Skill", () => {
        const text = "```md\n---\nname: Bad Name\ndescription: invalid\n---\n```\n\n```\n---\nname: valid-skill\ndescription: valid\n---\n\nUse it.\n```";
        expect(extractSkillMarkdown(text)).toContain("name: valid-skill");
    });
    it("returns null for plain text", () => {
        expect(extractSkillMarkdown("no skill here")).toBeNull();
    });
    it("returns null for invalid whole-message frontmatter", () => {
        expect(extractSkillMarkdown("---\nname: Bad Name\ndescription: invalid\n---\n\nbody")).toBeNull();
    });
});

describe("isValidSkillName", () => {
    it("accepts kebab-case and rejects others", () => {
        expect(isValidSkillName("a-b-c")).toBe(true);
        expect(isValidSkillName("a")).toBe(true);
        expect(isValidSkillName("a--b")).toBe(false);
        expect(isValidSkillName("-a")).toBe(false);
        expect(isValidSkillName("A-b")).toBe(false);
        expect(isValidSkillName("../x")).toBe(false);
    });
});
