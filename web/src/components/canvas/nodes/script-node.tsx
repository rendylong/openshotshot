import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { CanvasNodeContext } from "@/types/canvas-plugin";
import { createEmptyScriptData } from "@/types/script-node";
import { useScriptEntityStore } from "@/stores/use-script-entity-store";
import { buildScriptNodeSummary } from "@/lib/canvas/script-node-model";
import { ScriptNodeSummaryCard } from "./script-node-summary";

/** 节点 = 场记板摘要卡（spec D1-D4）：看状态、识别进度、双击进 Script Studio。 */
export function ScriptNodeContent({ ctx }: { ctx: CanvasNodeContext }) {
    const { t } = useTranslation();
    const script = ctx.node.metadata?.script ?? createEmptyScriptData();
    const entityIds = script.entityIds;
    const allEntities = useScriptEntityStore((state) => state.entities);
    const entities = useMemo(() => allEntities.filter((entity) => entityIds.includes(entity.id)), [allEntities, entityIds]);
    const assetsReady = useMemo(() => entities.filter((e) => e.refs.some((r) => r.state === "ready")).length, [entities]);

    // 已水合的分镜缩略：storyboardNodes[shotId] -> 画布节点 metadata.content
    // （与 project.tsx storyboardImageState 同源；资产存储迁移后该水合机制保留，勿改读 assetRef）
    const storyboardThumbs = useMemo(() => {
        const thumbs: Record<string, string> = {};
        const nodes = ctx.getNodes();
        for (const [shotId, nodeId] of Object.entries(script.output.storyboardNodes ?? {})) {
            const node = nodes.find((n) => n.id === nodeId);
            const content = node?.metadata?.content;
            if (typeof content === "string" && content) thumbs[shotId] = content;
        }
        return thumbs;
        // 节点上下文快照按渲染周期刷新即可
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ctx, script.output.storyboardNodes]);

    const summary = useMemo(
        () =>
            buildScriptNodeSummary(script, {
                assetsReady,
                assetsTotal: entities.length,
                hydratedStoryboardIds: new Set(Object.keys(storyboardThumbs)),
                maxFrames: ctx.node.width >= 280 ? 4 : 3,
            }),
        [script, assetsReady, entities.length, storyboardThumbs, ctx.node.width],
    );

    return (
        <ScriptNodeSummaryCard
            title={ctx.node.title || t("canvas.scriptNode.title")}
            summary={summary}
            storyboardThumbs={storyboardThumbs}
            compact={ctx.scale < 0.75}
        />
    );
}
