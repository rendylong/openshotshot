import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";

import i18n from "@/i18n";
import { resolveImageUrl } from "@/services/image-storage";
import { useScriptEntityStore, type ScriptEntity, type ScriptEntityRefSlot } from "@/stores/use-script-entity-store";
import type { CanvasNodeData } from "@/types/canvas";
import { EntityDrawer } from "./entity-drawer";

vi.mock("@/services/image-storage", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/services/image-storage")>()),
    resolveImageUrl: vi.fn(async (_storageKey?: string, fallback = "") => fallback),
}));

const resolveImageUrlMock = vi.mocked(resolveImageUrl);

const entity = (refs: ScriptEntityRefSlot[]): ScriptEntity => ({
    id: "e1", projectId: "p1", group: "character", name: "", refs, createdAt: "", updatedAt: "",
});

const canvasNode = (id: string, title: string, content?: string) =>
    ({ id, type: "image", title, position: { x: 0, y: 0 }, width: 10, height: 10, ...(content ? { metadata: { content } } : {}) }) as unknown as CanvasNodeData;

function renderDrawer(refs: ScriptEntityRefSlot[], opts: { canvasNodes?: CanvasNodeData[]; entity?: ScriptEntity | null } = {}) {
    const ent = "entity" in opts ? opts.entity! : entity(refs);
    useScriptEntityStore.setState({ entities: ent ? [{ ...ent, refs }] : [] });
    const props = {
        onClose: vi.fn(),
        onSaveDraft: vi.fn(),
        onGenerateRef: vi.fn(),
        onPickCanvas: vi.fn(),
        onPickLibrary: vi.fn(),
        onToast: vi.fn(),
    };
    render(
        <I18nextProvider i18n={i18n}>
            <EntityDrawer entity={ent} defaultGroup="character" canvasImageNodes={opts.canvasNodes ?? []} {...props} />
        </I18nextProvider>,
    );
    return props;
}

const emptySlot: ScriptEntityRefSlot = { id: "ref1", label: "sheet", state: "empty" };
const readySlot: ScriptEntityRefSlot = { id: "ref1", label: "sheet", state: "ready", source: "canvas", nodeId: "img-1" };
const queuedSlot: ScriptEntityRefSlot = { id: "ref1", label: "sheet", state: "queued", source: "generated" };

beforeEach(() => {
    useScriptEntityStore.setState({ entities: [] });
    resolveImageUrlMock.mockClear();
    resolveImageUrlMock.mockImplementation(async (_storageKey?: string, fallback = "") => fallback);
});

describe("RefRow 来源入口（加号菜单 + 替换）", () => {
    it("空槽只渲染一个「+」触发器，三来源按钮不直接可见", () => {
        renderDrawer([emptySlot]);
        expect(screen.getByLabelText("生成或选择图片")).not.toBeNull();
        expect(screen.queryByText("替换")).toBeNull();
        expect(screen.queryByText("从画布选择")).toBeNull();
    });

    it("ready 槽渲染「替换」入口", () => {
        renderDrawer([readySlot]);
        expect(screen.getByText("替换")).not.toBeNull();
        expect(screen.queryByLabelText("生成或选择图片")).toBeNull();
    });

    it("queued 槽显示生成中「…」并提供「替换」", () => {
        renderDrawer([queuedSlot]);
        expect(screen.getByText("…")).not.toBeNull();
        expect(screen.getByText("替换")).not.toBeNull();
    });

    it("菜单三选一：从画布选择 → 行内列表 → 点选择回调 onPickCanvas", () => {
        const props = renderDrawer([emptySlot], { canvasNodes: [canvasNode("n1", "画布图A")] });
        fireEvent.pointerDown(screen.getByLabelText("生成或选择图片"), { button: 0 });
        expect(screen.getByText("从画布选择")).not.toBeNull();
        fireEvent.click(screen.getByText("从画布选择"));
        expect(screen.getByText("画布图A")).not.toBeNull();
        fireEvent.click(screen.getByText("选择"));
        expect(props.onPickCanvas).toHaveBeenCalledWith(expect.any(Object), "e1", "ref1", "n1");
    });

    it("菜单开启时 Esc 只关菜单不关抽屉；菜单关闭后 Esc 关抽屉", () => {
        const props = renderDrawer([readySlot]);
        fireEvent.pointerDown(screen.getByText("替换"), { button: 0 });
        expect(screen.getByText("从资产库选择")).not.toBeNull();
        fireEvent.keyDown(document, { key: "Escape" });
        expect(props.onClose).not.toHaveBeenCalled();
        fireEvent.keyDown(document, { key: "Escape" });
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });
});

describe("RefRow ready 槽预览", () => {
    it("ready + nodeId → 渲染画布节点 dataURL 的 <img>，src 正确且不走 storageKey 解析", () => {
        renderDrawer([readySlot], { canvasNodes: [canvasNode("img-1", "画布图", "data:image/png;base64,AAA")] });
        const img = document.querySelector("img") as HTMLImageElement;
        expect(img).not.toBeNull();
        expect(img.getAttribute("src")).toBe("data:image/png;base64,AAA");
        expect(resolveImageUrlMock).not.toHaveBeenCalled();
    });

    it("ready + storageKey → img src 为 resolveImageUrl 解析结果", async () => {
        resolveImageUrlMock.mockResolvedValue("blob:mock");
        renderDrawer([{ id: "ref1", label: "sheet", state: "ready", source: "library", storageKey: "image:abc" }]);
        await waitFor(() => expect(document.querySelector("img")?.getAttribute("src")).toBe("blob:mock"));
        expect(resolveImageUrlMock).toHaveBeenCalledWith("image:abc");
    });

    it("empty 槽不渲染预览：无 img，仍显示来源选择按钮", () => {
        renderDrawer([emptySlot]);
        expect(document.querySelector("img")).toBeNull();
        expect(screen.getByLabelText("生成或选择图片")).not.toBeNull();
    });

    it("抽屉打开即渲染 RefRow 列表（ready/queued/empty 混合），不抛错", () => {
        expect(() =>
            renderDrawer(
                [
                    { id: "ref1", label: "sheet", state: "ready", source: "canvas", nodeId: "img-1" },
                    { id: "ref2", label: "portrait", state: "queued", source: "generated" },
                    { id: "ref3", label: "细节图", state: "empty" },
                ],
                { canvasNodes: [canvasNode("img-1", "画布图", "data:image/png;base64,AAA")] },
            ),
        ).not.toThrow();
        expect(screen.getByText("…")).not.toBeNull();
        expect(screen.getByLabelText("生成或选择图片")).not.toBeNull();
        expect((document.querySelector("img") as HTMLImageElement).getAttribute("src")).toBe("data:image/png;base64,AAA");
    });
});
