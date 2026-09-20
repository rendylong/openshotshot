import { afterEach, describe, expect, test } from "vitest";

import { buildSourceImageReferences, buildStrictGenerationContext, buildNodeGenerationContext, buildNodeGenerationInputs, countNodeReferenceImages, type NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { registerNodeDefinitions, unregisterPluginNodes } from "@/lib/canvas/node-registry";
import { clearModel3dSnapshots, setLiveModel3dViews } from "@/lib/canvas/model-3d-snapshot";
import type { AssetMentionResolver } from "@/lib/canvas/asset-mentions";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import i18n from "@/i18n";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeDefinition } from "@/types/canvas-plugin";

const TEST_PLUGIN = "test-generation-plugin";

const node = (type: string, metadata: Record<string, unknown>): CanvasNodeData =>
    ({ id: `${type}-1`, type, title: type, position: { x: 0, y: 0 }, width: 340, height: 240, metadata }) as CanvasNodeData;

const connection = (fromNodeId: string, toNodeId: string) => ({ id: `c-${fromNodeId}-${toNodeId}`, fromNodeId, toNodeId });

afterEach(() => {
    unregisterPluginNodes(TEST_PLUGIN);
    clearModel3dSnapshots();
});

describe("3D multi-view generation references", () => {
    test("expands one connected 3D node into four ordered image references", () => {
        registerNodeDefinitions(
            [{ type: "3d", title: "3D", defaultSize: { width: 640, height: 480 }, defaultMetadata: {}, referenceKind: "image", resource: () => null } as unknown as CanvasNodeDefinition],
            TEST_PLUGIN,
        );
        const modelNode = node("3d", {});
        const configNode = node("config", { generationMode: "image" });
        setLiveModel3dViews(modelNode.id, [
            { id: "primary", dataUrl: "data:image/png;base64,PRIMARY" },
            { id: "left", dataUrl: "data:image/png;base64,LEFT" },
            { id: "right", dataUrl: "data:image/png;base64,RIGHT" },
            { id: "top", dataUrl: "data:image/png;base64,TOP" },
        ]);

        const context = buildNodeGenerationContext(configNode.id, [modelNode, configNode], [connection(modelNode.id, configNode.id)], "render");
        expect(context.referenceImages.map((image) => image.id)).toEqual(["3d-1:primary", "3d-1:left", "3d-1:right", "3d-1:top"]);
        expect(context.referenceImages.map((image) => image.dataUrl)).toEqual([
            "data:image/png;base64,PRIMARY",
            "data:image/png;base64,LEFT",
            "data:image/png;base64,RIGHT",
            "data:image/png;base64,TOP",
        ]);
        expect(context.imageCount).toBe(4);
    });

    test("keeps an ordinary connected image as one reference", () => {
        const imageNode = node("image", { content: "data:image/png;base64,ONE", mimeType: "image/png" });
        const configNode = node("config", { generationMode: "image" });
        const context = buildNodeGenerationContext(configNode.id, [imageNode, configNode], [connection(imageNode.id, configNode.id)], "render");
        expect(context.referenceImages).toHaveLength(1);
        expect(context.referenceImages[0].id).toBe("image-1");
    });

    test("uses only the Agent-selected single 3D view stored on the generation target", () => {
        registerNodeDefinitions(
            [{ type: "3d", title: "3D", defaultSize: { width: 640, height: 480 }, defaultMetadata: {}, referenceKind: "image", resource: () => null } as unknown as CanvasNodeDefinition],
            TEST_PLUGIN,
        );
        const modelNode = node("3d", {});
        const targetNode = node("image", { generationMode: "image", reference3dViews: { [modelNode.id]: "left" } });
        setLiveModel3dViews(modelNode.id, [
            { id: "primary", dataUrl: "data:image/png;base64,PRIMARY" },
            { id: "left", dataUrl: "data:image/png;base64,LEFT" },
            { id: "right", dataUrl: "data:image/png;base64,RIGHT" },
            { id: "top", dataUrl: "data:image/png;base64,TOP" },
        ]);

        const context = buildNodeGenerationContext(targetNode.id, [modelNode, targetNode], [connection(modelNode.id, targetNode.id)], "render");

        expect(context.referenceImages.map((image) => image.id)).toEqual(["3d-1:left"]);
        expect(context.imageCount).toBe(1);
    });

    test("keeps all four 3D views when the Agent explicitly selects all", () => {
        registerNodeDefinitions(
            [{ type: "3d", title: "3D", defaultSize: { width: 640, height: 480 }, defaultMetadata: {}, referenceKind: "image", resource: () => null } as unknown as CanvasNodeDefinition],
            TEST_PLUGIN,
        );
        const modelNode = node("3d", {});
        const targetNode = node("image", { generationMode: "image", reference3dViews: { [modelNode.id]: "all" } });
        setLiveModel3dViews(modelNode.id, [
            { id: "primary", dataUrl: "data:image/png;base64,PRIMARY" },
            { id: "left", dataUrl: "data:image/png;base64,LEFT" },
            { id: "right", dataUrl: "data:image/png;base64,RIGHT" },
            { id: "top", dataUrl: "data:image/png;base64,TOP" },
        ]);

        const context = buildNodeGenerationContext(targetNode.id, [modelNode, targetNode], [connection(modelNode.id, targetNode.id)], "render");

        expect(context.referenceImages.map((image) => image.id)).toEqual(["3d-1:primary", "3d-1:left", "3d-1:right", "3d-1:top"]);
    });

    test("cold 3D node with migrated assetRef-only views still yields references carrying assetRef (终审 I2)", () => {
        registerNodeDefinitions(
            [{ type: "3d", title: "3D", defaultSize: { width: 640, height: 480 }, defaultMetadata: {}, referenceKind: "image", resource: () => null } as unknown as CanvasNodeDefinition],
            TEST_PLUGIN,
        );
        const modelNode = node("3d", {
            model3d: {
                views: [
                    { id: "primary", assetRef: { backend: "project-file", projectId: "p1", assetId: "a1", revision: 1, relativePath: "assets/generated/a1.png" } },
                    { id: "left", assetRef: { backend: "project-file", projectId: "p1", assetId: "a2", revision: 1, relativePath: "assets/generated/a2.png" } },
                ],
            },
        });
        const configNode = node("config", { generationMode: "image" });
        // 冷缓存（无 live 捕获）：持久化 assetRef-only 视图仍产出参考并通过 strict 缺参考校验
        const context = buildNodeGenerationContext(configNode.id, [modelNode, configNode], [connection(modelNode.id, configNode.id)], "render", { strictReferences: true });
        expect(context.referenceImages.map((image) => image.id)).toEqual(["3d-1:primary", "3d-1:left"]);
        const ref = context.referenceImages[0];
        expect(ref.storageKey).toBeUndefined();
        expect(ref.assetRef?.backend === "project-file" && ref.assetRef.assetId).toBe("a1");
        expect(context.imageCount).toBe(2);
    });
});

