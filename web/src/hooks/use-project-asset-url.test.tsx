import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";

const projectStoreState = vi.hoisted(() => ({
    projects: [{ id: "p1", title: "P", workspacePath: "/ws/p1" }] as Array<Record<string, unknown>>,
    setProjectWorkspacePath: vi.fn(),
}));

vi.mock("@/services/image-storage", () => ({ uploadImage: vi.fn(), resolveImageUrl: vi.fn(), getImageBlob: vi.fn(), loadImageMeta: vi.fn() }));
vi.mock("@/services/file-storage", () => ({ uploadMediaFile: vi.fn(), resolveMediaUrl: vi.fn(), getMediaBlob: vi.fn(), readVideoMeta: vi.fn(), readAudioMeta: vi.fn() }));
vi.mock("@/stores/canvas/use-project-store", () => ({ useProjectStore: { getState: () => projectStoreState } }));

let changedListener: ((event: unknown) => void) | null = null;
let unsubscribeChanged: ReturnType<typeof vi.fn>;
const projectAssetsBridge = {
    write: vi.fn(),
    importPath: vi.fn(),
    read: vi.fn(),
    stat: vi.fn(),
    restore: vi.fn(),
    watch: vi.fn(),
    unwatch: vi.fn(),
    onChanged: vi.fn((listener: (event: unknown) => void) => {
        changedListener = listener;
        return unsubscribeChanged;
    }),
};

const record = {
    backend: "project-file",
    assetId: "a1",
    projectId: "p1",
    relativePath: "assets/imported/clip.mp4",
    revision: 1,
    originalName: "clip.mp4",
    kind: "video",
    mimeType: "video/mp4",
    bytes: 1,
    sha256: "hash",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "canvas-import", canvasId: "c1" },
};
const projectRef: CanvasAssetRef = { backend: "project-file", assetId: "a1", projectId: "p1", relativePath: "assets/imported/clip.mp4", revision: 1 };

beforeEach(() => {
    vi.resetModules();
    changedListener = null;
    unsubscribeChanged = vi.fn();
    Object.values(projectAssetsBridge).forEach((mock) => (mock as ReturnType<typeof vi.fn>).mockReset());
    projectAssetsBridge.onChanged.mockImplementation((listener: (event: unknown) => void) => {
        changedListener = listener;
        return unsubscribeChanged;
    });
    projectAssetsBridge.read.mockResolvedValue({ ok: true, value: { bytes: new Uint8Array([1]), record } });
    window.shotshot = { agent: {}, projectAssets: projectAssetsBridge, platform: "darwin" } as unknown as typeof window.shotshot;
    let urlCount = 0;
    // 类形式保持 URL 可构造：resetModules 后动态 import 的模块解析内部会 new URL。
    const UrlStub = class extends URL {};
    UrlStub.createObjectURL = vi.fn(() => `blob:url-${(urlCount += 1)}`);
    UrlStub.revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", UrlStub);
});

afterEach(() => {
    vi.unstubAllGlobals();
    delete window.shotshot;
});

const importHook = () => import("@/hooks/use-project-asset-url");

