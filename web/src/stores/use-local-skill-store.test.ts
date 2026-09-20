import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillRuntimeSnapshot, SkillsBridge } from "@/lib/skills/skill-types";
import { useAgentStore } from "@/stores/use-agent-store";
import { useLocalSkillStore } from "@/stores/use-local-skill-store";

const snapshot: SkillRuntimeSnapshot = {
    revision: 1,
    skills: [{ name: "cosmetic-label", description: "Design labels", path: "/skills/cosmetic-label", source: "piGlobal", manualOnly: false, readonly: true, valid: true }],
    sources: [{ key: "piGlobal", enabled: true, readonly: true, paths: ["/skills"], exists: true, skillCount: 1, diagnostics: [] }],
    diagnostics: ["loaded pi skills"],
};

describe("useLocalSkillStore", () => {
    beforeEach(() => {
        useLocalSkillStore.getState().reset();
        useAgentStore.getState().setAgentState({ prompt: "", submitRequest: null, panelOpen: false });
    });
    afterEach(() => {
        delete (window as { shotshot?: unknown }).shotshot;
    });
    it("starts empty and not desktop-flagged", () => {
        const s = useLocalSkillStore.getState();
        expect(s.skills).toEqual([]);
        expect(s.loaded).toBe(false);
    });
    it("selectSkill ignores invalid skills", () => {
        useLocalSkillStore.getState().selectSkill({ name: "x", description: "", path: "/p", source: "app", manualOnly: false, readonly: false, valid: false, error: "bad" });
        expect(useLocalSkillStore.getState().selectedSkill).toBeNull();
    });
    it("defaults every optional Pi source to disabled", () => {
        expect(useLocalSkillStore.getState().sourcePreferences).toEqual({
            piGlobal: false,
            agentsGlobal: false,
            piProject: false,
            agentsProject: false,
        });
    });
    it("updates one optional source without changing the others", () => {
        useLocalSkillStore.getState().setSourceEnabled("piGlobal", true);
        expect(useLocalSkillStore.getState().sourcePreferences).toEqual({
            piGlobal: true,
            agentsGlobal: false,
            piProject: false,
            agentsProject: false,
        });
    });
    it("does not toggle the app source", () => {
        useLocalSkillStore.getState().setSourceEnabled("app", true);
        expect(useLocalSkillStore.getState().sourcePreferences).toEqual({
            piGlobal: false,
            agentsGlobal: false,
            piProject: false,
            agentsProject: false,
        });
    });
    it("inserts the standard command without submitting it", () => {
        useAgentStore.getState().setAgentState({ prompt: "queued", submitRequest: { nonce: 1 } });
        useLocalSkillStore.getState().useSkill("cosmetic-label");
        expect(useAgentStore.getState().prompt).toBe("/cosmetic-label ");
        expect(useAgentStore.getState().submitRequest).toBeNull();
        expect(useAgentStore.getState().panelOpen).toBe(true);
    });
    it("persists only source preferences", () => {
        const state = {
            ...useLocalSkillStore.getState(),
            skills: snapshot.skills,
            selectedSkill: snapshot.skills[0],
            loading: true,
            errors: ["transient"],
            sourcePreferences: { piGlobal: true, agentsGlobal: false, piProject: false, agentsProject: true },
        };

        expect(useLocalSkillStore.persist.getOptions().partialize?.(state)).toEqual({
            sourcePreferences: { piGlobal: true, agentsGlobal: false, piProject: false, agentsProject: true },
        });
    });
    it("hydrates a partial persisted preference payload over default-off fields", () => {
        const current = useLocalSkillStore.getState();
        const merged = useLocalSkillStore.persist.getOptions().merge?.(
            { sourcePreferences: { piGlobal: true } },
            current,
        ) as typeof current;

        expect(merged.sourcePreferences).toEqual({
            piGlobal: true,
            agentsGlobal: false,
            piProject: false,
            agentsProject: false,
        });
        expect(merged.skills).toBe(current.skills);
    });
    it("immediately configures a newly enabled source and applies its snapshot", async () => {
        const configure = vi.fn(async (_preferences: unknown) => snapshot);
        const result = { fresh: true as const, snapshot };
        const skills: SkillsBridge = {
            configure: vi.fn(async (preferences) => {
                await configure(preferences);
                return result;
            }),
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

        await useLocalSkillStore.getState().setSourceEnabled("piGlobal", true);

        expect(configure).toHaveBeenCalledWith({ piGlobal: true, agentsGlobal: false, piProject: false, agentsProject: false });
        expect(useLocalSkillStore.getState().sourcePreferences.piGlobal).toBe(true);
        expect(useLocalSkillStore.getState().skills).toEqual(snapshot.skills);
        expect(useLocalSkillStore.getState().sources).toEqual(snapshot.sources);
        expect(useLocalSkillStore.getState().errors).toEqual(snapshot.diagnostics);
    });

    it("applies a fallback snapshot but reports failure until a fresh refresh recovers", async () => {
        const fallbackSnapshot = { ...snapshot, diagnostics: ["Skill 刷新失败：loader unavailable"] };
        let failing = true;
        const skills: SkillsBridge = {
            configure: async () => failing
                ? { fresh: false, snapshot: fallbackSnapshot, error: "Skill 刷新失败：loader unavailable" }
                : { fresh: true, snapshot },
            scan: async () => failing
                ? { fresh: false, snapshot: fallbackSnapshot, error: "Skill 刷新失败：loader unavailable" }
                : { fresh: true, snapshot },
            read: async () => null,
            readFile: async () => ({ ok: false, error: "not found" }),
            write: async () => ({ ok: true }),
            importSkill: async () => null,
            remove: async () => ({ ok: true }),
            seed: async () => ({ ok: true }),
            pickFolder: async () => null,
        };
        (window as { shotshot?: { skills: SkillsBridge } }).shotshot = { skills };

        await expect(useLocalSkillStore.getState().scanSkills()).resolves.toEqual({
            ok: false,
            error: "Skill 刷新失败：loader unavailable",
        });
        expect(useLocalSkillStore.getState().skills).toEqual(fallbackSnapshot.skills);
        expect(useLocalSkillStore.getState().errors).toEqual(fallbackSnapshot.diagnostics);

        failing = false;
        await expect(useLocalSkillStore.getState().scanSkills()).resolves.toEqual({ ok: true });
        expect(useLocalSkillStore.getState().skills).toEqual(snapshot.skills);
        expect(useLocalSkillStore.getState().errors).toEqual(snapshot.diagnostics);
    });

    it("passes force only for an explicit refresh", async () => {
        const result = { fresh: true as const, snapshot };
        const scan = vi.fn(async () => result);
        const skills: SkillsBridge = {
            configure: async () => result,
            scan,
            read: async () => null,
            readFile: async () => ({ ok: false, error: "not found" }),
            write: async () => ({ ok: true }),
            importSkill: async () => null,
            remove: async () => ({ ok: true }),
            seed: async () => ({ ok: true }),
            pickFolder: async () => null,
        };
        (window as { shotshot?: { skills: SkillsBridge } }).shotshot = { skills };

        await useLocalSkillStore.getState().scanSkills();
        await useLocalSkillStore.getState().scanSkills(true);

        expect(scan.mock.calls).toEqual([[false], [true]]);
    });
});
