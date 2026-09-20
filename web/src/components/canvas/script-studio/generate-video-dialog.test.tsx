// web/src/components/canvas/script-studio/generate-video-dialog.test.tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ensureManagedCatalog, resetManagedCatalogForTests } from "@/lib/desktop/managed-catalog-cache";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { defaultConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { GenerateVideoDialog } from "./generate-video-dialog";

const effective = vi.hoisted(() => ({ config: null as AiConfig | null }));
vi.mock("@/stores/use-config-store", async importOriginal => {
    const actual = await importOriginal<typeof import("@/stores/use-config-store")>();
    return { ...actual, useEffectiveConfig: () => effective.config || actual.defaultConfig };
});

function buildShotshotConfig() {
    return {
        ...defaultConfig,
        credentialMode: "shotshot" as const,
        credentialModes: { agent: "shotshot", text: "shotshot", image: "shotshot", video: "shotshot", audio: "shotshot" } as const,
        managedModels: { text: "", image: "", video: "", audio: "" },
    };
}
const node: CanvasNodeData = { id: "shot-node", type: CanvasNodeType.Video, title: "Shot 1", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: {} };

function renderDialog(overrides: { node?: CanvasNodeData; onConfirm?: (settings: Partial<CanvasNodeData["metadata"]>) => void } = {}) {
    return render(
        <I18nextProvider i18n={i18n}><AntApp>
            <GenerateVideoDialog open mode="generate" shotNo={1} node={overrides.node ?? node} onConfirm={overrides.onConfirm ?? vi.fn()} onCancel={vi.fn()} />
        </AntApp></I18nextProvider>,
    );
}

afterEach(() => {
    delete window.shotshot;
    resetManagedCatalogForTests();
    useConfigStore.setState({ config: defaultConfig });
    effective.config = null;
});

describe("GenerateVideoDialog managed picker", () => {
    it("lists plan catalog models and commits the selection into the node settings on confirm", async () => {
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(async () => [{ id: "shotshot-video", name: "ShotShot Video", capability: "video" as const, execution: "remote_task" as const }, { id: "shotshot-video-lite", name: "ShotShot Video Lite", capability: "video" as const, execution: "remote_task" as const }]), fetch: vi.fn(), abort: vi.fn() } } as never;
        const config = buildShotshotConfig();
        effective.config = config;
        useConfigStore.setState({ config });
        const onConfirm = vi.fn();
        renderDialog({ onConfirm });

        expect(await screen.findByText("ShotShot Video")).toBeInTheDocument();
        fireEvent.click(screen.getByText("ShotShot Video"));
        fireEvent.click(await screen.findByText("ShotShot Video Lite"));
        fireEvent.click(screen.getByText(i18n.t("canvas.scriptCompose.confirmGenerate")));

        await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ model: "shotshot-video-lite" })));
        expect(useConfigStore.getState().config.managedModels.video).toBe("");
    });

    it("shows the node's explicit catalog model over the plan preference", async () => {
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(async () => [{ id: "shotshot-video", name: "ShotShot Video", capability: "video" as const, execution: "remote_task" as const }, { id: "shotshot-video-lite", name: "ShotShot Video Lite", capability: "video" as const, execution: "remote_task" as const }]), fetch: vi.fn(), abort: vi.fn() } } as never;
        const config = { ...buildShotshotConfig(), managedModels: { text: "", image: "", video: "shotshot-video", audio: "" } };
        effective.config = config;
        useConfigStore.setState({ config });
        renderDialog({ node: { ...node, metadata: { model: "shotshot-video-lite" } } });
        expect(await screen.findByText("ShotShot Video Lite")).toBeInTheDocument();
    });

    it("keeps the channel picker in BYOK mode", () => {
        useConfigStore.setState({ config: defaultConfig });
        renderDialog();
        // 触发器文本以实际渲染为准：无节点模型覆盖时 displayConfig.model 是原始编码 id
        // （default::grok-imagine-video），经 currentLabel 原样透出。
        expect(screen.getByText(/grok-imagine-video/)).toBeInTheDocument();
    });
});
