import { describe, expect, it } from "vitest";

import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-op-types";
import type { AgentGenerationTask } from "./pi-agent-types";
import { buildGenerationStatusReport } from "./generation-status";

const snapshot: CanvasAgentSnapshot = {
    projectId: "p1", canvasId: "c1", title: "t",
    nodes: [
        { id: "text-1", type: "text", title: "t1", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { generationMode: "text", status: "loading" } },
    ],
    connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 },
};

const task = (overrides: Partial<AgentGenerationTask> & { nodeId: string }): AgentGenerationTask => ({
    source: "remote_media", status: "pending", projectId: "p1", canvasId: "c1", terminal: false,
    submittedAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z", ...overrides,
});

describe("buildGenerationStatusReport", () => {
    it("只返回当前画布任务（跨画布同 nodeId 不混入）", () => {
        const { entries } = buildGenerationStatusReport({
            tasks: [task({ nodeId: "n1" }), task({ nodeId: "n1", projectId: "p2", canvasId: "c2" })],
            snapshot, limit: 20,
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ nodeId: "n1", canvasId: "c1" });
    });

    it("同节点多条按 submittedAt 取最新；sourceNodeId 可命中派生任务并带实际 nodeId", () => {
        const { entries } = buildGenerationStatusReport({
            tasks: [
                task({ nodeId: "image-a", sourceNodeId: "config-1", status: "failed", terminal: true, submittedAt: "2026-09-15T00:00:00.000Z" }),
                task({ nodeId: "image-a", sourceNodeId: "config-1", status: "pending", submittedAt: "2026-09-15T01:00:00.000Z" }),
            ],
            snapshot, nodeIds: ["config-1"], limit: 20,
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ nodeId: "image-a", status: "pending" });
    });

    it("文本节点状态合并为 node_status 来源（loading→running），远端任务优先", () => {
        const withRemote = buildGenerationStatusReport({ tasks: [task({ nodeId: "text-1" })], snapshot, nodeIds: ["text-1"], limit: 20 });
        expect(withRemote.entries[0]).toMatchObject({ source: "remote_media" });

        const nodeOnly = buildGenerationStatusReport({ tasks: [], snapshot, nodeIds: ["text-1"], limit: 20 });
        expect(nodeOnly.entries[0]).toMatchObject({ nodeId: "text-1", source: "node_status", status: "running", terminal: false });
    });

    it("查无记录的 id 显式 not_found；列表模式每节点最新一条并截断 limit", () => {
        const missing = buildGenerationStatusReport({ tasks: [], snapshot, nodeIds: ["ghost"], limit: 20 });
        expect(missing.entries).toEqual([{ nodeId: "ghost", status: "not_found" }]);

        const { entries } = buildGenerationStatusReport({
            tasks: [
                task({ nodeId: "n1", submittedAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z", status: "failed", terminal: true }),
                task({ nodeId: "n1", submittedAt: "2026-09-15T02:00:00.000Z", updatedAt: "2026-09-15T02:00:00.000Z" }),
                task({ nodeId: "n2", submittedAt: "2026-09-15T01:00:00.000Z", updatedAt: "2026-09-15T01:00:00.000Z" }),
            ],
            snapshot, limit: 1,
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ nodeId: "n1", status: "pending" });
    });

    it("failed 终态必含非空 error（缺失时兜底 unknown_failure）", () => {
        const { entries } = buildGenerationStatusReport({
            tasks: [task({ nodeId: "n1", status: "failed", terminal: true })],
            snapshot, nodeIds: ["n1"], limit: 20,
        });
        expect(entries[0]).toMatchObject({ nodeId: "n1", status: "failed", error: "unknown_failure" });
    });

    it("已有 error 的 failed 回执原样保留", () => {
        const { entries } = buildGenerationStatusReport({
            tasks: [task({ nodeId: "n1", status: "failed", terminal: true, error: "upstream_failed" })],
            snapshot, nodeIds: ["n1"], limit: 20,
        });
        expect(entries[0]).toMatchObject({ nodeId: "n1", error: "upstream_failed" });
    });

    it("node_status 来源的 failed 文本节点同样兜底 error", () => {
        const failedText: CanvasAgentSnapshot = { ...snapshot, nodes: [{ ...snapshot.nodes[0], metadata: { generationMode: "text", status: "error" } }] };
        const { entries } = buildGenerationStatusReport({ tasks: [], snapshot: failedText, nodeIds: ["text-1"], limit: 20 });
        expect(entries[0]).toMatchObject({ nodeId: "text-1", status: "failed", error: "unknown_failure" });
    });
});
