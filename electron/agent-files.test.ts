import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { attachmentsManifestData, attachmentManifestAbortData, createAgentFileRegistry, mimeFor, parseAttachmentManifestAbort, parseAttachmentsManifestData, prepareImageForView, readAsImageForView } from "./agent-files";

describe("Agent file registry", () => {
    it("registers a file and reads it through an opaque handle", async () => {
        const root = await mkdtemp(join(tmpdir(), "shotshot-agent-files-"));
        const sourcePath = join(root, "brief.pdf");
        await writeFile(sourcePath, "%PDF-1.4 fixture");
        const registry = createAgentFileRegistry({ allowedRoots: [root] });

        const [descriptor] = await registry.register([{ name: "brief.pdf", sourcePath, mimeType: "application/pdf", size: 16 }]);
        expect(descriptor.handle).not.toContain("brief.pdf");
        await expect(registry.read(descriptor.handle)).resolves.toMatchObject({ ok: true, file: { name: "brief.pdf", kind: "pdf", dataUrl: "data:application/pdf;base64,JVBERi0xLjQgZml4dHVyZQ==" } });
    });

    it("rejects a folder path outside an allowed root", async () => {
        const root = await mkdtemp(join(tmpdir(), "shotshot-agent-files-"));
        const registry = createAgentFileRegistry({ allowedRoots: [root] });
        await expect(registry.listFolder("/etc", true)).resolves.toEqual({ ok: false, error: expect.stringContaining("不允许") });
    });

    it("lists supported files recursively and ignores unsupported files", async () => {
        const root = await mkdtemp(join(tmpdir(), "shotshot-agent-files-"));
        await mkdir(join(root, "nested"));
        await writeFile(join(root, "nested", "model.glb"), "glb");
        // `txt` 自 AgentAttachmentKind 扩展后属于受支持的 text 类型，改用仍未支持的 docx 验证忽略行为。
        await writeFile(join(root, "nested", "notes.docx"), "ignore");
        const registry = createAgentFileRegistry({ allowedRoots: [root] });
        const result = await registry.listFolder(root, true);

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.files).toHaveLength(1);
        if (result.ok) expect(result.files[0]).toMatchObject({ name: "model.glb", kind: "glb" });
    });

    it("lists expanded kinds with their own MIME instead of the glb fallback", async () => {
        const root = await mkdtemp(join(tmpdir(), "shotshot-agent-files-"));
        await writeFile(join(root, "voice.mp3"), "audio");
        await writeFile(join(root, "deck.pptx"), "slides");
        await writeFile(join(root, "budget.xlsx"), "sheet");
        await writeFile(join(root, "notes.txt"), "text");
        const registry = createAgentFileRegistry({ allowedRoots: [root] });
        const result = await registry.listFolder(root, true);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const byName = new Map(result.files.map((file) => [file.name, file]));
        expect(byName.get("voice.mp3")).toMatchObject({ kind: "audio", mimeType: "audio/mp3" });
        expect(byName.get("deck.pptx")).toMatchObject({ kind: "presentation", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
        expect(byName.get("budget.xlsx")).toMatchObject({ kind: "spreadsheet", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        expect(byName.get("notes.txt")).toMatchObject({ kind: "text", mimeType: "text/plain" });
    });

    it("synthesizes MIME per kind for legacy office variants and the defensive file kind", () => {
        expect(mimeFor("audio", "voice.wav")).toBe("audio/wav");
        expect(mimeFor("presentation", "deck.ppt")).toBe("application/vnd.ms-powerpoint");
        expect(mimeFor("spreadsheet", "budget.xls")).toBe("application/vnd.ms-excel");
        expect(mimeFor("text", "notes.md")).toBe("text/plain");
        expect(mimeFor("file", "archive.bin")).toBe("application/octet-stream");
        expect(mimeFor("glb", "model.glb")).toBe("model/gltf-binary");
        expect(mimeFor("glb", "model.gltf")).toBe("model/gltf+json");
    });
});

describe("readAsImageForView", () => {
    it("returns the original bytes unchanged when nativeImage is unavailable (test env)", async () => {
        const root = await mkdtemp(join(tmpdir(), "shotshot-agent-image-"));
        const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        const tinyPngBytes = Buffer.from(tinyPngBase64, "base64").byteLength;
        const dataUrl = `data:image/png;base64,${tinyPngBase64}`;
        const registry = createAgentFileRegistry({ allowedRoots: [root] });
        const [descriptor] = await registry.register([{ name: "pixel.png", mimeType: "image/png", size: tinyPngBytes, dataUrl }]);

        const result = await readAsImageForView(descriptor.handle, registry);
        expect("error" in result).toBe(false);
        if (!("error" in result)) {
            expect(result.base64).toBe(tinyPngBase64);
            expect(result.mimeType).toBe("image/png");
            expect(result.sizeBytes).toBe(tinyPngBytes);
            expect(result.oversized).toBe(false);
        }
    });

    it("flags oversized images (>5MB) so callers can warn the user", async () => {
        const root = await mkdtemp(join(tmpdir(), "shotshot-agent-image-"));
        const oversizeBytes = Buffer.alloc(6 * 1024 * 1024, 0xff);
        const dataUrl = `data:image/png;base64,${oversizeBytes.toString("base64")}`;
        const registry = createAgentFileRegistry({ allowedRoots: [root] });
        const [descriptor] = await registry.register([{ name: "huge.png", mimeType: "image/png", size: oversizeBytes.byteLength, dataUrl }]);

        const result = await readAsImageForView(descriptor.handle, registry);
        expect("error" in result).toBe(false);
        if (!("error" in result)) {
            expect(result.oversized).toBe(true);
            expect(result.sizeBytes).toBe(6 * 1024 * 1024);
        }
    });

    it("refuses to render non-image kinds (pdf/video/glb) so the agent falls back to metadata-only", async () => {
        const root = await mkdtemp(join(tmpdir(), "shotshot-agent-image-"));
        const sourcePath = join(root, "brief.pdf");
        await writeFile(sourcePath, "%PDF-1.4 fixture");
        const registry = createAgentFileRegistry({ allowedRoots: [root] });
        const [descriptor] = await registry.register([{ name: "brief.pdf", sourcePath, mimeType: "application/pdf", size: 16 }]);

        const result = await readAsImageForView(descriptor.handle, registry);
        expect(result).toEqual({ error: expect.stringContaining("仅 image 支持视觉预览") });
    });

    it("returns an error for unknown handles", async () => {
        const root = await mkdtemp(join(tmpdir(), "shotshot-agent-image-"));
        const registry = createAgentFileRegistry({ allowedRoots: [root] });
        const result = await readAsImageForView("missing-handle", registry);
        expect(result).toEqual({ error: expect.stringContaining("句柄不存在") });
    });
});

describe("prepareImageForView", () => {
    const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

    it("preserves the exact original bytes when original detail is requested", async () => {
        const result = await prepareImageForView(`data:image/png;base64,${tinyPngBase64}`, "original");

        expect("error" in result).toBe(false);
        if (!("error" in result)) {
            expect(result.base64).toBe(tinyPngBase64);
            expect(result.mimeType).toBe("image/png");
            expect(result.transformed).toBe(false);
            expect(result.sizeBytes).toBe(Buffer.from(tinyPngBase64, "base64").byteLength);
        }
    });

    it("rejects a non-base64 image data URL", async () => {
        await expect(prepareImageForView("data:image/png,not-base64", "high")).resolves.toEqual({ error: expect.stringContaining("dataUrl") });
    });
});

describe("attachment manifest persistence", () => {
    const files = [{
        assetId: "asset-1",
        relativePath: "assets/imported/budget--a1b2c3d4.xlsx",
        name: "budget.xlsx",
        kind: "spreadsheet" as const,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 64,
        revision: 1,
    }];

    it("round-trips the bounded manifest through the session custom entry payload", () => {
        const data = attachmentsManifestData("project-1", files);
        expect(parseAttachmentsManifestData(data)).toEqual({ projectId: "project-1", files });
    });

    it("rejects malformed or unbounded manifest payloads", () => {
        expect(parseAttachmentsManifestData(null)).toBeNull();
        expect(parseAttachmentsManifestData("manifest")).toBeNull();
        expect(parseAttachmentsManifestData({})).toBeNull();
        expect(parseAttachmentsManifestData({ projectId: "", files })).toBeNull();
        expect(parseAttachmentsManifestData({ projectId: "project-1", files: [{ ...files[0], assetId: "" }] })).toBeNull();
        expect(parseAttachmentsManifestData({ projectId: "project-1", files: [{ ...files[0], relativePath: "/etc/passwd" }] })).toBeNull();
        expect(parseAttachmentsManifestData({ projectId: "project-1", files: [{ ...files[0], kind: "executable" }] })).toBeNull();
        expect(parseAttachmentsManifestData({ projectId: "project-1", files: [{ ...files[0], size: -1 }] })).toBeNull();
        expect(parseAttachmentsManifestData({ projectId: "project-1", files: [{ ...files[0], revision: 0 }] })).toBeNull();
    });

    it("round-trips abort markers so failed prompts never leave attachable orphans", () => {
        expect(parseAttachmentManifestAbort(attachmentManifestAbortData("manifest-1"))).toBe("manifest-1");
        expect(parseAttachmentManifestAbort({ abortedEntryId: "" })).toBeNull();
        expect(parseAttachmentManifestAbort({ data: "manifest-1" })).toBeNull();
        expect(parseAttachmentManifestAbort(null)).toBeNull();
    });
});
