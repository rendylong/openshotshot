import { App } from "antd";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, test, vi } from "vitest";

import i18n from "@/i18n";
import type { LocalSkillSummary, SkillsBridge } from "@/lib/skills/skill-types";
import { SkillDetailModal } from "./skill-detail-modal";
import { useProjectStore } from "@/stores/canvas/use-project-store";

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", () => ({ useNavigate: () => navigateMock }));

const skill: LocalSkillSummary = {
    name: "photo-workflow",
    displayName: "摄影工作流",
    description: "组织产品摄影的准备、拍摄与交付",
    path: "/Users/test/.shotshot/skills/photo-workflow",
    source: "app",
    manualOnly: false,
    readonly: false,
    valid: true,
};

const submitPendingPromptMock = vi.fn(() => ({ projectId: "__uncategorized__", canvasId: "canvas-1" }));

function installBridge() {
    const snapshot = { revision: 1, skills: [], sources: [], diagnostics: [] };
    const skills: SkillsBridge = {
        configure: async () => ({ fresh: true, snapshot }),
        scan: async () => ({ fresh: true, snapshot }),
        read: async () => null,
        readFile: async () => ({ ok: false, error: "not found" }),
        write: async () => ({ ok: true }),
        importSkill: async () => null,
        remove: async () => ({ ok: true }),
        seed: async () => ({ ok: true }),
        pickFolder: async () => null,
    };
    (window as { shotshot?: { skills: SkillsBridge } }).shotshot = { skills };
}

function renderModal() {
    const onClose = vi.fn();
    render(
        <App>
            <I18nextProvider i18n={i18n}>
                <SkillDetailModal skill={skill} open onClose={onClose} />
            </I18nextProvider>
        </App>,
    );
    return { onClose };
}

beforeEach(() => {
    i18n.changeLanguage("zh-CN");
    navigateMock.mockClear();
    submitPendingPromptMock.mockClear();
    installBridge();
    useProjectStore.setState({ submitPendingPrompt: submitPendingPromptMock });
});

describe("SkillDetailModal use handoff", () => {
    test("「使用」走 handoff：安装 pendingPrompt、关闭弹窗并导航到未分类画布", async () => {
        const { onClose } = renderModal();
        expect(await screen.findByText("/photo-workflow")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "使用此 Skill" }));

        expect(submitPendingPromptMock).toHaveBeenCalledWith("/photo-workflow", expect.any(String));
        expect(navigateMock).toHaveBeenCalledWith("/canvas/__uncategorized__/canvas-1");
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test("双击只提交一次（eng review P1 守卫）", async () => {
        renderModal();
        expect(await screen.findByText("/photo-workflow")).toBeInTheDocument();
        const button = screen.getByRole("button", { name: "使用此 Skill" });
        fireEvent.click(button);
        fireEvent.click(button);

        expect(submitPendingPromptMock).toHaveBeenCalledTimes(1);
    });
});