describe("readNodeGenerationResource text-fallback suppression", () => {
    test("declared referenceKind:image plugin node with cold cache injects no stale prompt text", () => {
        const definition: CanvasNodeDefinition = {
            type: "plug-img",
            title: "Plug",
            defaultSize: { width: 340, height: 240 },
            defaultMetadata: {},
            referenceKind: "image",
            resource: () => null,
        } as unknown as CanvasNodeDefinition;
        registerNodeDefinitions([definition], TEST_PLUGIN);

        const pluginNode = node("plug-img", { prompt: "stale prompt" });
        const configNode = node("config", { generationMode: "image" });
        const inputs = buildNodeGenerationInputs(configNode.id, [pluginNode, configNode], [connection(pluginNode.id, configNode.id)]);
        expect(inputs).toEqual([]);
    });

    test("text node with only a prompt keeps the legacy prompt text fallback (suppression does not overreach)", () => {
        const textNode = node("text", { prompt: "hello" });
        const configNode = node("config", { generationMode: "image" });
        const inputs = buildNodeGenerationInputs(configNode.id, [textNode, configNode], [connection(textNode.id, configNode.id)]);
        expect(inputs).toEqual([{ nodeId: "text-1", type: "text", title: "text", text: "hello" }]);
    });

    test("warm declared plugin node still resolves through resource()", () => {
        const definition: CanvasNodeDefinition = {
            type: "plug-img",
            title: "Plug",
            defaultSize: { width: 340, height: 240 },
            defaultMetadata: {},
            referenceKind: "image",
            resource: () => ({ kind: "image", url: "data:image/png;base64,WARM" }),
        } as unknown as CanvasNodeDefinition;
        registerNodeDefinitions([definition], TEST_PLUGIN);

        const pluginNode = node("plug-img", {});
        const configNode = node("config", { generationMode: "image" });
        const inputs = buildNodeGenerationInputs(configNode.id, [pluginNode, configNode], [connection(pluginNode.id, configNode.id)]);
        expect(inputs).toEqual([
            {
                nodeId: "plug-img-1",
                type: "image",
                title: "plug-img",
                image: { id: "plug-img-1", name: "plug-img.png", type: "image/png", dataUrl: "data:image/png;base64,WARM", storageKey: undefined },
            },
        ]);
    });
});

