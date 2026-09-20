import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ShotAudioChip } from "./shot-audio-chip";
import { resolveMediaUrl } from "@/services/file-storage";
import { resolveCanvasAssetUrl } from "@/services/project-asset-storage";

vi.mock("@/services/file-storage", () => ({ resolveMediaUrl: vi.fn(async (key?: string) => (key ? `blob:${key}` : "")) }));
// useProjectAssetUrl 依赖的三个门面入口：桌面 assetRef 解析走 resolveCanvasAssetUrl。
vi.mock("@/services/project-asset-storage", () => ({
    resolveCanvasAssetUrl: vi.fn(async () => "blob:project"),
    onCanvasAssetChanged: vi.fn(() => () => undefined),
    isCanvasAssetMissing: vi.fn(() => false),
}));

class MockAudio {
    static instances: MockAudio[] = [];
    play = vi.fn().mockResolvedValue(undefined);
    pause = vi.fn();
    onerror: (() => void) | null = null;
    onended: (() => void) | null = null;
    constructor(public url: string) {
        MockAudio.instances.push(this);
    }
}

vi.stubGlobal("Audio", MockAudio);

const labels = { play: "播放 a.mp3", pause: "暂停 a.mp3", remove: "移除音频 a.mp3", invalid: "音频文件已失效" };
const renderChip = (over: { onRemove?: (() => void) | null; className?: string } = {}) => {
    const onRemove = vi.fn();
    const view = render(<ShotAudioChip audio={{ name: "a.mp3", storageKey: "audio:k1", durationMs: 42_000 }} labels={labels} onRemove={over.onRemove === null ? undefined : (over.onRemove ?? onRemove)} className={over.className} />);
    return { onRemove, unmount: view.unmount };
};

afterEach(() => {
    cleanup();
    MockAudio.instances = [];
    vi.clearAllMocks();
});

describe("ShotAudioChip", () => {
    it("渲染名称、时长（m:ss）与移除按钮；不传 onRemove 时无移除按钮", () => {
        const { unmount } = renderChip();
        expect(screen.getByText("a.mp3")).toBeTruthy();
        expect(screen.getByText("0:42")).toBeTruthy();
        expect(screen.getByRole("button", { name: "移除音频 a.mp3" })).toBeTruthy();
        unmount();
        cleanup();
        renderChip({ onRemove: null });
        expect(screen.queryByRole("button", { name: "移除音频 a.mp3" })).toBeNull();
    });

    it("播放/再点暂停走单例；aria-label 随播放态切换", async () => {
        renderChip();
        const playBtn = () => screen.getByRole("button", { name: /^(播放|暂停) a\.mp3$/ }) as HTMLButtonElement;
        await act(async () => fireEvent.click(playBtn()));
        const instance = MockAudio.instances.at(-1)!;
        expect(instance.play).toHaveBeenCalled();
        expect(playBtn().getAttribute("aria-label")).toBe("暂停 a.mp3");
        await act(async () => fireEvent.click(playBtn()));
        expect(instance.pause).toHaveBeenCalled();
        expect(playBtn().getAttribute("aria-label")).toBe("播放 a.mp3");
    });

    it("resolveMediaUrl 返回空 → 失败态（TriangleAlert 语义：aria-label 换 invalid）", async () => {
        vi.mocked(resolveMediaUrl).mockResolvedValueOnce("");
        renderChip();
        const btn = () => screen.getAllByRole("button")[0] as HTMLButtonElement;
        await act(async () => fireEvent.click(btn()));
        expect(btn().getAttribute("aria-label")).toBe("音频文件已失效");
    });

    it("卸载时正在播放 → 立即 stop（幽灵播放防护）", async () => {
        const { unmount } = renderChip();
        await act(async () => fireEvent.click(screen.getAllByRole("button")[0]));
        const instance = MockAudio.instances.at(-1)!;
        unmount();
        expect(instance.pause).toHaveBeenCalled();
    });

    it("只有项目资产 assetRef（无 storageKey）→ 经 useProjectAssetUrl 解析播放，不走旧解析器", async () => {
        render(<ShotAudioChip audio={{ name: "p.mp3", assetRef: { backend: "project-file", assetId: "a1", projectId: "p1", relativePath: "assets/imported/p.mp3", revision: 1 }, durationMs: 1000 }} labels={labels} />);
        await waitFor(() => expect(resolveCanvasAssetUrl).toHaveBeenCalled());
        await act(async () => fireEvent.click(screen.getAllByRole("button")[0]));
        const instance = MockAudio.instances.at(-1)!;
        expect(instance.url).toBe("blob:project");
        expect(instance.play).toHaveBeenCalled();
        expect(resolveMediaUrl).not.toHaveBeenCalled();
    });

    it("assetRef 解析为空（资产缺失）→ 播放进入失败态", async () => {
        vi.mocked(resolveCanvasAssetUrl).mockResolvedValueOnce("");
        render(<ShotAudioChip audio={{ name: "p.mp3", assetRef: { backend: "project-file", assetId: "a2", projectId: "p1", relativePath: "assets/imported/gone.mp3", revision: 1 } }} labels={labels} />);
        await waitFor(() => expect(resolveCanvasAssetUrl).toHaveBeenCalled());
        await act(async () => fireEvent.click(screen.getAllByRole("button")[0]));
        expect((screen.getAllByRole("button")[0] as HTMLButtonElement).getAttribute("aria-label")).toBe("音频文件已失效");
        expect(resolveMediaUrl).not.toHaveBeenCalled();
    });
});
