import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatGptCredentialStore } from "./chatgpt-credentials";
let dir: string, path: string;
const protection = { available: () => true, encrypt: (s: string) => Buffer.from([...s].reverse().join("")), decrypt: (b: Buffer) => [...b.toString()].reverse().join("") };
const sample = { type: "oauth" as const, access: "sentinel-access", refresh: "sentinel-refresh", expires: 1 };
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "shotshot-auth-")); path = join(dir, "auth.enc.json"); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
test("protects round trip and only exposes metadata", async () => {
    const store = createChatGptCredentialStore({ path, protection });
    await store.modify("openai-codex", async () => sample);
    expect(await store.read("openai-codex")).toEqual(sample);
    expect(await readFile(path, "utf8")).not.toContain("sentinel");
    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
    expect(await store.read("other")).toBeUndefined();
});
test("unavailable OS protection never writes plaintext", async () => {
    const encrypt = vi.fn();
    const store = createChatGptCredentialStore({ path, protection: { ...protection, available: () => false, encrypt } });
    await expect(store.modify("openai-codex", async () => sample)).rejects.toThrow();
    expect(encrypt).not.toHaveBeenCalled();
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
});
test("serializes refresh and logout", async () => {
    const store = createChatGptCredentialStore({ path, protection });
    await store.modify("openai-codex", async () => sample);
    await Promise.all([store.modify("openai-codex", async c => ({ ...sample, expires: Number(c?.type === "oauth" ? c.expires : 0) + 1 })), store.modify("openai-codex", async c => { expect(c?.type === "oauth" ? c.expires : 0).toBe(2); return { ...sample, expires: 3 }; })]);
    await Promise.all([store.modify("openai-codex", async () => sample), store.delete("openai-codex")]);
    expect(await store.read("openai-codex")).toBeUndefined();
});
test.each(['{"version":2,"ciphertext":"abc"}', '{"version":1,"ciphertext":"broken"}'])("preserves corrupt or unknown data", async raw => {
    await writeFile(path, raw);
    const store = createChatGptCredentialStore({ path, protection });
    await expect(store.modify("openai-codex", async () => sample)).rejects.toThrow();
    await expect(store.delete("openai-codex")).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(raw);
});
test("encryption failure retains prior file", async () => {
    const store = createChatGptCredentialStore({ path, protection });
    await store.modify("openai-codex", async () => sample);
    const raw = await readFile(path, "utf8");
    const broken = createChatGptCredentialStore({ path, protection: { ...protection, encrypt: () => { throw new Error("failed"); } } });
    await expect(broken.modify("openai-codex", async () => sample)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(raw);
});
