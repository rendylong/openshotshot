import { randomUUID } from "node:crypto";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ChatGptStatus } from "@/lib/agent/ai-source-types";
import { CHATGPT_PROVIDER } from "./chatgpt-credentials";

type Runtime = Pick<ModelRuntime, "login" | "logout" | "checkAuth" | "getModels">;
function authErrorCode(error: unknown, fallback: NonNullable<ChatGptStatus["errorCode"]>): NonNullable<ChatGptStatus["errorCode"]> {
    const seen = new Set<unknown>();
    while (error instanceof Error && !seen.has(error)) {
        seen.add(error);
        if (error.message === "chatgpt_protection_unavailable") return "protection_unavailable";
        if (["chatgpt_storage_failed", "invalid_chatgpt_credentials"].includes(error.message)) return "storage_failed";
        if (error.message === "chatgpt_network_failed" || (error instanceof TypeError && error.message === "fetch failed")) return "network_failed";
        error = error.cause;
    }
    return fallback;
}

export function validateChatGptAuthUrl(raw: string): string {
    const url = new URL(raw);
    if (url.origin !== "https://auth.openai.com" || url.username || url.password) throw new Error("unsafe_auth_url");
    return url.href;
}
export function createChatGptAuthController(options: {
    getRuntime(): Promise<Runtime>;
    checkStorage(): Promise<void>;
    openExternal(url: string): Promise<unknown>;
    onStatus(status: ChatGptStatus): void;
    beforeSignOut(): Promise<void>;
}) {
    let status: ChatGptStatus = { state: "signed-out" };
    let attempt: AbortController | undefined;
    let operation: Promise<void> | undefined;
    let signingOut = false;
    let disposed = false;
    let revision = 0;
    let pending: { id: string; answer(value: string): void; cancel(): void; options?: readonly { id: string }[] } | undefined;
    const publish = (next: ChatGptStatus) => { revision += 1; status = next; if (!disposed) options.onStatus(next); };
    const getStatus = async (): Promise<ChatGptStatus> => {
        if (attempt || signingOut || status.state === "error") return status;
        const readingRevision = revision;
        try {
            const runtime = await options.getRuntime();
            const auth = await runtime.checkAuth(CHATGPT_PROVIDER);
            if (!attempt && !signingOut && readingRevision === revision) status = { state: auth?.type === "oauth" ? "signed-in" : "signed-out" };
        } catch (error) { if (readingRevision === revision) status = { state: "error", errorCode: authErrorCode(error, "storage_failed") }; }
        return status;
    };
    const cancel = async () => {
        attempt?.abort(); pending?.cancel();
        await operation;
    };
    return {
        getStatus,
        async isReady() { return !signingOut && !disposed && (await getStatus()).state === "signed-in"; },
        async signIn() {
            if (disposed || signingOut || attempt) return;
            const callbackHost = process.env.PI_OAUTH_CALLBACK_HOST;
            if (callbackHost && callbackHost !== "127.0.0.1" && callbackHost !== "localhost") { publish({ state: "error", errorCode: "unavailable" }); return; }
            const current = new AbortController(); attempt = current;
            publish({ state: "signing-in" });
            operation = (async () => {
                try {
                    await options.checkStorage();
                    current.signal.throwIfAborted();
                    const runtime = await options.getRuntime();
                    current.signal.throwIfAborted();
                    await runtime.login(CHATGPT_PROVIDER, "oauth", {
                        signal: current.signal,
                        prompt: (prompt: AuthPrompt) => new Promise<string>((resolve, reject) => {
                            if (current.signal.aborted || prompt.signal?.aborted) { reject(new Error("cancelled")); return; }
                            const id = randomUUID();
                            const clean = () => { current.signal.removeEventListener("abort", onAbort); prompt.signal?.removeEventListener("abort", onAbort); if (pending?.id === id) pending = undefined; };
                            const onAbort = () => { clean(); reject(new Error("cancelled")); };
                            pending = { id, options: prompt.type === "select" ? prompt.options : undefined, answer: value => { clean(); publish({ state: "signing-in" }); resolve(value); }, cancel: onAbort };
                            current.signal.addEventListener("abort", onAbort, { once: true }); prompt.signal?.addEventListener("abort", onAbort, { once: true });
                            publish({ state: "signing-in", prompt: { id, type: prompt.type, ...(prompt.type === "select" ? { options: prompt.options.map(({ id, label }) => ({ id, label })) } : {}) } });
                        }),
                        notify: event => {
                            current.signal.throwIfAborted();
                            if (event.type === "auth_url") {
                                const url = validateChatGptAuthUrl(event.url);
                                void options.openExternal(url).catch(() => { current.abort(); publish({ state: "error", errorCode: "login_failed" }); });
                            }
                            if (event.type === "device_code") publish({ state: "signing-in", deviceCode: { userCode: event.userCode, verificationUri: validateChatGptAuthUrl(event.verificationUri) } });
                        },
                    });
                    if (current.signal.aborted) { await runtime.logout(CHATGPT_PROVIDER); publish({ state: "signed-out" }); }
                    else publish({ state: "signed-in" });
                } catch (error) { publish(current.signal.aborted ? { state: "signed-out" } : { state: "error", errorCode: authErrorCode(error, "login_failed") }); }
                finally { pending?.cancel(); attempt = undefined; operation = undefined; }
            })();
        },
        cancelSignIn: cancel,
        async respond(id: string, value: string) {
            if (!pending || pending.id !== id || !attempt || attempt.signal.aborted || (pending.options && !pending.options.some(o => o.id === value))) throw new Error("invalid_auth_response");
            pending.answer(value);
        },
        async signOut() {
            if (signingOut) return;
            signingOut = true; publish({ state: "signed-out" });
            try { await cancel(); await options.beforeSignOut(); await (await options.getRuntime()).logout(CHATGPT_PROVIDER); publish({ state: "signed-out" }); }
            catch (error) { publish({ state: "error", errorCode: authErrorCode(error, "storage_failed") }); throw new Error("chatgpt_logout_failed"); }
            finally { signingOut = false; }
        },
        async getModels() {
            if (!(await this.isReady())) return [];
            return (await options.getRuntime()).getModels(CHATGPT_PROVIDER).filter(model => model.input.includes("text")).map(model => ({ id: model.id, name: model.name, supportsImageInput: model.input.includes("image") }));
        },
        dispose() { disposed = true; attempt?.abort(); pending?.cancel(); },
    };
}
export type ChatGptAuthController = ReturnType<typeof createChatGptAuthController>;
