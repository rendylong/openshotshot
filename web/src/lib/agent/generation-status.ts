// generation_get_status 查询侧纯函数（可靠性 spec §3/§3.5/§4）：
// 画布过滤 → id 匹配（nodeId + sourceNodeId）→ 每节点最新一条 → 文本节点状态合并 → not_found。
// 主进程工具通过 getGenerationStatus 缓存取数后在此收敛语义；bridge 的防重护栏用 latestTaskForNodeId。
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-op-types";
import type { AgentGenerationTask } from "./pi-agent-types";

export type GenerationStatusEntry = AgentGenerationTask | { nodeId: string; status: "not_found" };

const NODE_TEXT_STATUS: Record<string, { status: "running" | "succeeded" | "failed"; terminal: boolean }> = {
    loading: { status: "running", terminal: false },
    success: { status: "succeeded", terminal: true },
    error: { status: "failed", terminal: true },
};

function sortKey(task: AgentGenerationTask): string {
    return task.submittedAt ?? task.updatedAt;
}

export function latestTaskForNodeId(tasks: AgentGenerationTask[], nodeId: string): AgentGenerationTask | undefined {
    const hits = tasks.filter((task) => task.nodeId === nodeId || (task.sourceNodeId !== undefined && task.sourceNodeId === nodeId));
    return [...hits].sort((a, b) => sortKey(b).localeCompare(sortKey(a)))[0];
}

// spec D4：failed 回执必须带原因，杜绝 status-only failed 让 Agent 盲猜换模型重跑。
function withFailureDetail(entry: GenerationStatusEntry): GenerationStatusEntry {
    if (entry.status !== "failed" || entry.error) return entry;
    return { ...entry, error: "unknown_failure" };
}

export function buildGenerationStatusReport(input: {
    tasks: AgentGenerationTask[];
    snapshot: CanvasAgentSnapshot;
    nodeIds?: string[];
    limit: number;
}): { entries: GenerationStatusEntry[] } {
    const { tasks, snapshot, nodeIds, limit } = input;
    const wanted = nodeIds ? new Set(nodeIds) : null;
    const scoped = tasks.filter((task) => task.projectId === snapshot.projectId && task.canvasId === snapshot.canvasId);

    const latestByNode = new Map<string, AgentGenerationTask>();
    for (const task of scoped) {
        if (wanted && !wanted.has(task.nodeId) && !(task.sourceNodeId !== undefined && wanted.has(task.sourceNodeId))) continue;
        const current = latestByNode.get(task.nodeId);
        if (!current || sortKey(task) > sortKey(current)) latestByNode.set(task.nodeId, task);
    }

    // 文本生成不走远端任务 store：从快照节点 metadata 合并第二来源（spec §3 文本任务纳入）。
    // 仅在显式 nodeIds 查询时合并：列表模式（不传 nodeIds）只回报远端任务，
    // 否则 loading 中的文本节点会以“当前时间”占据“最近 limit 条”头部。
    if (wanted) {
        const textEntries: AgentGenerationTask[] = [];
        for (const node of snapshot.nodes) {
            if (node.metadata?.generationMode !== "text") continue;
            if (!wanted.has(node.id)) continue;
            if (latestByNode.has(node.id)) continue;
            const mapped = NODE_TEXT_STATUS[String(node.metadata.status)];
            if (!mapped) continue;
            textEntries.push({
                nodeId: node.id,
                source: "node_status",
                status: mapped.status,
                terminal: mapped.terminal,
                updatedAt: new Date().toISOString(),
            });
        }
        const entries: GenerationStatusEntry[] = [...latestByNode.values(), ...textEntries];
        const covered = new Set(entries.map((entry) => entry.nodeId));
        // sourceNodeId 命中的派生任务：别名 id 已解析（实际 nodeId 在 entries 里），不算 not_found。
        for (const task of latestByNode.values()) {
            if (task.sourceNodeId !== undefined) covered.add(task.sourceNodeId);
        }
        const notFound: GenerationStatusEntry[] = [...wanted].filter((id) => !covered.has(id)).map((id) => ({ nodeId: id, status: "not_found" as const }));
        return { entries: [...entries, ...notFound].map(withFailureDetail) };
    }
    const merged = [...latestByNode.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit);
    return { entries: merged.map(withFailureDetail) };
}
