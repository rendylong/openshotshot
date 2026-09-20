import { create } from "zustand";

import type { HomeCanvasTarget } from "@/stores/canvas/use-project-store";
import type { AgentAttachment } from "./use-agent-store";

type HomeComposerState = {
    draftId: number;
    prompt: string;
    attachments: AgentAttachment[];
    projectTarget: HomeCanvasTarget;
    setPrompt(prompt: string): void;
    setProjectTarget(projectTarget: HomeCanvasTarget): void;
    appendAttachments(draftId: number, files: AgentAttachment[]): void;
    removeAttachment(id: string): void;
    resetDraft(): void;
};

export const useHomeComposerStore = create<HomeComposerState>((set) => ({
    draftId: 0,
    prompt: "",
    attachments: [],
    projectTarget: null,
    setPrompt: (prompt) => set({ prompt }),
    setProjectTarget: (projectTarget) => set({ projectTarget }),
    appendAttachments: (draftId, files) => set((state) => state.draftId === draftId ? { attachments: [...state.attachments, ...files] } : state),
    removeAttachment: (id) => set((state) => ({ attachments: state.attachments.filter((attachment) => attachment.id !== id) })),
    resetDraft: () => set((state) => ({ draftId: state.draftId + 1, prompt: "", attachments: [], projectTarget: null })),
}));
