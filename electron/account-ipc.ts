import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { ACCOUNT_CHANNELS, type ReferralInfo } from "../web/src/lib/desktop/account-bridge";
import type { AuthController } from "./auth-controller";

type AccountIpcOptions = {
    ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
    controller: AuthController;
    isTrustedSender(sender: WebContents): boolean;
    recipients(): WebContents[];
    referralInfo(): Promise<ReferralInfo>;
};

export function registerAccountIpc(options: AccountIpcOptions): () => void {
    const trusted = (event: IpcMainInvokeEvent) => {
        if (!options.isTrustedSender(event.sender)) throw new Error("untrusted_ipc_sender");
    };
    const handlers: Array<[string, (event: IpcMainInvokeEvent) => unknown]> = [
        [ACCOUNT_CHANNELS.getState, (event) => { trusted(event); return options.controller.getState(); }],
        [ACCOUNT_CHANNELS.signIn, async (event) => { trusted(event); await options.controller.signIn(); }],
        [ACCOUNT_CHANNELS.retrySignIn, async (event) => { trusted(event); await options.controller.retrySignIn(); }],
        [ACCOUNT_CHANNELS.cancelSignIn, async (event) => { trusted(event); await options.controller.cancelSignIn(); }],
        [ACCOUNT_CHANNELS.signOut, async (event) => { trusted(event); await options.controller.signOut(); }],
        [ACCOUNT_CHANNELS.refresh, async (event) => { trusted(event); await options.controller.refresh(); }],
        [ACCOUNT_CHANNELS.openAccountPage, async (event) => { trusted(event); await options.controller.openAccountPage(); }],
        [ACCOUNT_CHANNELS.getReferralInfo, async (event) => { trusted(event); return options.referralInfo(); }],
    ];
    for (const [channel, handler] of handlers) options.ipcMain.handle(channel, handler);
    const unsubscribe = options.controller.subscribe((state) => {
        for (const recipient of options.recipients()) {
            if (!recipient.isDestroyed()) recipient.send(ACCOUNT_CHANNELS.changed, state);
        }
    });
    return () => {
        unsubscribe();
        for (const [channel] of handlers) options.ipcMain.removeHandler(channel);
    };
}
