import { beforeEach, describe, expect, it } from "vitest";

import { importAppConfig } from "@/services/config-file";
import { defaultConfig, defaultWebdavSyncConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";

describe("config file migration", () => {
    beforeEach(() => {
        useConfigStore.setState({ config: defaultConfig, webdav: defaultWebdavSyncConfig });
    });

    it("gives legacy imports an independent Agent model and Responses API default", async () => {
        const legacyConfig = { ...defaultConfig } as Partial<AiConfig>;
        delete legacyConfig.agentModel;
        delete legacyConfig.agentApiMode;
        const file = {
            text: async () =>
                JSON.stringify({
                    app: "shotshot",
                    version: 1,
                    exportedAt: new Date().toISOString(),
                    config: legacyConfig,
                    webdav: defaultWebdavSyncConfig,
                }),
        } as File;

        await importAppConfig(file);

        expect(useConfigStore.getState().config).toMatchObject({
            credentialMode: "byok",
            managedModels: { text: "", image: "", video: "", audio: "" },
            agentModel: defaultConfig.textModel,
            agentApiMode: "responses",
        });
    });
});

import { expect as assert, vi } from "vitest";
import { useAiSourceStore } from "@/stores/use-ai-source-store";
import { sourceStorage, AI_SOURCE_KEY, AI_IMPORT_BACKUP_KEY } from "./ai-source-preferences";
import { recoverConfigImport } from "./config-file";

describe("managed source config import", () => {
    beforeEach(async () => {
        await sourceStorage.clear();
        useAiSourceStore.setState({ status: "ready", error: null, applying: false, preferences: { version: 1, selections: {} } });
    });
    const file = (version: number, preferences?: unknown) => ({ text: async () => JSON.stringify({ app: "shotshot", version, config: defaultConfig, webdav: defaultWebdavSyncConfig, aiSourcePreferences: preferences }) }) as File;
    it("v1 clears managed selection without removing BYOK credentials", async () => {
        await useAiSourceStore.getState().select("agent", { source: "chatgpt", modelId: "gpt" });
        await importAppConfig(file(1));
        assert(useAiSourceStore.getState().preferences.selections).toEqual({});
    });
    it("rejects unknown source versions before changing either store", async () => {
        const before = useConfigStore.getState().config;
        await assert(importAppConfig(file(2, { version: 9, selections: {} }))).rejects.toThrow();
        assert(useConfigStore.getState().config).toBe(before);
        assert(await sourceStorage.getItem(AI_IMPORT_BACKUP_KEY)).toBeNull();
    });
    it("restores both stores if config persistence fails", async () => {
        const oldConfig = useConfigStore.getState().config;
        const setter = vi.spyOn(useConfigStore, "setState").mockImplementationOnce(() => { throw new Error("failed"); });
        await assert(importAppConfig(file(2, { version: 1, selections: { agent: { source: "chatgpt", modelId: "gpt" } } }))).rejects.toThrow();
        setter.mockRestore();
        assert(useConfigStore.getState().config).toEqual(oldConfig);
        assert(useAiSourceStore.getState().preferences.selections).toEqual({});
        assert(await sourceStorage.getItem(AI_IMPORT_BACKUP_KEY)).toBeNull();
    });
    it("exposes recovery after interruption without discarding unknown backups", async () => {
        await sourceStorage.setItem(AI_IMPORT_BACKUP_KEY, { version: 1, id: "test", configRaw: null, sourceRaw: null, config: defaultConfig, webdav: defaultWebdavSyncConfig });
        await sourceStorage.setItem(AI_SOURCE_KEY, { version: 1, selections: { agent: { source: "chatgpt", modelId: "gpt" } } });
        useAiSourceStore.setState({ status: "loading" });
        await assert(useAiSourceStore.getState().hydrate()).rejects.toThrow();
        await recoverConfigImport();
        assert(useAiSourceStore.getState().preferences.selections).toEqual({});
        await sourceStorage.setItem(AI_IMPORT_BACKUP_KEY, { version: 99 });
        await assert(recoverConfigImport()).rejects.toThrow();
        assert(await sourceStorage.getItem(AI_IMPORT_BACKUP_KEY)).toEqual({ version: 99 });
    });
});
