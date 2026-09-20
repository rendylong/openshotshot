import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export type StoredAuthSession = {
    refreshToken: string;
    deviceId: string;
    gateway?: {
        tokenId: string;
        secret: string;
        expiresAt: string;
        modelIds: string[];
    };
};

export interface AuthSessionStore {
    load(): Promise<StoredAuthSession | null>;
    save(value: StoredAuthSession): Promise<void>;
    clear(): Promise<void>;
}

export type SafeStorageAdapter = {
    isEncryptionAvailable(): boolean;
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
    getSelectedStorageBackend?(): string;
};

type PersistedEnvelope = {
    version: 1;
    ciphertext: string;
};

function isStoredAuthSession(value: unknown): value is StoredAuthSession {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<StoredAuthSession>;
    if (!(typeof candidate.refreshToken === "string" && candidate.refreshToken.length > 0
        && typeof candidate.deviceId === "string" && candidate.deviceId.length > 0)) return false;
    if (candidate.gateway === undefined) return true;
    const gateway = candidate.gateway;
    return Boolean(gateway && typeof gateway === "object"
        && typeof gateway.tokenId === "string" && gateway.tokenId.length > 0
        && typeof gateway.secret === "string" && gateway.secret.length > 0
        && typeof gateway.expiresAt === "string" && Number.isFinite(Date.parse(gateway.expiresAt))
        && Array.isArray(gateway.modelIds)
        && gateway.modelIds.length > 0
        && gateway.modelIds.every((modelId) => typeof modelId === "string" && modelId.length > 0)
        && new Set(gateway.modelIds).size === gateway.modelIds.length);
}

function encryptionAvailable(safeStorage: SafeStorageAdapter): boolean {
    return safeStorage.isEncryptionAvailable()
        && safeStorage.getSelectedStorageBackend?.() !== "basic_text";
}

export function createAuthSessionStore(
    filePath: string,
    safeStorage: SafeStorageAdapter,
): AuthSessionStore {
    return {
        async load() {
            if (!encryptionAvailable(safeStorage)) return null;
            try {
                const envelope = JSON.parse(await readFile(filePath, "utf8")) as Partial<PersistedEnvelope>;
                if (envelope.version !== 1 || typeof envelope.ciphertext !== "string") {
                    await rm(filePath, { force: true });
                    return null;
                }
                const plaintext = safeStorage.decryptString(Buffer.from(envelope.ciphertext, "base64"));
                const session = JSON.parse(plaintext) as unknown;
                if (isStoredAuthSession(session)) return session;
                await rm(filePath, { force: true });
                return null;
            } catch (error) {
                if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
                    await rm(filePath, { force: true }).catch(() => undefined);
                }
                return null;
            }
        },

        async save(value) {
            if (!encryptionAvailable(safeStorage)) throw new Error("secure_storage_unavailable");
            if (!isStoredAuthSession(value)) throw new Error("invalid_auth_session");
            const ciphertext = safeStorage.encryptString(JSON.stringify(value)).toString("base64");
            const envelope: PersistedEnvelope = { version: 1, ciphertext };
            const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
            await mkdir(dirname(filePath), { recursive: true });
            try {
                await writeFile(temporaryPath, JSON.stringify(envelope), { encoding: "utf8", mode: 0o600 });
                await rename(temporaryPath, filePath);
            } finally {
                await rm(temporaryPath, { force: true }).catch(() => undefined);
            }
        },

        async clear() {
            await rm(filePath, { force: true });
        },
    };
}
