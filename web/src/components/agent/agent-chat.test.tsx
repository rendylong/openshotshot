import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import { useAgentStore } from "@/stores/use-agent-store";
import { AgentChatTimeline } from "./agent-chat";

describe("AgentChatTimeline duration", () => {
    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        HTMLElement.prototype.scrollTo = vi.fn();
        await i18n.changeLanguage("zh-CN");
        useAgentStore.setState({
            messages: [{ id: "user", itemId: "user", threadId: "thread", turnId: "turn", role: "user", text: "开始", startedAt: 1_000 }],
            sending: true,
            waiting: true,
        });
    });

    afterEach(() => vi.useRealTimers());

    it("updates while the turn is running and freezes at completion", () => {
        render(
            <AgentChatTimeline
                theme={canvasThemes.light}
                pendingTool={null}
                pendingApprovals={[]}
                sending
                waiting
                onRejectTool={() => {}}
                onApproveTool={() => {}}
                onApprovalDecision={() => {}}
            />,
        );

        expect(screen.getByText("用时 0秒")).toBeInTheDocument();
        act(() => vi.advanceTimersByTime(2_000));
        expect(screen.getByText("用时 2秒")).toBeInTheDocument();

        act(() => useAgentStore.setState({
            messages: [{ id: "user", itemId: "user", threadId: "thread", turnId: "turn", role: "user", text: "开始", startedAt: 1_000, completedAt: 3_500, durationMs: 2_500 }],
            sending: false,
            waiting: false,
        }));
        act(() => vi.advanceTimersByTime(3_000));
        expect(screen.getByText("用时 2秒")).toBeInTheDocument();
    });

    it("hides a completed turn process until the user expands it", () => {
        useAgentStore.setState({
            messages: [
                { id: "user", itemId: "user", threadId: "thread", turnId: "turn", role: "user", text: "开始", startedAt: 1_000, completedAt: 3_500, durationMs: 2_500 },
                { id: "reasoning", itemId: "reasoning:0", threadId: "thread", turnId: "turn", role: "tool", text: "分析画布", detail: { kind: "reasoning", status: "completed" } },
                { id: "interim", itemId: "assistant:0", threadId: "thread", turnId: "turn", role: "assistant", text: "我先检查。" },
                { id: "tool", itemId: "tool:1", threadId: "thread", turnId: "turn", role: "tool", title: "读取画布", text: "已读取", detail: { kind: "tool", status: "completed" } },
                { id: "final", itemId: "assistant:1", threadId: "thread", turnId: "turn", role: "assistant", text: "检查完成。" },
            ],
            sending: false,
            waiting: false,
        });
        render(
            <AgentChatTimeline
                theme={canvasThemes.light}
                pendingTool={null}
                pendingApprovals={[]}
                sending={false}
                waiting={false}
                onRejectTool={() => {}}
                onApproveTool={() => {}}
                onApprovalDecision={() => {}}
            />,
        );

        expect(screen.getByText("开始")).toBeInTheDocument();
        expect(screen.getByText("检查完成。")).toBeInTheDocument();
        expect(screen.queryByText("我先检查。")).not.toBeInTheDocument();
        expect(screen.queryByText("读取画布")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "用时 2秒" }));
        expect(screen.getByText("我先检查。")).toBeInTheDocument();
        expect(screen.getByText("读取画布")).toBeInTheDocument();
    });

    it("renders a pending Pi user input request instead of the generic working row", () => {
        render(
            <AgentChatTimeline
                theme={canvasThemes.light}
                pendingTool={null}
                pendingApprovals={[]}
                pendingUserInput={{ requestId: "r1", method: "select", title: "选择方案", options: ["方案 A", "方案 B"] }}
                sending
                waiting
                onRejectTool={() => {}}
                onApproveTool={() => {}}
                onApprovalDecision={() => {}}
                onUserInputResponse={() => {}}
            />,
        );

        expect(screen.getByText("选择方案")).toBeInTheDocument();
        expect(screen.getByRole("radio", { name: "方案 A" })).toBeInTheDocument();
        expect(screen.queryByText("正在思考")).not.toBeInTheDocument();
    });
});
