import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";

import i18n from "@/i18n";
import { useAgentStore } from "@/stores/use-agent-store";
import { ComposeStep } from "./compose-step";
import type { AssetMentionCandidate } from "@/lib/canvas/asset-mentions";
import type { ScriptNodeData, ScriptShot } from "@/types/script-node";
import type { CanvasNodeData } from "@/types/canvas";
import type { ScriptEntity } from "@/stores/use-script-entity-store";

// jsdom 未实现 HTMLMediaElement.play（返回 undefined，会让播放 hook 内的 .catch 抛错）；
// 连播起播会调用 <video>.play()，这里垫成 resolved promise。
beforeAll(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    // jsdom 未实现 requestFullscreen：垫一个空实现，供全屏层 best-effort 调用与用例 spyOn
    if (!("requestFullscreen" in HTMLElement.prototype)) {
        Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, writable: true, value: () => Promise.resolve() });
    }
});

const shot = (shotId: string, over: Partial<ScriptShot> = {}): ScriptShot => ({
    shotId, no: 0, origin: "manual", shotSize: "中景", angle: "平视", movement: "固定",
    duration: 4, mood: "温暖", sfx: "", dialogue: "", descriptionRich: [], description: "切开辣椒", entityRefs: ["e1"], composed: false, finalPrompt: undefined, ...over,
});

const script = (shots: ScriptShot[], over: Partial<ScriptNodeData> = {}): ScriptNodeData => ({
    schemaVersion: 1, instruction: "", globalStyle: "皮克斯风格", entityIds: ["e1"],
    output: { status: "done", shots },
    ...over,
});

const entity = (id: string, name: string): ScriptEntity => ({
    id, projectId: "p1", group: "item", name, refs: [{ id: `${id}_ref1`, label: "物品图", state: "ready", source: "generated", nodeId: "img-1", storageKey: "k1" }], createdAt: "", updatedAt: "",
});

function renderStep(shots: ScriptShot[], over: Partial<ScriptNodeData> = {}, storyboardFirst = false, assetCandidates: AssetMentionCandidate[] = []) {
    const onUpdateScript = vi.fn((updater: (data: ScriptNodeData) => ScriptNodeData) => updater(script(shots, over)));
    const onToast = vi.fn();
    const utils = render(
        <I18nextProvider i18n={i18n}>
            <ComposeStep
                nodeId="script-1"
                script={script(shots, over)}
                entities={[entity("e1", "发光辣椒")]}
                onUpdateScript={onUpdateScript}
                onToast={onToast}
                storyboardFirst={storyboardFirst}
                storyboardImageState={{}}
                assetCandidates={assetCandidates}
                onGenerateStoryboard={vi.fn()}
                onBatchGenerateStoryboards={vi.fn()}
            />
        </I18nextProvider>,
    );
    return { onUpdateScript, onToast, container: utils.container };
}

