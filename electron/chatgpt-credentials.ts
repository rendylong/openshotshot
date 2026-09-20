import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";

export const CHATGPT_PROVIDER = "openai-codex";
type Protection = { available(): boolean; encrypt(value: string): Buffer; decrypt(value: Buffer): string };
function credential(value: unknown): Credential {
    const c = value as Record<string, unknown> | null;
    if (!c || c.type !== "oauth" || typeof c.access !== "string" || !c.access || typeof c.refresh !== "string" || !c.refresh || typeof c.expires !== "number" || !Number.isFinite(c.expires)) throw new Error("invalid_chatgpt_credentials");
    return c as Credential;
}
export function createChatGptCredentialStore({ path, protection }: { path: string; protection: Protection }): CredentialStore {
    let pending: Promise<unknown> = Promise.resolve();
    const read = async () => {
        let raw: string;
        try { raw = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("chatgpt_storage_failed"); }
        if (!protection.available()) throw new Error("chatgpt_protection_unavailable");
        try {
            const data = JSON.parse(raw);
            if (data.version !== 1 || typeof data.ciphertext !== "string" || !data.ciphertext || Object.keys(data).some(key => !["version", "ciphertext"].includes(key))) throw new Error();
            return credential(JSON.parse(protection.decrypt(Buffer.from(data.ciphertext, "base64"))));
        } catch { throw new Error("invalid_chatgpt_credentials"); }
    };
    const mutate = <T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
        const result = pending.then(async () => {
            signal?.throwIfAborted();
            if (!protection.available()) throw new Error("chatgpt_protection_unavailable");
            await mkdir(dirname(path), { recursive: true });
            const lockPath = `${path}.lock-target`;
            const handle = await open(lockPath, "a", 0o600); await handle.close();
            const release = await lockfile.lock(lockPath);
            try { signal?.throwIfAborted(); return await fn(); } finally { await release(); }
        });
        pending = result.catch(() => undefined);
        return result;
    };
    return {
        async read(providerId, options) { options?.signal?.throwIfAborted(); return providerId === CHATGPT_PROVIDER ? read() : undefined; },
        async list(options) { options?.signal?.throwIfAborted(); return await read() ? [{ providerId: CHATGPT_PROVIDER, type: "oauth" }] : []; },
        async modify(providerId, fn, options) {
            if (providerId !== CHATGPT_PROVIDER) throw new Error("unsupported_credential_provider");
            return mutate(async () => {
                const current = await read();
                const next = await fn(current);
                options?.signal?.throwIfAborted();
                if (next === undefined) return current;
                const encoded = protection.encrypt(JSON.stringify(credential(next))).toString("base64");
                const temp = `${path}.${randomUUID()}.tmp`;
                try {
                    const file = await open(temp, "wx", 0o600);
                    try { await file.writeFile(JSON.stringify({ version: 1, ciphertext: encoded })); await file.sync(); } finally { await file.close(); }
                    options?.signal?.throwIfAborted();
                    await rename(temp, path);
                } finally { await unlink(temp).catch(() => undefined); }
                return next;
            }, options?.signal);
        },
        async delete(providerId, options) {
            if (providerId !== CHATGPT_PROVIDER) throw new Error("unsupported_credential_provider");
            await mutate(async () => { await read(); await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; }); }, options?.signal);
        },
    };
}