describe("strict workflow reference compilation", () => {
    test("keeps mention order and deduplicates repeated images", () => {
        const a = { ...node("image", { content: "https://example.com/a.png" }), id: "a" };
        const b = { ...node("image", { content: "https://example.com/b.png" }), id: "b" };
        const config = node("config", { composerContent: "@[node:b] then @[node:a] and @[node:b]" });
        const context = buildNodeGenerationContext(config.id, [a, b, config], [connection(a.id, config.id), connection(b.id, config.id)], config.metadata!.composerContent!, { strictReferences: true });
        expect(context.referenceImages.map(image => image.id)).toEqual(["b", "a"]);
        expect(context.prompt).not.toContain("@[node:");
        expect(context.prompt).toContain(" then ");
        expect(context.imageCount).toBe(2);
    });
    test("rejects missing tokens instead of quietly erasing them", () => {
        const config = node("config", { composerContent: "@[node:missing]" });
        expect(() => buildNodeGenerationContext(config.id, [config], [], "@[node:missing]", { strictReferences: true })).toThrow();
    });
    test("allocates a separate label for each image in a multi-image node", () => {
        const images = node("image", { content: "https://example.com/a.png", images: [
            { id: "one", status: "success", content: "https://example.com/a.png" },
            { id: "two", status: "success", content: "https://example.com/b.png" },
        ] });
        const config = node("config", { composerContent: "@[node:image-1]" });
        const context = buildNodeGenerationContext(config.id, [images, config], [connection(images.id, config.id)], "@[node:image-1]", { strictReferences: true });
        expect(context.referenceImages.map(image => image.id)).toEqual(["image-1:one", "image-1:two"]);
        expect(context.prompt).toContain("1");
        expect(context.prompt).toContain("2");
    });
    test("plain composer text does not implicitly consume connected media", () => {
        const images = node("image", { content: "https://example.com/a.png" });
        const config = node("config", { composerContent: "words only" });
        const context = buildNodeGenerationContext(config.id, [images, config], [connection(images.id, config.id)], "words only", { strictReferences: true });
        expect(context.referenceImages).toEqual([]);
        expect(context.prompt).toBe("words only");
    });
});