describe("ComposeStep（三层结构：预览窗口 / 分镜画面条 / 固定提示词卡）", () => {
    it("顶部预览窗口显示当前镜头标签与播放控制", () => {
        renderStep([shot("s1", { no: 1 })]);
        expect(screen.getByText(/视频预览 · 镜头 1/)).not.toBeNull();
        expect(screen.getByText("单镜")).not.toBeNull();
        // 「连播全片」两处：分镜条连播入口 + 控制条模式钮
        expect(screen.getAllByText("连播全片").length).toBeGreaterThan(0);
        expect(document.querySelector("video, [class*=aspect-video]")).not.toBeNull();
    });

    it("中部画面条按序渲染画格；点击画格切换底部卡内容", () => {
        renderStep([
            shot("s1", { no: 1, description: "第一镜描述" }),
            shot("s2", { no: 2, description: "第二镜描述" }),
        ]);
        // 两个画格（含序号角标）
        const frames = screen.getAllByText("1").length ? screen.getAllByText("2") : [];
        expect(frames.length).toBeGreaterThan(0);
        // 点击第 2 个画格 → 底部卡切到镜头 2（预览标签更新）
        const frameBtns = document.querySelectorAll("[data-frame-shot-id]");
        expect(frameBtns.length).toBe(2);
        fireEvent.click(frameBtns[1]!);
        expect(screen.getByText(/视频预览 · 镜头 2/)).not.toBeNull();
    });

    it("底部固定卡片：初始合成文本含元信息/描述/实体/全局风格", () => {
        renderStep([shot("s1", { no: 1 })]);
        const block = document.querySelector(".rich-desc") as HTMLElement;
        expect(block.textContent).toContain("【中景 · 平视 · 固定 · 4s · 氛围:温暖】");
        expect(block.textContent).toContain("切开辣椒");
        expect(block.textContent).toContain("[道具:发光辣椒]");
        expect(block.textContent).toContain("皮克斯风格");
        // 引用资产 chip 行（图标 + 名称分开渲染）
        expect(screen.getByText("发光辣椒")).not.toBeNull();
    });

    it("空拍摄参数的镜头：展示无 0s/占位残留，meta 全空显示 —", () => {
        renderStep([shot("s1", { no: 1, shotSize: "", angle: "", movement: "", duration: 0, mood: "", description: "只有描述" })]);
        const text = document.body.textContent ?? "";
        expect(text).not.toContain("0s");
        expect(text).not.toContain("nulls");
        expect(text).not.toContain("undefined");
        expect(text).not.toContain("音效：");
        // 预览标签与属性面板 meta 全空时显示 —
        expect(screen.getAllByText("—").length).toBeGreaterThan(0);
        // 提示词无【】行，描述保留
        const block = document.querySelector(".rich-desc") as HTMLElement;
        expect(block.textContent).not.toContain("【");
        expect(block.textContent).toContain("只有描述");
    });

    it("‹ › 导航切换镜头（首镜头 ‹ 禁用）", () => {
        renderStep([shot("s1", { no: 1 }), shot("s2", { no: 2 })]);
        const prev = screen.getByRole("button", { name: "上一个镜头" }) as HTMLButtonElement;
        const next = screen.getByRole("button", { name: "下一个镜头" });
        expect(prev.disabled).toBe(true);
        fireEvent.click(next);
        expect((screen.getByRole("button", { name: "上一个镜头" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("确认 → updateScript 收到 finalPrompt 与 composed: true", () => {
        const { onUpdateScript } = renderStep([shot("s1", { no: 1 })]);
        fireEvent.click(screen.getByText("确认"));
        const data = onUpdateScript.mock.results.at(-1)?.value as ScriptNodeData;
        expect(data.output.shots[0].composed).toBe(true);
        expect(data.output.shots[0].finalPrompt).toContain("切开辣椒");
    });

    it("空镜头显示引导文案，且本组件不含批量入口（由外壳底栏提供）", () => {
        renderStep([]);
        expect(screen.getByText(/没有镜头可合成/)).not.toBeNull();
        expect(screen.queryByText("完成脚本编辑")).toBeNull(); // CTA 在外壳底栏
    });

    it("有镜头时本组件也不重复放置完成按钮（避免与底栏 CTA 重复）", () => {
        renderStep([shot("s1", { no: 1, composed: true, finalPrompt: "x" })]);
        expect(screen.queryByText("完成脚本编辑")).toBeNull();
    });
});

describe("ComposeStep 音频呈现", () => {
    it("FrameCard 有音频 → 非交互 Music2 徽标（title 区分）；无嵌套 button", () => {
        renderStep([shot("s1", { no: 1, sfxAudio: { name: "爆炸.wav" }, dialogueAudio: { name: "台词.mp3" } })]);
        const frame = document.querySelector("[data-frame-shot-id='s1']") as HTMLElement;
        expect(frame.querySelectorAll("button").length).toBe(0); // 卡片根是 button，内部不得再有交互控件
        const badges = [...frame.querySelectorAll("span[title]")].filter((el) => (el.getAttribute("title") ?? "").includes("爆炸.wav") || (el.getAttribute("title") ?? "").includes("台词.mp3"));
        expect(badges.length).toBe(2);
    });

    it("右栏属性面板：只读 chip 带前置标签（音效/台词），可播放无移除", () => {
        renderStep([shot("s1", { no: 1, sfxAudio: { name: "爆炸.wav", storageKey: "audio:k" } })]);
        expect(screen.getByText("音效")).toBeTruthy();
        expect(screen.getByText("爆炸.wav")).toBeTruthy();
        expect(screen.queryByRole("button", { name: /移除音频/ })).toBeNull();
    });

    it("无音频时不渲染音频徽标/chip", () => {
        renderStep([shot("s1", { no: 1 })]);
        expect(screen.queryByText("音效")).toBeNull();
        expect(screen.queryByText("台词")).toBeNull();
    });
});

describe("ComposeStep 优化提示词（可选 AI 打磨）", () => {
    it("点击按钮 → 向画布 Agent 提交含 nodeId 与回写工具的优化指令，面板打开并 toast", () => {
        const { onToast } = renderStep([
            shot("s1", { no: 1, composed: true, finalPrompt: "旧提示词" }),
            shot("s2", { no: 2 }),
        ]);
        fireEvent.click(screen.getByRole("button", { name: /优化提示词/ }));
        const state = useAgentStore.getState();
        expect(state.panelOpen).toBe(true);
        expect(state.prompt).toContain("/shotshot-director");
        expect(state.prompt).toContain("script-1");
        expect(state.prompt).toContain("canvas_script_compile_prompts");
        expect(onToast).toHaveBeenCalled();
    });

    it("无镜头时组件直接渲染空态（优化按钮不出现）", () => {
        renderStep([]);
        expect(screen.getByText("没有镜头可合成，回到「确认镜头」先添加。")).not.toBeNull();
        expect(screen.queryByRole("button", { name: /优化提示词/ })).toBeNull();
    });
});

describe("D1：「优化提示词」按钮遵循 design token", () => {
    it("按钮用语义轮廓类，不含 violet 字面量", () => {
        renderStep([shot("s1", { no: 1 })]);
        const button = screen.getByText("优化提示词").closest("button");
        expect(button).not.toBeNull();
        expect(button?.className).toContain("border-border");
        expect(button?.className).not.toContain("violet");
    });
});

describe("ComposeStep 资产 @ 引用", () => {
    const assetCandidates: AssetMentionCandidate[] = [{ assetId: "a1", kind: "image", title: "唐剑", coverUrl: "blob:cover-a1" }];

    it("按 token 渲染资产 chip，编辑后序列化回 token", () => {
        const { onUpdateScript } = renderStep([shot("s1", { no: 1, composed: true, finalPrompt: "开场 @[asset:a1] 收尾" })], {}, false, assetCandidates);
        const chip = document.querySelector('[data-asset-id="a1"]');
        expect(chip).not.toBeNull();
        expect(chip?.querySelector("img")?.getAttribute("src")).toBe("blob:cover-a1");
        const editor = document.querySelector(".prompt-block") as HTMLElement;
        const appended = document.createElement("span");
        appended.contentEditable = "false";
        appended.dataset.assetId = "a1";
        editor.appendChild(appended);
        fireEvent.input(editor);
        const updater = onUpdateScript.mock.calls.at(-1)![0] as (data: ScriptNodeData) => ScriptNodeData;
        const next = updater(script([shot("s1", { composed: true })]));
        expect(next.output.shots[0].finalPrompt).toBe("开场 @[asset:a1] 收尾@[asset:a1]");
    });

    it("悬空 token 渲染为虚线未知资产 chip", () => {
        renderStep([shot("s1", { no: 1, composed: true, finalPrompt: "@[asset:gone]" })], {}, false, assetCandidates);
        expect(document.querySelector('[data-asset-id="gone"]')?.className).toContain("border-dashed");
    });

    it("IME 组合期间的 Enter 不被 @ 菜单劫持（isImeComposing 早退，无插入）", () => {
        const { onUpdateScript } = renderStep([shot("s1", { no: 1, composed: true, finalPrompt: "@" })], {}, false, assetCandidates);
        const editor = document.querySelector(".prompt-block") as HTMLElement;
        // jsdom 无真实光标：在 "@" 文本节点上放置选区并触发 input，使空 query 菜单打开（匹配全部候选）
        const textNode = editor.firstChild as Text;
        const range = document.createRange();
        range.setStart(textNode, 1);
        range.setEnd(textNode, 1);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        fireEvent.input(editor);
        expect(screen.getByText("唐剑")).not.toBeNull(); // 菜单已开
        const callsAfterMenu = onUpdateScript.mock.calls.length;
        // 组合期 Enter：isImeComposing 早退，不得 preventDefault + insertAsset
        const composingEnter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
        Object.defineProperty(composingEnter, "isComposing", { value: true });
        fireEvent(editor, composingEnter);
        expect(onUpdateScript.mock.calls.length).toBe(callsAfterMenu);
        expect(document.querySelector('[data-asset-id="a1"]')).toBeNull();
    });
});

const videoNode = (id: string, over: Record<string, unknown> = {}): CanvasNodeData =>
    ({ id, type: "video", title: `视频 ${id}`, position: { x: 0, y: 0 }, width: 480, height: 270, metadata: { content: `blob:video-${id}`, status: "success", ...over } }) as CanvasNodeData;

const scriptWithVersions = (shots: ScriptShot[], versions: Record<string, Array<{ nodeId: string; no: number }>> = {}, over: Partial<ScriptNodeData["output"]> = {}): ScriptNodeData => ({
    ...script(shots),
    output: { ...script(shots).output, shotVideoVersions: versions, ...over },
});

function renderStepFull(scriptData: ScriptNodeData, props: Partial<Parameters<typeof ComposeStep>[0]> = {}, assetCandidates: AssetMentionCandidate[] = []) {
    const onUpdateScript = vi.fn((updater: (data: ScriptNodeData) => ScriptNodeData) => updater(scriptData));
    const onGenerateShotVideo = vi.fn();
    const onSwitchShotVideo = vi.fn();
    const videoNodes = props.videoNodes ?? [];
    const view = render(
        <I18nextProvider i18n={i18n}>
            <ComposeStep
                nodeId="script-1"
                script={scriptData}
                entities={[entity("e1", "发光辣椒")]}
                onUpdateScript={onUpdateScript}
                onToast={vi.fn()}
                videoNodes={videoNodes}
                onGenerateShotVideo={onGenerateShotVideo}
                onSwitchShotVideo={onSwitchShotVideo}
                storyboardFirst={false}
                storyboardImageState={{}}
                assetCandidates={assetCandidates}
                onGenerateStoryboard={vi.fn()}
                onBatchGenerateStoryboards={vi.fn()}
                {...props}
            />
        </I18nextProvider>,
    );
    return { onGenerateShotVideo, onSwitchShotVideo, unmount: view.unmount };
}

describe("D2–D7：预览窗视频播放与版本链 UI", () => {
    it("镜头有视频版本时渲染 <video> 且 src 为节点内容；无版本时保持占位", () => {
        const first = renderStepFull(
            scriptWithVersions([shot("s1", { no: 1, composed: true })], { s1: [{ nodeId: "v1", no: 1 }] }),
            { videoNodes: [videoNode("v1")] },
        );
        const video = document.querySelector("video");
        expect(video?.getAttribute("src")).toBe("blob:video-v1");
        first.unmount();
        // 无版本：占位 + 生成视频按钮
        renderStepFull(scriptWithVersions([shot("s1", { no: 1, composed: true })]));
        expect(document.querySelector("video")).toBeNull();
        expect(screen.getByText("生成视频")).not.toBeNull();
    });

    it("生成中显示覆盖层并禁用重新生成", () => {
        renderStepFull(
            scriptWithVersions([shot("s1", { no: 1, composed: true })], { s1: [{ nodeId: "v1", no: 1 }] }),
            { videoNodes: [videoNode("v1", { status: "loading" })] },
        );
        expect(screen.getByText("视频生成中…")).not.toBeNull();
        expect(screen.getByText("生成中…").closest("button")?.hasAttribute("disabled")).toBe(true);
    });

    it("失败显示错误文案", () => {
        renderStepFull(
            scriptWithVersions([shot("s1", { no: 1, composed: true })], { s1: [{ nodeId: "v1", no: 1 }] }),
            { videoNodes: [videoNode("v1", { status: "error", errorDetails: "队列超时" })] },
        );
        expect(screen.getByText(/生成失败/)).not.toBeNull();
        expect(screen.getByText(/队列超时/)).not.toBeNull();
    });

    it("版本下拉列出全部版本，点击旧版本触发 onSwitchShotVideo", () => {
        const { onSwitchShotVideo } = renderStepFull(
            scriptWithVersions([shot("s1", { no: 1, composed: true })], { s1: [{ nodeId: "v2", no: 2 }, { nodeId: "v1", no: 1 }] }),
            { videoNodes: [videoNode("v2"), videoNode("v1")] },
        );
        fireEvent.click(screen.getByText(/V2 \/ 共 2 版/));
        expect(screen.getByText("最新")).not.toBeNull();
        fireEvent.click(screen.getByText("V1"));
        expect(onSwitchShotVideo).toHaveBeenCalledWith("s1", "v1");
    });

    it("未确认镜头生成按钮禁用并提示", () => {
        renderStepFull(
            scriptWithVersions([shot("s1", { no: 1, composed: false })], { s1: [{ nodeId: "v1", no: 1 }] }),
            { videoNodes: [videoNode("v1")] },
        );
        expect(screen.getByText("重新生成").closest("button")?.hasAttribute("disabled")).toBe(true);
    });

    it("无版本但 expandedShotNodes 指向有内容节点（legacy）时合成只读版本视图", () => {
        renderStepFull(
            scriptWithVersions([shot("s1", { no: 1, composed: true })], {}, { expandedShotNodes: { s1: "v-legacy" } }),
            { videoNodes: [videoNode("v-legacy")] },
        );
        expect(document.querySelector("video")?.getAttribute("src")).toBe("blob:video-v-legacy");
    });

    it("FrameCard 有视频时缩略图用 <video>", () => {
        renderStepFull(
            scriptWithVersions([shot("s1", { no: 1, composed: true })], { s1: [{ nodeId: "v1", no: 1 }] }),
            { videoNodes: [videoNode("v1")] },
        );
        // 预览窗 1 个 + 缩略图 1 个
        expect(document.querySelectorAll("video").length).toBe(2);
    });
});

describe("D12–D13：生成设置确认弹窗", () => {
    const withVideo = () =>
        renderStepFull(
            scriptWithVersions([shot("s1", { no: 1, composed: true })], { s1: [{ nodeId: "v1", no: 2 }] }),
            { videoNodes: [videoNode("v1")] },
        );

    it("点「重新生成」先开设置弹窗（不直接生成）；确认后带 settings 回调", () => {
        const { onGenerateShotVideo } = withVideo();
        fireEvent.click(screen.getByText("重新生成"));
        expect(onGenerateShotVideo).not.toHaveBeenCalled();
        // 弹窗标题为「重新生成 · 生成设置 · V2」整体串，getByText 按整段直接文本匹配，故用正则断言可见性
        expect(screen.getByText(/生成设置/)).not.toBeNull();
        expect(screen.getAllByText(/重新生成/).length).toBeGreaterThanOrEqual(1);
        fireEvent.click(screen.getByText("确认重新生成"));
        expect(onGenerateShotVideo).toHaveBeenCalledTimes(1);
        expect(onGenerateShotVideo.mock.calls[0]?.[0]).toBe("s1");
        expect(onGenerateShotVideo.mock.calls[0]?.[1]).toEqual({});
    });

    it("点占位「生成视频」同样先开弹窗；取消则零调用", () => {
        const { onGenerateShotVideo } = renderStepFull(scriptWithVersions([shot("s1", { no: 1, composed: true })]));
        fireEvent.click(screen.getByText("生成视频"));
        expect(onGenerateShotVideo).not.toHaveBeenCalled();
        expect(screen.getByText(/生成设置/)).not.toBeNull();
        fireEvent.click(screen.getByText("取消"));
        expect(onGenerateShotVideo).not.toHaveBeenCalled();
    });
});


describe("ComposeStep 分镜图落位（舞台 + 提示词卡折叠节）", () => {
    type SbState = "none" | "generating" | "ready" | "error";
    function renderSb(shots: ScriptShot[], sbState: Record<string, { state: SbState; thumbUrl?: string }>, onGenerateStoryboard = vi.fn()) {
        const onUpdateScript = vi.fn((updater: (data: ScriptNodeData) => ScriptNodeData) => updater(script(shots)));
        render(
            <I18nextProvider i18n={i18n}>
                <ComposeStep
                    nodeId="script-1"
                    script={script(shots)}
                    entities={[entity("e1", "发光辣椒")]}
                    onUpdateScript={onUpdateScript}
                    onToast={vi.fn()}
                    storyboardFirst
                    storyboardImageState={sbState}
                    onGenerateStoryboard={onGenerateStoryboard}
                    onBatchGenerateStoryboards={vi.fn()}
                />
            </I18nextProvider>,
        );
        return { onUpdateScript, onGenerateStoryboard };
    }

    it("D16：storyboardFirst 关闭时不出现任何分镜图元素（无首帧标/生成入口/折叠节/批量入口）", () => {
        renderStep([shot("s1", { no: 1 })]);
        expect(screen.queryByText("首帧 · 分镜图")).toBeNull();
        expect(screen.queryByText("生成分镜图")).toBeNull();
        expect(screen.queryByText(/分镜图提示词/)).toBeNull();
        expect(screen.queryByText(/批量生成全部分镜图/)).toBeNull();
    });

    it("开启：无图镜头舞台中央出现生成入口；批量按钮按未生成计数", () => {
        const onGenerateStoryboard = vi.fn();
        renderSb([shot("s1", { no: 1 }), shot("s2", { no: 2 }), shot("s3", { no: 3 })], { s1: { state: "none" }, s2: { state: "generating" }, s3: { state: "none" } }, onGenerateStoryboard);
        expect(screen.getByText("该镜还没有分镜图（首帧）")).not.toBeNull();
        fireEvent.click(screen.getByText("生成分镜图"));
        expect(onGenerateStoryboard).toHaveBeenCalledWith("s1");
        expect(screen.getByText(/批量生成全部分镜图（2 未生成）/)).not.toBeNull();
    });

    it.each(["none", "generating", "error"] as const)("%s 只显示一组状态，不叠加视频占位文案", (state) => {
        renderSb([shot("s1", { no: 1, composed: true })], { s1: { state } });
        expect(document.querySelectorAll("[data-stage-state]")).toHaveLength(1);
        expect(screen.queryByText("已确认 · 生成后显示镜头首帧")).toBeNull();
        expect(screen.queryByRole("button", { name: "生成视频" })).toBeNull();
    });

    it("就绪：舞台满幅分镜图 + 首帧标 + 重新生成工具", () => {
        const onGenerateStoryboard = vi.fn();
        renderSb([shot("s1", { no: 1 })], { s1: { state: "ready", thumbUrl: "blob:sb1" } }, onGenerateStoryboard);
        expect(document.querySelector("img[src='blob:sb1']")).not.toBeNull();
        expect(screen.getByText("首帧 · 分镜图")).not.toBeNull();
        fireEvent.click(screen.getByText("↻ 重新生成"));
        expect(onGenerateStoryboard).toHaveBeenCalledWith("s1");
    });

    it("生成中：舞台覆盖层文案", () => {
        renderSb([shot("s1", { no: 1 })], { s1: { state: "generating" } });
        expect(screen.getByText("分镜图生成中…")).not.toBeNull();
    });

    it("失败：舞台错误覆盖层带提示与重新生成入口（点击回调原 shotId）", () => {
        const onGenerateStoryboard = vi.fn();
        renderSb([shot("s1", { no: 1 })], { s1: { state: "error" } }, onGenerateStoryboard);
        expect(screen.getByText("分镜图生成失败，可重试")).not.toBeNull();
        expect(screen.getByText(/即可重试/)).not.toBeNull();
        fireEvent.click(screen.getByText("↻ 重新生成"));
        expect(onGenerateStoryboard).toHaveBeenCalledWith("s1");
    });

    it("提示词卡内 storyboardPrompt 折叠节可编辑写回（不翻转 composed）", () => {
        const { onUpdateScript } = renderSb([shot("s1", { no: 1 })], { s1: { state: "none" } });
        expect(screen.getByText(/分镜图提示词（storyboardPrompt/)).not.toBeNull();
        fireEvent.change(document.querySelector("textarea")!, { target: { value: "静态帧：自定义" } });
        const data = onUpdateScript.mock.results.at(-1)?.value as ScriptNodeData;
        expect(data.output.shots[0].storyboardPrompt).toBe("静态帧：自定义");
        expect(data.output.shots[0].composed).toBe(false);
    });

    it("storyboardPrompt 为空时显示模板兜底（含描述）", () => {
        renderSb([shot("s1", { no: 1, description: "切开辣椒" })], { s1: { state: "none" } });
        expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toContain("切开辣椒");
    });

    it("storyboard 模式重新合成 → finalPrompt 带「从首帧开始：」前缀", () => {
        const { onUpdateScript } = renderSb([shot("s1", { no: 1, description: "切开辣椒", finalPrompt: "旧" })], { s1: { state: "ready", thumbUrl: "blob:sb" } });
        fireEvent.click(screen.getByText("重新合成"));
        const data = onUpdateScript.mock.results.at(-1)?.value as ScriptNodeData;
        expect(data.output.shots[0].finalPrompt).toContain("从首帧开始：切开辣椒");
    });
});

describe("分镜图区 imageGen caption（spec D7）", () => {
    it("imageGen 已设置时显示参数摘要", () => {
        renderStep([shot("s1", { no: 1 })], { template: { storyboardFirst: true, imageGen: { size: "16:9", quality: "high", count: 2 } } }, true);
        expect(screen.getByText(/分镜图生图参数：16:9 · high · ×2/)).not.toBeNull();
    });

    it("无 imageGen 时不渲染 caption", () => {
        renderStep([shot("s1", { no: 1 })], { template: { storyboardFirst: true } }, true);
        expect(screen.queryByText(/分镜图生图参数/)).toBeNull();
    });
});

describe("连播完整时间轴（spec D1/D2/D3/D6）", () => {
    // 「连播全片」有两处按钮：控制条模式钮（无图标）+ 分镜条连播入口（带 Play 图标）；连播入口是后者
    const reelButton = () => screen.getAllByRole("button", { name: /连播全片/ }).find((button) => button.querySelector("svg"))!;

    it("连播入口存在；无视频但分镜图 ready 的镜头以静帧补位（不跳镜）", () => {
        renderStepFull(
            scriptWithVersions(
                [shot("s1", { no: 1, composed: true }), shot("s2", { no: 2, composed: true }), shot("s3", { no: 3, composed: true })],
                { s1: [{ nodeId: "v1", no: 1 }] },
            ),
            {
                videoNodes: [videoNode("v1")],
                storyboardFirst: true,
                storyboardImageState: { s2: { state: "ready", thumbUrl: "blob:sb2" }, s3: { state: "none" } },
            },
        );
        expect(screen.getAllByRole("button", { name: /连播全片/ }).length).toBeGreaterThan(0);
        // 第 2 镜（无视频 + 分镜图 ready）在单镜预览下即显示分镜图静帧
        fireEvent.click(document.querySelectorAll("[data-frame-shot-id]")[1]!);
        expect(document.querySelector("img[src='blob:sb2']")).not.toBeNull();
        expect(screen.getByText("首帧 · 分镜图")).not.toBeNull();
    });

    it("点「连播全片」→ 进入连播模式并开始播放（从第 1 镜起）", () => {
        renderStepFull(
            scriptWithVersions([shot("s1", { no: 1, composed: true }), shot("s2", { no: 2, composed: true })], { s1: [{ nodeId: "v1", no: 1 }] }),
            { videoNodes: [videoNode("v1")], storyboardFirst: true, storyboardImageState: { s2: { state: "ready", thumbUrl: "blob:sb2" } } },
        );
        fireEvent.click(reelButton());
        // 连播模式下第 1 镜为当前镜，控制条文案切到连播态
        expect(screen.getByRole("button", { name: /连播中/ })).not.toBeNull();
    });

    it("连播中点击画格 = 跳镜续播，不退回单镜", () => {
        renderStepFull(
            scriptWithVersions([shot("s1", { no: 1, composed: true }), shot("s2", { no: 2, composed: true })], { s1: [{ nodeId: "v1", no: 1 }] }),
            { videoNodes: [videoNode("v1")], storyboardFirst: true, storyboardImageState: { s2: { state: "ready", thumbUrl: "blob:sb2" } } },
        );
        fireEvent.click(reelButton());
        fireEvent.click(document.querySelectorAll("[data-frame-shot-id]")[1]!);
        expect(screen.getByText(/视频预览 · 镜头 2/)).not.toBeNull();
        expect(screen.getByRole("button", { name: /连播中/ })).not.toBeNull();
    });

    it("视频生成中的镜头降级为分镜图静帧并显示生成中角标", () => {
        renderStepFull(
            scriptWithVersions([shot("s1", { no: 1, composed: true })], { s1: [{ nodeId: "v1", no: 1 }] }),
            { videoNodes: [videoNode("v1", { status: "loading", content: "" })], storyboardFirst: true, storyboardImageState: { s1: { state: "ready", thumbUrl: "blob:sb1" } } },
        );
        expect(document.querySelector("img[src='blob:sb1']")).not.toBeNull();
        expect(screen.getByText("视频生成中")).not.toBeNull();
    });
});

describe("全屏播放层（spec D8–D12）", () => {
    it("点全屏按钮 → 渲染 role=dialog 的全屏层；Esc 关闭且不关闭 studio 内容", () => {
        renderStepFull(
            scriptWithVersions([shot("s1", { no: 1, composed: true })], { s1: [{ nodeId: "v1", no: 1 }] }),
            { videoNodes: [videoNode("v1")] },
        );
        expect(document.querySelector('[data-shot-stage="fullscreen"]')).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "全屏播放" }));
        const layer = document.querySelector('[role="dialog"]');
        expect(layer).not.toBeNull();
        expect(document.querySelector('[data-shot-stage="fullscreen"]')).not.toBeNull();
        // 内联舞台让位：lightbox 打开时内联不再渲染 <video>（只有全屏层一个）
        expect(document.querySelectorAll('[data-shot-stage="inline"] video').length).toBe(0);
        fireEvent.keyDown(document, { key: "Escape" });
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        // 全屏层关闭后内联舞台恢复渲染视频
        expect(document.querySelectorAll('[data-shot-stage="inline"] video').length).toBe(1);
    });

    it("全屏层内可切镜：连播入口在全屏层同样可见", () => {
        renderStepFull(
            scriptWithVersions([shot("s1", { no: 1, composed: true }), shot("s2", { no: 2, composed: true })], { s1: [{ nodeId: "v1", no: 1 }], s2: [{ nodeId: "v2", no: 1 }] }),
            { videoNodes: [videoNode("v1"), videoNode("v2")] },
        );
        fireEvent.click(screen.getByRole("button", { name: "全屏播放" }));
        expect(screen.getAllByText("连播全片").length).toBeGreaterThan(1);
    });

    it("原生 requestFullscreen 抛错时静默降级（不抛异常）", () => {
        const spy = vi.spyOn(HTMLElement.prototype, "requestFullscreen").mockImplementation(() => { throw new Error("denied"); });
        expect(() => {
            renderStepFull(scriptWithVersions([shot("s1", { no: 1, composed: true })]), { videoNodes: [] });
            fireEvent.click(screen.getByRole("button", { name: "全屏播放" }));
        }).not.toThrow();
        spy.mockRestore();
    });

    it("全屏层内占位「生成视频」可点：关闭全屏层并打开生成弹窗", () => {
        renderStepFull(scriptWithVersions([shot("s1", { no: 1, composed: true })]));
        fireEvent.click(screen.getByRole("button", { name: "全屏播放" }));
        const layer = document.querySelector('[data-shot-stage="fullscreen"]') as HTMLElement;
        expect(layer).not.toBeNull();
        // 全屏层与内联舞台各有一份「生成视频」按钮，限定在全屏层内点击
        fireEvent.click(within(layer).getByText("生成视频"));
        expect(document.querySelector('[data-shot-stage="fullscreen"]')).toBeNull(); // 全屏层已关
        expect(screen.getByText(/生成设置/)).not.toBeNull(); // 生成弹窗已开（无版本 → 生成模式）
    });
});

describe("分镜图来源入口", () => {
    it.each(["none", "ready", "error"] as const)("%s 状态把来源和当前镜头交给选择器", (state) => {
        const onPickStoryboard = vi.fn();
        render(<ComposeStep nodeId="script-1" script={script([shot("s1")])} entities={[]}
            onUpdateScript={vi.fn()} onToast={vi.fn()} storyboardFirst
            storyboardImageState={{ s1: { state, thumbUrl: state === "ready" ? "data:image/png;base64,test" : undefined } }}
            onGenerateStoryboard={vi.fn()} onBatchGenerateStoryboards={vi.fn()} onPickStoryboard={onPickStoryboard} />);
        fireEvent.click(screen.getByRole("button", { name: "从画布选择" }));
        expect(onPickStoryboard).toHaveBeenLastCalledWith("s1", "canvas");
        fireEvent.click(screen.getByRole("button", { name: "从资产库选择" }));
        expect(onPickStoryboard).toHaveBeenLastCalledWith("s1", "library");
    });
});
