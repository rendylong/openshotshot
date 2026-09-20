import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { MANAGED_MODEL_CHANNELS, type ManagedModelRequest } from "../web/src/lib/desktop/managed-model-types";
import type { ManagedModelClient } from "./managed-model-client";

type ManagedModelIpcOptions = {
    ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
    client: ManagedModelClient | null;
    isTrustedSender(sender: WebContents): boolean;
};

export function registerManagedModelIpc(options: ManagedModelIpcOptions): () => void {
    const active = new Map<number, Map<string, AbortController>>();
    const temporaryFiles = new Map<number, Set<string>>();
    const ownerCleanup = new Map<number, { sender: WebContents; listener: () => void }>();
    const trusted = (event: IpcMainInvokeEvent) => {
        if (!options.isTrustedSender(event.sender)) throw new Error("untrusted_ipc_sender");
        if (!options.client) throw new Error("managed_gateway_not_configured");
        return options.client;
    };
    const cleanupOwner = async (senderId: number) => {
        for (const controller of active.get(senderId)?.values() || []) controller.abort();
        active.delete(senderId);
        const ids = [...(temporaryFiles.get(senderId) || [])];
        temporaryFiles.delete(senderId);
        await Promise.all(ids.map((id) => options.client?.discardTemporaryFile(id)));
    };
    const watchOwner = (sender: WebContents) => {
        if (ownerCleanup.has(sender.id)) return;
        const listener = () => { void cleanupOwner(sender.id); ownerCleanup.delete(sender.id); };
        ownerCleanup.set(sender.id, { sender, listener });
        sender.once("destroyed", listener);
    };
    options.ipcMain.handle(MANAGED_MODEL_CHANNELS.listModels, async (event) => {
        const client = trusted(event);
        watchOwner(event.sender);
        return client.listModels();
    });
    options.ipcMain.handle(MANAGED_MODEL_CHANNELS.fetch, async (event, request: ManagedModelRequest) => {
        const client = trusted(event);
        watchOwner(event.sender);
        const owner = active.get(event.sender.id) || new Map<string, AbortController>();
        active.set(event.sender.id, owner);
        if (!request || owner.has(request.id)) throw new Error("duplicate_managed_request_id");
        const controller = new AbortController();
        owner.set(request.id, controller);
        try {
            const response = await client.request(request, controller.signal);
            if (response.body.kind === "temporary-file") {
                const ids = temporaryFiles.get(event.sender.id) || new Set<string>();
                ids.add(response.body.id);
                temporaryFiles.set(event.sender.id, ids);
            }
            return response;
        } finally {
            owner.delete(request.id);
            if (!owner.size) active.delete(event.sender.id);
        }
    });
    options.ipcMain.handle(MANAGED_MODEL_CHANNELS.abort, async (event, requestId: string) => {
        trusted(event);
        active.get(event.sender.id)?.get(requestId)?.abort();
    });
    return () => {
        for (const [senderId, watcher] of ownerCleanup) {
            watcher.sender.off("destroyed", watcher.listener);
            void cleanupOwner(senderId);
        }
        ownerCleanup.clear();
        for (const channel of Object.values(MANAGED_MODEL_CHANNELS)) options.ipcMain.removeHandler(channel);
    };
}
