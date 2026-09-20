import { afterEach, describe, expect, test } from "vitest";

import { annotateCanvasAgentNodes } from "@/lib/canvas/canvas-agent-snapshot";
import { registerNodeDefinitions, unregisterPluginNodes } from "@/lib/canvas/node-registry";
import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeDefinition } from "@/types/canvas-plugin";

import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { getFalProfile } from "@/lib/models/fal/profiles";
import { patchProviderParams } from "@/lib/models/provider-options";

const SOURCE = "agent-snapshot-test";

afterEach(() => unregisterPluginNodes(SOURCE));

describe("annotateCanvasAgentNodes", () => {
    test("advertises four references for 3D nodes without exposing image payloads", () => {
        registerNodeDefinitions(
            [{ type: "3d", title: "3D", defaultSize: { width: 640, height: 480 }, defaultMetadata: {}, referenceKind: "image" } as unknown as CanvasNodeDefinition],
            SOURCE,
        );
        const nodes: CanvasNodeData[] = [
            { id: "model", type: "3d", title: "Model", position: { x: 0, y: 0 }, width: 640, height: 480, metadata: { model3d: { views: [{ id: "primary", storageKey: "image:primary" }] } } },
            { id: "text", type: "text", title: "Text", position: { x: 700, y: 0 }, width: 340, height: 240, metadata: { content: "hello" } },
        ];
        const annotated = annotateCanvasAgentNodes(nodes);
        expect(annotated[0].referenceKind).toBe("image");
        expect(annotated[0].referenceCount).toBe(4);
        expect(annotated[1].referenceCount).toBeUndefined();
        expect(JSON.stringify(annotated)).not.toContain("data:image");
    });
});


const model = "channel::fal-ai/flux-2-pro";
const config: AiConfig = { ...defaultConfig, channels: [{ id: "channel", name: "fal.ai", provider: "fal", baseUrl: "https://queue.fal.run", apiKey: "private-key", apiFormat: "openai", models: [{ name: "fal-ai/flux-2-pro", capability: "image" }] }] };
const falNode: CanvasNodeData = { id: "fal", type: "config", title: "Generate", position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { model } };
test("derives a detached top-level contract without secrets, defaults or schemas", () => {
    const [node] = annotateCanvasAgentNodes([falNode], config);
    const profile = getFalProfile("fal-ai/flux-2-pro")!;
    expect(node.generationContract).toEqual({ endpointId: profile.endpointId, profileId: profile.id, profileVersion: 1, fields: profile.fields, media: profile.media });
    expect(node.generationContract?.fields).not.toBe(profile.fields);
    expect(falNode).not.toHaveProperty("generationContract");
    expect(JSON.stringify(node)).not.toMatch(/private-key|data:image|inputSchema|outputSchema|defaults/);
});
test("requires exact channel provider and explicit model with a known saved version", () => {
    const options = patchProviderParams(undefined, model, getFalProfile("fal-ai/flux-2-pro")!, { seed: 7 });
    for (const [node, settings] of [
        [falNode, undefined],
        [{ ...falNode, metadata: {} }, config],
        [{ ...falNode, metadata: { model: "missing::fal-ai/flux-2-pro" } }, config],
        [{ ...falNode, metadata: { model: "fal-ai/flux-2-pro" } }, config],
        [falNode, { ...config, channels: [{ ...config.channels[0], provider: "custom" }] }],
        [{ ...falNode, metadata: { model, providerOptions: { ...options, version: 99 } } }, config],
        [{ ...falNode, metadata: { model, providerOptions: { ...options, models: { [model]: { ...options.models[model], profileVersion: 99 } } } } }, config],
        [{ ...falNode, metadata: { model, providerOptions: { ...options, models: { [model]: { ...options.models[model], profileId: "fal-ai/veo3.1" } } } } }, config],
    ] as [CanvasNodeData, AiConfig | undefined][]) {
        const [annotated] = annotateCanvasAgentNodes([node], settings);
        expect(annotated.generationContract).toBeUndefined();
        expect(annotated.metadata?.providerOptions).toEqual(node.metadata?.providerOptions);
    }
});


test("removes a stale contract when reannotating after channel removal", () => {
    const nodes = annotateCanvasAgentNodes([falNode], config);
    expect(nodes[0].generationContract).toBeDefined();
    const next = annotateCanvasAgentNodes(nodes, { ...config, channels: [] });
    expect(next[0].generationContract).toBeUndefined();
    expect(nodes[0].generationContract).toBeDefined();
});