describe("strict stored-media traversal", () => {
    test.each([false, true])("retains storage-only image/audio/video references through direct or grouped input (group=%s)", grouped => {
        const config = node("config", { generationMode: "video" });
        const group = node("group", {});
        const image = node("image", { storageKey: "image:stored", ...(grouped ? { groupId: group.id } : {}) });
        const audio = node("audio", { storageKey: "audio:stored", ...(grouped ? { groupId: group.id } : {}) });
        const video = node("video", { storageKey: "video:stored", ...(grouped ? { groupId: group.id } : {}) });
        const nodes = [image, audio, video, group, config];
        const connections = (grouped ? [group] : [image, audio, video]).map(source => connection(source.id, config.id));
        const context = buildNodeGenerationContext(config.id, nodes, connections, "Animate", { strictReferences: true });
        expect(context.referenceImages).toMatchObject([{ id: image.id, storageKey: "image:stored", dataUrl: "" }]);
        expect(context.referenceAudios).toMatchObject([{ id: audio.id, storageKey: "audio:stored", url: "" }]);
        expect(context.referenceVideos).toMatchObject([{ id: video.id, storageKey: "video:stored", url: "" }]);
        // Non-AutoDL traversal keeps its original eligibility and read rules.
        expect(buildNodeGenerationInputs(config.id, nodes, connections)).toEqual([]);
    });

    test.each([false, true])("retains all storage-only images from a multi-image node in composer order (group=%s)", grouped => {
        const group = node("group", {});
        const images = node("image", { ...(grouped ? { groupId: group.id } : {}), images: [
            { id: "one", status: "success", storageKey: "image:one" },
            { id: "two", status: "success", storageKey: "image:two" },
        ] });
        const source = grouped ? group : images;
        const prompt = `Use @[node:${source.id}]`;
        const config = node("config", { composerContent: prompt });
        const context = buildNodeGenerationContext(config.id, [images, group, config], [connection(source.id, config.id)], prompt, { strictReferences: true });
        expect(context.referenceImages.map(image => [image.id, image.storageKey])).toEqual([["image-1:one", "image:one"], ["image-1:two", "image:two"]]);
        expect(context.prompt).not.toContain("@[node:");
    });

    test.each(["image", "audio", "video"])("rejects connected unready %s instead of silently generating without it", kind => {
        const resource = node(kind, {});
        const config = node("config", { generationMode: "video" });
        expect(() => buildNodeGenerationContext(config.id, [resource, config], [connection(resource.id, config.id)], "Animate", { strictReferences: true })).toThrow();
        expect(buildNodeGenerationContext(config.id, [resource, config], [connection(resource.id, config.id)], "Animate").referenceImages).toEqual([]);
    });

    test("keeps unready group children visible to strict compilation so optional-media workflows cannot lose them", () => {
        const group = node("group", {});
        const unready = node("audio", { groupId: group.id });
        const stored = node("image", { storageKey: "image:stored", groupId: group.id });
        const config = node("config", { generationMode: "video" });
        expect(() => buildNodeGenerationContext(config.id, [unready, stored, group, config], [connection(group.id, config.id)], "Animate", { strictReferences: true })).toThrow();
    });

    test("rejects an unavailable image inside a multi-image node instead of assigning it a submitted label", () => {
        const images = node("image", { images: [{ id: "ready", storageKey: "image:ready" }, { id: "pending", status: "loading" }] });
        const config = node("config", { generationMode: "video" });
        expect(() => buildNodeGenerationContext(config.id, [images, config], [connection(images.id, config.id)], "Animate", { strictReferences: true })).toThrow();
    });

    test("strict generation reached through a connected config also retains stored references", () => {
        const output = node("video", {});
        const image = node("image", { storageKey: "image:stored" });
        const config = node("config", { generationMode: "video" });
        const context = buildNodeGenerationContext(output.id, [output, image, config], [connection(output.id, config.id), connection(image.id, config.id)], "Animate", { strictReferences: true });
        expect(context.referenceImages[0]).toMatchObject({ id: image.id, storageKey: "image:stored" });
        expect(context.referenceVideos).toEqual([]);
    });
});


describe("已生成视频节点重新生成的参考来源（inputsSourceNodeId）", () => {
    test("以 Config 祖先为参考收集起点时，取回 config 的全部输入且 prompt 仍来自原节点", () => {
        const imageA = { ...node("image", { content: "https://example.com/a.png" }), id: "a" };
        const imageB = { ...node("image", { content: "https://example.com/b.png" }), id: "b" };
        const config = { ...node("config", { generationMode: "video" }), id: "cfg" };
        const video = { ...node("video", { content: "https://example.com/old.mp4" }), id: "v1" };
        const nodes = [imageA, imageB, config, video];
        const connections = [connection(imageA.id, config.id), connection(imageB.id, config.id), connection(config.id, video.id)];
        // 一跳上游只有 config（非资源节点）：默认收集结果为空——正是参考静默丢失的现状。
        expect(buildNodeGenerationContext(video.id, nodes, connections, "新 prompt").referenceImages).toEqual([]);
        // 追溯到 config 祖先后参考恢复，且不得触发 config 的 composer 分支。
        const context = buildNodeGenerationContext(video.id, nodes, connections, "新 prompt", { inputsSourceNodeId: config.id, strictReferences: true });
        expect(context.referenceImages.map(image => image.id)).toEqual(["a", "b"]);
        expect(context.prompt).toBe("新 prompt");
        expect(context.imageCount).toBe(2);
    });

    test("config 自身作为 inputsSourceNodeId 时保持原语义（不改变 config 面板生成）", () => {
        const image = node("image", { content: "https://example.com/a.png" });
        const config = node("config", { generationMode: "video" });
        const context = buildNodeGenerationContext(config.id, [image, config], [connection(image.id, config.id)], "Animate", { inputsSourceNodeId: config.id });
        expect(context.referenceImages.map(imageNode => imageNode.id)).toEqual(["image-1"]);
    });
});

