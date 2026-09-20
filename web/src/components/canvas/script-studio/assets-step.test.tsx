import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import type { ComponentProps } from "react";

import i18n from "@/i18n";
import { resolveImageUrl } from "@/services/image-storage";
import { resolveCanvasAssetUrl } from "@/services/project-asset-storage";
import { useScriptEntityStore, type ScriptEntity, type ScriptEntityRefSlot } from "@/stores/use-script-entity-store";
import { useAssetStore } from "@/stores/use-asset-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { ScriptNodeData } from "@/types/script-node";
import { AssetsStep } from "./assets-step";

vi.mock("@/services/image-storage", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/services/image-storage")>()),
    resolveImageUrl: vi.fn(async (_storageKey?: string, fallback = "") => fallback),
}));
// useProjectAssetUrl 依赖的门面入口：桌面 assetRef 解析走 resolveCanvasAssetUrl。
vi.mock("@/services/project-asset-storage", () => ({
    resolveCanvasAssetUrl: vi.fn(async (_ref?: unknown, fallback = "") => fallback || "blob:project"),
    onCanvasAssetChanged: vi.fn(() => () => undefined),
    isCanvasAssetMissing: vi.fn(() => false),
}));

const resolveImageUrlMock = vi.mocked(resolveImageUrl);

const script: ScriptNodeData = { schemaVersion: 1, instruction: "", globalStyle: "", entityIds: ["e1"], output: { status: "idle", shots: [] } };

const entity = (refs: ScriptEntityRefSlot[]): ScriptEntity => ({
    id: "e1", projectId: "p1", group: "item", name: "发光辣椒", refs, createdAt: "", updatedAt: "",
});

const imageNode = (id: string, content: string): CanvasNodeData =>
    ({ id, type: "image", title: "", position: { x: 0, y: 0 }, width: 10, height: 10, metadata: { content } });

function renderStep(refs: ScriptEntityRefSlot[], canvasNodes: CanvasNodeData[] = [], entities: ScriptEntity[] = [entity(refs)], onPickLibrary: ComponentProps<typeof AssetsStep>["onPickLibrary"] = vi.fn()) {
    render(
        <I18nextProvider i18n={i18n}>
            <AssetsStep
                script={script}
                projectId="p1"
                entities={entities}
                canvasImageNodes={canvasNodes}
                onUpdateScript={vi.fn()}
                onGenerateRef={vi.fn()}
                onPickLibrary={onPickLibrary}
                onToast={vi.fn()}
            />
        </I18nextProvider>,
    );
}

/** 单大图卡预览盒（方案 A：首张就绪图 object-cover 填满） */
const previewBox = () => document.querySelector('[data-testid="entity-preview"]') as HTMLElement;
const dotsRow = () => document.querySelector('[data-testid="entity-dots"]') as HTMLElement;

beforeEach(() => {
    resolveImageUrlMock.mockClear();
    resolveImageUrlMock.mockImplementation(async (_storageKey?: string, fallback = "") => fallback);
});

