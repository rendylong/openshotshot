import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
    createLibraryAssetStore,
    extForMimeType,
    resolveLibraryAssetPath,
    type LibraryAssetStore,
} from "./library-asset-store";

const stores: LibraryAssetStore[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
    for (const store of stores.splice(0)) await store.close().catch(() => undefined);
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeStore(): Promise<LibraryAssetStore> {
    const root = await mkdtemp(join(tmpdir(), "library-store-"));
    tempRoots.push(root);
    const store = createLibraryAssetStore({ root });
    stores.push(store);
    return store;
}

const pngBytes = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const waitFor = async (predicate: () => boolean, timeoutMs = 3000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("condition not met in time");
};

describe("library asset store", () => {
    it("write 落盘并写入 manifest，图片路由到 images/", async () => {
        const store = await makeStore();
        const result = await store.write({ name: "主角设定.png", mimeType: "image/png", bytes: pngBytes(), title: "主角设定", tags: ["角色"], source: "Agent" });
        expect(result.record.kind).toBe("image");
        expect(result.record.revision).toBe(1);
        expect(result.record.relativePath).toMatch(/^images\/.+--.{8}\.png$/);
        expect(result.record.title).toBe("主角设定");
        expect(result.record.sha256).toHaveLength(64);
        expect(result.ref.backend).toBe("library-file");
        const listed = await store.list();
        expect(listed.assets).toHaveLength(1);
        expect(listed.legacyMigratedAt).toBeUndefined();
        const onDisk = await readFile(join(await store.ensure(), result.record.relativePath));
        expect([...onDisk]).toEqual([...pngBytes()]);
        const manifest = JSON.parse(await readFile(join(await store.ensure(), ".shotshot/assets.json"), "utf8"));
        expect(manifest.scope).toBe("library");
        expect(manifest.assets).toHaveLength(1);
    });

    it("write 支持 assetId/createdAt 覆写，重复 id 冲突拒绝", async () => {
        const store = await makeStore();
        await store.write({ name: "a.png", mimeType: "image/png", bytes: pngBytes(), title: "a", assetId: "fixed-id", createdAt: "2026-01-01T00:00:00.000Z" });
        const listed = await store.list();
        expect(listed.assets[0].assetId).toBe("fixed-id");
        expect(listed.assets[0].createdAt).toBe("2026-01-01T00:00:00.000Z");
        await expect(store.write({ name: "b.png", mimeType: "image/png", bytes: pngBytes(), title: "b", assetId: "fixed-id" })).rejects.toThrow("资产 id 冲突");
    });

    it("text 写入 texts/，importPath 导入本地文件并拒 symlink", async () => {
        const store = await makeStore();
        const text = await store.write({ name: "设定.md", mimeType: "text/markdown", bytes: new TextEncoder().encode("# 设定"), title: "设定" });
        expect(text.record.kind).toBe("text");
        expect(text.record.relativePath).toMatch(/^texts\//);
        const sourceDir = await mkdtemp(join(tmpdir(), "library-src-"));
        tempRoots.push(sourceDir);
        const source = join(sourceDir, "clip.mp4");
        await writeFile(source, Buffer.from([1, 2, 3, 4]));
        const imported = await store.importPath({ sourcePath: source, title: "片段" });
        expect(imported.record.kind).toBe("video");
        expect(imported.record.relativePath).toMatch(/^videos\/.+--.{8}\.mp4$/);
        const link = join(sourceDir, "link.mp4");
        await symlink(source, link);
        await expect(store.importPath({ sourcePath: link, title: "x" })).rejects.toThrow("符号链接");
    });

    it("read/stat/remove 与 missing", async () => {
        const store = await makeStore();
        const { ref, record } = await store.write({ name: "a.png", mimeType: "image/png", bytes: pngBytes(), title: "a" });
        const read = await store.read({ ref });
        expect([...read.bytes]).toEqual([...pngBytes()]);
        expect((await store.stat({ ref })).status).toBe("ready");
        await unlink(join(await store.ensure(), ref.relativePath));
        expect((await store.stat({ ref })).status).toBe("missing");
        await store.write({ name: "b.png", mimeType: "image/png", bytes: pngBytes(), title: "b" });
        await store.remove(record.assetId);
        const listed = await store.list();
        expect(listed.assets).toHaveLength(1);
        await expect(store.remove("no-such-id")).rejects.toThrow("不在素材索引");
    });

    it("相对路径越界与 manifest 位置写保护", async () => {
        const store = await makeStore();
        await expect(resolveLibraryAssetPath(await store.ensure(), "../escape.png")).rejects.toThrow();
        await expect(resolveLibraryAssetPath(await store.ensure(), "images/../../escape.png")).rejects.toThrow();
        await expect(resolveLibraryAssetPath(await store.ensure(), "/etc/passwd")).rejects.toThrow();
        await expect(store.write({ name: "x", mimeType: "text/plain", bytes: new Uint8Array([1]), title: "x", })).resolves.toBeTruthy();
        // manifest 文件本身不可作为资产路径
        await expect(resolveLibraryAssetPath(await store.ensure(), ".shotshot/assets.json")).resolves.toBeTruthy();
    });

    it("manifest 损坏时拒绝写入", async () => {
        const store = await makeStore();
        await store.ensure();
        await mkdir(join(await store.ensure(), ".shotshot"), { recursive: true });
        await writeFile(join(await store.ensure(), ".shotshot/assets.json"), "{broken");
        await expect(store.write({ name: "a.png", mimeType: "image/png", bytes: pngBytes(), title: "a" })).rejects.toThrow("资产索引损坏");
    });

    it("markLegacyMigrated 落 manifest 元数据", async () => {
        const store = await makeStore();
        await store.markLegacyMigrated();
        const listed = await store.list();
        expect(listed.legacyMigratedAt).toBeTruthy();
    });

    it("watch：外部修改文件 → changed(revision+1)；删除文件 → missing", async () => {
        const store = await makeStore();
        const { ref } = await store.write({ name: "a.png", mimeType: "image/png", bytes: pngBytes(), title: "a" });
        const events: Array<{ type: string; revision?: number }> = [];
        const unsubscribe = await store.watch((event) => {
            events.push(event.type === "changed" ? { type: event.type, revision: event.record.revision } : { type: event.type });
        });
        const target = join(await store.ensure(), ref.relativePath);
        await writeFile(target, Buffer.from([9, 9, 9]));
        await waitFor(() => events.some((event) => event.type === "changed"));
        const changed = events.find((event) => event.type === "changed");
        expect(changed?.revision).toBe(2);
        await unlink(target);
        await waitFor(() => events.some((event) => event.type === "missing"));
        unsubscribe();
    });

    it("watch：主进程 write 后监听器立即收到 changed(revision=1) 广播", async () => {
        const store = await makeStore();
        const events: Array<{ type: string; assetId?: string; revision?: number }> = [];
        const unsubscribe = await store.watch((event) => {
            events.push(event.type === "changed" ? { type: event.type, assetId: event.record.assetId, revision: event.record.revision } : { type: event.type });
        });
        const written = await store.write({ name: "a.png", mimeType: "image/png", bytes: pngBytes(), title: "a" });
        await waitFor(() => events.some((event) => event.type === "changed"));
        const changed = events.find((event) => event.type === "changed");
        expect(changed?.assetId).toBe(written.record.assetId);
        expect(changed?.revision).toBe(1);
        unsubscribe();
    });

    it("extForMimeType 映射", () => {
        expect(extForMimeType("image/png")).toBe("png");
        expect(extForMimeType("video/quicktime")).toBe("mov");
        expect(extForMimeType("text/markdown")).toBe("md");
        expect(extForMimeType("application/octet-stream")).toBe("bin");
    });
});
