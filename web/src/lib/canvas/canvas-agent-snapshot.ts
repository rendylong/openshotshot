import { getNodeDefinition } from "@/lib/canvas/node-registry";
import type { CanvasAgentSnapshot, CanvasGenerationContract } from "@/lib/canvas/canvas-agent-op-types";
import type { CanvasNodeData } from "@/types/canvas";
import { decodeChannelModel, resolveModelChannel, type AiConfig } from "@/stores/use-config-store";
import { getFalProfile } from "@/lib/models/fal/profiles";

function generationContract(node: CanvasNodeData, config?: AiConfig): CanvasGenerationContract | undefined {
    const model = node.metadata?.model;
    if (!config || !model) return;
    const decoded = decodeChannelModel(model);
    if (!decoded?.channelId) return;
    const channel = resolveModelChannel(config, model);
    // resolveModelChannel has a general fallback; a contract must never use that fallback.
    if (channel.id !== decoded.channelId || channel.provider !== "fal") return;
    const options = node.metadata?.providerOptions;
    if (options !== undefined && (!options || options.version !== 1 || !options.models || typeof options.models !== "object" || Array.isArray(options.models))) return;
    const stored = options && Object.hasOwn(options.models, model) ? options.models[model] : undefined;
    if (options && Object.hasOwn(options.models, model) && (!stored || stored.provider !== "fal" || stored.profileId !== decoded.model || stored.profileVersion !== 1)) return;
    const profile = getFalProfile(decoded.model, stored?.profileVersion);
    if (!profile) return;
    return { endpointId: profile.endpointId, profileId: profile.id, profileVersion: profile.version, fields: structuredClone(profile.fields), media: structuredClone(profile.media) };
}

export function annotateCanvasAgentNodes(nodes: CanvasNodeData[], config?: AiConfig): CanvasAgentSnapshot["nodes"] {
    return nodes.map((node: CanvasAgentSnapshot["nodes"][number]) => {
        const { generationContract: _previous, ...persisted } = node;
        const contract = generationContract(node, config);
        return {
            ...persisted,
            referenceKind: getNodeDefinition(node.type)?.referenceKind,
            ...(node.type === "3d" ? { referenceCount: 4 } : {}),
            ...(contract ? { generationContract: contract } : {}),
        };
    });
}
