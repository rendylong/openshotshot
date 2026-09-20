import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ensureManagedCatalog, invalidateManagedCatalog, managedCatalogSnapshot, resetManagedCatalogForTests } from "@/lib/desktop/managed-catalog-cache";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { CapabilityModelPicker } from "./managed-model-picker";

const catalogModel = (id: string, capability: "image" | "video" | "text" | "audio", name = id) => ({ id, name, capability, execution: "direct" as const });
const shotshotConfig = {
    ...defaultConfig,
    credentialMode: "shotshot" as const,
    credentialModes: { agent: "shotshot", text: "shotshot", image: "shotshot", video: "shotshot", audio: "shotshot" } as const,
    managedModels: { text: "", image: "", video: "", audio: "" },
};

function mockBridge(models: ReturnType<typeof catalogModel>[]) {
    window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(async () => models), fetch: vi.fn(), abort: vi.fn() } } as never;
}

function pick(props: Partial<React.ComponentProps<typeof CapabilityModelPicker>> = {}) {
    return render(
        <I18nextProvider i18n={i18n}><AntApp>
            <CapabilityModelPicker config={shotshotConfig} capability="video" value="chan::minimax-video" onChange={vi.fn()} className="h-9" {...props} />
        </AntApp></I18nextProvider>,
    );
}

afterEach(() => {
    delete window.shotshot;
    resetManagedCatalogForTests();
    useConfigStore.setState({ config: defaultConfig });
});

describe("CapabilityModelPicker byok passthrough", () => {
    it("renders the original picker and forwards onChange untouched", () => {
        const onChange = vi.fn();
        render(
            <I18nextProvider i18n={i18n}><AntApp>
                <CapabilityModelPicker config={defaultConfig} capability="video" value="chan::minimax-video" onChange={onChange} />
            </AntApp></I18nextProvider>,
        );
        expect(screen.getByText(/minimax-video/)).toBeInTheDocument();
        fireEvent.click(screen.getByText(/minimax-video/));
        fireEvent.click(screen.getByText(/grok-imagine-video/));
        expect(onChange).toHaveBeenCalledWith("default::grok-imagine-video");
    });
});

