import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
    DEFAULT_SKILL_SOURCE_PREFERENCES,
    type LocalSkillSummary,
    type SkillRuntimeSnapshot,
    type SkillSourceKey,
    type SkillSourcePreferences,
    type SkillSourceStatus,
} from "@/lib/skills/skill-types";
import { configureLocalSkillSources, isElectron, readLocalSkill, scanLocalSkills } from "@/services/local-skill";
import { useAgentStore } from "@/stores/use-agent-store";

type LocalSkillStore = {
    skills: LocalSkillSummary[];
    selectedSkill: LocalSkillSummary | null;
    loading: boolean;
    loaded: boolean;
    desktop: boolean;
    errors: string[];
    sourcePreferences: SkillSourcePreferences;
    sources: SkillSourceStatus[];
    scanSkills: (force?: boolean) => Promise<{ ok: true } | { ok: false; error: string }>;
    selectSkill: (skill: LocalSkillSummary | null) => void;
    setSourceEnabled: (key: SkillSourceKey, enabled: boolean) => Promise<void>;
    applySnapshot: (snapshot: SkillRuntimeSnapshot) => void;
    useSkill: (name: string) => void;
    reset: () => void;
};

export const useLocalSkillStore = create<LocalSkillStore>()(
    persist(
        (set, get) => ({
            skills: [],
            selectedSkill: null,
            loading: false,
            loaded: false,
            desktop: isElectron(),
            errors: [],
            sourcePreferences: { ...DEFAULT_SKILL_SOURCE_PREFERENCES },
            sources: [],
            scanSkills: async (force = false) => {
                if (!isElectron()) {
                    set({ desktop: false, loading: false, loaded: true });
                    return { ok: false, error: "desktop-only" };
                }
                set({ loading: true, desktop: true });
                try {
                    const configured = await configureLocalSkillSources(get().sourcePreferences);
                    if (!configured) throw new Error("desktop-only");
                    set({
                        skills: configured.snapshot.skills,
                        sources: configured.snapshot.sources,
                        errors: configured.snapshot.diagnostics,
                        loading: false,
                        loaded: true,
                    });
                    const scanned = await scanLocalSkills(force);
                    if (!scanned) throw new Error("desktop-only");
                    set({
                        skills: scanned.snapshot.skills,
                        sources: scanned.snapshot.sources,
                        errors: scanned.snapshot.diagnostics,
                        loading: false,
                        loaded: true,
                    });
                    if (!scanned.fresh) return { ok: false, error: scanned.error };
                    return { ok: true };
                } catch (error) {
                    const text = error instanceof Error ? error.message : String(error);
                    set({ loading: false, loaded: true, errors: [text] });
                    return { ok: false, error: text };
                }
            },
            selectSkill: (selectedSkill) => {
                set((state) => {
                    if (selectedSkill && !selectedSkill.valid) return state;
                    return { selectedSkill };
                });
            },
            setSourceEnabled: async (key, enabled) => {
                if (key === "app") return;
                set((state) => ({ sourcePreferences: { ...state.sourcePreferences, [key]: enabled } }));
                await get().scanSkills();
            },
            applySnapshot: (snapshot) => set({ skills: snapshot.skills, sources: snapshot.sources, errors: snapshot.diagnostics, loading: false, loaded: true }),
            useSkill: (name) => {
                useAgentStore.getState().setAgentState({
                    prompt: `/${name} `,
                    submitRequest: null,
                    panelOpen: true,
                    panelMounted: true,
                    panelClosing: false,
                });
            },
            reset: () => set({ skills: [], selectedSkill: null, loading: false, loaded: false, errors: [], sourcePreferences: { ...DEFAULT_SKILL_SOURCE_PREFERENCES }, sources: [] }),
        }),
        {
            name: "shotshot:skill_sources",
            partialize: (state) => ({ sourcePreferences: state.sourcePreferences }),
            merge: (persisted, current) => ({
                ...current,
                sourcePreferences: {
                    ...DEFAULT_SKILL_SOURCE_PREFERENCES,
                    ...((persisted as { sourcePreferences?: Partial<SkillSourcePreferences> } | null)?.sourcePreferences ?? {}),
                },
            }),
        },
    ),
);

export async function loadSkillDetail(name: string) {
    return readLocalSkill(name);
}
