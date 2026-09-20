import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const specUrl = new URL("../../docs/superpowers/specs/2026-09-09-openrouter-fal-channels-design.md", import.meta.url);
const fixtureDir = new URL("../src/lib/models/fal/fixtures/", import.meta.url);

export function readEndpointIds(spec) {
    const ids = [...spec.matchAll(/^\| \[`([^`]+)`\]/gm)].map((match) => match[1]);
    if (ids.length !== 36 || new Set(ids).size !== 36) throw new Error("invalid_endpoint_manifest");
    return ids;
}

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateFixture(fixture, endpointId) {
    const openapi = fixture?.openapi;
    if (fixture?.endpointId !== endpointId || typeof openapi?.openapi !== "string"
        || !openapi.openapi.startsWith("3.") || !isRecord(openapi.paths)
        || !Object.values(openapi.paths).some((path) => {
            const schema = path?.post?.requestBody?.content?.["application/json"]?.schema;
            return isRecord(schema) && Object.keys(schema).length > 0;
        })) {
        throw new Error(`incomplete_schema: ${endpointId}`);
    }
    return fixture;
}

// Public metadata only: no SDK, environment credentials, inferred request targets or retries.
export async function fetchPublicSchema(endpointId, fetcher = fetch) {
    let cursor;
    const visited = new Set();
    while (true) {
        const query = new URLSearchParams({ endpoint_id: endpointId, expand: "openapi-3.0" });
        if (cursor) query.set("cursor", cursor);
        const response = await fetcher(`https://api.fal.ai/v1/models?${query}`);
        if (!response.ok) {
            const error = new Error(`catalog_http_${response.status}: ${endpointId}`);
            if (response.status === 429) error.retryAfter = response.headers.get("retry-after");
            throw error;
        }
        const page = await response.json();
        if (!Array.isArray(page?.models) || typeof page.has_more !== "boolean") {
            throw new Error(`invalid_catalog_page: ${endpointId}`);
        }
        const model = page.models.find((item) => item?.endpoint_id === endpointId);
        if (model) return validateFixture({ endpointId, openapi: model.openapi }, endpointId);
        if (!page.has_more) throw new Error(`missing_endpoint: ${endpointId}`);
        if (typeof page.next_cursor !== "string" || !page.next_cursor || visited.has(page.next_cursor)) {
            throw new Error(`invalid_catalog_cursor: ${endpointId}`);
        }
        cursor = page.next_cursor;
        visited.add(cursor);
    }
}

export async function captureSchemas({ ids, dir = fixtureDir, fetcher = fetch, log = console.log }) {
    await mkdir(dir, { recursive: true });
    for (const endpointId of ids) {
        const file = join(dir instanceof URL ? fileURLToPath(dir) : dir, encodeURIComponent(endpointId) + ".json");
        let existing;
        try {
            existing = await readFile(file, "utf8");
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        if (existing !== undefined) {
            validateFixture(JSON.parse(existing), endpointId);
            log(`reused ${endpointId}`);
            continue;
        }
        const fixture = await fetchPublicSchema(endpointId, fetcher);
        // Atomic rename leaves completed evidence intact if interrupted mid-write.
        const temporary = file + ".tmp";
        await writeFile(temporary, JSON.stringify(fixture, null, 2) + "\n");
        await rename(temporary, file);
        log(`captured ${endpointId}`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const ids = readEndpointIds(await readFile(specUrl, "utf8"));
        await captureSchemas({ ids });
        console.log(`complete: ${ids.length} public schemas`);
    } catch (error) {
        console.error(error.message);
        if ("retryAfter" in error) console.error(`retry_after: ${JSON.stringify(error.retryAfter)}`);
        process.exitCode = 1;
    }
}
