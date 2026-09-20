import { beforeEach, describe, expect, it, test, vi } from "vitest";

const resolveMediaUrl = vi.hoisted(() => vi.fn());
const resolveImageUrl = vi.hoisted(() => vi.fn());
const uploadImage = vi.hoisted(() => vi.fn());
const getCanvasAssetBlob = vi.hoisted(() => vi.fn());
const resolveCanvasAssetUrl = vi.hoisted(() => vi.fn(async () => "resolved:pfile"));

vi.mock("@/services/file-storage", () => ({ resolveMediaUrl }));
vi.mock("@/services/image-storage", () => ({ resolveImageUrl, uploadImage }));
vi.mock("@/services/project-asset-storage", () => ({ getCanvasAssetBlob, resolveCanvasAssetUrl }));

import { buildGenerationConfig, buildInputEvidence, buildVideoChildConnections, findRetrySourceNode, generationReferenceUrls, hydrateCanvasImages, imageModeSourceNodeTransform, resetInterruptedGeneration, resolveMetadataReferences, shouldMarkSourceStatus } from "@/lib/canvas/canvas-generation-helpers";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

const node = (type: string, metadata: Record<string, unknown> = {}): CanvasNodeData =>
    ({ id: `${type}-1`, type, title: `Node ${type}`, position: { x: 10, y: 20 }, width: 340, height: 240, metadata }) as CanvasNodeData;

const connection = (fromNodeId: string, toNodeId: string): CanvasConnection => ({ id: `c-${fromNodeId}-${toNodeId}`, fromNodeId, toNodeId });

beforeEach(() => {
    vi.clearAllMocks();
});

const rootNode = node("image", { prompt: "p", status: "loading" });

describe("findRetrySourceNode 视频重新生成的参考来源追溯", () => {
    it("沿生成链向上找到 Config 祖先（多代生成节点共享同一参考来源）", () => {
        const config = { ...node("config", {}), id: "cfg" };
        const v1 = { ...node("video", { content: "blob:1" }), id: "v1" };
        const v2 = { ...node("video", { content: "blob:2" }), id: "v2" };
        const nodes = [config, v1, v2];
        const connections = [connection("cfg", "v1"), connection("v1", "v2")];
        expect(findRetrySourceNode("v2", nodes, connections)?.id).toBe("cfg");
        expect(findRetrySourceNode("v1", nodes, connections)?.id).toBe("cfg");
    });

    it("上游没有 Config 时返回 null（调用方回退到节点自身的一跳上游）", () => {
        const image = { ...node("image", { content: "data:image/png;base64,X" }), id: "img" };
        const video = { ...node("video", { content: "blob:1" }), id: "v1" };
        expect(findRetrySourceNode("v1", [image, video], [connection("img", "v1")])).toBeNull();
    });

    it("config 自身发起生成时不回溯到更上游的 config（调用方以 sourceNode 类型防护）", () => {
        const outer = { ...node("config", {}), id: "outer" };
        const inner = { ...node("config", {}), id: "inner" };
        expect(findRetrySourceNode("inner", [outer, inner], [connection("outer", "inner")])?.id).toBe("outer");
    });
});

