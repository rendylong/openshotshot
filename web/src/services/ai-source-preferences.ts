import localforage from "localforage";
import type { AiCapability, AiSourcePreferences } from "@/lib/agent/ai-source-types";
export const AI_IMPORT_BACKUP_KEY = "shotshot:ai-import-backup";
export const AI_SOURCE_KEY = "shotshot:ai-source-preferences";
export const sourceStorage = localforage.createInstance({name: "shotshot", storeName: "ai_preferences"});
export const emptyAiSourcePreferences = (): AiSourcePreferences => ({version: 1, selections: {}});
const capabilities = new Set(["agent", "image", "video", "text", "audio"]);
export function parseAiSourcePreferences(raw: unknown): AiSourcePreferences {
    const fail = () => { throw new Error("invalid_ai_source_preferences"); };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
    const value = raw as Record<string, unknown>;
    if (value.version !== 1 || Object.keys(value).some(k => !["version", "selections"].includes(k))) return fail();
    if (!value.selections || typeof value.selections !== "object" || Array.isArray(value.selections)) return fail();
    const result = emptyAiSourcePreferences();
    for (const [key, item] of Object.entries(value.selections)) {
        if (!capabilities.has(key) || !item || typeof item !== "object" || Array.isArray(item)) return fail();
        const selection = item as Record<string, unknown>;
        if (Object.keys(selection).some(k => !["source", "modelId"].includes(k)) ||
            String(selection.source) !== "chatgpt" ||
            (selection.source === "chatgpt" && key !== "agent") ||
            typeof selection.modelId !== "string" || !selection.modelId.trim()) return fail();
        result.selections[key as AiCapability] = {source: selection.source as "chatgpt", modelId: selection.modelId};
    }
    return result;
}
export async function readAiSourcePreferences(): Promise<AiSourcePreferences> {
    if (await sourceStorage.getItem(AI_IMPORT_BACKUP_KEY)) throw new Error("ai_source_import_recovery_required");
    const value = await sourceStorage.getItem<unknown>(AI_SOURCE_KEY);
    return value == null ? emptyAiSourcePreferences() : parseAiSourcePreferences(value);
}
export async function writeAiSourcePreferences(value: AiSourcePreferences): Promise<void> {
    await sourceStorage.setItem(AI_SOURCE_KEY, parseAiSourcePreferences(value));
}
