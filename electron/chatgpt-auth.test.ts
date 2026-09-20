import { expect, test, vi } from "vitest";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { createChatGptAuthController, validateChatGptAuthUrl } from "./chatgpt-auth";
function setup(login?: (interaction: AuthInteraction) => Promise<unknown>) {
    let signedIn = false;
    const runtime = {
        checkAuth: vi.fn(async () => signedIn ? { type: "oauth" as const } : undefined),
        getModels: vi.fn(() => []),
        logout: vi.fn(async () => { signedIn = false; }),
        login: vi.fn(async (_p: string, _t: string, interaction: AuthInteraction) => { await login?.(interaction); signedIn = true; return { type: "oauth" as const, access: "sentinel-access", refresh: "sentinel-refresh", expires: 1 }; }),
    };
    const checkStorage = vi.fn(async () => undefined);
    const onStatus = vi.fn(), openExternal = vi.fn(async () => undefined), beforeSignOut = vi.fn(async (): Promise<void> => undefined);
    const controller = createChatGptAuthController({ getRuntime: async () => runtime, checkStorage, openExternal, onStatus, beforeSignOut });
    return { controller, runtime, checkStorage, onStatus, openExternal, beforeSignOut };
}
test("browser authorization projects safe status only", async () => {
    const h = setup(async interaction => { interaction.notify({ type: "auth_url", url: "https://auth.openai.com/oauth/authorize?state=test" }); });
    await h.controller.signIn();
    await vi.waitFor(() => expect(h.onStatus).toHaveBeenLastCalledWith({ state: "signed-in" }));
    expect(h.openExternal).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.onStatus.mock.calls)).not.toContain("sentinel");
});
test("rejects stale answers, duplicate attempts and clears pending manual code on cancel", async () => {
    const h = setup(async interaction => { await interaction.prompt({ type: "manual_code", message: "hidden" }); });
    await h.controller.signIn(); await h.controller.signIn();
    await vi.waitFor(() => expect(h.onStatus.mock.calls.at(-1)?.[0].prompt).toBeDefined());
    await expect(h.controller.respond("stale", "sentinel-code")).rejects.toThrow();
    expect(h.runtime.login).toHaveBeenCalledOnce();
    await h.controller.cancelSignIn();
    expect(await h.controller.getStatus()).toEqual({ state: "signed-out" });
    expect(JSON.stringify(h.onStatus.mock.calls)).not.toContain("sentinel");
});
test("per-prompt abort releases manual input while callback succeeds", async () => {
    const h = setup(async interaction => {
        const abort = new AbortController();
        const answer = interaction.prompt({ type: "manual_code", message: "hidden", signal: abort.signal }).catch(() => undefined);
        abort.abort(); await answer;
    });
    await h.controller.signIn();
    await vi.waitFor(() => expect(h.onStatus).toHaveBeenLastCalledWith({ state: "signed-in" }));
});
test("late login completion after cancellation cannot leave a credential active", async () => {
    let finish!: () => void;
    const h = setup(async () => new Promise<void>(resolve => { finish = resolve; }));
    await h.controller.signIn(); await vi.waitFor(() => expect(finish).toBeDefined());
    const cancelled = h.controller.cancelSignIn(); finish(); await cancelled;
    expect(h.runtime.logout).toHaveBeenCalledOnce();
    expect(await h.controller.isReady()).toBe(false);
});
test("logout blocks readiness before abort and credential deletion", async () => {
    const h = setup(); await h.controller.signIn();
    await vi.waitFor(() => expect(h.onStatus).toHaveBeenLastCalledWith({ state: "signed-in" }));
    let finish!: () => void;
    h.beforeSignOut.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const logout = h.controller.signOut();
    expect(await h.controller.isReady()).toBe(false);
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(h.runtime.logout).not.toHaveBeenCalled();
    finish(); await logout; expect(h.runtime.logout).toHaveBeenCalledOnce();
});
test.each(["http://auth.openai.com/a", "https://auth.openai.com.evil.test/a", "https://user:pass@auth.openai.com/a", "https://evil.test"])("rejects unsafe auth URL %s", url => expect(() => validateChatGptAuthUrl(url)).toThrow());
test("does not expose SDK error content", async () => {
    const h = setup(async () => { throw new Error("sentinel-access"); }); await h.controller.signIn();
    await vi.waitFor(() => expect(h.onStatus).toHaveBeenLastCalledWith({ state: "error", errorCode: "login_failed" }));
    expect(JSON.stringify(h.onStatus.mock.calls)).not.toContain("sentinel");
});

test("unavailable keychain stops login before opening authorization and can recover", async () => {
    const h = setup();
    h.checkStorage.mockRejectedValueOnce(new Error("chatgpt_protection_unavailable"));
    await h.controller.signIn();
    await vi.waitFor(() => expect(h.onStatus).toHaveBeenLastCalledWith({ state: "error", errorCode: "protection_unavailable" }));
    expect(h.runtime.login).not.toHaveBeenCalled();
    await h.controller.signIn();
    await vi.waitFor(() => expect(h.onStatus).toHaveBeenLastCalledWith({ state: "signed-in" }));
});
test("storage failure wrapped by the SDK remains distinct from authorization failure", async () => {
    const h = setup(async () => { throw new Error("Credential store modify failed", { cause: new Error("chatgpt_protection_unavailable") }); });
    await h.controller.signIn();
    await vi.waitFor(() => expect(h.onStatus).toHaveBeenLastCalledWith({ state: "error", errorCode: "protection_unavailable" }));
});
test("network failure is not reported as a secure storage problem", async () => {
    const h = setup(async () => { throw new Error("chatgpt_network_failed"); });
    await h.controller.signIn();
    await vi.waitFor(() => expect(h.onStatus).toHaveBeenLastCalledWith({ state: "error", errorCode: "network_failed" }));
});
