import { describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";

import i18n from "@/i18n";
import { ShotsStep } from "./shots-step";
import type { ScriptNodeData, ScriptShot, ShotAudioRef } from "@/types/script-node";

const shot = (shotId: string, over: Partial<ScriptShot> = {}): ScriptShot => ({
    shotId, no: 0, origin: "manual", shotSize: "中景", angle: "平视", movement: "固定",
    duration: 4, mood: "温暖", sfx: "", dialogue: "", descriptionRich: [], description: "", entityRefs: [], composed: false, ...over,
});

const script = (shots: ScriptShot[], over: Partial<ScriptNodeData> = {}): ScriptNodeData => ({
    schemaVersion: 1, instruction: "做菜短片", globalStyle: "", entityIds: [], output: { status: "idle", shots }, ...over,
});

function renderStep(over: Partial<ScriptNodeData> = {}, storyboardFirst = false, storyboardImageState: Record<string, { state: "none" | "generating" | "ready" | "error"; thumbUrl?: string }> = {}, onReorchestrate?: () => void) {
    const base = script([shot("a", { no: 1 }), shot("b", { no: 2 })], over);
    const onUpdateScript = vi.fn((updater: (data: ScriptNodeData) => ScriptNodeData) => updater(base));
    const onImportAudio = vi.fn(async (file: File) => ({ name: file.name, storageKey: "audio:new" }) as ShotAudioRef);
    render(
        <I18nextProvider i18n={i18n}>
            <ShotsStep
                script={base}
                storyboardFirst={storyboardFirst}
                entities={[]}
                audioNodes={[{ id: "audio-1", title: "环境声.mp3", storageKey: "audio:k1" }]}
                storyboardImageState={storyboardImageState}
                onImportAudio={onImportAudio}
                onUpdateScript={onUpdateScript}
                onToast={vi.fn()}
                onReorchestrate={onReorchestrate}
            />
        </I18nextProvider>,
    );
    return onUpdateScript;
}

describe("ShotsStep 导演式镜头列表 + 检查器", () => {
    it("渲染镜头列表行并支持选中检查器", () => {
        renderStep();
        const options = screen.getAllByRole("option");
        expect(options).toHaveLength(2);
        expect(screen.getByRole("option", { selected: true })).toBeInTheDocument();
        // 检查器默认选中首镜，镜号格式 SH 01
        expect(screen.getByText("SH 01")).toBeInTheDocument();
    });

    it("↑↓ 键盘换选中行", () => {
        renderStep();
        screen.getByRole("option", { selected: true }).focus();
        fireEvent.keyDown(screen.getByRole("option", { selected: true }), { key: "ArrowDown" });
        expect(screen.getByText("SH 02")).toBeInTheDocument();
        fireEvent.keyDown(screen.getByRole("listbox", { name: "脚本视图" }), { key: "ArrowUp" });
        expect(screen.getByText("SH 01")).toBeInTheDocument();
    });

    it("键盘移动选中后新选中行 scrollIntoView（block: nearest）", () => {
        const scrollSpy = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
        renderStep();
        fireEvent.keyDown(screen.getByRole("listbox", { name: "脚本视图" }), { key: "ArrowDown" });
        expect(scrollSpy).toHaveBeenCalledTimes(1);
        expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest" });
        // 滚动的是下移后的新选中行（第 2 行），不是原选中行
        expect(scrollSpy.mock.contexts[0]).toBe(screen.getAllByRole("option")[1]);
        scrollSpy.mockRestore();
    });

    it("无产物镜头删除走 Popconfirm 确认", async () => {
        const onUpdateScript = renderStep();
        fireEvent.click(screen.getByText("删除此镜头"));
        // antd Button 会对两字中文按钮自动插空格（"删 除"），按 role + 正则匹配确认键
        fireEvent.click(await screen.findByRole("button", { name: /^删\s*除$/ }));
        const data = onUpdateScript.mock.results.at(-1)?.value as ScriptNodeData;
        expect(data.output.shots).toHaveLength(1);
        expect(data.output.shots[0].shotId).toBe("b");
        // normalizeShots 重排序号
        expect(data.output.shots[0].no).toBe(1);
    });

    it("有产物镜头（已展开节点）删除走 Modal 确认", async () => {
        const onUpdateScript = renderStep({ output: { status: "idle", shots: [shot("a", { no: 1 }), shot("b", { no: 2 })], expandedShotNodes: { a: "node-x" } } });
        fireEvent.click(screen.getByText("删除此镜头"));
        fireEvent.click(await screen.findByText("该镜头已生成视频/音频或已展开生成节点，删除将一并解除关联，不可撤销。"));
        fireEvent.click(screen.getByRole("button", { name: /^删\s*除$/ }));
        const data = onUpdateScript.mock.results.at(-1)?.value as ScriptNodeData;
        expect(data.output.shots).toHaveLength(1);
        expect(data.output.shots[0].shotId).toBe("b");
    });

    it("检查器改景别触发 updateScript 并使 composed 失效", () => {
        const onUpdateScript = renderStep();
        fireEvent.change(screen.getByLabelText("景别"), { target: { value: "特写" } });
        const data = onUpdateScript.mock.results.at(-1)?.value as ScriptNodeData;
        expect(data.output.shots[0].shotSize).toBe("特写");
        expect(data.output.shots[0].composed).toBe(false);
    });

    it("时长清空落 0（未设置），非空仍钳制 ≥1", () => {
        const onUpdateScript = renderStep();
        const durationInput = document.getElementById("insp-dur") as HTMLInputElement;
        fireEvent.change(durationInput, { target: { value: "" } });
        let data = onUpdateScript.mock.results.at(-1)?.value as ScriptNodeData;
        expect(data.output.shots[0].duration).toBe(0);
        fireEvent.change(durationInput, { target: { value: "0" } });
        data = onUpdateScript.mock.results.at(-1)?.value as ScriptNodeData;
        expect(data.output.shots[0].duration).toBe(1);
    });

    it("添加镜头：追加一条空字段行并重排序号", () => {
        const onUpdateScript = renderStep();
        fireEvent.click(screen.getByText("添加镜头"));
        const data = onUpdateScript.mock.results.at(-1)?.value as ScriptNodeData;
        expect(data.output.shots).toHaveLength(3);
        expect(data.output.shots.map((s) => s.no)).toEqual([1, 2, 3]);
        expect(data.output.shots[2].origin).toBe("manual");
        // 新行五字段默认空（不预填假数据）
        expect(data.output.shots[2].shotSize).toBe("");
        expect(data.output.shots[2].angle).toBe("");
        expect(data.output.shots[2].movement).toBe("");
        expect(data.output.shots[2].mood).toBe("");
        expect(data.output.shots[2].duration).toBe(0);
    });

    it("行 hover「+」：在第 1 镜后插入并重排序号", () => {
        const onUpdateScript = renderStep();
        fireEvent.click(screen.getByRole("button", { name: "在第 1 镜后插入镜头" }));
        const data = onUpdateScript.mock.results.at(-1)?.value as ScriptNodeData;
        expect(data.output.shots).toHaveLength(3);
        expect(data.output.shots.map((s) => s.no)).toEqual([1, 2, 3]);
        expect(data.output.shots[1].shotId).not.toBe("a");
        expect(data.output.shots[1].shotId).not.toBe("b");
        expect(data.output.shots[1].origin).toBe("manual");
    });

    it("开启时添加镜头默认 5s；关闭时默认 0（未设置）", () => {
        let onUpdateScript = renderStep({ template: { storyboardFirst: true } }, true);
        fireEvent.click(screen.getByText("添加镜头"));
        let data = onUpdateScript.mock.results.at(-1)?.value as ScriptNodeData;
        expect(data.output.shots.at(-1)!.duration).toBe(5);

        // 同一用例内二次 render：先清理 DOM，避免 getByText 命中上一次渲染的按钮
        cleanup();
        onUpdateScript = renderStep({}, false);
        fireEvent.click(screen.getByText("添加镜头"));
        data = onUpdateScript.mock.results.at(-1)?.value as ScriptNodeData;
        expect(data.output.shots.at(-1)!.duration).toBe(0);
    });

    it("空镜头：空态引导添加", () => {
        const onUpdateScript = renderStep({ output: { status: "idle", shots: [] } });
        expect(screen.getByText("还没有镜头")).toBeInTheDocument();
        fireEvent.click(screen.getByText("添加镜头"));
        const data = onUpdateScript.mock.results.at(-1)?.value as ScriptNodeData;
        expect(data.output.shots).toHaveLength(1);
        expect(data.output.shots[0].no).toBe(1);
    });

    it("generating 状态显示编排状态条与补位骨架行", () => {
        renderStep({ output: { status: "generating", shots: [shot("a", { no: 1 })] }, template: { shotCount: 3 } });
        expect(screen.getByRole("status")).toHaveTextContent("Agent 正在按脚本指令逐镜生成，已写入镜头可直接编辑");
        // shotCount 3 - 已写入 1 = 2 条骨架（aria-hidden 占位）
        expect(document.querySelectorAll('div[role="listbox"] > div[aria-hidden="true"]')).toHaveLength(2);
    });

    it("storyboardImageState 驱动行内分镜图 chip", () => {
        renderStep({}, false, { a: { state: "generating" }, b: { state: "error" } });
        expect(screen.getByText("分镜图生成中")).toBeInTheDocument();
        expect(screen.getByText("分镜图失败")).toBeInTheDocument();
    });
});

describe("ShotsStep 编排失败横幅（spec D11）", () => {
    it("error 状态：横幅落地 errorMessage（title 全文），重试按钮触发 onReorchestrate", () => {
        const onReorchestrate = vi.fn();
        renderStep({ output: { status: "error", shots: [shot("a", { no: 1 }), shot("b", { no: 2 })], errorMessage: "编排超时：模型未响应" } }, false, {}, onReorchestrate);
        expect(screen.getByRole("alert")).toHaveTextContent("编排超时：模型未响应");
        expect(screen.getByTitle("编排超时：模型未响应")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "让 Agent 继续编排" }));
        expect(onReorchestrate).toHaveBeenCalledTimes(1);
    });

    it("error 状态未注入 onReorchestrate：横幅仍展示，仅隐藏重试按钮", () => {
        renderStep({ output: { status: "error", shots: [shot("a", { no: 1 }), shot("b", { no: 2 })], errorMessage: "配额不足" } });
        expect(screen.getByRole("alert")).toHaveTextContent("配额不足");
        expect(screen.queryByText("让 Agent 继续编排")).not.toBeInTheDocument();
    });

    it("error 状态空镜头：横幅展示在空态上方", () => {
        renderStep({ output: { status: "error", shots: [], errorMessage: "编排失败" } });
        expect(screen.getByRole("alert")).toHaveTextContent("编排失败");
        expect(screen.getByText("还没有镜头")).toBeInTheDocument();
    });
});

