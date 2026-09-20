import { CanvasNodeType, type CanvasNodeTypeId, type Position } from "@/types/canvas";
import type { CanvasAgentSnapshot } from "./canvas-agent-op-types";

export const AGENT_NODE_GAP = 48;

export type AgentNodeBounds = { x: number; y: number; width: number; height: number };

type AgentNodeSize = { width: number; height: number };

type AgentPositionedNode = { position: { x: number; y: number }; width: number; height: number };

// A pure fallback for the Electron main process, which cannot rely on the renderer-owned node
// registry being populated. applyCanvasAgentOps still uses the registry for exact plugin sizes.
const BUILTIN_AGENT_NODE_SIZES: Record<CanvasNodeType, AgentNodeSize> = {
    [CanvasNodeType.Image]: { width: 340, height: 240 },
    [CanvasNodeType.Text]: { width: 340, height: 240 },
    [CanvasNodeType.Config]: { width: 340, height: 240 },
    [CanvasNodeType.Video]: { width: 420, height: 236 },
    [CanvasNodeType.Audio]: { width: 340, height: 120 },
    [CanvasNodeType.File]: { width: 360, height: 240 },
    [CanvasNodeType.Group]: { width: 760, height: 480 },
};

export function getAgentNodeSize(type: CanvasNodeTypeId, explicit?: Partial<AgentNodeSize>): AgentNodeSize {
    const fallback = BUILTIN_AGENT_NODE_SIZES[type as CanvasNodeType] || { width: 340, height: 240 };
    const width = typeof explicit?.width === "number" && explicit.width > 0 ? explicit.width : fallback.width;
    const height = typeof explicit?.height === "number" && explicit.height > 0 ? explicit.height : fallback.height;
    return { width, height };
}

export function getNodeBounds(nodes: Array<AgentNodeBounds | undefined>): AgentNodeBounds | null {
    const valid = nodes.filter((node): node is AgentNodeBounds => Boolean(
        node && [node.x, node.y, node.width, node.height].every((value) => Number.isFinite(value)),
    ));
    if (!valid.length) return null;
    const left = Math.min(...valid.map((node) => node.x));
    const top = Math.min(...valid.map((node) => node.y));
    const right = Math.max(...valid.map((node) => node.x + node.width));
    const bottom = Math.max(...valid.map((node) => node.y + node.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
}

export function getNodeAsBounds(node: AgentPositionedNode): AgentNodeBounds {
    return { x: node.position.x, y: node.position.y, width: node.width, height: node.height };
}

export function getNodesBounds(nodes: AgentPositionedNode[]): AgentNodeBounds | null {
    return getNodeBounds(nodes.map(getNodeAsBounds));
}

function boundsOverlap(a: AgentNodeBounds, b: AgentNodeBounds) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function isFree(position: Position, size: AgentNodeSize, occupied: AgentNodeBounds[]) {
    return !occupied.some((bounds) => boundsOverlap({ ...position, ...size }, bounds));
}

function rightOf(anchor: AgentNodeBounds, size: AgentNodeSize, distance = AGENT_NODE_GAP): Position {
    return { x: anchor.x + anchor.width + distance, y: anchor.y + anchor.height / 2 - size.height / 2 };
}

function leftOf(anchor: AgentNodeBounds, size: AgentNodeSize, distance = AGENT_NODE_GAP): Position {
    return { x: anchor.x - distance - size.width, y: anchor.y + anchor.height / 2 - size.height / 2 };
}

function belowOf(anchor: AgentNodeBounds, size: AgentNodeSize, distance = AGENT_NODE_GAP): Position {
    return { x: anchor.x + anchor.width / 2 - size.width / 2, y: anchor.y + anchor.height + distance };
}

function aboveOf(anchor: AgentNodeBounds, size: AgentNodeSize, distance = AGENT_NODE_GAP): Position {
    return { x: anchor.x + anchor.width / 2 - size.width / 2, y: anchor.y - distance - size.height };
}

export function placeAgentNodeBesideAnchor(anchor: AgentNodeBounds, size: AgentNodeSize, occupied: AgentNodeBounds[] = []): Position {
    for (let distance = AGENT_NODE_GAP; distance <= AGENT_NODE_GAP * 8; distance += AGENT_NODE_GAP) {
        const candidates = [rightOf(anchor, size, distance), leftOf(anchor, size, distance), belowOf(anchor, size, distance), aboveOf(anchor, size, distance)];
        const free = candidates.find((position) => isFree(position, size, occupied));
        if (free) return free;
    }
    return rightOf(anchor, size, AGENT_NODE_GAP * 8);
}

function viewportCenteredPosition(snapshot: CanvasAgentSnapshot, size: AgentNodeSize): Position {
    const width = snapshot.viewportSize?.width || 1200;
    const height = snapshot.viewportSize?.height || 720;
    const k = Number.isFinite(snapshot.viewport.k) && snapshot.viewport.k > 0 ? snapshot.viewport.k : 1;
    return {
        x: (-snapshot.viewport.x + width / 2) / k - size.width / 2,
        y: (-snapshot.viewport.y + height / 2) / k - size.height / 2,
    };
}

export function resolveAgentNodePosition(
    snapshot: CanvasAgentSnapshot,
    size: AgentNodeSize,
    options: { referenceNodeIds?: string[]; occupied?: AgentNodeBounds[] } = {},
): Position {
    const referenceIds = new Set(options.referenceNodeIds || []);
    const referenceNodes = referenceIds.size ? snapshot.nodes.filter((node) => referenceIds.has(node.id)) : [];
    const selectedNodes = snapshot.nodes.filter((node) => snapshot.selectedNodeIds.includes(node.id));
    const anchor = getNodesBounds([...referenceNodes, ...selectedNodes]);
    const occupied = [...snapshot.nodes.map(getNodeAsBounds), ...(options.occupied || [])];

    if (anchor) return placeAgentNodeBesideAnchor(anchor, size, occupied);

    const center = viewportCenteredPosition(snapshot, size);
    const centerBounds = { ...center, ...size };
    if (isFree(center, size, occupied)) return center;

    for (let distance = AGENT_NODE_GAP; distance <= AGENT_NODE_GAP * 8; distance += AGENT_NODE_GAP) {
        const candidates = [rightOf(centerBounds, size, distance), leftOf(centerBounds, size, distance), belowOf(centerBounds, size, distance), aboveOf(centerBounds, size, distance)];
        const free = candidates.find((position) => isFree(position, size, occupied));
        if (free) return free;
    }
    return center;
}
