import { create } from "zustand";
import type { ChatGptModel, ChatGptStatus } from "@/lib/agent/ai-source-types";
let revision = 0;
export const useChatGptStore = create<{ status: ChatGptStatus; models: ChatGptModel[]; refresh(): Promise<void> }>((set) => ({
    status: { state: "signed-out" }, models: [],
    async refresh() {
        const bridge = window.shotshot?.chatgpt;
        if (!bridge) return;
        const readingRevision = revision;
        try {
            const status = await bridge.getStatus();
            if (readingRevision !== revision) return;
            set({ status });
            const models = status.state === "signed-in" ? await bridge.getModels() : [];
            if (useChatGptStore.getState().status === status) set({ models });
        } catch { if (readingRevision === revision) set({ status: { state: "error", errorCode: "unavailable" }, models: [] }); }
    },
}));
export function watchChatGptStatus() {
    const bridge = window.shotshot?.chatgpt;
    if (!bridge) return () => undefined;
    const unsubscribe = bridge.onStatusChanged(status => {
        revision += 1;
        useChatGptStore.setState({ status, ...(status.state !== "signed-in" ? { models: [] } : {}) });
        if (status.state === "signed-in") void useChatGptStore.getState().refresh();
    });
    void useChatGptStore.getState().refresh();
    return unsubscribe;
}