describe("useProjectAssetUrl", () => {
    it("resolves a project asset URL on mount", async () => {
        const { useProjectAssetUrl } = await importHook();
        const { result } = renderHook(() => useProjectAssetUrl(projectRef, "fallback"));
        await waitFor(() => expect(result.current.status).toBe("ready"));
        expect(result.current.url).toMatch(/^blob:/);
        expect(projectAssetsBridge.read).toHaveBeenCalledWith({ workspacePath: "/ws/p1", ref: projectRef });
    });

    it("re-resolves after an asset change event and lets the centralized cache revoke the old URL", async () => {
        const { useProjectAssetUrl } = await importHook();
        const { result } = renderHook(() => useProjectAssetUrl(projectRef, "fallback"));
        await waitFor(() => expect(result.current.status).toBe("ready"));
        const first = result.current.url;
        await act(async () => {
            changedListener!({ type: "changed", record: { ...record, revision: 2 } });
        });
        await waitFor(() => expect(result.current.url).not.toBe(first));
        expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
    });

    it("exposes an explicit missing state after a missing event", async () => {
        const { useProjectAssetUrl } = await importHook();
        const { result } = renderHook(() => useProjectAssetUrl(projectRef, "fallback"));
        await waitFor(() => expect(result.current.status).toBe("ready"));
        await act(async () => {
            changedListener!({ type: "missing", ref: projectRef });
        });
        await waitFor(() => expect(result.current.status).toBe("missing"));
        expect(result.current.url).toBe("fallback");
    });

    it("resolves again when the asset ref revision changes", async () => {
        const { useProjectAssetUrl } = await importHook();
        const { result, rerender } = renderHook(({ ref }: { ref: typeof projectRef }) => useProjectAssetUrl(ref, "fallback"), { initialProps: { ref: projectRef } });
        await waitFor(() => expect(result.current.status).toBe("ready"));
        const first = result.current.url;
        rerender({ ref: { ...projectRef, revision: 2 } });
        await waitFor(() => expect(result.current.url).not.toBe(first));
    });

    it("returns the fallback for refs without a project-file backend", async () => {
        const { useProjectAssetUrl } = await importHook();
        const { result } = renderHook(() => useProjectAssetUrl(undefined, "fallback"));
        expect(result.current).toEqual({ url: "fallback", status: "ready" });
        expect(projectAssetsBridge.read).not.toHaveBeenCalled();
    });

    it("does not commit a stale resolve that settles after a newer event-driven re-resolve", async () => {
        const { useProjectAssetUrl } = await importHook();
        let releaseFirstRead!: (value: { ok: true; value: { bytes: Uint8Array; record: typeof record } }) => void;
        const firstRead = new Promise<{ ok: true; value: { bytes: Uint8Array; record: typeof record } }>((resolve) => { releaseFirstRead = resolve; });
        projectAssetsBridge.read.mockImplementationOnce(() => firstRead).mockResolvedValue({ ok: true, value: { bytes: new Uint8Array([2]), record: { ...record, revision: 2 } } });
        const { result } = renderHook(() => useProjectAssetUrl(projectRef, "fallback"));
        await waitFor(() => expect(changedListener).toBeTruthy());
        // 初始 resolve 仍在途时收到 changed 事件，重解析先落定
        await act(async () => {
            changedListener!({ type: "changed", record: { ...record, revision: 2 } });
        });
        await waitFor(() => expect(result.current.status).toBe("ready"));
        const reResolvedUrl = result.current.url;
        // 再放行旧的在途 resolve，确认它不会覆盖新结果
        await act(async () => {
            releaseFirstRead({ ok: true, value: { bytes: new Uint8Array([1]), record } });
        });
        await act(async () => {});
        expect(result.current.url).toBe(reResolvedUrl);
        expect(result.current.status).toBe("ready");
    });

    it("keeps the explicit missing state when a stale in-flight resolve settles afterwards", async () => {
        const { useProjectAssetUrl } = await importHook();
        let releaseFirstRead!: (value: { ok: true; value: { bytes: Uint8Array; record: typeof record } }) => void;
        const firstRead = new Promise<{ ok: true; value: { bytes: Uint8Array; record: typeof record } }>((resolve) => { releaseFirstRead = resolve; });
        projectAssetsBridge.read.mockImplementationOnce(() => firstRead).mockResolvedValue({ ok: true, value: { bytes: new Uint8Array([1]), record } });
        const { result } = renderHook(() => useProjectAssetUrl(projectRef, "fallback"));
        await waitFor(() => expect(changedListener).toBeTruthy());
        await act(async () => {
            changedListener!({ type: "missing", ref: projectRef });
        });
        expect(result.current).toEqual({ url: "fallback", status: "missing" });
        await act(async () => {
            releaseFirstRead({ ok: true, value: { bytes: new Uint8Array([1]), record } });
        });
        await act(async () => {});
        expect(result.current).toEqual({ url: "fallback", status: "missing" });
    });

    it("unsubscribes from change events on unmount", async () => {
        const { useProjectAssetUrl } = await importHook();
        const { unmount } = renderHook(() => useProjectAssetUrl(projectRef, "fallback"));
        await waitFor(() => expect(changedListener).toBeTruthy());
        const readCalls = projectAssetsBridge.read.mock.calls.length;
        unmount();
        await act(async () => {
            changedListener!({ type: "changed", record: { ...record, revision: 2 } });
        });
        // 卸载后 hook 的监听已移除：事件不再触发重解析；桥级单例订阅由 facade 持有，不随组件清理。
        expect(projectAssetsBridge.read).toHaveBeenCalledTimes(readCalls);
        expect(unsubscribeChanged).not.toHaveBeenCalled();
    });
});
