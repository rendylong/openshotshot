import { describe, expect, test } from "vitest";

import { defaultConfig, normalizeChannelModels } from "@/stores/use-config-store";
import { getPluginVariables, runModelPlugin, runRemoteQueryPlugin, runRemoteSubmitPlugin } from "./model-plugin";

describe("model plugin transport errors", () => {
    test("preserves transport code and cause when wrapping script errors", async () => {
        try {
            await runModelPlugin({
                capability: "image",
                config: defaultConfig,
                script: `const error = new Error("timeout of 30000ms exceeded"); error.code = "ECONNABORTED"; throw error;`,
            });
            throw new Error("expected runModelPlugin to reject");
        } catch (error) {
            expect(error).toMatchObject({
                code: "ECONNABORTED",
                cause: expect.objectContaining({ code: "ECONNABORTED", message: "timeout of 30000ms exceeded" }),
            });
        }
    });

    test("does not expose taskId to direct scripts", async () => {
        expect(getPluginVariables().map((variable) => variable.name)).not.toContain("taskId");
        await expect(runModelPlugin({ capability: "image", config: defaultConfig, script: "return typeof taskId" })).resolves.toBe("undefined");
    });

    test("isolates submit and query script locals", async () => {
        const signal = new AbortController().signal;
        await expect(runRemoteSubmitPlugin({ capability: "image", config: defaultConfig, script: "return typeof taskId" })).resolves.toBe("undefined");
        await expect(runRemoteQueryPlugin({
            capability: "image",
            config: defaultConfig,
            taskId: "remote-1",
            signal,
            script: "return [taskId, typeof prompt, typeof images, typeof params, typeof model, typeof baseUrl, typeof apiKey, typeof http, typeof request, typeof signal]",
        })).resolves.toEqual(["remote-1", "undefined", "undefined", "undefined", "string", "string", "string", "object", "function", "object"]);
    });

    test("allows custom scripts to declare names hidden by their phase", async () => {
        await expect(runModelPlugin({ capability: "image", config: defaultConfig, script: "const taskId = 'direct-local'; return taskId" })).resolves.toBe("direct-local");
        await expect(runRemoteSubmitPlugin({ capability: "image", config: defaultConfig, script: "const taskId = 'submit-local'; return taskId" })).resolves.toBe("submit-local");
        await expect(runRemoteQueryPlugin({ capability: "image", config: defaultConfig, taskId: "remote-1", script: "const prompt = 'query-local'; return [taskId, prompt]" })).resolves.toEqual(["remote-1", "query-local"]);
    });

    test("keeps the legacy HiAPI direct script's local taskId compatible", async () => {
        const script = `
const created = { taskId: "legacy-task" };
const taskId = (created && created.taskId) || "";
return await poll(
  () => Promise.resolve({ status: "success", output: ["legacy-result"] }),
  (state) => state.status === "success" ? state.output : null,
);`;

        await expect(runModelPlugin({ capability: "image", config: defaultConfig, script })).resolves.toEqual(["legacy-result"]);
    });

    test("executes imported legacy direct and remote scripts without rewriting their bytes", async () => {
        const directScript = "\nreturn ['legacy-direct', model];\n";
        const submitScript = "\nreturn 'legacy-remote-id';\n";
        const queryScript = "\nreturn { status: 'pending', taskId };\n";
        const model = normalizeChannelModels([{
            name: "legacy-video",
            capability: "video",
            executionMode: "remote_task",
            script: directScript,
            remoteTask: { timeoutMinutes: 13, submitScript, queryScript },
        }])[0];

        expect(model.script).toBe(directScript);
        expect(model.remoteTask).toEqual({ timeoutMinutes: 13, submitScript, queryScript });
        await expect(runModelPlugin({ capability: "video", config: defaultConfig, script: model.script! })).resolves.toEqual(["legacy-direct", defaultConfig.model]);
        await expect(runRemoteSubmitPlugin({ capability: "video", config: defaultConfig, script: model.remoteTask!.submitScript })).resolves.toBe("legacy-remote-id");
        await expect(runRemoteQueryPlugin({ capability: "video", config: defaultConfig, taskId: "legacy-remote-id", script: model.remoteTask!.queryScript })).resolves.toEqual({ status: "pending", taskId: "legacy-remote-id" });
    });
});