describe("buildVideoChildConnections 视频再生成子节点连线（血统边 + 参考继承）", () => {
    it("直接参考流：血统边标 lineage，并把源节点的参考入边继承给子节点", () => {
        const img = { ...node("image", { content: "data:image/png;base64,X" }), id: "img" };
        const source = { ...node("video", { content: "blob:a" }), id: "v1" };
        const child = { ...node("video", {}), id: "v2" };
        const connections = buildVideoChildConnections("v1", "v2", [img, source, child], [connection("img", "v1")]);
        expect(connections).toHaveLength(2);
        expect(connections[0]).toMatchObject({ fromNodeId: "v1", toNodeId: "v2", lineage: true });
        expect(connections[1]).toMatchObject({ fromNodeId: "img", toNodeId: "v2" });
        expect(connections[1].lineage).toBeUndefined();
    });

    it("config 祖先持有参考：只建血统边不复制，避免制造断开无效的假引用芯片", () => {
        const config = { ...node("config", {}), id: "cfg" };
        const img = { ...node("image", { content: "data:image/png;base64,X" }), id: "img" };
        const source = { ...node("video", { content: "blob:a" }), id: "v1" };
        const child = { ...node("video", {}), id: "v2" };
        const connections = buildVideoChildConnections("v1", "v2", [config, img, source, child], [connection("img", "cfg"), connection("cfg", "v1")]);
        expect(connections).toHaveLength(1);
        expect(connections[0]).toMatchObject({ fromNodeId: "v1", toNodeId: "v2", lineage: true });
    });

    it("非视频源（config 触发的视频生成）不继承参考", () => {
        const config = { ...node("config", {}), id: "cfg" };
        const img = { ...node("image", { content: "data:image/png;base64,X" }), id: "img" };
        const child = { ...node("video", {}), id: "v2" };
        const connections = buildVideoChildConnections("cfg", "v2", [config, img, child], [connection("img", "cfg")]);
        expect(connections).toHaveLength(1);
        expect(connections[0]).toMatchObject({ fromNodeId: "cfg", toNodeId: "v2", lineage: true });
    });

    it("多代链：血统边不作为参考被再次继承（继承 IMG，不继承父视频）", () => {
        const img = { ...node("image", { content: "data:image/png;base64,X" }), id: "img" };
        const v1 = { ...node("video", { content: "blob:1" }), id: "v1" };
        const v2 = { ...node("video", { content: "blob:2" }), id: "v2" };
        const v3 = { ...node("video", {}), id: "v3" };
        const previous = [connection("img", "v1"), ...buildVideoChildConnections("v1", "v2", [img, v1, v2], [connection("img", "v1")])];
        const next = buildVideoChildConnections("v2", "v3", [img, v1, v2, v3], previous);
        const fromNodes = next.filter((item) => item.toNodeId === "v3").map((item) => item.fromNodeId).sort();
        expect(fromNodes).toEqual(["img", "v2"]);
    });

    it("脚本从属边（v0.5 非参考）不被继承", async () => {
        const { registerBuiltinNodes } = await import("@/components/canvas/nodes/builtin-nodes");
        registerBuiltinNodes();
        const script = { id: "s1", type: "script", title: "脚本", position: { x: 0, y: 0 }, width: 250, height: 170, metadata: {} } as CanvasNodeData;
        const source = { ...node("video", { content: "blob:a" }), id: "v1" };
        const child = { ...node("video", {}), id: "v2" };
        const connections = buildVideoChildConnections("v1", "v2", [script, source, child], [connection("s1", "v1")]);
        expect(connections).toHaveLength(1);
    });
});

describe("imageModeSourceNodeTransform", () => {
    test("3d/plugin source node is preserved verbatim (no type conversion, no prompt overwrite)", () => {
        const source = node("3d", { content: "blob:glb", model3d: { storageKey: "file:glb-1", content: "blob:glb" } });
        const transformed = imageModeSourceNodeTransform(source, { isConfigNode: false, isEmptyImageNode: false, isImageNode: false, rootNode, prompt: "用户输入的 prompt", parentConfig: { width: 340, height: 240 } });
        expect(transformed).toEqual(source);
        expect(transformed.type).toBe("3d");
        expect(transformed.metadata?.content).toBe("blob:glb");
    });

    test("config source node keeps the loading status (existing behavior)", () => {
        const source = node("config", { generationMode: "image", errorDetails: "boom" });
        const transformed = imageModeSourceNodeTransform(source, { isConfigNode: true, isEmptyImageNode: false, isImageNode: false, rootNode, prompt: "p", parentConfig: { width: 340, height: 240 } });
        expect(transformed).toEqual({ ...source, metadata: { ...source.metadata, status: "loading", errorDetails: undefined } });
    });

    test("image source node with content resolves to success (existing behavior)", () => {
        const source = node("image", { content: "data:image/png;base64,X", errorDetails: "boom" });
        const transformed = imageModeSourceNodeTransform(source, { isConfigNode: false, isEmptyImageNode: false, isImageNode: true, rootNode, prompt: "p", parentConfig: { width: 340, height: 240 } });
        expect(transformed).toEqual({ ...source, metadata: { ...source.metadata, status: "success", errorDetails: undefined } });
    });

    test("empty image source node adopts the generated root geometry (existing behavior)", () => {
        const source = node("image", {});
        const root = { ...rootNode, position: { x: 5, y: 6 }, width: 512, height: 512, title: "Generated" } as CanvasNodeData;
        const transformed = imageModeSourceNodeTransform(source, { isConfigNode: false, isEmptyImageNode: true, isImageNode: true, rootNode: root, prompt: "p", parentConfig: { width: 340, height: 240 } });
        expect(transformed.position).toEqual({ x: 5, y: 6 });
        expect(transformed.width).toBe(512);
        expect(transformed.title).toBe("Generated");
        expect(transformed.metadata?.status).toBe("loading");
    });

    test("text source node still converts to the prompt text node (existing behavior preserved)", () => {
        const source = node("text", { content: "old" });
        const transformed = imageModeSourceNodeTransform(source, { isConfigNode: false, isEmptyImageNode: false, isImageNode: false, rootNode, prompt: "用户输入的 prompt", parentConfig: { width: 340, height: 240 } });
        expect(transformed.type).toBe(CanvasNodeType.Text);
        expect(transformed.metadata?.content).toBe("用户输入的 prompt");
        expect(transformed.metadata?.prompt).toBe("用户输入的 prompt");
    });
});

