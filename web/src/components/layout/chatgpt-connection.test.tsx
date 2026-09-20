import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "antd";
import "@/i18n";
import { ChatGptConnection } from "./chatgpt-connection";
import { useAiSourceStore } from "@/stores/use-ai-source-store";
import { useChatGptStore } from "@/stores/use-chatgpt-store";
const signIn = vi.fn(async () => undefined), respond = vi.fn(async () => undefined), cancelSignIn = vi.fn(async () => undefined);
beforeEach(() => { vi.clearAllMocks(); useChatGptStore.setState({ status: { state: "signed-out" }, models: [] }); useAiSourceStore.setState({ preferences: { version: 1, selections: {} } }); Object.defineProperty(window, "shotshot", { configurable: true, value: { chatgpt: { signIn, respond, cancelSignIn, getStatus: async () => ({ state: "signed-out" }), getModels: async () => [], onStatusChanged: () => () => undefined } } }); });
afterEach(() => { delete window.shotshot; });
test("login does not activate a model source", async () => {
    render(<App><ChatGptConnection /></App>);
    fireEvent.click(screen.getByRole("button", { name: /登录 ChatGPT|Sign in with ChatGPT/ }));
    await waitFor(() => expect(signIn).toHaveBeenCalledOnce());
    expect(useAiSourceStore.getState().preferences.selections.agent).toBeUndefined();
});
test("independent Web explains desktop requirement", () => {
    delete window.shotshot; render(<App><ChatGptConnection /></App>);
    expect(screen.queryByRole("button", { name: /登录 ChatGPT|Sign in with ChatGPT/ })).toBeNull();
    expect(screen.getByText(/桌面应用|desktop app/)).toBeDefined();
});

test("secure storage failure gives an actionable explanation instead of generic login advice", () => {
    useChatGptStore.setState({ status: { state: "error", errorCode: "protection_unavailable" } });
    render(<App><ChatGptConnection /></App>);
    expect(screen.getByRole("alert").textContent).toMatch(/钥匙串|keychain/i);
});
