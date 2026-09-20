import { useEffect, useRef } from "react";
import { act, render } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App as AntApp } from "antd";

import i18n from "@/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import type { ProjectAssetSource } from "@/lib/project-assets/project-asset-types";
import { useConfigStore, defaultConfig } from "@/stores/use-config-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import type { CanvasPluginAi } from "@/types/canvas-plugin";
import { usePluginHost } from "./use-plugin-host";

const requestVideoGeneration = vi.hoisted(() => vi.fn());
const storeGeneratedVideo = vi.hoisted(() => vi.fn());

vi.mock("@/services/api/video", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/services/api/video")>()),
    requestVideoGeneration,
    storeGeneratedVideo,
}));

const STORED_VIDEO_REF = { backend: "project-file" as const, assetId: "asset-plugin-video", projectId: "project-1", relativePath: "assets/generated/videos/plugin.mp4", revision: 1 };

// 与画布页 assetWriteContext 同构的显式写上下文（不读全局活动项目）。
const assetWriteContext = (source: ProjectAssetSource) => ({
    projectId: "project-1",
    projectTitle: "Project One",
    workspacePath: "/ws/project-1",
    canvasId: "canvas-1",
    source: { ...source, canvasId: "canvas-1" },
});

let pluginAi: CanvasPluginAi | null = null;

function Harness() {
    const nodesRef = useRef<CanvasNodeData[]>([]);
    const connectionsRef = useRef<CanvasConnection[]>([]);
    const viewportRef = useRef({ x: 0, y: 0, k: 1 });
    const config = useConfigStore((state) => state.config);
    const { pluginHost } = usePluginHost({
        effectiveConfig: config,
        isAiConfigReady: () => true,
        openConfigDialog: () => undefined,
        theme: canvasThemes.light,
        nodesRef,
        connectionsRef,
        viewportRef,
        setNodes: () => undefined,
        setDialogNodeId: () => undefined,
        applyAgentOps: () => undefined,
        open3dPreview: () => undefined,
        assetWriteContext,
    });
    useEffect(() => {
        pluginAi = pluginHost.ai;
    }, [pluginHost]);
    return null;
}

describe("usePluginHost ai generation", () => {
    beforeEach(() => {
        requestVideoGeneration.mockReset();
        requestVideoGeneration.mockResolvedValue({ url: "data:video/mp4;base64,AAAA", width: 640, height: 360 });
        storeGeneratedVideo.mockReset();
        storeGeneratedVideo.mockResolvedValue({ url: "blob:stored-video", assetRef: STORED_VIDEO_REF, width: 640, height: 360, bytes: 4, mimeType: "video/mp4", durationMs: 4000, storageKey: "video:stored" });
        useConfigStore.setState({
            config: { ...defaultConfig, channels: [{ ...defaultConfig.channels[0]!, apiKey: "test-key" }] },
        });
    });

    it("stores plugin-generated video through the project asset facade with canvas context", async () => {
        render(
            <I18nextProvider i18n={i18n}>
                <AntApp>
                    <Harness />
                </AntApp>
            </I18nextProvider>,
        );
        expect(pluginAi).not.toBeNull();
        await act(async () => {
            await pluginAi!.generateVideo("orbit shot");
        });
        expect(storeGeneratedVideo).toHaveBeenCalledTimes(1);
        expect(storeGeneratedVideo).toHaveBeenCalledWith(expect.objectContaining({ url: "data:video/mp4;base64,AAAA" }), expect.objectContaining({
            projectId: "project-1",
            canvasId: "canvas-1",
            source: expect.objectContaining({ type: "generated", canvasId: "canvas-1" }),
        }));
    });
});
