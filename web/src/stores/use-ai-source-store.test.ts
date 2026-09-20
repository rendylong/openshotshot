import { beforeEach, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({read: vi.fn(), write: vi.fn()}));
vi.mock("@/services/ai-source-preferences", () => ({emptyAiSourcePreferences: () => ({version: 1, selections: {}}), readAiSourcePreferences: io.read, writeAiSourcePreferences: io.write}));
import { useAiSourceStore } from "./use-ai-source-store";
beforeEach(() => {vi.clearAllMocks(); useAiSourceStore.setState({status: "loading", preferences: {version: 1, selections: {}}, error: null, applying: false});});
it("deduplicates hydration", async () => {
    io.read.mockResolvedValue({version: 1, selections: {}});
    await Promise.all([useAiSourceStore.getState().hydrate(), useAiSourceStore.getState().hydrate()]);
    expect(io.read).toHaveBeenCalledTimes(1);
});
it("does not overwrite a corrupt record or use BYOK as fallback", async () => {
    io.read.mockRejectedValue(new Error("corrupt"));
    await expect(useAiSourceStore.getState().hydrate()).rejects.toThrow();
    await expect(useAiSourceStore.getState().select("agent", null)).rejects.toThrow();
    expect(io.write).not.toHaveBeenCalled();
});
it("does not activate a failed write", async () => {
    useAiSourceStore.setState({status: "ready"}); io.write.mockRejectedValue(new Error("disk"));
    await expect(useAiSourceStore.getState().select("agent", {source: "chatgpt", modelId: "model"})).rejects.toThrow();
    expect(useAiSourceStore.getState().preferences.selections.agent).toBeUndefined();
});
