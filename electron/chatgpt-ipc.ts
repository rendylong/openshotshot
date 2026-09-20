import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { CHATGPT_CHANNELS as CH } from "@/lib/agent/ai-source-types";
import type { ChatGptAuthController } from "./chatgpt-auth";
export function isTrustedRendererUrl(actual: string, expected: string): boolean {
    try {
        const actualUrl = new URL(actual); const expectedUrl = new URL(expected);
        actualUrl.hash = ""; actualUrl.search = ""; expectedUrl.hash = ""; expectedUrl.search = "";
        return actualUrl.href === expectedUrl.href;
    } catch { return false; }
}
export function isTrustedChatGptSender(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">, win: BrowserWindow | null, rendererUrl: string): boolean {
    return !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && isTrustedRendererUrl(event.senderFrame?.url ?? "", rendererUrl);
}
export function registerChatGptIpc(getWindow: () => BrowserWindow | null, controller: ChatGptAuthController, rendererUrl: string) {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {
        [CH.status]: () => controller.getStatus(), [CH.signIn]: () => controller.signIn(),
        [CH.cancel]: () => controller.cancelSignIn(), [CH.signOut]: () => controller.signOut(),
        [CH.models]: () => controller.getModels(),
        [CH.respond]: (id, value) => { if (typeof id !== "string" || !id || typeof value !== "string") throw new Error("invalid_auth_response"); return controller.respond(id, value); },
    };
    for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, (event, ...args) => {
        if (!isTrustedChatGptSender(event, getWindow(), rendererUrl)) throw new Error("untrusted_sender");
        return handler(...args);
    });
    return () => { for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel); controller.dispose(); };
}