describe("shouldMarkSourceStatus", () => {
    test("plugin nodes are skipped (LoadingContent would replace their preview)", () => {
        expect(shouldMarkSourceStatus(node("3d", { content: "blob:glb" }))).toBe(false);
        expect(shouldMarkSourceStatus(node("some-plugin:widget", {}))).toBe(false);
    });

    test("built-in nodes keep the loading marker", () => {
        expect(shouldMarkSourceStatus(node("text", {}))).toBe(true);
        expect(shouldMarkSourceStatus(node("config", {}))).toBe(true);
        expect(shouldMarkSourceStatus(node("image", {}))).toBe(true);
    });
});

describe("resetInterruptedGeneration", () => {
    test("preserves recoverable remote loading nodes", () => {
        const source = node("image", { status: "loading", remoteTask: { id: "t1", status: "pending", submittedAt: 1 } });
        expect(resetInterruptedGeneration([source])[0].metadata?.status).toBe("loading");
    });

    test("still fails ordinary interrupted in-memory generation", () => {
        const source = node("image", { status: "loading" });
        expect(resetInterruptedGeneration([source])[0].metadata?.status).toBe("error");
    });

    test("preserves a reloaded batch when one item failed and another remote item is recoverable", () => {
        const source = node("image", {
            status: "loading",
            images: [
                { id: "i1", status: "error", content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "", remoteTask: { id: "t1", status: "failed", submittedAt: 1 } },
                { id: "i2", status: "loading", content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "", remoteTask: { id: "t2", status: "pending", submittedAt: 1 } },
            ],
        });
        const [next] = resetInterruptedGeneration([source]);
        expect(next.metadata?.status).toBe("loading");
        expect(next.metadata?.images?.map((image) => image.status)).toEqual(["error", "loading"]);
    });

    test("preserves a reloaded config source linked to a failed and pending image batch", () => {
        const config = node("config", { status: "loading" });
        config.id = "config-1";
        const batch = node("image", {
            status: "loading",
            images: [
                { id: "i1", status: "error", content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "", remoteTask: { id: "t1", status: "failed", submittedAt: 1, sourceNodeId: "config-1" } },
                { id: "i2", status: "loading", content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "", remoteTask: { id: "t2", status: "pending", submittedAt: 1, sourceNodeId: "config-1" } },
            ],
        });
        const next = resetInterruptedGeneration([config, batch]);
        expect(next[0].metadata?.status).toBe("loading");
        expect(next[1].metadata?.status).toBe("loading");
    });
});