describe("exact fal and AutoDL image identities", () => {    test("source multi-image nodes expose ordered item identities instead of the primary fallback", () => {
        const source = node("image", { content: "blob:primary-stale", storageKey: "image:primary", images: [
            { id: "b", content: "", storageKey: "image:b", mimeType: "image/webp" },
            { id: "a", content: "", storageKey: "image:a", mimeType: "image/png" },
        ] });
        expect(buildSourceImageReferences(source).map(ref => [ref.id, ref.storageKey, ref.dataUrl])).toEqual([["image-1:b", "image:b", ""], ["image-1:a", "image:a", ""]]);
    });
    test("does not collapse distinct storage items with the same external id or name", () => {
        const refs = ["image:b", "image:a"].map(storageKey => ({ id: "same", name: "same", type: "image/png", dataUrl: "", storageKey }));
        const context = buildStrictGenerationContext([{ nodeId: "n", title: "Images", type: "image", images: refs }], "@[node:n] @[node:n]", true);
        expect(context.referenceImages.map(ref => ref.storageKey)).toEqual(["image:b", "image:a"]);
    });
});

describe("countNodeReferenceImages", () => {
    test("3D 节点返回四视角张数，普通图片节点返回 1，冷 3D 节点不虚报", () => {
        registerNodeDefinitions(
            [{ type: "3d", title: "3D", defaultSize: { width: 640, height: 480 }, defaultMetadata: {}, referenceKind: "image", resource: () => null } as unknown as CanvasNodeDefinition],
            TEST_PLUGIN,
        );
        const modelNode = node("3d", {});
        setLiveModel3dViews(modelNode.id, [
            { id: "primary", dataUrl: "data:image/png;base64,P" },
            { id: "left", dataUrl: "data:image/png;base64,L" },
            { id: "right", dataUrl: "data:image/png;base64,R" },
            { id: "top", dataUrl: "data:image/png;base64,T" },
        ]);
        expect(countNodeReferenceImages(modelNode)).toBe(4);
        clearModel3dSnapshots();
        expect(countNodeReferenceImages(modelNode)).toBe(0);
        const imageNode = node("image", { content: "data:image/png;base64,X" });
        expect(countNodeReferenceImages(imageNode)).toBe(1);
    });
});

