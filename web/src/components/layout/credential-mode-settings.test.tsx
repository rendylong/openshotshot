import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CredentialModeSettings } from "./credential-mode-settings";
import i18n from "@/i18n";
import type { AccountBridge } from "@/lib/desktop/account-bridge";
import type { DesktopAccountSnapshot } from "@/lib/desktop/auth-types";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { useAiSourceStore } from "@/stores/use-ai-source-store";

const bridge = {} as AccountBridge;
const snapshot: DesktopAccountSnapshot = {
    account: { subjectId: "subject-1", email: "user@example.com", displayName: "User", avatarUrl: null },
    subscription: { plan: "pro", status: "active", currentPeriodEndsAt: null, cancelAtPeriodEnd: false },
    usage: { balance: 100, usedUnits: 20, periodStart: "2026-09-01", periodEnd: "2026-10-01" },
    entitlements: [{ code: "managed-models", state: "active", limitValue: 1000, validUntil: null }],
    fetchedAt: "2026-09-05T00:00:00.000Z",
};

function view() {
    return render(<I18nextProvider i18n={i18n}><CredentialModeSettings /></I18nextProvider>);
}

afterEach(() => {
    useConfigStore.setState({ config: defaultConfig });
    useUserStore.setState({ account: { state: "signed-out" } });
    delete window.shotshot;
});

describe("CredentialModeSettings", () => {
    test("selects Shotshot only for an eligible desktop account and hydrates its catalog", async () => {
        useAiSourceStore.setState({ status: "ready", error: null, applying: false, preferences: { version: 1, selections: { agent: { source: "chatgpt", modelId: "prior-chatgpt-model" } } } });
        window.shotshot = {
            account: bridge,
            agent: {} as never,
            skills: {} as never,
            platform: "darwin",
            managedModels: {
                listModels: vi.fn(async () => [
                    { id: "managed-text", name: "Text", capability: "text" as const, execution: "direct" as const },
                    { id: "managed-image", name: "Image", capability: "image" as const, execution: "direct" as const },
                ]),
                fetch: vi.fn(),
                abort: vi.fn(),
            },
        };
        useUserStore.setState({ account: { state: "ready", snapshot } });
        view();
        fireEvent.click(screen.getByRole("button", { name: /Shotshot 套餐/ }));
        await waitFor(() => expect(useConfigStore.getState().config.credentialMode).toBe("shotshot"));
        expect(useConfigStore.getState().config.managedModels).toMatchObject({ text: "managed-text", image: "managed-image" });
        expect(useAiSourceStore.getState().preferences.selections.agent).toBeUndefined();
    });

    test("explains an empty published catalog without reporting a transport failure", async () => {
        window.shotshot = {
            account: bridge,
            agent: {} as never,
            skills: {} as never,
            platform: "darwin",
            managedModels: { listModels: vi.fn(async () => []), fetch: vi.fn(), abort: vi.fn() },
        };
        useUserStore.setState({ account: { state: "ready", snapshot } });
        view();

        fireEvent.click(screen.getByRole("button", { name: /Shotshot 套餐/ }));

        expect(await screen.findByText("当前套餐暂时没有可用模型，请稍后再试。")).toBeInTheDocument();
        expect(screen.queryByText("暂时无法读取套餐模型，请稍后重试。")).not.toBeInTheDocument();
        expect(useConfigStore.getState().config.credentialMode).toBe("byok");
    });

    test("starts sign-in without changing mode when signed out", () => {
        const signIn = vi.fn(async () => undefined);
        window.shotshot = { account: bridge, agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels: vi.fn(), fetch: vi.fn(), abort: vi.fn() } };
        useUserStore.setState({ account: { state: "signed-out" }, signIn });
        view();
        fireEvent.click(screen.getByRole("button", { name: /Shotshot 套餐/ }));
        expect(signIn).toHaveBeenCalledOnce();
        expect(useConfigStore.getState().config.credentialMode).toBe("byok");
    });

    test("lets a signed-in free user select Shotshot from the published model catalog", async () => {
        const openAccountPage = vi.fn(async () => undefined);
        window.shotshot = {
            account: bridge,
            agent: {} as never,
            skills: {} as never,
            platform: "darwin",
            managedModels: {
                listModels: vi.fn(async () => [{ id: "free-image", name: "Free Image", capability: "image" as const, execution: "direct" as const }]),
                fetch: vi.fn(),
                abort: vi.fn(),
            },
        };
        useUserStore.setState({
            account: {
                state: "ready",
                snapshot: {
                    ...snapshot,
                    subscription: { ...snapshot.subscription, plan: "free" },
                    entitlements: [],
                },
            },
            openAccountPage,
        });
        view();
        fireEvent.click(screen.getByRole("button", { name: /Shotshot 套餐/ }));
        await waitFor(() => expect(useConfigStore.getState().config.credentialMode).toBe("shotshot"));
        expect(useConfigStore.getState().config.managedModels.image).toBe("free-image");
        expect(openAccountPage).not.toHaveBeenCalled();
    });

    test("keeps BYOK always available and never mutates its provider settings", async () => {
        useConfigStore.setState({ config: { ...defaultConfig, credentialMode: "shotshot", channels: defaultConfig.channels.map((item) => ({ ...item, apiKey: "keep-me" })) } });
        view();
        fireEvent.click(screen.getByRole("button", { name: /我的 API Key/ }));
        await waitFor(() => expect(useConfigStore.getState().config).toMatchObject({ credentialMode: "byok", channels: [{ apiKey: "keep-me" }] }));
    });

    test("allows a managed video source while keeping text and BYOK as separate choices", async () => {
        window.shotshot = {
            account: bridge,
            agent: {} as never,
            skills: {} as never,
            platform: "darwin",
            managedModels: {
                listModels: vi.fn(async () => [{ id: "managed-video", name: "Video", capability: "video" as const, execution: "remote_task" as const }]),
                fetch: vi.fn(),
                abort: vi.fn(),
            },
        };
        useUserStore.setState({ account: { state: "ready", snapshot } });
        view();
        fireEvent.click(screen.getByRole("button", { name: "video:shotshot" }));
        await waitFor(() => expect(useConfigStore.getState().config.credentialModes.video).toBe("shotshot"));
        expect(useConfigStore.getState().config.credentialModes.text).toBe("byok");
        expect(useConfigStore.getState().config.credentialModes.image).toBe("byok");
        expect(useConfigStore.getState().config.managedModels.video).toBe("managed-video");
    });

    test("does not block the all-card switch when the catalog lacks text models", async () => {
        window.shotshot = {
            account: bridge,
            agent: {} as never,
            skills: {} as never,
            platform: "darwin",
            managedModels: { listModels: vi.fn(async () => [{ id: "managed-video", name: "Video", capability: "video" as const, execution: "remote_task" as const }]), fetch: vi.fn(), abort: vi.fn() },
        };
        useUserStore.setState({ account: { state: "ready", snapshot } });
        view();
        fireEvent.click(screen.getByRole("button", { name: /Shotshot 套餐/ }));
        await waitFor(() => expect(useConfigStore.getState().config.credentialMode).toBe("shotshot"));
        expect(useConfigStore.getState().config.credentialModes).toEqual({ agent: "shotshot", text: "shotshot", image: "shotshot", video: "shotshot", audio: "shotshot" });
        expect(useConfigStore.getState().config.managedModels).toEqual({ text: "", image: "", video: "managed-video", audio: "" });
    });
});
