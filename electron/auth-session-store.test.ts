import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";

import { createAuthSessionStore, type SafeStorageAdapter } from "./auth-session-store";

const tempRoots: string[] = [];
const safeStorage: SafeStorageAdapter = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`),
    decryptString: (value) => {
        const encoded = value.toString().replace(/^encrypted:/, "");
        return Buffer.from(encoded, "base64").toString();
    },
};

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "shotshot-auth-session-"));
    tempRoots.push(root);
    const filePath = join(root, "session.json");
    return { filePath, store: createAuthSessionStore(filePath, safeStorage) };
}

afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop auth session store", () => {
    test("round-trips a versioned session without writing its refresh token in plaintext", async () => {
        const { filePath, store } = await fixture();
        const session = { refreshToken: "refresh-super-secret", deviceId: "device-1" };

        await store.save(session);

        expect(await store.load()).toEqual(session);
        const persisted = await readFile(filePath, "utf8");
        expect(persisted).toContain('"version":1');
        expect(persisted).not.toContain(session.refreshToken);
        expect(persisted).not.toContain(session.deviceId);
        expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    });

    test("persists the device-scoped gateway credential only inside the encrypted envelope", async () => {
        const { filePath, store } = await fixture();
        const session = {
            refreshToken: "refresh-super-secret",
            deviceId: "device-1",
            gateway: {
                tokenId: "token-id-1",
                secret: "gateway-super-secret",
                expiresAt: "2026-09-05T12:00:00.000Z",
                modelIds: ["gpt-5-mini", "image-1"],
            },
        };

        await store.save(session);

        expect(await store.load()).toEqual(session);
        const persisted = await readFile(filePath, "utf8");
        expect(persisted).not.toContain(session.gateway.secret);
        expect(persisted).not.toContain(session.gateway.tokenId);
    });

    test("fails closed when the encrypted envelope is corrupt", async () => {
        const { filePath, store } = await fixture();
        await writeFile(filePath, '{"version":1,"ciphertext":"not-valid"}');

        await expect(store.load()).resolves.toBeNull();
        await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("removes unknown versions instead of guessing a migration", async () => {
        const { filePath, store } = await fixture();
        await writeFile(filePath, '{"version":2,"ciphertext":"dW5rbm93bg=="}');

        await expect(store.load()).resolves.toBeNull();
        await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("refuses to persist secrets when OS encryption is unavailable", async () => {
        const { filePath } = await fixture();
        const store = createAuthSessionStore(filePath, {
            ...safeStorage,
            isEncryptionAvailable: () => false,
        });

        await expect(store.save({ refreshToken: "secret", deviceId: "device-1" }))
            .rejects.toThrow("secure_storage_unavailable");
    });

    test("rejects Linux basic_text even when Electron reports encryption available", async () => {
        const { filePath } = await fixture();
        const store = createAuthSessionStore(filePath, {
            ...safeStorage,
            getSelectedStorageBackend: () => "basic_text",
        });

        await expect(store.save({ refreshToken: "secret", deviceId: "device-1" }))
            .rejects.toThrow("secure_storage_unavailable");
    });

    test("atomically replaces the envelope without leaving temporary files", async () => {
        const { filePath, store } = await fixture();
        await store.save({ refreshToken: "first", deviceId: "device-1" });
        await store.save({ refreshToken: "second", deviceId: "device-1" });

        expect(await store.load()).toEqual({ refreshToken: "second", deviceId: "device-1" });
        expect(await readdir(dirname(filePath))).toEqual(["session.json"]);
    });

    test("clears the persisted session", async () => {
        const { store } = await fixture();
        await store.save({ refreshToken: "refresh-token", deviceId: "device-1" });

        await store.clear();

        await expect(store.load()).resolves.toBeNull();
    });
});
