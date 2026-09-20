import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { APP_RELEASE_CHANNELS } from "../web/src/lib/desktop/app-release-bridge";
import type { AppReleaseController } from "./app-release-controller";

type AppReleaseIpcOptions = {
    ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
    controller: AppReleaseController;
    isTrustedSender(sender: WebContents): boolean;
    recipients(): WebContents[];
};

export function registerAppReleaseIpc(options: AppReleaseIpcOptions): () => void {
    const trusted = (event: IpcMainInvokeEvent) => {
        if (!options.isTrustedSender(event.sender)) throw new Error("untrusted_ipc_sender");
    };
    const handlers: Array<[string, (event: IpcMainInvokeEvent) => unknown]> = [
        [APP_RELEASE_CHANNELS.getState, (event) => { trusted(event); return options.controller.getState(); }],
        [APP_RELEASE_CHANNELS.refresh, async (event) => { trusted(event); return options.controller.refresh(); }],
        [APP_RELEASE_CHANNELS.openDownload, async (event) => { trusted(event); await options.controller.openDownload(); }],
    ];
    for (const [channel, handler] of handlers) options.ipcMain.handle(channel, handler);
    const unsubscribe = options.controller.subscribe((state) => {
        for (const recipient of options.recipients()) {
            if (!recipient.isDestroyed()) recipient.send(APP_RELEASE_CHANNELS.changed, state);
        }
    });
    return () => {
        unsubscribe();
        for (const [channel] of handlers) options.ipcMain.removeHandler(channel);
    };
}
