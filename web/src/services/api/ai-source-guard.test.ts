import { beforeEach, expect, test, vi } from "vitest";
import { useAiSourceStore } from "@/stores/use-ai-source-store";
import { assertByokGenerationAllowed } from "./ai-source-guard";
import { queryRemoteMediaTask, submitRemoteMediaTask } from "./remote-media-task";
import { defaultConfig } from "@/stores/use-config-store";
vi.mock("./model-plugin", () => ({ runRemoteSubmitPlugin: vi.fn(async () => ({ taskId: "sentinel" })), runRemoteQueryPlugin: vi.fn(async () => ({ status: "pending" })) }));
import { runRemoteSubmitPlugin, runRemoteQueryPlugin } from "./model-plugin";
beforeEach(() => { vi.clearAllMocks(); useAiSourceStore.setState({ status: "ready", error: null, applying: false, preferences: { version: 1, selections: {} } }); });
test("a stored capability selection prevents new submission without stopping queries", async () => {
    useAiSourceStore.setState({ preferences: { version: 1, selections: { image: { source: "chatgpt", modelId: "gpt" } } } });
    await expect(submitRemoteMediaTask({ capability: "image", config: { ...defaultConfig, apiKey: "sentinel-key" }, prompt: "test", images: [], params: {}, submitScript: "sentinel" })).rejects.toThrow();
    expect(runRemoteSubmitPlugin).not.toHaveBeenCalled();
    await queryRemoteMediaTask({ capability: "image", config: defaultConfig, taskId: "pending", queryScript: "sentinel" });
    expect(runRemoteQueryPlugin).toHaveBeenCalledOnce();
});
test("preserves BYOK and capability isolation", async () => {
    useAiSourceStore.setState({ preferences: { version: 1, selections: { agent: { source: "chatgpt", modelId: "gpt" } } } });
    await expect(assertByokGenerationAllowed("image")).resolves.toBeUndefined();
});
test("blocks while applying or after a storage error", async () => {
    useAiSourceStore.setState({ applying: true }); await expect(assertByokGenerationAllowed("audio")).rejects.toThrow();
    useAiSourceStore.setState({ applying: false, error: "unreadable" }); await expect(assertByokGenerationAllowed("audio")).rejects.toThrow();
});