describe("hydrateCanvasImages 3d branch", () => {
    test("re-resolves the 3d content from model3d.storageKey (blob URLs die on reload)", async () => {
        resolveMediaUrl.mockResolvedValue("blob:fresh");
        const [hydrated] = await hydrateCanvasImages([node("3d", { content: "blob:dead", model3d: { storageKey: "file:glb-1", content: "blob:dead" } })]);
        expect(resolveMediaUrl).toHaveBeenCalledWith("file:glb-1", "blob:dead");
        expect(hydrated.metadata?.content).toBe("blob:fresh");
        expect(hydrated.metadata?.model3d?.content).toBe("blob:fresh");
    });

    test("3d node without a storageKey passes through unchanged", async () => {
        const source = node("3d", { content: "blob:dead", model3d: { content: "blob:dead" } });
        const [hydrated] = await hydrateCanvasImages([source]);
        expect(hydrated).toEqual(source);
        expect(resolveMediaUrl).not.toHaveBeenCalled();
    });
});

describe("imageModeSourceNodeTransform 保留 scriptEntityRef", () => {
    const rootNode = { id: "root", type: "image", position: { x: 0, y: 0 }, width: 100, height: 100, title: "模板", metadata: { prompt: "p", status: "loading" as const } };
    it("isEmptyImageNode 展开模板后不清除 scriptEntityRef（槽位回写依赖）", () => {
        const node = { id: "n1", type: "image", title: "t", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { scriptEntityRef: { entityId: "e1", refId: "r1", slot: "sheet" } } };
        const out = imageModeSourceNodeTransform(node, { isConfigNode: false, isEmptyImageNode: true, isImageNode: true, rootNode, prompt: "p", parentConfig: { width: 1, height: 1 } });
        expect(out.metadata?.scriptEntityRef).toEqual({ entityId: "e1", refId: "r1", slot: "sheet" });
    });
    it("无 ref 时行为不变", () => {
        const node = { id: "n2", type: "image", title: "t", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { prompt: "x" } };
        const out = imageModeSourceNodeTransform(node, { isConfigNode: false, isEmptyImageNode: true, isImageNode: true, rootNode, prompt: "p", parentConfig: { width: 1, height: 1 } });
        expect(out.metadata?.scriptEntityRef).toBeUndefined();
    });
});

describe("buildGenerationConfig textCount 回退（C1：生成链与 buildNodeConfig 对齐）", () => {
    it("节点 textCount 优先", () => {
        const config = buildGenerationConfig({ channels: [] } as never, node("text", { textCount: 5 }), "text");
        expect(config.textCount).toBe("5");
    });
    it("无覆盖时回退 canvasTextCount（值为 String）", () => {
        const config = buildGenerationConfig({ channels: [], canvasTextCount: "4" } as never, node("text", {}), "text");
        expect(config.textCount).toBe("4");
    });
    it("canvasTextCount 越界时夹取到 1..15", () => {
        const high = buildGenerationConfig({ channels: [], canvasTextCount: "20" } as never, node("text", {}), "text");
        const low = buildGenerationConfig({ channels: [], canvasTextCount: "0" } as never, node("text", {}), "text");
        expect(high.textCount).toBe("15");
        expect(low.textCount).toBe("1");
    });
    it("都没有时落默认 1", () => {
        const config = buildGenerationConfig(defaultConfig, node("text", {}), "text");
        expect(config.textCount).toBe("1");
    });
});

describe("v0.5：脚本节点不作为生成参考 / hidePanel", () => {
    it("script 节点经连线不被计入生成参考（inputs 为空）", async () => {
        const { buildNodeGenerationInputs } = await import("@/components/canvas/canvas-node-generation");
        const { registerBuiltinNodes } = await import("@/components/canvas/nodes/builtin-nodes");
        registerBuiltinNodes();
        const scriptNode = { id: "s1", type: "script", title: "脚本", position: { x: 0, y: 0 }, width: 250, height: 170, metadata: { prompt: "残留 prompt" } };
        const imageNode = { id: "img1", type: "image", title: "生成", position: { x: 300, y: 0 }, width: 200, height: 200, metadata: {} };
        const inputs = buildNodeGenerationInputs("img1", [scriptNode, imageNode] as never, [{ id: "c1", fromNodeId: "s1", toNodeId: "img1" }] as never);
        expect(inputs.filter((input) => input.nodeId === "s1")).toEqual([]);
    });

    it("脚本节点定义 hidePanel=true（选中无底部快捷输入栏）", async () => {
        const { getNodeDefinition } = await import("@/lib/canvas/node-registry");
        const { registerBuiltinNodes } = await import("@/components/canvas/nodes/builtin-nodes");
        const { SCRIPT_NODE_TYPE } = await import("@/types/script-node");
        registerBuiltinNodes();
        expect(getNodeDefinition(SCRIPT_NODE_TYPE)?.hidePanel).toBe(true);
    });
});