describe("ShotsStep 音频槽位（音效/台词）", () => {
    const shotWithAudio = (over: Partial<ScriptShot> = {}): ScriptShot => shot("a", { no: 1, sfxAudio: { name: "爆炸.wav", storageKey: "audio:k9", durationMs: 5_000 }, ...over });

    function renderAudioStep(shots: ScriptShot[]) {
        const onImportAudio = vi.fn(async (file: File) => ({ name: file.name, storageKey: "audio:new" }) as ShotAudioRef);
        const onToast = vi.fn();
        const base = script(shots);
        const onUpdateScript = vi.fn((updater: (data: ScriptNodeData) => ScriptNodeData) => updater(base));
        render(
            <I18nextProvider i18n={i18n}>
                <ShotsStep
                    script={base}
                    storyboardFirst={false}
                    entities={[]}
                    audioNodes={[{ id: "audio-1", title: "环境声.mp3", storageKey: "audio:k1" }]}
                    storyboardImageState={{}}
                    onImportAudio={onImportAudio}
                    onUpdateScript={onUpdateScript}
                    onToast={onToast}
                />
            </I18nextProvider>,
        );
        return { onUpdateScript, onImportAudio, onToast };
    }

    it("有音频：chip 渲染名称/时长，文本与音频共存；移除只清音频不动文本", () => {
        const { onUpdateScript } = renderAudioStep([shotWithAudio({ sfx: "爆炸声" })]);
        expect(screen.getByText("爆炸.wav")).toBeTruthy();
        expect(screen.getByText("0:05")).toBeTruthy();
        // 有音频时该槽位输入框无「无」占位；台词槽为空则显示
        expect((screen.getByLabelText("音效") as HTMLInputElement).placeholder).toBe("");
        expect((screen.getByLabelText("台词") as HTMLInputElement).placeholder).toBe("无");
        fireEvent.click(screen.getByRole("button", { name: "移除音频 爆炸.wav" }));
        const data = onUpdateScript.mock.results.at(-1)?.value as ScriptNodeData;
        expect(data.output.shots[0].sfxAudio).toBeUndefined();
        expect(data.output.shots[0].sfx).toBe("爆炸声");
        expect(data.output.shots[0].composed).toBe(false);
    });

    it("picker 选择画布音频写入 sfxAudio；上传走 onImportAudio 且失败 toast", async () => {
        const { onUpdateScript, onImportAudio, onToast } = renderAudioStep([shot("a", { no: 1 })]);
        // 检查器内 sfx/dialogue 各一个「添加音频」锚点
        expect(screen.getAllByRole("button", { name: "添加音频" })).toHaveLength(2);
        fireEvent.click(screen.getAllByRole("button", { name: "添加音频" })[0]);
        fireEvent.mouseDown(screen.getByRole("option", { name: "环境声.mp3" }));
        let data = onUpdateScript.mock.results.at(-1)?.value as ScriptNodeData;
        expect(data.output.shots[0].sfxAudio).toMatchObject({ audioNodeId: "audio-1", name: "环境声.mp3" });

        fireEvent.click(screen.getAllByRole("button", { name: "添加音频" })[1]); // 台词槽
        const input = document.querySelector('input[type="file"]') as HTMLInputElement;
        onImportAudio.mockRejectedValueOnce(new Error("quota"));
        await act(async () => fireEvent.change(input, { target: { files: [new File(["x"], "v.mp3", { type: "audio/mpeg" })] } }));
        expect(onImportAudio).toHaveBeenCalled();
        expect(onToast).toHaveBeenCalledWith("音频添加失败，请重试");
    });
});
