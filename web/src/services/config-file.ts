import { saveAs } from "file-saver";
import i18n from "@/i18n";
import { defaultWebdavSyncConfig, normalizeAiConfig, useConfigStore, CONFIG_STORE_KEY, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { useAiSourceStore, settleAiSourceWrites } from "@/stores/use-ai-source-store";
import { AI_SOURCE_KEY, AI_IMPORT_BACKUP_KEY, sourceStorage, emptyAiSourcePreferences, parseAiSourcePreferences } from "./ai-source-preferences";
import type { AiSourcePreferences } from "@/lib/agent/ai-source-types";
type AppConfigFile = { app: "shotshot"; version: 2; exportedAt: string; config: AiConfig; webdav: WebdavSyncConfig; aiSourcePreferences: AiSourcePreferences };
type ImportBackup = { version: 1; id: string; configRaw: string | null; sourceRaw: unknown; config: AiConfig; webdav: WebdavSyncConfig };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const invalid = () => new Error(i18n.t("config.invalidFile"));
export async function exportAppConfig() {
    await useAiSourceStore.getState().hydrate();
    await settleAiSourceWrites();
    const state = useAiSourceStore.getState();
    if (state.applying || state.error) throw invalid();
    const { config, webdav } = useConfigStore.getState();
    const data: AppConfigFile = { app: "shotshot", version: 2, exportedAt: new Date().toISOString(), config, webdav, aiSourcePreferences: parseAiSourcePreferences(state.preferences) };
    saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), "shotshot-config.json");
}
async function restore(backup: ImportBackup) {
    if (!object(backup) || backup.version !== 1 || typeof backup.id !== "string" || !(backup.configRaw === null || typeof backup.configRaw === "string") || !object(backup.config) || !object(backup.webdav)) throw invalid();
    const preferences = backup.sourceRaw == null ? emptyAiSourcePreferences() : parseAiSourcePreferences(backup.sourceRaw);
    if (backup.configRaw !== null) { const raw = JSON.parse(backup.configRaw); if (!object(raw) || !object(raw.state)) throw invalid(); }
    await useAiSourceStore.getState().replace(preferences);
    if (backup.sourceRaw == null) await sourceStorage.removeItem(AI_SOURCE_KEY);
    useConfigStore.setState({ config: backup.config, webdav: backup.webdav });
    if (backup.configRaw === null) localStorage.removeItem(CONFIG_STORE_KEY); else localStorage.setItem(CONFIG_STORE_KEY, backup.configRaw);
    await sourceStorage.removeItem(AI_IMPORT_BACKUP_KEY);
}
export async function recoverConfigImport() {
    if (useAiSourceStore.getState().applying) throw invalid();
    useAiSourceStore.getState().setApplying(true);
    try {
        await settleAiSourceWrites();
        const backup = await sourceStorage.getItem<ImportBackup>(AI_IMPORT_BACKUP_KEY);
        if (!backup) throw invalid();
        await restore(backup);
    } catch (error) { useAiSourceStore.setState({ status: "error", error: "ai_source_preferences_unavailable" }); throw error; }
    finally { useAiSourceStore.getState().setApplying(false); }
}
export async function importAppConfig(file: File) {
    let raw: unknown;
    try { raw = JSON.parse(await file.text()); } catch { throw invalid(); }
    if (!object(raw) || raw.app !== "shotshot" || (raw.version !== 1 && raw.version !== 2) || !object(raw.config) || !object(raw.webdav)) throw invalid();
    // Validate and normalize both domains before touching either store.
    const preferences = raw.version === 1 ? emptyAiSourcePreferences() : parseAiSourcePreferences(raw.aiSourcePreferences);
    const config = normalizeAiConfig(raw.config);
    const webdav = { ...defaultWebdavSyncConfig, ...raw.webdav } as WebdavSyncConfig;
    for (const [key, value] of Object.entries(defaultWebdavSyncConfig)) if (key in raw.webdav && typeof raw.webdav[key] !== typeof value) throw invalid();
    await useAiSourceStore.getState().hydrate();
    if (useAiSourceStore.getState().applying) throw invalid();
    useAiSourceStore.getState().setApplying(true);
    let backup: ImportBackup | undefined;
    let saved = false;
    try {
        await settleAiSourceWrites();
        if (await sourceStorage.getItem(AI_IMPORT_BACKUP_KEY)) throw invalid();
        const prior = useConfigStore.getState();
        backup = { version: 1, id: crypto.randomUUID(), configRaw: localStorage.getItem(CONFIG_STORE_KEY), sourceRaw: await sourceStorage.getItem(AI_SOURCE_KEY), config: prior.config, webdav: prior.webdav };
        await sourceStorage.setItem(AI_IMPORT_BACKUP_KEY, backup); saved = true;
        await useAiSourceStore.getState().replace(preferences);
        useConfigStore.setState({ config, webdav });
        await sourceStorage.removeItem(AI_IMPORT_BACKUP_KEY);
    } catch (error) {
        if (saved && backup) {
            try { await restore(backup); } catch { useAiSourceStore.setState({ status: "error", error: "ai_source_preferences_unavailable" }); }
        }
        throw error;
    } finally { useAiSourceStore.getState().setApplying(false); }
}
