import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";

import i18n from "@/i18n";
import type { CanvasNodeData } from "@/types/canvas";
import { ComposeActionsBar } from "./compose-actions-bar";

const renderBar = (over: Partial<Parameters<typeof ComposeActionsBar>[0]> = {}) => {
    const props = { composed: 10, total: 12, generatingCount: 0, hasAnyVersion: false, onBatchGenerate: vi.fn(), onComposeWithAgent: vi.fn(), ...over };
    render(
        <I18nextProvider i18n={i18n}>
            <ComposeActionsBar {...props} />
        </I18nextProvider>,
    );
};

describe("ComposeActionsBar 三态", () => {
    it("有未生成镜头：主按钮批量生成 + 未合成 ghost", () => {
        renderBar();
        expect(screen.getByRole("button", { name: "批量生成剩余视频" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "让 Agent 补写 2 个未合成" })).toBeInTheDocument();
        expect(screen.getByText("已合成 10/12 镜提示词")).toBeInTheDocument();
    });

    it("生成中：只显状态，无生成按钮", () => {
        renderBar({ generatingCount: 2 });
        expect(screen.getByText("2 个镜头视频生成中…")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /批量生成/ })).not.toBeInTheDocument();
    });

    it("全部已生成：次级重新生成", () => {
        renderBar({ composed: 12, total: 12, hasAnyVersion: true });
        expect(screen.getByRole("button", { name: "重新生成视频" })).toBeInTheDocument();
    });
});
