import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { captureSchemas, fetchPublicSchema, readEndpointIds } from "./capture-fal-schemas.mjs";

const id = "fal-ai/fixture/edit";
const openapi = { openapi: "3.0.4", paths: { "/fixture/edit": { post: { requestBody: { content: {
    "application/json": { schema: { type: "object", properties: { prompt: { type: "string" } } } },
} } } } } };
const row = (endpoint_id = id) => ({ endpoint_id, openapi });
const page = (models, extra = {}) => Response.json({ models, has_more: false, ...extra });

test("follows opaque cursors to the exact ID and uses only public fixed catalog URL", async () => {
    const urls = [];
    const fixture = await fetchPublicSchema(id, async (url, init) => {
        assert.equal(init, undefined);
        urls.push(new URL(url));
        return urls.length === 1
            ? page([row(id + "/sibling")], { has_more: true, next_cursor: "opaque+/=" })
            : page([row()], { has_more: true, next_cursor: "unused" });
    });
    assert.deepEqual(fixture, { endpointId: id, openapi });
    assert.equal(urls.length, 2);
    for (const url of urls) {
        assert.equal(url.origin + url.pathname, "https://api.fal.ai/v1/models");
        assert.equal(url.searchParams.get("endpoint_id"), id);
        assert.equal(url.searchParams.get("expand"), "openapi-3.0");
    }
    assert.equal(urls[1].searchParams.get("cursor"), "opaque+/=");
});

test("rejects missing, unknown and repeated-cursor pages explicitly", async () => {
    await assert.rejects(fetchPublicSchema(id, async () => page([row(id + "/sibling")])), /missing_endpoint/);
    await assert.rejects(fetchPublicSchema(id, async () => Response.json({ models: [] })), /invalid_catalog_page/);
    await assert.rejects(fetchPublicSchema(id, async () => page([], { has_more: true })), /invalid_catalog_cursor/);
    await assert.rejects(fetchPublicSchema(id, async () => page([], { has_more: true, next_cursor: "same" })), /invalid_catalog_cursor/);
    await assert.rejects(fetchPublicSchema(id, async () => page([{ endpoint_id: id, openapi: {} }])), /incomplete_schema/);
});

test("429 stops immediately, preserves encoded fixtures, and rerun resumes without refetching", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shotshot-fal-capture-"));
    const ids = [id, "fal-ai/fixture/next", "fal-ai/fixture/last"];
    const requested = [];
    try {
        await assert.rejects(captureSchemas({ ids, dir, log() {}, fetcher: async (url) => {
            const endpointId = new URL(url).searchParams.get("endpoint_id");
            requested.push(endpointId);
            return endpointId === id ? page([row()]) : new Response("rate limited", { status: 429, headers: { "Retry-After": "10" } });
        } }), (error) => error.message.includes("catalog_http_429") && error.retryAfter === "10");
        assert.deepEqual(requested, ids.slice(0, 2));
        const filename = encodeURIComponent(id) + ".json";
        assert.deepEqual(await readdir(dir), [filename]);
        const saved = await readFile(join(dir, filename), "utf8");
        requested.length = 0;
        await captureSchemas({ ids, dir, log() {}, fetcher: async (url) => {
            const endpointId = new URL(url).searchParams.get("endpoint_id");
            requested.push(endpointId);
            return page([row(endpointId)]);
        } });
        assert.deepEqual(requested, ids.slice(1));
        assert.equal(await readFile(join(dir, filename), "utf8"), saved);
        assert.equal((await readdir(dir)).length, 3);
        await writeFile(join(dir, filename), JSON.stringify({ endpointId: "wrong", openapi }));
        await assert.rejects(captureSchemas({ ids, dir, log() {}, fetcher: async () => { assert.fail("must not fetch"); } }), /incomplete_schema/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("spec manifest has exactly 36 distinct IDs", async () => {
    const spec = await readFile(new URL("../../docs/superpowers/specs/2026-09-09-openrouter-fal-channels-design.md", import.meta.url), "utf8");
    assert.equal(readEndpointIds(spec).length, 36);
    assert.throws(() => readEndpointIds(spec + `\n| [\`${id}\`]`), /invalid_endpoint_manifest/);
    assert.throws(() => readEndpointIds(Array(36).fill(`| [\`${id}\`]`).join("\n")), /invalid_endpoint_manifest/);
});

const approvedIds = readEndpointIds(await readFile(new URL("../../docs/superpowers/specs/2026-09-09-openrouter-fal-channels-design.md", import.meta.url), "utf8"));
for (const endpointId of approvedIds) {
    test(`captured public contract has resolvable input and output: ${endpointId}`, async () => {
        const { default: $RefParser } = await import("@apidevtools/json-schema-ref-parser");
        const filename = join(fileURLToPath(new URL("../src/lib/models/fal/fixtures/", import.meta.url)), encodeURIComponent(endpointId) + ".json");
        const fixture = JSON.parse(await readFile(filename, "utf8"));
        assert.deepEqual(Object.keys(fixture).sort(), ["endpointId", "openapi"]);
        assert.equal(fixture.endpointId, endpointId);
        const document = await $RefParser.dereference(fixture.openapi, { resolve: { external: false } });
        const operation = Object.values(document.paths).find((path) => path.post?.requestBody)?.post;
        const input = operation?.requestBody?.content?.["application/json"]?.schema;
        assert.equal(input?.type, "object");
        assert.ok(Object.keys(input.properties).length > 0);
        const outputs = Object.values(document.paths).flatMap((path) => Object.values(path))
            .map((operation) => operation?.responses?.["200"]?.content?.["application/json"]?.schema);
        assert.ok(outputs.some((output) => output?.properties?.images || output?.properties?.video));
    });
}