describe("getInputSummary 多视角/多图输入按实际张数计数", () => {
    it("3D 节点展开的四视角计为 4 张参考图，单图节点计 1 张", async () => {
        const { getInputSummary } = await import("@/lib/canvas/canvas-generation-helpers");
        const { setLiveModel3dViews, clearModel3dSnapshots } = await import("@/lib/canvas/model-3d-snapshot");
        const { registerNodeDefinitions } = await import("@/lib/canvas/node-registry");
        const { registerBuiltinNodes } = await import("@/components/canvas/nodes/builtin-nodes");
        registerBuiltinNodes();
        registerNodeDefinitions(
            [{ type: "3d", title: "3D", defaultSize: { width: 640, height: 480 }, defaultMetadata: {}, referenceKind: "image", resource: () => null } as never],
            "test-3d-plugin",
        );
        const model3d = { ...node("3d", {}), id: "m3d" };
        setLiveModel3dViews(model3d.id, [
            { id: "primary", dataUrl: "data:image/png;base64,P" },
            { id: "left", dataUrl: "data:image/png;base64,L" },
            { id: "right", dataUrl: "data:image/png;base64,R" },
            { id: "top", dataUrl: "data:image/png;base64,T" },
        ]);
        const image = { ...node("image", { content: "data:image/png;base64,X" }), id: "img" };
        const inputs = await (async () => {
            const { buildNodeGenerationInputs } = await import("@/components/canvas/canvas-node-generation");
            return buildNodeGenerationInputs("cfg", [model3d, image, node("config", {})], [connection("m3d", "cfg"), connection("img", "cfg")]);
        })();
        expect(getInputSummary(inputs).imageCount).toBe(5);
        const { unregisterPluginNodes } = await import("@/lib/canvas/node-registry");
        unregisterPluginNodes("test-3d-plugin");
        clearModel3dSnapshots();
    });
});

describe("buildInputEvidence", () => {
    it("expands groups, dedupes by nodeId and maps mode-relevant groups", () => {
        const imageInput = { nodeId: "img-1", type: "image" as const, title: "图片", images: [{ id: "1", name: "a.png", type: "image/png", dataUrl: "data:image/png;base64,x" }] };
        const inputs = [
            { nodeId: "grp", type: "group" as const, title: "组", children: [imageInput, { nodeId: "txt-1", type: "text" as const, title: "文本", text: "口播文案" }] },
            imageInput,
        ];
        const evidence = buildInputEvidence(inputs, "image");
        expect(evidence.textPreview).toBe("口播文案");
        expect(evidence.groups).toHaveLength(1);
        expect(evidence.groups[0].kind).toBe("image");
        expect(evidence.groups[0].items.map((item) => item.nodeId)).toEqual(["img-1"]);
        expect(evidence.groups[0].items[0].previewUrl).toBe("data:image/png;base64,x");
        expect(buildInputEvidence(inputs, "text").groups).toEqual([]);
        expect(buildInputEvidence(inputs, "video").groups.map((group) => group.kind)).toEqual(["image", "video"]);
    });
});

describe("resolveMetadataReferences pfile", () => {
    it("pfile: 条目经 getCanvasAssetBlob 解析为 dataURL", async () => {
        getCanvasAssetBlob.mockResolvedValueOnce(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));
        const metadata = { generationType: "edit", references: ["pfile:p1:a1:1:x%2Fy.png"] };
        const refs = await resolveMetadataReferences(metadata as never);
        expect(refs?.[0]?.dataUrl).toContain("base64");
    });
    it("解析失败维持 null（显式报错语义不变）", async () => {
        getCanvasAssetBlob.mockResolvedValueOnce(null);
        expect(await resolveMetadataReferences({ generationType: "edit", references: ["pfile:p1:a1:1:x.png"] } as never)).toBeNull();
    });
    it("image: 既有路径回归", async () => {
        resolveImageUrl.mockResolvedValueOnce("data:image/png;base64,AA");
        expect((await resolveMetadataReferences({ generationType: "edit", references: ["image:abc"] } as never))?.[0]?.storageKey).toBe("image:abc");
    });
});

