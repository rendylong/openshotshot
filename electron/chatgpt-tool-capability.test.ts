import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Type } from "@sinclair/typebox";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { buildModelsFromConfig } from "@/lib/agent/pi-provider-map";
test("SDK retains registered image tool while disabling it for a text model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shotshot-tool-capability-"));
    try {
        const { models, model } = buildModelsFromConfig({ model: "test-text", apiKey: "sentinel", baseUrl: "https://example.test", apiFormat: "openai", agentApiMode: "responses", supportsImageInput: false });
        const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(dir, "models.json"), refreshOnCreate: false });
        runtime.registerNativeProvider(models.getProvider(model.provider)!);
        const settingsManager = SettingsManager.inMemory();
        const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
        await resourceLoader.reload();
        const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(), tools: ["read", "view_image"], customTools: [{ name: "view_image", label: "Image", description: "Test image tool", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "test" }], details: {} }) }] });
        try {
            await session.bindExtensions({ mode: "rpc" });
            session.setActiveToolsByName(["read"]);
            expect(session.getActiveToolNames()).not.toContain("view_image");
            expect(session.getAllTools().map(tool => tool.name)).toContain("view_image");
            session.setActiveToolsByName(["read", "view_image"]);
            expect(session.getActiveToolNames()).toContain("view_image");
        } finally { session.dispose(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
});
