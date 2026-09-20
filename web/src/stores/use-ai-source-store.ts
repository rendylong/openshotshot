import { create } from "zustand";
import type { AiCapability, AiSourcePreferences, ManagedSelection } from "@/lib/agent/ai-source-types";
import { emptyAiSourcePreferences, readAiSourcePreferences, writeAiSourcePreferences } from "@/services/ai-source-preferences";
type SourceStore = {
    status: "loading" | "ready" | "error"; preferences: AiSourcePreferences; error: string | null; applying: boolean;
    hydrate(): Promise<void>; retry(): Promise<void>; setApplying(value: boolean): void;
    select(capability: AiCapability, value: ManagedSelection | null): Promise<void>;
    replace(value: AiSourcePreferences): Promise<void>;
};
let hydration: Promise<void> | undefined;
let writes: Promise<void> = Promise.resolve();
export async function settleAiSourceWrites() { await writes.catch(() => undefined); }
export const useAiSourceStore = create<SourceStore>((set, get) => ({
    status: "loading", preferences: emptyAiSourcePreferences(), error: null, applying: false,
    hydrate() {
        if (get().status === "ready") return Promise.resolve();
        if (get().status === "error") return Promise.reject(new Error(get().error || "ai_source_preferences_unavailable"));
        hydration ??= readAiSourcePreferences().then(preferences => {set({preferences, status: "ready", error: null});})
            .catch(() => {set({status: "error", error: "ai_source_preferences_unavailable"}); throw new Error("ai_source_preferences_unavailable");})
            .finally(() => {hydration = undefined;});
        return hydration;
    },
    async retry() {set({status: "loading", error: null}); await get().hydrate();},
    setApplying: applying => set({applying}),
    select(capability, value) {
        const operation = writes.catch(() => undefined).then(async () => {
            await get().hydrate();
            if (get().applying) throw new Error("ai_source_import_in_progress");
            const next = {...get().preferences, selections: {...get().preferences.selections}};
            if (value === null) delete next.selections[capability]; else next.selections[capability] = value;
            try {await writeAiSourcePreferences(next); set({preferences: next, error: null});}
            catch {set({error: "ai_source_write_failed"}); throw new Error("ai_source_write_failed");}
        });
        writes = operation;
        return operation;
    },
    replace(value) {
        const operation = writes.catch(() => undefined).then(async () => {
            await writeAiSourcePreferences(value);
            set({preferences: value, status: "ready", error: null});
        });
        writes = operation; return operation;
    },
}));