describe("asset mention references", () => {
    const resolveAsset: AssetMentionResolver = (id) =>
        id === "a1" ? { kind: "image", title: "唐剑", dataUrl: "data:image/png;base64,ASSET" } :
        id === "v1" ? { kind: "video", title: "航拍", url: "https://example.com/v.mp4" } :
        undefined;

    test("plain path: connection refs first, asset tokens appended in word order with continuing labels", () => {
        const sourceImage = node("image", { content: "data:image/png;base64,REF" });
        const target = node("image", { content: "data:image/png;base64,TARGET" });
        const context = buildNodeGenerationContext(target.id, [sourceImage, target], [connection(sourceImage.id, target.id)], "用 @[asset:a1] 和 @[asset:v1]", { resolveAsset });
        expect(context.referenceImages.map((image) => image.id)).toEqual([sourceImage.id, "asset:a1"]);
        expect(context.referenceVideos.map((video) => video.id)).toEqual(["asset:v1"]);
        expect(context.prompt).toBe(`用 ${imageReferenceLabel(1)} 和 ${i18n.t("canvas.configNode.videoReferences")} 1`);
    });

    test("plain path dedupes repeated asset tokens to one reference", () => {
        const imageNode = node("image", { content: "data:image/png;base64,REF" });
        const context = buildNodeGenerationContext(imageNode.id, [imageNode], [], "@[asset:a1] again @[asset:a1]", { resolveAsset });
        expect(context.referenceImages).toHaveLength(1);
        expect(context.prompt).toBe(`${imageReferenceLabel(0)} again ${imageReferenceLabel(0)}`);
    });

    test("asset tokens alone do not trigger the composer branch (script-shot connection refs survive)", () => {
        const firstFrame = node("image", { content: "data:image/png;base64,FRAME" });
        const videoNode = node("video", { prompt: "镜头" });
        const context = buildNodeGenerationContext(videoNode.id, [firstFrame, videoNode], [connection(firstFrame.id, videoNode.id)], "镜头 @[asset:a1]", { strictReferences: true, resolveAsset });
        expect(context.referenceImages.map((image) => image.id)).toEqual([firstFrame.id, "asset:a1"]);
        expect(context.prompt).toBe(`镜头 ${imageReferenceLabel(1)}`);
    });

    test("missing asset aborts with the asset id in the error", () => {
        const imageNode = node("image", { content: "data:image/png;base64,REF" });
        expect(() => buildNodeGenerationContext(imageNode.id, [imageNode], [], "@[asset:gone]", { resolveAsset })).toThrowError(/gone/);
    });

    test("config composer interleaves node and asset tokens in prompt word order", () => {
        const configNode = node("config", { generationMode: "image", composerContent: "x" });
        const imgNode = node("image", { content: "data:image/png;base64,NODE" });
        const context = buildNodeGenerationContext(configNode.id, [configNode, imgNode], [connection(imgNode.id, configNode.id)], `@[asset:a1] 加 @[node:${imgNode.id}]`, { resolveAsset });
        expect(context.referenceImages.map((image) => image.id)).toEqual(["asset:a1", imgNode.id]);
        expect(context.prompt).toBe(`${imageReferenceLabel(0)} 加 ${imageReferenceLabel(1)}`);
    });

    test("strict composer path resolves asset tokens mixed with node tokens", () => {
        const input: NodeGenerationInput = { nodeId: "img-1", type: "image", title: "角色图", image: { id: "img-1", name: "a.png", type: "image/png", dataUrl: "data:image/png;base64,A" } };
        const context = buildStrictGenerationContext([input], "@[asset:a1] 然后 @[node:img-1]", true, [], resolveAsset);
        expect(context.referenceImages.map((image) => image.id)).toEqual(["asset:a1", "img-1"]);
        expect(context.prompt).toBe(`${imageReferenceLabel(0)} 然后 ${imageReferenceLabel(1)}`);
    });

    test("strict non-composer appends asset tokens after all input refs", () => {
        const input: NodeGenerationInput = { nodeId: "img-1", type: "image", title: "角色图", image: { id: "img-1", name: "a.png", type: "image/png", dataUrl: "data:image/png;base64,A" } };
        const context = buildStrictGenerationContext([input], "角色在前 @[asset:a1]", false, [], resolveAsset);
        expect(context.referenceImages.map((image) => image.id)).toEqual(["img-1", "asset:a1"]);
        expect(context.prompt).toBe(`角色在前 ${imageReferenceLabel(1)}`);
    });
});

describe("reference assetRef 透传", () => {
    const assetRefNode = (id: string): CanvasNodeData => ({
        id, type: CanvasNodeType.Image, title: "场景图", position: { x: 0, y: 0 }, width: 100, height: 100,
        metadata: { content: "blob:file:///dead", assetRef: { backend: "project-file", projectId: "p1", assetId: "a1", revision: 1, relativePath: "x.png" } },
    });
    const videoNode: CanvasNodeData = { id: "v", type: CanvasNodeType.Video, title: "v", position: { x: 0, y: 0 }, width: 10, height: 10, metadata: {} };
    test("readNodeGenerationResource 透传 assetRef（dataUrl 是死 blob 也要带身份）", () => {
        const [input] = buildNodeGenerationInputs("v", [assetRefNode("img"), videoNode], [{ id: "c", fromNodeId: "img", toNodeId: "v" }], { strictReferences: true });
        expect(input.type === "image" && input.image?.assetRef?.backend === "project-file" && input.image.assetRef.assetId).toBe("a1");
    });
    test("strict 上下文接受 assetRef-only 引用（不抛 missingReference）", () => {
        const context = buildNodeGenerationContext("v", [assetRefNode("img"), videoNode], [{ id: "c", fromNodeId: "img", toNodeId: "v" }], "prompt", { strictReferences: true });
        const ref = context.referenceImages[0]?.assetRef;
        expect(ref?.backend === "project-file" && ref.assetId).toBe("a1");
        expect(context.imageCount).toBe(1);
    });
});
