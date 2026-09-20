import { beforeEach, expect, it } from "vitest";
import { useHomeComposerStore } from "./use-home-composer-store";
import type { AgentAttachment } from "./use-agent-store";

const model: AgentAttachment = {
    id: "model",
    name: "bottle.glb",
    kind: "glb",
    mimeType: "model/gltf-binary",
    size: 1,
    url: "data:model/gltf-binary;base64,AA==",
    dataUrl: "data:model/gltf-binary;base64,AA==",
};

beforeEach(() => useHomeComposerStore.getState().resetDraft());

it("replaces text without clearing project or model", () => {
    const s = useHomeComposerStore.getState();
    s.setProjectTarget({ projectId: "p" });
    s.appendAttachments(s.draftId, [model]);
    s.setPrompt("old");
    s.setPrompt("new inspiration");
    expect(useHomeComposerStore.getState()).toMatchObject({
        prompt: "new inspiration",
        projectTarget: { projectId: "p" },
        attachments: [model],
    });
});

it("rejects a file read from a submitted draft", () => {
    const previous = useHomeComposerStore.getState().draftId;
    useHomeComposerStore.getState().resetDraft();
    useHomeComposerStore.getState().appendAttachments(previous, [model]);
    expect(useHomeComposerStore.getState().attachments).toEqual([]);
});

it("removes only the selected attachment", () => {
    const s = useHomeComposerStore.getState();
    s.appendAttachments(s.draftId, [model, { ...model, id: "other" }]);
    s.removeAttachment("model");
    expect(useHomeComposerStore.getState().attachments.map((a) => a.id)).toEqual(["other"]);
});