describe("AssetsStep 资产卡单大图预览", () => {
    it("ready + nodeId → 预览盒渲染画布节点 dataURL 的 <img>，object-cover 填满，不走 storageKey 解析", () => {
        renderStep([{ id: "ref1", label: "物品图", state: "ready", source: "canvas", nodeId: "img-1" }], [imageNode("img-1", "data:image/png;base64,AAA")]);
        const img = previewBox().querySelector("img") as HTMLImageElement;
        expect(img).not.toBeNull();
        expect(img.getAttribute("src")).toBe("data:image/png;base64,AAA");
        expect(img.className).toContain("object-cover");
        expect(resolveImageUrlMock).not.toHaveBeenCalled();
    });

    it("ready + storageKey → 异步 resolveImageUrl 的 objectURL 作为 src", async () => {
        resolveImageUrlMock.mockResolvedValue("blob:mock");
        renderStep([{ id: "ref1", label: "物品图", state: "ready", source: "library", storageKey: "image:abc" }]);
        await waitFor(() => expect(previewBox().querySelector("img")?.getAttribute("src")).toBe("blob:mock"));
        expect(resolveImageUrlMock).toHaveBeenCalledWith("image:abc");
    });

    it("ready 但 nodeId 无对应节点且无 storageKey → 回退 ImageIcon，不渲染 img", () => {
        renderStep([{ id: "ref1", label: "物品图", state: "ready", source: "canvas", nodeId: "missing" }]);
        expect(previewBox().querySelector("img")).toBeNull();
        expect(previewBox().querySelector("svg.lucide-image")).not.toBeNull();
        expect(resolveImageUrlMock).not.toHaveBeenCalled();
    });

    it("ready 只有项目资产 assetRef（无 nodeId/storageKey）→ useProjectAssetUrl 解析 img，不走旧解析器", async () => {
        renderStep([{ id: "ref1", label: "物品图", state: "ready", source: "library", assetRef: { backend: "project-file", assetId: "a1", projectId: "p1", relativePath: "assets/imported/a.png", revision: 1 } }]);
        await waitFor(() => expect(previewBox().querySelector("img")?.getAttribute("src")).toBe("blob:project"));
        expect(resolveImageUrlMock).not.toHaveBeenCalled();
    });

    it("无 ready 有 queued → 预览显示「生成中…」，不渲染 img", () => {
        renderStep([
            { id: "ref1", label: "物品图", state: "empty" },
            { id: "ref2", label: "细节图", state: "queued", source: "generated" },
        ]);
        expect(screen.getByText(i18n.t("canvas.scriptAssets.previewGenerating"))).not.toBeNull();
        expect(document.querySelector("img")).toBeNull();
    });

    it("全部未设置 → 预览显示虚线空态，不渲染 img", () => {
        renderStep([{ id: "ref1", label: "物品图", state: "empty" }]);
        expect(screen.getByText(i18n.t("canvas.scriptAssets.previewEmpty"))).not.toBeNull();
        expect(document.querySelector("img")).toBeNull();
    });

    it("就绪徽标 + 状态点：n/N 按全量槽计数，点逐枚带槽位 title 且颜色按 ready/queued/empty 区分", () => {
        renderStep([
            { id: "r1", label: "物品图", state: "ready", source: "canvas", nodeId: "img-1" },
            { id: "r2", label: "细节图", state: "queued" },
            { id: "r3", label: "备选图", state: "empty" },
        ], [imageNode("img-1", "data:image/png;base64,AAA")]);
        expect(screen.getByText("1/3 就绪")).not.toBeNull();
        const dots = dotsRow().querySelectorAll("span[title]");
        expect(dots).toHaveLength(3);
        expect(dots[0]!.getAttribute("title")).toBe("物品图");
        expect(dots[0]!.className).toContain("bg-success");
        expect(dots[1]!.className).toContain("bg-warning");
        expect(dots[2]!.className).toContain("border");
    });
});

describe("AssetsStep 资产卡 min-w-0 钉", () => {
    it("超长描述不撑破布局：section/卡片根/名字行/描述 div 逐级带 min-w-0（防回退到 min-width:auto）", () => {
        const longAppearance = "裙摆为流动的星云，行进时拖出数米长的光尾，星屑随步伐散落。".repeat(10);
        renderStep([{ id: "ref1", label: "物品图", state: "empty" }], [], [{ ...entity([]), appearance: longAppearance }]);

        const nameSpan = screen.getByText("发光辣椒");
        expect(nameSpan.className).toContain("truncate");
        const nameRow = nameSpan.parentElement as HTMLElement;
        const cardRoot = nameRow.parentElement as HTMLElement;
        const descDiv = screen.getByText(longAppearance) as HTMLElement;
        const section = cardRoot.closest("section") as HTMLElement;

        expect(cardRoot.className).toContain("flex-col"); // 定位正确：纵向单大图卡根（高度内容驱动，无 basis 定宽）
        expect(cardRoot.className).toContain("min-w-0");
        expect(nameRow.className).toContain("min-w-0");
        expect(descDiv.className).toContain("min-w-0");
        expect(section.className).toContain("min-w-0");
    });
});

describe("AssetsStep 库图挑选透传", () => {
    it("库图挑选透传 onPickLibrary（含 assetRef）", () => {
        const assetRef = { backend: "project-file", assetId: "a1", projectId: "p1", relativePath: "assets/imported/a.png", revision: 1 } as const;
        const refs: ScriptEntityRefSlot[] = [{ id: "ref1", label: "物品图", state: "empty" }];
        // 抽屉内槽行与库列表分别读 script-entity / asset 两个 store
        useScriptEntityStore.setState({ entities: [entity(refs)] });
        useAssetStore.setState({
            assets: [{ id: "a1", kind: "image", title: "库图A", coverUrl: "", tags: [], createdAt: "", updatedAt: "", data: { dataUrl: "", width: 10, height: 10, bytes: 0, mimeType: "image/png", assetRef } }],
        });
        const onPickLibrary = vi.fn();
        renderStep(refs, [], [entity(refs)], onPickLibrary);
        // 点实体卡打开抽屉 → 加号菜单「从资产库选择」→ 库行点「选择」
        fireEvent.click(screen.getByText("发光辣椒"));
        fireEvent.pointerDown(screen.getByLabelText("生成或选择图片"), { button: 0 });
        fireEvent.click(screen.getByText("从资产库选择"));
        fireEvent.click(screen.getByText("选择"));
        expect(onPickLibrary).toHaveBeenCalledTimes(1);
        const call = onPickLibrary.mock.calls[0];
        expect(call[1]).toBe("e1");
        expect(call[2]).toBe("ref1");
        expect(call[3]).toBe("a1");
        expect(call[4]).toBeUndefined();
        expect(call[5]).toEqual(assetRef);
    });
});
