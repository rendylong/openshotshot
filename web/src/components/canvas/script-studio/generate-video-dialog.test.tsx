// web/src/components/canvas/script-studio/generate-video-dialog.test.tsx
import { render, screen } from "@testing-library/react";
import { App as AntApp } from "antd";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { defaultConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { GenerateVideoDialog } from "./generate-video-dialog";

const effective = vi.hoisted(() => ({ config: null as AiConfig | null }));
vi.mock("@/stores/use-config-store", async importOriginal => {
    const actual = await importOriginal<typeof import("@/stores/use-config-store")>();
    return { ...actual, useEffectiveConfig: () => effective.config || actual.defaultConfig };
});

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
    useConfigStore.setState({ config: defaultConfig });
    effective.config = null;
});

describe("GenerateVideoDialog channel picker", () => {
    it("keeps the channel picker in BYOK mode", () => {
        useConfigStore.setState({ config: defaultConfig });
        renderDialog();
        // 触发器文本以实际渲染为准：无节点模型覆盖时 displayConfig.model 是原始编码 id
        // （default::grok-imagine-video），经 currentLabel 原样透出。
        expect(screen.getByText(/grok-imagine-video/)).toBeInTheDocument();
    });
});
