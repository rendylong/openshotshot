import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentChatItem } from "@/stores/use-agent-store";
import type { PiSessionEntryRange, PiSessionEntrySnapshot } from "@/lib/agent/pi-agent-types";
import { AgentCompactionCard } from "./agent-compaction-card";

const item: AgentChatItem = {
    id: "session:compaction",
    itemId: "compaction",
    threadId: "session",
    turnId: "turn",
    role: "compaction",
    text: "The user prepared canvas references.",
    detail: {
        kind: "compaction",
        status: "completed",
        reason: "manual",
        summary: "The user prepared canvas references.",
        tokensBefore: 1_000,
        tokensAfter: 180,
        range: { fromEntryId: "user", toEntryId: "tool" },
    },
};

type ReadSessionEntriesFixture = (sessionId: string, range?: PiSessionEntryRange) => Promise<PiSessionEntrySnapshot[]>;

function entry(id: string, role: string, text: string): PiSessionEntrySnapshot {
    return { id, parentId: null, type: "message", role, text, raw: { role, content: [{ type: "text", text }] } };
}

describe("AgentCompactionCard", () => {
    it("renders collapsed metadata and fetches the covered range read-only on demand", async () => {
        const readSessionEntries = vi.fn(async (_sessionId: string, range?: PiSessionEntryRange) => {
            expect(range).toEqual({ fromEntryId: "user", toEntryId: "tool" });
            return [
                entry("user", "user", "Prepare the canvas"),
                entry("assistant", "assistant", "I inspected it."),
                entry("tool", "toolResult", "canvas state"),
            ];
        });

        render(<AgentCompactionCard item={item} readSessionEntries={readSessionEntries} />);

        expect(screen.getByText("已纳入摘要")).toBeInTheDocument();
        expect(screen.getByText("手动压缩")).toBeInTheDocument();
        expect(screen.getByText("The user prepared canvas references.")).toBeInTheDocument();
        expect(screen.getByText("减少 820 tokens")).toBeInTheDocument();
        expect(screen.queryByText("Prepare the canvas")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "查看原文" }));

        await waitFor(() => expect(screen.getByText("canvas state")).toBeInTheDocument());
        expect(readSessionEntries).toHaveBeenCalledWith("session", { fromEntryId: "user", toEntryId: "tool" });
        expect(screen.getByText("用户")).toBeInTheDocument();
        expect(screen.getByText("助手")).toBeInTheDocument();
        expect(screen.getByText("工具")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /执行|运行|重试/ })).not.toBeInTheDocument();
    });

    it("shows a read-only fetch failure without changing the compaction result", async () => {
        const readSessionEntries = vi.fn<ReadSessionEntriesFixture>()
            .mockRejectedValueOnce(new Error("session unavailable"))
            .mockResolvedValueOnce([entry("retry", "user", "Readable after retry")]);

        render(<AgentCompactionCard item={item} readSessionEntries={readSessionEntries} />);
        fireEvent.click(screen.getByRole("button", { name: "查看原文" }));

        await waitFor(() => expect(screen.getByText("原文读取失败：session unavailable")).toBeInTheDocument());
        expect(screen.getByText("已纳入摘要")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "收起原文" }));
        fireEvent.click(screen.getByRole("button", { name: "查看原文" }));
        await waitFor(() => expect(screen.getByText("Readable after retry")).toBeInTheDocument());
        expect(readSessionEntries).toHaveBeenCalledTimes(2);
    });

    it("labels approval, error, and unknown evidence without replaying or executing it", async () => {
        const readSessionEntries = vi.fn(async () => [
            {
                id: "approval",
                parentId: null,
                type: "custom",
                raw: { customType: "shotshot.approval", data: { decision: "approved", text: "Approve canvas write" } },
            },
            {
                id: "error",
                parentId: "approval",
                type: "message",
                role: "assistant",
                raw: { message: { role: "assistant", content: [], errorMessage: "Model failed" } },
            },
            { id: "unknown", parentId: "error", type: "label", raw: { label: "marker" } },
        ] satisfies PiSessionEntrySnapshot[]);

        render(<AgentCompactionCard item={item} readSessionEntries={readSessionEntries} />);
        fireEvent.click(screen.getByRole("button", { name: "查看原文" }));

        await waitFor(() => expect(screen.getByText("Approve canvas write · approved")).toBeInTheDocument());
        expect(screen.getByText("审批")).toBeInTheDocument();
        expect(screen.getByText("Model failed")).toBeInTheDocument();
        expect(screen.getByText("错误")).toBeInTheDocument();
        expect(screen.getByText("记录")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /执行|批准|拒绝|重试/ })).not.toBeInTheDocument();
    });

    it("ignores a stale fetch response after collapse and refetch", async () => {
        let resolveFirst!: (value: PiSessionEntrySnapshot[]) => void;
        const first = new Promise<PiSessionEntrySnapshot[]>((resolve) => {
            resolveFirst = resolve;
        });
        const readSessionEntries = vi.fn<ReadSessionEntriesFixture>()
            .mockImplementationOnce(() => first)
            .mockImplementationOnce(async () => [entry("fresh", "user", "Fresh response")]);

        render(<AgentCompactionCard item={item} readSessionEntries={readSessionEntries} />);
        fireEvent.click(screen.getByRole("button", { name: "查看原文" }));
        fireEvent.click(screen.getByRole("button", { name: "收起原文" }));
        fireEvent.click(screen.getByRole("button", { name: "查看原文" }));

        await waitFor(() => expect(screen.getByText("Fresh response")).toBeInTheDocument());
        resolveFirst([entry("stale", "user", "Stale response")]);
        await act(async () => { await Promise.resolve(); });

        expect(screen.queryByText("Stale response")).not.toBeInTheDocument();
        expect(screen.getByText("Fresh response")).toBeInTheDocument();
    });
});
