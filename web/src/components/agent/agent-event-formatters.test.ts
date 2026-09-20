import { beforeAll, describe, expect, it } from "vitest";

import i18n from "@/i18n";
import type { ProjectFileAssetRef } from "@/lib/project-assets/project-asset-types";
import { agentAttachmentToChatAttachment, isRunningWaitItem, toolName, workingActivity } from "./agent-event-formatters";

const projectRef: ProjectFileAssetRef = {
    backend: "project-file",
    projectId: "project-1",
    assetId: "asset-1",
    relativePath: "assets/imported/budget--a1b2c3d4.xlsx",
    revision: 1,
};

describe("agentAttachmentToChatAttachment", () => {
    it("preserves kind, mimeType, size, and assetRef when mapping a message attachment for display", () => {
        const chat = agentAttachmentToChatAttachment({
            id: "a",
            name: "budget.xlsx",
            url: "",
            kind: "spreadsheet",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            size: 64,
            assetRef: projectRef,
            relativePath: projectRef.relativePath,
        });

        expect(chat).toMatchObject({
            id: "a",
            name: "budget.xlsx",
            kind: "spreadsheet",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            size: 64,
            assetRef: projectRef,
            relativePath: projectRef.relativePath,
        });
    });

    it("prefers the inline dataUrl over the runtime url for the preview source", () => {
        const chat = agentAttachmentToChatAttachment({ id: "a", name: "photo.png", url: "blob:runtime", dataUrl: "data:image/png;base64,AA==", kind: "image" });
        expect(chat.url).toBe("data:image/png;base64,AA==");

        const runtimeOnly = agentAttachmentToChatAttachment({ id: "b", name: "photo.png", url: "blob:runtime", kind: "image" });
        expect(runtimeOnly.url).toBe("blob:runtime");
    });
});

describe("workingActivity wait labels", () => {
    beforeAll(async () => {
        await i18n.changeLanguage("zh-CN");
    });

    const waitItem = (status: string) => ({ id: "w1", role: "tool" as const, text: "", detail: { kind: "tool", toolName: "wait", status } });

    it("maps wait to the localized short label", () => {
        expect(toolName("wait")).toBe("等待");
    });

    it("renders the completed wait row without the 调用工具 prefix", () => {
        const activity = workingActivity(waitItem("completed"));
        expect(activity.text).toContain("等待已完成");
        expect(activity.text).not.toContain("调用工具");
    });

    it("detects a running wait item for slow-response suppression", () => {
        expect(isRunningWaitItem(waitItem("running"))).toBe(true);
        expect(isRunningWaitItem(waitItem("completed"))).toBe(false);
        expect(isRunningWaitItem({ id: "a", role: "assistant", text: "hi" })).toBe(false);
    });
});
