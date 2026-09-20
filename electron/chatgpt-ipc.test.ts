import { expect, test, vi } from "vitest";
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { isTrustedChatGptSender, registerChatGptIpc } from "./chatgpt-ipc";
import type { ChatGptAuthController } from "./chatgpt-auth";
test("requires current window and exact main frame", () => {
    const mainFrame = { url: "http://localhost:3000/" }; const webContents = { mainFrame };
    const win = { isDestroyed: () => false, webContents } as unknown as BrowserWindow;
    expect(isTrustedChatGptSender({ sender: webContents, senderFrame: mainFrame } as IpcMainInvokeEvent, win, "http://localhost:3000/")).toBe(true);
    expect(isTrustedChatGptSender({ sender: webContents, senderFrame: {} } as IpcMainInvokeEvent, win, "http://localhost:3000/")).toBe(false);
    expect(isTrustedChatGptSender({ sender: {}, senderFrame: mainFrame } as IpcMainInvokeEvent, win, "http://localhost:3000/")).toBe(false);
});
test("removes every fixed handler and disposes controller", () => {
    const dispose = vi.fn(); const cleanup = registerChatGptIpc(() => null, { dispose } as unknown as ChatGptAuthController, "http://localhost:3000/");
    cleanup(); expect(ipcMain.handle).toHaveBeenCalledTimes(6); expect(ipcMain.removeHandler).toHaveBeenCalledTimes(6); expect(dispose).toHaveBeenCalledOnce();
});

test("rejects navigation outside the trusted renderer URL", () => {
    const mainFrame = { url: "https://evil.test/" }; const webContents = { mainFrame };
    const win = { isDestroyed: () => false, webContents } as unknown as BrowserWindow;
    expect(isTrustedChatGptSender({ sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent, win, "http://localhost:3000/")).toBe(false);
});
