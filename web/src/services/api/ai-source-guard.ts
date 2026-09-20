import i18n from "@/i18n";
import type { AiCapability } from "@/lib/agent/ai-source-types";
import { useAiSourceStore } from "@/stores/use-ai-source-store";
export async function assertByokGenerationAllowed(capability: Exclude<AiCapability, "agent">) {
    try { await useAiSourceStore.getState().hydrate(); } catch { throw new Error(i18n.t("aiSources.preferencesFailed")); }
    const state = useAiSourceStore.getState();
    if (state.status !== "ready" || state.applying || state.error) throw new Error(i18n.t("aiSources.preferencesFailed"));
    if (state.preferences.selections[capability]) throw new Error(i18n.t("aiSources.generationUnavailable"));
}
