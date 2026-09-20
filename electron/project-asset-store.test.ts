import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
    createProjectAssetStore,
    resolveProjectAssetPath,
    sanitizeProjectAssetFileName,
    type ProjectAssetRestoreInput,
    type ProjectAssetStore,
    type ProjectAssetWatchEvent,
    type ProjectAssetWriteInput,
} from "./project-asset-store";

const stores: ProjectAssetStore[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
    for (const store of stores.splice(0)) await store.close().catch(() => undefined);
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
    const workspacePath = await mkdtemp(join(tmpdir(), "asset-store-"));
    tempRoots.push(workspacePath);
    return workspacePath;
}

function makeStore(): ProjectAssetStore {
    const store = createProjectAssetStore();
    stores.push(store);
    return store;
}

function writeInput(workspacePath: string, overrides: Partial<ProjectAssetWriteInput> = {}): ProjectAssetWriteInput {
    return {
        projectId: "project-1",
        workspacePath,
        name: "产品 图.png",
        mimeType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
        source: { type: "agent-attachment", canvasId: "canvas-1" },
        ...overrides,
    };
}

async function waitFor(assertion: () => void, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            assertion();
            return;
        } catch (error) {
            if (Date.now() > deadline) throw error;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }
}

describe("sanitizeProjectAssetFileName", () => {
    it("keeps a readable stem, folds unsafe runs to hyphens, and appends the 8-char asset id", () => {
        expect(sanitizeProjectAssetFileName("产品 图.png", "f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe("产品-图--f47ac10b.png");
        expect(sanitizeProjectAssetFileName("My Report v2!!.PNG", "abcdef12-3456-4999-8999-000000000000")).toBe("My-Report-v2--abcdef12.png");
        expect(sanitizeProjectAssetFileName("archive", "01234567-89ab-4999-8999-000000000000")).toBe("archive--01234567.bin");
    });
});

describe("resolveProjectAssetPath", () => {
    it.each(["../escape.png", "/tmp/escape.png"])("rejects unsafe relative path %s", async (relativePath) => {
        const workspacePath = await makeWorkspace();
        await expect(resolveProjectAssetPath(workspacePath, relativePath)).rejects.toThrow(/项目资产目录/);
    });

    it("resolves asset and .shotshot paths inside the canonical workspace", async () => {
        const workspacePath = await makeWorkspace();
        const workspace = await realpath(workspacePath);
        await expect(resolveProjectAssetPath(workspacePath, "assets/imported/a.png")).resolves.toBe(join(workspace, "assets", "imported", "a.png"));
        await expect(resolveProjectAssetPath(workspacePath, ".shotshot/assets.json")).resolves.toBe(join(workspace, ".shotshot", "assets.json"));
    });

    it("rejects symlink escape out of the workspace", async () => {
        const workspacePath = await makeWorkspace();
        const outside = await makeWorkspace();
        await writeFile(join(outside, "secret.txt"), "x");
        await mkdir(join(workspacePath, "assets"), { recursive: true });
        await symlink(join(outside, "secret.txt"), join(workspacePath, "assets", "link.png"));
        await expect(resolveProjectAssetPath(workspacePath, "assets/link.png")).rejects.toThrow(/项目资产目录/);
    });
});

describe("createProjectAssetStore", () => {
    it("writes a readable imported file and atomic version-1 manifest", async () => {
        const workspacePath = await makeWorkspace();
        const store = makeStore();
        const result = await store.writeBytes({
            projectId: "project-1",
            workspacePath,
            name: "产品 图.png",
            mimeType: "image/png",
            bytes: new Uint8Array([1, 2, 3]),
            source: { type: "agent-attachment", canvasId: "canvas-1" },
        });
        expect(result.ref.relativePath).toMatch(/^assets\/imported\/产品-图--[a-f0-9]{8}\.png$/);
        expect(await readFile(join(workspacePath, result.ref.relativePath))).toEqual(Buffer.from([1, 2, 3]));
        expect(JSON.parse(await readFile(join(workspacePath, ".shotshot/assets.json"), "utf8"))).toMatchObject({ app: "shotshot", version: 1, projectId: "project-1" });
        expect(result.record).toMatchObject({
            projectId: "project-1",
            originalName: "产品 图.png",
            kind: "image",
            mimeType: "image/png",
            bytes: 3,
            sha256: createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex"),
            revision: 1,
        });
        expect(result.ref).toMatchObject({ backend: "project-file", assetId: result.record.assetId, projectId: "project-1", revision: 1 });
    });

    it("routes generated images into assets/generated/images", async () => {
        const workspacePath = await makeWorkspace();
        const store = makeStore();
        const result = await store.writeBytes(writeInput(workspacePath, { name: "shot-001 分镜.png", source: { type: "generated", nodeId: "node-1" } }));
        expect(result.ref.relativePath).toMatch(/^assets\/generated\/images\/shot-001-分镜--[a-f0-9]{8}\.png$/);
        expect(result.record.kind).toBe("image");
    });

    it("creates a new asset identity on every write and never overwrites a manifest-known file", async () => {
        const workspacePath = await makeWorkspace();
        const store = makeStore();
        const first = await store.writeBytes(writeInput(workspacePath));
        const second = await store.writeBytes(writeInput(workspacePath));
        expect(second.ref.assetId).not.toBe(first.ref.assetId);
        expect(second.ref.relativePath).not.toBe(first.ref.relativePath);
        const manifest = JSON.parse(await readFile(join(workspacePath, ".shotshot/assets.json"), "utf8"));
        expect(manifest.assets).toHaveLength(2);
        expect(await readFile(join(workspacePath, first.ref.relativePath))).toEqual(Buffer.from([1, 2, 3]));
    });

    it("refuses to overwrite a corrupt manifest", async () => {
        const workspacePath = await makeWorkspace();
        const store = makeStore();
        await mkdir(join(workspacePath, ".shotshot"), { recursive: true });
        await writeFile(join(workspacePath, ".shotshot/assets.json"), "not-json");
        const validWrite = writeInput(workspacePath);
        await expect(store.writeBytes(validWrite)).rejects.toThrow(/资产索引损坏/);
        expect(await readFile(join(workspacePath, ".shotshot/assets.json"), "utf8")).toBe("not-json");
    });

    it("refuses manifest writes on unknown version or foreign projectId and leaves the file untouched", async () => {
        const workspacePath = await makeWorkspace();
        const store = makeStore();
        const manifestPath = join(workspacePath, ".shotshot/assets.json");
        await mkdir(join(workspacePath, ".shotshot"), { recursive: true });
        await writeFile(manifestPath, JSON.stringify({ app: "shotshot", version: 2, projectId: "project-1", assets: [] }));
        const beforeVersion = await readFile(manifestPath, "utf8");
        await expect(store.writeBytes(writeInput(workspacePath))).rejects.toThrow(/版本/);
        expect(await readFile(manifestPath, "utf8")).toBe(beforeVersion);
        await writeFile(manifestPath, JSON.stringify({ app: "shotshot", version: 1, projectId: "project-2", assets: [] }));
        const beforeProject = await readFile(manifestPath, "utf8");
        await expect(store.writeBytes(writeInput(workspacePath))).rejects.toThrow(/项目/);
        expect(await readFile(manifestPath, "utf8")).toBe(beforeProject);
    });

    it("imports a regular file by path and leaves the source untouched", async () => {
        const workspacePath = await makeWorkspace();
        const sourceDir = await mkdtemp(join(tmpdir(), "asset-src-"));
        tempRoots.push(sourceDir);
        const sourcePath = join(sourceDir, "手稿.pdf");
        const sourceBytes = new Uint8Array([4, 5, 6, 7]);
        await writeFile(sourcePath, sourceBytes);
        const store = makeStore();
        const result = await store.importPath({
            projectId: "project-1",
            workspacePath,
            name: "手稿.pdf",
            mimeType: "application/pdf",
            sourcePath,
            source: { type: "canvas-import", canvasId: "canvas-1" },
        });
        expect(result.ref.relativePath).toMatch(/^assets\/imported\/手稿--[a-f0-9]{8}\.pdf$/);
        expect(await readFile(join(workspacePath, result.ref.relativePath))).toEqual(Buffer.from(sourceBytes));
        expect(await readFile(sourcePath)).toEqual(Buffer.from(sourceBytes));
        expect(result.record.kind).toBe("pdf");
        expect(result.record.sha256).toBe(createHash("sha256").update(sourceBytes).digest("hex"));
    });

    it("rejects symlinks and directories as import sources", async () => {
        const workspacePath = await makeWorkspace();
        const sourceDir = await mkdtemp(join(tmpdir(), "asset-src-"));
        tempRoots.push(sourceDir);
        const realPath = join(sourceDir, "real.png");
        await writeFile(realPath, new Uint8Array([1]));
        await symlink(realPath, join(sourceDir, "link.png"));
        await mkdir(join(sourceDir, "folder"), { recursive: true });
        const store = makeStore();
        const base = { projectId: "project-1", workspacePath, name: "link.png", mimeType: "image/png", source: { type: "canvas-import" as const } };
        await expect(store.importPath({ ...base, sourcePath: join(sourceDir, "link.png") })).rejects.toThrow(/符号链接/);
        await expect(store.importPath({ ...base, sourcePath: join(sourceDir, "folder") })).rejects.toThrow(/普通文件/);
    });

    it("reads a manifest-known ref and rejects unknown or mismatched refs", async () => {
        const workspacePath = await makeWorkspace();
        const store = makeStore();
        const result = await store.writeBytes(writeInput(workspacePath));
        const read = await store.read({ workspacePath, ref: result.ref });
        expect(read.bytes).toEqual(Buffer.from([1, 2, 3]));
        expect(read.record.assetId).toBe(result.ref.assetId);
        await expect(store.read({ workspacePath, ref: { ...result.ref, assetId: "00000000-0000-4000-8000-000000000000" } })).rejects.toThrow(/索引/);
        await expect(store.read({ workspacePath, ref: { ...result.ref, relativePath: "assets/imported/other--00000000.png" } })).rejects.toThrow(/路径不匹配/);
        await expect(store.read({ workspacePath, ref: { ...result.ref, projectId: "project-2" } })).rejects.toThrow(/项目/);
    });

    it("stats a known asset as ready and a deleted asset as missing", async () => {
        const workspacePath = await makeWorkspace();
        const store = makeStore();
        const result = await store.writeBytes(writeInput(workspacePath));
        await expect(store.stat({ workspacePath, ref: result.ref })).resolves.toMatchObject({ status: "ready", record: { assetId: result.ref.assetId } });
        await unlink(join(workspacePath, result.ref.relativePath));
        await expect(store.stat({ workspacePath, ref: result.ref })).resolves.toEqual({ status: "missing" });
    });

    it("restores an explicit identity, is idempotent, and refuses hash conflicts", async () => {
        const workspacePath = await makeWorkspace();
        const store = makeStore();
        const restoreInput: ProjectAssetRestoreInput = {
            projectId: "project-1",
            workspacePath,
            assetId: "11111111-2222-4333-8444-555555555555",
            relativePath: "assets/imported/synced--11111111.png",
            revision: 3,
            originalName: "synced.png",
            kind: "image",
            mimeType: "image/png",
            bytes: new Uint8Array([1, 2, 3]),
            sha256: createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex"),
            source: { type: "webdav-restore" },
        };
        const first = await store.restore(restoreInput);
        expect(first.record).toMatchObject({ assetId: restoreInput.assetId, revision: 3, bytes: 3 });
        expect(first.ref).toMatchObject({ backend: "project-file", assetId: restoreInput.assetId, projectId: "project-1", relativePath: restoreInput.relativePath, revision: 3 });
        expect(await readFile(join(workspacePath, restoreInput.relativePath))).toEqual(Buffer.from([1, 2, 3]));

        const second = await store.restore(restoreInput);
        expect(second.record.revision).toBe(3);
        const manifest = JSON.parse(await readFile(join(workspacePath, ".shotshot/assets.json"), "utf8"));
        expect(manifest.assets).toHaveLength(1);

        await unlink(join(workspacePath, restoreInput.relativePath));
        const third = await store.restore(restoreInput);
        expect(third.record.revision).toBe(3);
        expect(await readFile(join(workspacePath, restoreInput.relativePath))).toEqual(Buffer.from([1, 2, 3]));

        await expect(store.restore({ ...restoreInput, bytes: new Uint8Array([9, 9, 9]) })).rejects.toThrow(/冲突/);
        await expect(store.restore({ ...restoreInput, assetId: "22222222-3333-4999-8999-000000000000", relativePath: "assets/imported/other--22222222.png", sha256: "deadbeef" })).rejects.toThrow(/哈希/);
        const manifestAfter = JSON.parse(await readFile(join(workspacePath, ".shotshot/assets.json"), "utf8"));
        expect(manifestAfter.assets).toHaveLength(1);
    });

    it("refuses to restore bytes over the manifest path and leaves the manifest untouched", async () => {
        const workspacePath = await makeWorkspace();
        const store = makeStore();
        const written = await store.writeBytes(writeInput(workspacePath));
        const manifestPath = join(workspacePath, ".shotshot/assets.json");
        const before = await readFile(manifestPath, "utf8");
        const poisoned: ProjectAssetRestoreInput = {
            projectId: "project-1",
            workspacePath,
            assetId: "99999999-8888-4999-8999-000000000000",
            relativePath: ".shotshot/assets.json",
            revision: 1,
            originalName: "assets.json",
            kind: "other",
            mimeType: "application/json",
            bytes: new Uint8Array([3, 3, 3]),
            source: { type: "webdav-restore" },
        };
        await expect(store.restore(poisoned)).rejects.toThrow(/索引/);
        // 规范化等价写法（./ 与多余分隔符）同样指向 manifest，必须一并拒绝。
        await expect(store.restore({ ...poisoned, relativePath: ".shotshot/./assets.json" })).rejects.toThrow(/索引/);
        await expect(store.restore({ ...poisoned, relativePath: ".shotshot//assets.json" })).rejects.toThrow(/索引/);
        expect(await readFile(manifestPath, "utf8")).toBe(before);
        const manifest = JSON.parse(before);
        expect(manifest.assets).toHaveLength(1);
        expect(manifest.assets[0].assetId).toBe(written.ref.assetId);
    });

    it("serializes concurrent manifest mutations in one workspace", async () => {
        const workspacePath = await makeWorkspace();
        const store = makeStore();
        const [first, second] = await Promise.all([store.writeBytes(writeInput(workspacePath)), store.writeBytes(writeInput(workspacePath))]);
        expect(first.ref.assetId).not.toBe(second.ref.assetId);
        expect(first.ref.relativePath).not.toBe(second.ref.relativePath);
        expect(await readFile(join(workspacePath, first.ref.relativePath))).toEqual(Buffer.from([1, 2, 3]));
        expect(await readFile(join(workspacePath, second.ref.relativePath))).toEqual(Buffer.from([1, 2, 3]));
        const manifest = JSON.parse(await readFile(join(workspacePath, ".shotshot/assets.json"), "utf8"));
        expect(manifest).toMatchObject({ app: "shotshot", version: 1, projectId: "project-1" });
        expect(manifest.assets).toHaveLength(2);
        expect(new Set(manifest.assets.map((asset: { assetId: string }) => asset.assetId))).toEqual(new Set([first.ref.assetId, second.ref.assetId]));
    });

    it("publishes a new revision when an Agent edits a watched asset", async () => {
        const workspacePath = await makeWorkspace();
        const store = makeStore();
        const changed: ProjectAssetWatchEvent[] = [];
        const result = await store.writeBytes(writeInput(workspacePath));
        const off = await store.watch("project-1", workspacePath, (record) => changed.push(record));
        await writeFile(join(workspacePath, result.ref.relativePath), new Uint8Array([9, 9]));
        await waitFor(() => expect(changed.at(-1)).toMatchObject({ assetId: result.ref.assetId, revision: 2, bytes: 2 }));
        off();
    });

    it("emits a missing event without dropping the record when a watched asset is deleted", async () => {
        const workspacePath = await makeWorkspace();
        const store = makeStore();
        const events: ProjectAssetWatchEvent[] = [];
        const result = await store.writeBytes(writeInput(workspacePath));
        await store.watch("project-1", workspacePath, (event) => events.push(event));
        await unlink(join(workspacePath, result.ref.relativePath));
        await waitFor(() => expect(events.at(-1)).toEqual({ type: "missing", ref: result.ref }));
        await expect(store.stat({ workspacePath, ref: result.ref })).resolves.toEqual({ status: "missing" });
    });

    it("ignores watched files that are not manifest-known assets", async () => {
        const workspacePath = await makeWorkspace();
        const store = makeStore();
        const events: ProjectAssetWatchEvent[] = [];
        const result = await store.writeBytes(writeInput(workspacePath));
        await store.watch("project-1", workspacePath, (event) => events.push(event));
        await writeFile(join(workspacePath, "assets/imported/unknown--00000000.png"), new Uint8Array([7]));
        await writeFile(join(workspacePath, result.ref.relativePath), new Uint8Array([8, 8, 8, 8]));
        await waitFor(() => expect(events.at(-1)).toMatchObject({ assetId: result.ref.assetId, bytes: 4 }));
        expect(events).toHaveLength(1);
    });
});
