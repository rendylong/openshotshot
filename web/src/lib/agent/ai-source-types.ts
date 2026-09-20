export type AiCapability = "agent" | "image" | "video" | "text" | "audio";
export type ManagedSelection = { source: "chatgpt"; modelId: string };
export type AiSourcePreferences = { version: 1; selections: Partial<Record<AiCapability, ManagedSelection>> };
export type ChatGptModel = { id: string; name: string; supportsImageInput: boolean };
export type ChatGptPrompt = { id: string; type: "text" | "secret" | "select" | "manual_code"; options?: Array<{id: string; label: string}> };
export type ChatGptStatus = {
    state: "signed-out" | "signing-in" | "signed-in" | "error";
    errorCode?: "login_failed" | "storage_failed" | "protection_unavailable" | "network_failed" | "unavailable";
    prompt?: ChatGptPrompt;
    deviceCode?: {userCode: string; verificationUri: string};
};
export interface ChatGptBridge {
    getStatus(): Promise<ChatGptStatus>;
    signIn(): Promise<void>;
    cancelSignIn(): Promise<void>;
    respond(id: string, value: string): Promise<void>;
    signOut(): Promise<void>;
    getModels(): Promise<ChatGptModel[]>;
    onStatusChanged(listener: (status: ChatGptStatus) => void): () => void;
}
export const CHATGPT_CHANNELS = {
    status: "chatgpt:status", signIn: "chatgpt:sign-in", cancel: "chatgpt:cancel",
    respond: "chatgpt:respond", signOut: "chatgpt:sign-out", models: "chatgpt:models", changed: "chatgpt:changed",
} as const;