describe("CapabilityModelPicker managed mode", () => {
    it("lists catalog names instead of channel models and hands the catalog id to onChange (node-level selection)", async () => {
        mockBridge([catalogModel("shotshot-video", "video", "ShotShot Video"), catalogModel("shotshot-video-lite", "video", "ShotShot Video Lite")]);
        useConfigStore.setState({ config: shotshotConfig });
        await ensureManagedCatalog();
        const onChange = vi.fn();
        pick({ onChange });

        expect(await screen.findByText("ShotShot Video")).toBeInTheDocument();
        expect(screen.queryByText("minimax-video")).not.toBeInTheDocument();
        fireEvent.click(screen.getByText("ShotShot Video"));
        expect(await screen.findByText("套餐内视频模型（2）")).toBeInTheDocument();
        fireEvent.click(await screen.findByText("ShotShot Video Lite"));

        await waitFor(() => expect(onChange).toHaveBeenCalledWith("shotshot-video-lite"));
        expect(useConfigStore.getState().config.managedModels.video).toBe("");
        expect(useConfigStore.getState().config.videoModel).toBe(defaultConfig.videoModel);
    });

    it("still lists and selects old catalog models when a refresh fails and the snapshot is stale", async () => {
        mockBridge([catalogModel("shotshot-video", "video", "ShotShot Video"), catalogModel("shotshot-video-lite", "video", "ShotShot Video Lite")]);
        useConfigStore.setState({ config: shotshotConfig });
        await ensureManagedCatalog();
        window.shotshot!.managedModels!.listModels = vi.fn(async () => {
            throw new Error("managed_catalog_unavailable");
        });
        invalidateManagedCatalog();
        await ensureManagedCatalog().catch(() => undefined);
        expect(managedCatalogSnapshot()?.status).toBe("stale");
        const onChange = vi.fn();
        pick({ onChange });

        expect(await screen.findByText("ShotShot Video")).toBeInTheDocument();
        fireEvent.click(screen.getByText("ShotShot Video"));
        fireEvent.click(await screen.findByText("ShotShot Video Lite"));

        await waitFor(() => expect(onChange).toHaveBeenCalledWith("shotshot-video-lite"));
        expect(managedCatalogSnapshot()?.status).toBe("stale");
    });

    it("shows the effective model (preference hit) as the trigger label", async () => {
        mockBridge([catalogModel("shotshot-video", "video", "ShotShot Video"), catalogModel("shotshot-video-lite", "video", "ShotShot Video Lite")]);
        const config = { ...shotshotConfig, managedModels: { text: "", image: "", video: "shotshot-video-lite", audio: "" } };
        useConfigStore.setState({ config });
        await ensureManagedCatalog();
        pick({ config });
        expect(await screen.findByText("ShotShot Video Lite")).toBeInTheDocument();
    });

    it("prefers the node's explicit catalog model over the plan preference", async () => {
        mockBridge([catalogModel("shotshot-video", "video", "ShotShot Video"), catalogModel("shotshot-video-lite", "video", "ShotShot Video Lite")]);
        const config = { ...shotshotConfig, managedModels: { text: "", image: "", video: "shotshot-video", audio: "" } };
        useConfigStore.setState({ config });
        await ensureManagedCatalog();
        pick({ config, nodeModel: "shotshot-video-lite" });
        expect(await screen.findByText("ShotShot Video Lite")).toBeInTheDocument();
    });

    it("falls back to the plan preference when the node model is absent or not in the catalog", async () => {
        mockBridge([catalogModel("shotshot-video", "video", "ShotShot Video"), catalogModel("shotshot-video-lite", "video", "ShotShot Video Lite")]);
        const config = { ...shotshotConfig, managedModels: { text: "", image: "", video: "shotshot-video", audio: "" } };
        useConfigStore.setState({ config });
        await ensureManagedCatalog();
        pick({ config, nodeModel: "removed-video" });
        expect(await screen.findByText("ShotShot Video")).toBeInTheDocument();
    });

    it("falls back to the first catalog model when the preference is stale", async () => {
        mockBridge([catalogModel("shotshot-video", "video", "ShotShot Video")]);
        const config = { ...shotshotConfig, managedModels: { text: "", image: "", video: "removed-video", audio: "" } };
        useConfigStore.setState({ config });
        await ensureManagedCatalog();
        pick({ config });
        expect(await screen.findByText("ShotShot Video")).toBeInTheDocument();
    });

    it("renders a static missing-capability label when the catalog has no such model", async () => {
        mockBridge([catalogModel("shotshot-video", "video", "ShotShot Video")]);
        await ensureManagedCatalog();
        render(
            <I18nextProvider i18n={i18n}><AntApp>
                <CapabilityModelPicker config={shotshotConfig} capability="image" value="" onChange={vi.fn()} />
            </AntApp></I18nextProvider>,
        );
        expect(await screen.findByText("套餐暂未包含图片模型")).toBeInTheDocument();
    });

    it("offers remote_task image models now that the managed image runner exists", async () => {
        window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(async () => [{ id: "gpt-image-2", name: "GPT Image 2", capability: "image", execution: "remote_task" }]), fetch: vi.fn(), abort: vi.fn() } } as never;
        useConfigStore.setState({ config: shotshotConfig });
        await ensureManagedCatalog();
        const onChange = vi.fn();
        render(
            <I18nextProvider i18n={i18n}><AntApp>
                <CapabilityModelPicker config={shotshotConfig} capability="image" value="" onChange={onChange} />
            </AntApp></I18nextProvider>,
        );
        expect(await screen.findByText("GPT Image 2")).toBeInTheDocument();
        fireEvent.click(screen.getByText("GPT Image 2"));
        expect(await screen.findByText("套餐内图片模型（1）")).toBeInTheDocument();
        // The trigger and the single option share the label; click the option in the opened dropdown.
        const options = screen.getAllByText("GPT Image 2");
        fireEvent.click(options[options.length - 1]!);
        await waitFor(() => expect(onChange).toHaveBeenCalledWith("gpt-image-2"));
        expect(useConfigStore.getState().config.managedModels.image).toBe("");
    });

    it("renders the audio not-provided label for audio capability", async () => {
        mockBridge([catalogModel("shotshot-video", "video", "ShotShot Video")]);
        await ensureManagedCatalog();
        render(
            <I18nextProvider i18n={i18n}><AntApp>
                <CapabilityModelPicker config={shotshotConfig} capability="audio" value="" onChange={vi.fn()} />
            </AntApp></I18nextProvider>,
        );
        expect(await screen.findByText("套餐暂未提供音频模型")).toBeInTheDocument();
    });

    it("renders a neutral provided label before the catalog hydrates", () => {
        useConfigStore.setState({ config: shotshotConfig });
        pick();
        expect(screen.getByText("由 shotshot 套餐提供")).toBeInTheDocument();
    });
});