describe("generationReferenceUrls 音视频持久身份（assetRef-aware）", () => {
    const pfileRef = { backend: "project-file" as const, projectId: "p1", assetId: "a1", revision: 3, relativePath: "media/v.mp4" };
    it("storageKey 缺失 + project-file assetRef 时序列化为 pfile: token（不写死 blob 条目）", () => {
        const urls = generationReferenceUrls({
            referenceImages: [],
            referenceVideos: [{ id: "v1", name: "v.mp4", type: "video/mp4", url: "blob:dead-video", assetRef: pfileRef }],
            referenceAudios: [{ id: "a1", name: "a.mp3", type: "audio/mpeg", url: "blob:dead-audio", assetRef: pfileRef }],
        });
        expect(urls).toEqual(["pfile:p1:a1:3:media%2Fv.mp4", "pfile:p1:a1:3:media%2Fv.mp4"]);
    });
    it("storageKey 在时原值回归（不改为 token）", () => {
        const urls = generationReferenceUrls({
            referenceImages: [],
            referenceVideos: [{ id: "v1", name: "v.mp4", type: "video/mp4", url: "blob:1", storageKey: "file:v-1" }],
            referenceAudios: [{ id: "a1", name: "a.mp3", type: "audio/mpeg", url: "blob:2", storageKey: "file:a-1" }],
        });
        expect(urls).toEqual(["file:v-1", "file:a-1"]);
    });
});

describe("generationReferenceUrls 顺序", () => {
    const pfileRef = { backend: "project-file" as const, projectId: "p1", assetId: "a1", revision: 1, relativePath: "assets/generated/videos/a1.mp4" };
    it("video/audio 参考以 pfile token 先于 storageKey", () => {
        const urls = generationReferenceUrls({
            referenceImages: [],
            referenceVideos: [{ id: "v", name: "v", type: "video/mp4", url: "blob:dead", storageKey: "video:old", assetRef: pfileRef }],
        });
        expect(urls).toEqual(["pfile:p1:a1:1:assets%2Fgenerated%2Fvideos%2Fa1.mp4"]);
    });
});

describe("hydrateCanvasImages assetRef 分支", () => {
    const pfileRef = { backend: "project-file" as const, projectId: "p1", assetId: "a1", revision: 1, relativePath: "assets/generated/videos/a1.mp4" };
    it("video 节点 assetRef 优先，storageKey 缺失不再依赖 IDB", async () => {
        const node = { id: "v1", type: "video", title: "v", position: { x: 0, y: 0 }, width: 10, height: 10, metadata: { assetRef: pfileRef, content: "blob:dead" } };
        const [hydrated] = await hydrateCanvasImages([node as CanvasNodeData]);
        expect(hydrated.metadata?.content).toBe("resolved:pfile");
    });
    it("3D 节点 assetRef 优先并同步 model3d.content", async () => {
        const node = { id: "m1", type: "3d", title: "m", position: { x: 0, y: 0 }, width: 10, height: 10, metadata: { model3d: { assetRef: pfileRef, content: "blob:dead" }, content: "blob:dead" } };
        const [hydrated] = await hydrateCanvasImages([node as CanvasNodeData]);
        expect(hydrated.metadata?.content).toBe("resolved:pfile");
        expect(hydrated.metadata?.model3d?.content).toBe("resolved:pfile");
    });
    it("pfile token 经 resolveMetadataReferences 可解析为参考 dataUrl（迁移 references 改写往返，spec §3）", async () => {
        const { getCanvasAssetBlob } = await import("@/services/project-asset-storage");
        vi.mocked(getCanvasAssetBlob).mockResolvedValueOnce(new Blob(["ref"], { type: "image/png" }));
        const refs = await resolveMetadataReferences({ generationType: "edit" as const, references: ["pfile:p1:a1:1:x%2Fy.png"] } as CanvasNodeMetadata);
        expect(refs?.[0]?.dataUrl?.startsWith("data:image/png")).toBe(true);
    });
});
