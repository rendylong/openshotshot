import { afterEach, expect, test } from "vitest";
import { useChatGptStore, watchChatGptStatus } from "./use-chatgpt-store";
import type { ChatGptBridge, ChatGptStatus } from "@/lib/agent/ai-source-types";
afterEach(() => { delete window.shotshot; });
test("a late initial status cannot overwrite sign-out notification", async () => {
    let finish!: (status: ChatGptStatus) => void;
    let notify!: (status: ChatGptStatus) => void;
    const bridge: Partial<ChatGptBridge> = { getStatus: () => new Promise(resolve => { finish = resolve; }), getModels: async () => [{ id: "gpt", name: "GPT", supportsImageInput: true }], onStatusChanged: listener => { notify = listener; return () => undefined; } };
    Object.defineProperty(window, "shotshot", { configurable: true, value: { chatgpt: bridge } });
    const stop = watchChatGptStatus();
    notify({ state: "signed-out" });
    finish({ state: "signed-in" });
    await Promise.resolve(); await Promise.resolve();
    expect(useChatGptStore.getState().status.state).toBe("signed-out");
    expect(useChatGptStore.getState().models).toEqual([]);
    stop();
});
