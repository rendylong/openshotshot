import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/fal-ai%2Fnano-banana-2.json";
import type { FalProfile } from "./profile-types";
import { extractFalSchemas, validateFalInput } from "./schema";

const submitPath = "/fal-ai/nano-banana-2";
const resultPath = `${submitPath}/requests/{request_id}`;
const contractDoc = (input: unknown) => ({
    openapi: "3.0.0",
    paths: {
        "/submit": { post: { requestBody: { content: { "application/json": { schema: input } } } } },
        "/result": { get: { responses: { "200": { content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" } } } } } } } } },
    },
});
const profileFor = (inputSchema: FalProfile["inputSchema"]): FalProfile => ({
    id: "test",
    version: 1,
    endpointId: fixture.endpointId,
    modality: "image",
    inputSchema,
    outputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    defaults: {},
    fields: [],
    media: [],
});

afterEach(() => vi.unstubAllGlobals());

describe("fal schema extraction", () => {
    it("uses independently reviewed document paths and GET media output, not POST QueueStatus", async () => {
        const doc = structuredClone(fixture.openapi);
        const original = structuredClone(doc);
        const schemas = await extractFalSchemas(doc, submitPath, resultPath);
        expect(schemas.inputSchema).toMatchObject({ required: ["prompt"] });
        expect(schemas.outputSchema).toHaveProperty("properties.images.items.properties.url");
        expect(schemas.outputSchema).not.toHaveProperty("properties.status");
        expect(doc).toEqual(original);
        // Document paths need not equal the endpoint that executes the request.
        const moved = { ...doc, paths: { "/reviewed-submit": doc.paths[submitPath], "/reviewed-result": doc.paths[resultPath] } };
        expect(await extractFalSchemas(moved, "/reviewed-submit", "/reviewed-result")).toEqual(schemas);
    });

    it.each(["https://example.test/input.json", "file:///secret.json", "../input.json"])("rejects external reference %s without network", async ($ref) => {
        const fetcher = vi.fn();
        vi.stubGlobal("fetch", fetcher);
        await expect(extractFalSchemas(contractDoc({ $ref }), "/submit", "/result")).rejects.toThrow("fal_schema_invalid");
        expect(fetcher).not.toHaveBeenCalled();
    });

    it("rejects unresolved and circular local references", async () => {
        await expect(extractFalSchemas(contractDoc({ $ref: "#/missing" }), "/submit", "/result")).rejects.toThrow("fal_schema_invalid");
        const doc = { ...contractDoc({ $ref: "#/components/schemas/Input" }), components: { schemas: { Input: { type: "object", properties: { child: { $ref: "#/components/schemas/Input" } } } } } };
        await expect(extractFalSchemas(doc, "/submit", "/result")).rejects.toThrow("fal_schema_invalid");
    });

    it("rejects missing paths and invalid schemas explicitly", async () => {
        await expect(extractFalSchemas(fixture.openapi, submitPath, "/missing")).rejects.toThrow("fal_schema_invalid");
        await expect(extractFalSchemas(contractDoc({ type: "imaginary" }), "/submit", "/result")).rejects.toThrow("fal_schema_invalid");
        await expect(extractFalSchemas(contractDoc(null), "/submit", "/result")).rejects.toThrow("fal_schema_invalid");
    });

    it("isolates repeated schema IDs and rejects asynchronous contracts", async () => {
        const doc = contractDoc({ $id: "https://example.test/input", type: "object", properties: { prompt: { type: "string" } } });
        await expect(extractFalSchemas(doc, "/submit", "/result")).resolves.toHaveProperty("inputSchema");
        await expect(extractFalSchemas(doc, "/submit", "/result")).resolves.toHaveProperty("inputSchema");
        await expect(extractFalSchemas(contractDoc({ $async: true, type: "object", required: ["prompt"] }), "/submit", "/result")).rejects.toThrow("fal_schema_invalid");
    });
});

describe("fal input validation", () => {
    it("validates the real input contract without injecting defaults or coercing values", async () => {
        const { inputSchema } = await extractFalSchemas(fixture.openapi, submitPath, resultPath);
        const profile = profileFor(inputSchema);
        const input = { prompt: "a blue bottle" };
        expect(() => validateFalInput(profile, input)).not.toThrow();
        expect(input).toEqual({ prompt: "a blue bottle" });
        expect(() => validateFalInput(profile, { ...input, num_images: "1" })).toThrow("/num_images");
        expect(() => validateFalInput(profile, { ...input, num_images: 0 })).toThrow("must be >= 1");
        expect(() => validateFalInput(profile, { ...input, resolution: "7K" })).toThrow("/resolution");
    });

    it("uses Ajv support for nullable, allOf, anyOf, scalar arrays and formats", () => {
        const profile = profileFor({
            type: "object",
            additionalProperties: false,
            required: ["count"],
            properties: {
                count: { allOf: [{ type: "integer" }, { minimum: 1 }] },
                seed: { anyOf: [{ type: "integer" }, { type: "null" }] },
                caption: { type: "string", nullable: true },
                urls: { type: "array", items: { type: "string", format: "uri" } },
            },
        });
        expect(() => validateFalInput(profile, { count: 1, seed: null, caption: null, urls: ["https://example.test/image.png"] })).not.toThrow();
        expect(() => validateFalInput(profile, { count: 0, urls: ["invalid"] })).toThrow("/count");
        expect(() => validateFalInput(profile, { count: 1, urls: ["invalid"] })).toThrow("/urls/0");
        const input = { count: 1, extra: true };
        expect(() => validateFalInput(profile, input)).toThrow("/extra");
        expect(input.extra).toBe(true);
    });

    it("reports required field paths and readable reasons without request values", () => {
        const profile = profileFor({ type: "object", required: ["prompt"], properties: { seed: { type: "integer" } } });
        expect(() => validateFalInput(profile, {})).toThrow("/prompt");
        expect(() => validateFalInput(profile, { prompt: "secret prompt", seed: "secret data URI" })).toThrow("must be integer");
        try {
            validateFalInput(profile, { seed: "secret data URI" });
        } catch (error) {
            expect(String(error)).not.toContain("secret data URI");
        }
    });
});
