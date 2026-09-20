import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { I18nextProvider } from "react-i18next";

import i18n from "@/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import type { PiSessionSummary } from "@/lib/agent/pi-agent-types";
import { useAgentStore } from "@/stores/use-agent-store";
import { useAgentSessionStore } from "@/stores/use-agent-session-store";
import { PiAgentHistoryView } from "./pi-agent-history-view";

describe("PiAgentHistoryView", () => {
    beforeEach(async () => {
        await i18n.changeLanguage("zh-CN");
        useAgentStore.setState({ canvasContext: null });
        const session: PiSessionSummary = {
            sessionId: "session-1",
            title: "Readable",
            scope: { projectId: "project-1", canvasId: "canvas-1" },
            createdAt: 0,
            updatedAt: 0,
            status: "idle",
            hasUnfinishedOperation: false,
        };
        useAgentSessionStore.setState({
            sessions: [session],
            activeSessionId: "session-1",
            unreadableSessions: [
                { file: "broken.jsonl", error: "invalid JSON" },
                { file: "partial.jsonl", error: "truncated line" },
            ],
        });
    });

    it("surfaces unreadable session diagnostics with full details in the title", () => {
        const theme = Object.values(canvasThemes)[0];
        render(
            <I18nextProvider i18n={i18n}>
                <PiAgentHistoryView theme={theme} onNewSession={() => undefined} onContinue={() => undefined} onCloseSession={() => undefined} />
            </I18nextProvider>,
        );

        const warning = screen.getByRole("status");
        expect(warning).toHaveTextContent("2 个会话文件无法读取：invalid JSON");
        expect(warning).toHaveAttribute("title", "broken.jsonl: invalid JSON\npartial.jsonl: truncated line");
    });

    it("only lists sessions belonging to the current canvas", () => {
        // 会话严格归属白板：同项目其他画布、其他项目与全局空 scope 的会话都不展示。
        const theme = Object.values(canvasThemes)[0];
        useAgentStore.setState({
            canvasContext: {
                snapshot: { projectId: "project-1", canvasId: "canvas-1", title: "Canvas", nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } },
                applyOps: () => {
                    throw new Error("not used");
                },
                undoOps: () => null,
                canUndo: false,
            },
        });
        useAgentSessionStore.setState({
            sessions: [
                { sessionId: "session-current", title: "Current canvas chat", scope: { projectId: "project-1", canvasId: "canvas-1" }, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false },
                { sessionId: "session-sibling", title: "Sibling canvas chat", scope: { projectId: "project-1", canvasId: "canvas-2" }, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false },
                { sessionId: "session-foreign", title: "Foreign project chat", scope: { projectId: "project-9", canvasId: "canvas-9" }, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false },
                { sessionId: "session-global", title: "Global chat", scope: { projectId: "", canvasId: "" }, createdAt: 0, updatedAt: 0, status: "idle", hasUnfinishedOperation: false },
            ],
            activeSessionId: "session-current",
            unreadableSessions: [],
        });

        render(
            <I18nextProvider i18n={i18n}>
                <PiAgentHistoryView theme={theme} onNewSession={() => undefined} onContinue={() => undefined} onCloseSession={() => undefined} />
            </I18nextProvider>,
        );

        expect(screen.getByText("Current canvas chat")).toBeTruthy();
        expect(screen.queryByText("Sibling canvas chat")).toBeNull();
        expect(screen.queryByText("Foreign project chat")).toBeNull();
        expect(screen.queryByText("Global chat")).toBeNull();
    });
});
