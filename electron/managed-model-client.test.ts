import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ShotshotCloudClientError, type GatewayCredential, type ManagedModel } from "./shotshot-cloud-client";
import { ManagedModelClient, ManagedModelClientError } from "./managed-model-client";
import type { ManagedModelRequest } from "../web/src/lib/desktop/managed-model-types";

const MODEL = { id: "gpt-5-mini", name: "GPT-5 mini", capability: "text" as const, execution: "direct" as const };
const MULTIMODAL_MODEL: ManagedModel = { id: "minimax-m3", name: "MiniMax M3", capability: "text", execution: "direct", input_modalities: ["text", "image"] };
const CREDENTIAL = { tokenId: "token-1", secret: "gateway-secret", expiresAt: "2026-09-05T03:00:00.000Z", modelIds: [MODEL.id] };
const directories: string[] = [];

type FetchMock = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

async function harness(
    fetch: FetchMock = vi.fn<typeof globalThis.fetch>(async () => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json", authorization: "must-not-leak" } })),
    overrides: { now?: () => number; credential?: GatewayCredential | null; models?: ManagedModel[] } = {},
) {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "shotshot-managed-test-"));
    directories.push(temporaryDirectory);
    const cloud = {
        requestManagedAsset: vi.fn(async () => ({ asset_id: "asset-1" })),
        getManagedModels: vi.fn(async () => overrides.models ?? [MODEL]),
        getStoredGatewayCredential: vi.fn<() => Promise<GatewayCredential | null>>(async () => overrides.credential === undefined ? CREDENTIAL : overrides.credential),
        issueGatewayCredential: vi.fn(async () => CREDENTIAL),
        rotateGatewayCredential: vi.fn(async () => ({ ...CREDENTIAL, tokenId: "token-2", secret: "rotated-secret" })),
        clearGatewayCredential: vi.fn(async () => undefined),
    };
    return {
        cloud,
        fetch,
        temporaryDirectory,
        client: new ManagedModelClient({
            gatewayOrigin: "https://gateway.shotshot.ai",
            cloud,
            temporaryDirectory,
        fetch,
            now: overrides.now ?? (() => Date.parse("2026-09-05T02:00:00.000Z")),
        }),
    };
}

function request(overrides: Partial<ManagedModelRequest> = {}): ManagedModelRequest {
    return {
        id: "request-1",
        path: "/v1/responses",
        method: "POST",
        timeoutClass: "text",
        body: { kind: "json", value: JSON.stringify({ model: MODEL.id, input: "hello" }) },
        ...overrides,
    };
}

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ManagedModelClient", () => {
    test("resolves a text credential only inside main for a catalog model", async () => {
        const value = await harness();
        await expect(value.client.resolveApiKeyForTextModel(MODEL.id)).resolves.toBe("gateway-secret");
        await expect(value.client.resolveApiKeyForTextModel("not-in-catalog")).rejects.toMatchObject({ code: "managed_invalid_request" });
    });

    test("resolveTextModelDescriptor returns cloned canonical modalities from the cached catalog", async () => {
        const value = await harness(undefined, { models: [MULTIMODAL_MODEL] });
        const descriptor = await value.client.resolveTextModelDescriptor(MULTIMODAL_MODEL.id);
        expect(descriptor.inputModalities).toEqual(["text", "image"]);
        descriptor.inputModalities.push("image");
        await expect(value.client.resolveTextModelDescriptor(MULTIMODAL_MODEL.id)).resolves.toEqual({ inputModalities: ["text", "image"] });
        await expect(value.client.resolveTextModelDescriptor("not-in-catalog")).rejects.toMatchObject({ code: "managed_invalid_request" });
    });

    test("resolveTextModelDescriptor rejects catalog entries that are not text models", async () => {
        const value = await harness(undefined, { models: [{ ...MODEL, id: "managed-image", capability: "image" }] });
        await expect(value.client.resolveTextModelDescriptor("managed-image")).rejects.toMatchObject({ code: "managed_invalid_request" });
    });

    test("missing input modalities normalize to text-only at use time", async () => {
        const value = await harness();
        await expect(value.client.resolveTextModelDescriptor(MODEL.id)).resolves.toEqual({ inputModalities: ["text"] });
    });

    test("descriptor and API-key lookups share the ten-minute model cache", async () => {
        const value = await harness(undefined, { credential: { ...CREDENTIAL, expiresAt: "2026-09-05T04:00:00.000Z" } });
        await value.client.resolveApiKeyForTextModel(MODEL.id);
        await value.client.resolveTextModelDescriptor(MODEL.id);
        expect(value.cloud.getManagedModels).toHaveBeenCalledTimes(1);
    });

    test("resolve cache serves repeated text resolves without extra model fetches", async () => {
        const value = await harness(undefined, { credential: { ...CREDENTIAL, expiresAt: "2026-09-05T04:00:00.000Z" } });
        await expect(value.client.resolveApiKeyForTextModel(MODEL.id)).resolves.toBe("gateway-secret");
        await expect(value.client.resolveApiKeyForTextModel(MODEL.id)).resolves.toBe("gateway-secret");
        expect(value.cloud.getManagedModels).toHaveBeenCalledTimes(1);
    });

    test("resolve logs a structured managed_resolve line", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const value = await harness(undefined, { credential: { ...CREDENTIAL, expiresAt: "2026-09-05T04:00:00.000Z" } });
        await value.client.resolveApiKeyForTextModel(MODEL.id);
        const line = errorSpy.mock.calls.map(([arg]) => String(arg)).find((arg) => arg.includes("managed_resolve"));
        expect(line).toBeDefined();
        expect(JSON.parse(line!)).toMatchObject({ event: "managed_resolve", cache: "hit" });
        errorSpy.mockRestore();
    });

    test("models cache expires after TTL and refetches", async () => {
        let now = Date.parse("2026-09-05T02:00:00.000Z");
        const value = await harness(undefined, { credential: { ...CREDENTIAL, expiresAt: "2026-09-05T04:00:00.000Z" }, now: () => now });
        await value.client.resolveApiKeyForTextModel(MODEL.id);
        now += 11 * 60_000;
        await value.client.resolveApiKeyForTextModel(MODEL.id);
        expect(value.cloud.getManagedModels).toHaveBeenCalledTimes(2);
    });

    test("public listModels always refetches and refreshes the hot cache", async () => {
        const value = await harness(undefined, { credential: { ...CREDENTIAL, expiresAt: "2026-09-05T04:00:00.000Z" } });
        await value.client.listModels();
        await value.client.resolveApiKeyForTextModel(MODEL.id);
        expect(value.cloud.getManagedModels).toHaveBeenCalledTimes(1); // 公共刷新喂饱热缓存
    });

    test("dispose clears the resolve cache", async () => {
        const value = await harness(undefined, { credential: { ...CREDENTIAL, expiresAt: "2026-09-05T04:00:00.000Z" } });
        await value.client.resolveApiKeyForTextModel(MODEL.id);
        await value.client.dispose();
        await value.client.resolveApiKeyForTextModel(MODEL.id);
        expect(value.cloud.getManagedModels).toHaveBeenCalledTimes(2);
    });

    test("margin window returns the old secret without awaiting rotation", async () => {
        const value = await harness(undefined, { credential: { ...CREDENTIAL, expiresAt: "2026-09-05T02:04:00.000Z" } }); // 剩余4min
        value.cloud.rotateGatewayCredential.mockImplementation(() => new Promise(() => undefined)); // 永不resolve
        await expect(value.client.resolveApiKeyForTextModel(MODEL.id)).resolves.toBe("gateway-secret");
        expect(value.cloud.rotateGatewayCredential).toHaveBeenCalledTimes(1);
    });

    test("rotation result is picked up by the next resolve", async () => {
        const value = await harness(undefined, { credential: { ...CREDENTIAL, expiresAt: "2026-09-05T02:04:00.000Z" } });
        await value.client.resolveApiKeyForTextModel(MODEL.id); // 触发后台rotate
        await vi.waitFor(() => expect(value.cloud.rotateGatewayCredential).toHaveBeenCalled());
        await expect(value.client.resolveApiKeyForTextModel(MODEL.id)).resolves.toBe("rotated-secret");
    });

    test("inside blocking margin resolve awaits rotation", async () => {
        const value = await harness(undefined, { credential: { ...CREDENTIAL, expiresAt: "2026-09-05T02:00:10.000Z" } }); // 剩余10s
        await expect(value.client.resolveApiKeyForTextModel(MODEL.id)).resolves.toBe("rotated-secret");
    });

    test("background renewal failure does not break the current resolve", async () => {
        const value = await harness(undefined, { credential: { ...CREDENTIAL, expiresAt: "2026-09-05T02:04:00.000Z" } });
        value.cloud.rotateGatewayCredential.mockRejectedValueOnce(new Error("rotate failed"));
        await expect(value.client.resolveApiKeyForTextModel(MODEL.id)).resolves.toBe("gateway-secret");
        await vi.waitFor(() => expect(value.cloud.rotateGatewayCredential).toHaveBeenCalledTimes(1)); // 失败已落地、单飞已清
        value.cloud.rotateGatewayCredential.mockResolvedValueOnce({ ...CREDENTIAL, tokenId: "token-2", secret: "rotated-secret" });
        await expect(value.client.resolveApiKeyForTextModel(MODEL.id)).resolves.toBe("gateway-secret"); // 仍在边距内，旧secret继续用
        await vi.waitFor(() => expect(value.cloud.rotateGatewayCredential).toHaveBeenCalledTimes(2));
        await expect(value.client.resolveApiKeyForTextModel(MODEL.id)).resolves.toBe("rotated-secret"); // 第三次拿到新凭证
    });

    test("permits a fixed localhost HTTP gateway only when explicitly enabled", async () => {
        const value = await harness();
        expect(() => new ManagedModelClient({
            gatewayOrigin: "http://localhost:3000",
            cloud: value.cloud,
            temporaryDirectory: value.temporaryDirectory,
            allowLocalHttp: true,
        })).not.toThrow();
        expect(() => new ManagedModelClient({
            gatewayOrigin: "http://gateway.example",
            cloud: value.cloud,
            temporaryDirectory: value.temporaryDirectory,
            allowLocalHttp: true,
        })).toThrow("invalid_gateway_origin");
    });

    test("routes the full asset upload lifecycle to Cloud without obtaining gateway credentials", async () => {
        const value = await harness();
        const metadata = { kind: "json" as const, value: JSON.stringify({ mime_type: "image/png", byte_size: 3 }) };
        const bytes = new Uint8Array([1, 2, 3]);
        for (const [path, body] of [
            ["/v1/assets/upload", metadata],
            ["/v1/assets/asset-1/content", { kind: "bytes", value: bytes, contentType: "application/octet-stream" }],
            ["/v1/assets/asset-1/complete", { kind: "json", value: '{"byte_size":3}' }],
        ] as const) {
            const response = await value.client.request(request({ path, timeoutClass: "image", body, headers: { "content-type": "image/png" } }));
            expect(response.status).toBe(200);
        }
        expect(value.cloud.requestManagedAsset).toHaveBeenCalledTimes(3);
        expect(value.cloud.requestManagedAsset).toHaveBeenNthCalledWith(2, "/v1/assets/asset-1/content", bytes, "image/png", expect.any(AbortSignal));
        expect(value.cloud.getStoredGatewayCredential).not.toHaveBeenCalled();
        expect(value.cloud.getManagedModels).not.toHaveBeenCalled();
        expect(value.fetch).not.toHaveBeenCalled();
        await value.client.request(request({ path: "/v1/media/tasks" }));
        expect(String(value.fetch.mock.calls[0][0])).toBe("https://gateway.shotshot.ai/v1/media/tasks");
    });

    test("preserves safe Cloud upload failure status across IPC", async () => {
        const value = await harness();
        value.cloud.requestManagedAsset.mockRejectedValueOnce(new ShotshotCloudClientError("cloud_request_failed", 500, "internal_error"));
        const result = await value.client.request(request({ path: "/v1/assets/upload", timeoutClass: "image" }));
        expect(result).toMatchObject({ status: 500, body: { kind: "text", value: '{"error":"internal_error"}' } });
        expect(value.cloud.issueGatewayCredential).not.toHaveBeenCalled();
        expect(value.fetch).not.toHaveBeenCalled();
    });

    test("uses only the fixed gateway origin and injects the stored credential", async () => {
        const value = await harness();
        const response = await value.client.request(request({ headers: { Accept: "application/json", "x-request-id": "public-id" } }));

        const [url, init] = value.fetch.mock.calls[0];
        expect(url.toString()).toBe("https://gateway.shotshot.ai/v1/responses");
        expect(init!.headers).toMatchObject({ authorization: "Bearer gateway-secret", accept: "application/json", "x-request-id": "public-id" });
        expect(response.headers).not.toHaveProperty("authorization");
        expect(JSON.stringify(response)).not.toContain("gateway-secret");
    });

    test.each([
        { path: "https://evil.example/v1/responses" },
        { path: "/v1/unknown" },
        { headers: { Authorization: "Bearer renderer-secret" } },
        { headers: { Cookie: "session=renderer-secret" } },
        { headers: { Host: "evil.example" } },
        { headers: { "x-forwarded-host": "evil.example" } },
    ])("rejects unsafe renderer input before network access: %j", async (override) => {
        const value = await harness();
        await expect(value.client.request(request(override as Partial<ManagedModelRequest>))).rejects.toMatchObject({ code: "managed_invalid_request" });
        expect(value.fetch).not.toHaveBeenCalled();
    });

    test("rejects models outside the server-owned catalog", async () => {
        const value = await harness();
        await expect(value.client.request(request({ body: { kind: "json", value: JSON.stringify({ model: "renderer-picked" }) } }))).rejects.toMatchObject({ code: "managed_invalid_request" });
        expect(value.fetch).not.toHaveBeenCalled();
    });

    test("rotates an expired or policy-mismatched credential", async () => {
        const value = await harness();
        value.cloud.getStoredGatewayCredential.mockResolvedValueOnce({ ...CREDENTIAL, expiresAt: "2026-09-05T02:00:01.000Z" });
        await value.client.request(request());
        expect(value.cloud.rotateGatewayCredential).toHaveBeenCalledWith([MODEL.id]);
        expect((value.fetch.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe("Bearer rotated-secret");
    });

    test("recovers device_token_exists by rotating", async () => {
        const value = await harness();
        value.cloud.getStoredGatewayCredential.mockResolvedValueOnce(null);
        value.cloud.issueGatewayCredential.mockRejectedValueOnce(new ShotshotCloudClientError("cloud_request_failed", 409, "device_token_exists"));
        await value.client.request(request());
        expect(value.cloud.rotateGatewayCredential).toHaveBeenCalledOnce();
    });

    test("shares one credential renewal across concurrent resolvers", async () => {
        const value = await harness();
        value.cloud.getStoredGatewayCredential.mockResolvedValue(null);
        const [first, second] = await Promise.all([
            value.client.resolveApiKeyForTextModel(MODEL.id),
            value.client.resolveApiKeyForTextModel(MODEL.id),
        ]);
        expect(first).toBe("gateway-secret");
        expect(second).toBe("gateway-secret");
        expect(value.cloud.issueGatewayCredential).toHaveBeenCalledTimes(1);
        expect(value.cloud.rotateGatewayCredential).not.toHaveBeenCalled();
    });

    test("recovers a rotation race by re-anchoring with issue", async () => {
        const value = await harness();
        value.cloud.getStoredGatewayCredential.mockResolvedValue({ ...CREDENTIAL, expiresAt: "2026-09-05T02:00:01.000Z" });
        value.cloud.rotateGatewayCredential.mockRejectedValueOnce(new ShotshotCloudClientError("cloud_request_failed", 409, "device_token_changed"));
        await value.client.request(request());
        expect(value.cloud.issueGatewayCredential).toHaveBeenCalledOnce();
        expect((value.fetch.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe("Bearer gateway-secret");
    });

    test("recovers device_token_not_found by issuing", async () => {
        const value = await harness();
        value.cloud.getStoredGatewayCredential.mockResolvedValue({ ...CREDENTIAL, expiresAt: "2026-09-05T02:00:01.000Z" });
        value.cloud.rotateGatewayCredential.mockRejectedValueOnce(new ShotshotCloudClientError("cloud_request_failed", 409, "device_token_not_found"));
        await value.client.request(request());
        expect(value.cloud.issueGatewayCredential).toHaveBeenCalledOnce();
    });

    test("retries one gateway 401 with a rotated credential", async () => {
        const fetch = vi.fn()
            .mockResolvedValueOnce(new Response("unauthorized", { status: 401, headers: { "content-type": "text/plain" } }))
            .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }));
        const value = await harness(fetch);
        const response = await value.client.request(request());
        expect(response.status).toBe(200);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(value.cloud.clearGatewayCredential).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[1][1].headers.authorization).toBe("Bearer rotated-secret");
    });

    test("returns stable quota and request-size failures", async () => {
        const quota = await harness(vi.fn<typeof globalThis.fetch>(async () => new Response('{"error":{"code":"insufficient_user_quota"}}', { status: 403, headers: { "content-type": "application/json" } })));
        await expect(quota.client.request(request())).rejects.toMatchObject({ code: "managed_quota_exhausted" });

        const large = await harness();
        await expect(large.client.request(request({ body: { kind: "json", value: JSON.stringify({ model: MODEL.id, input: "x".repeat(2 * 1024 * 1024) }) } }))).rejects.toMatchObject({ code: "managed_request_too_large" });
        expect(large.fetch).not.toHaveBeenCalled();
    });

    test("serializes multipart bytes without accepting a renderer boundary", async () => {
        const value = await harness();
        await value.client.request(request({
            path: "/v1/images/edits",
            timeoutClass: "image",
            headers: { "content-type": "multipart/form-data; boundary=renderer" },
            body: { kind: "multipart", fields: [
                { name: "model", kind: "text", value: MODEL.id },
                { name: "image", kind: "bytes", value: new Uint8Array([1, 2, 3]), filename: "image.png", contentType: "image/png" },
            ] },
        }));
        const init = value.fetch.mock.calls[0][1];
        expect(init!.body).toBeInstanceOf(FormData);
        expect(init!.headers).not.toHaveProperty("content-type");
    });

    test("rejects oversized textual responses while reading", async () => {
        const value = await harness(vi.fn<typeof globalThis.fetch>(async () => new Response("x".repeat(16 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } })));
        await expect(value.client.request(request())).rejects.toMatchObject({ code: "managed_response_too_large" });
    });

    test("spools video binary responses above 64 MiB and removes them on dispose", async () => {
        const bytes = new Uint8Array(64 * 1024 * 1024 + 1);
        const value = await harness(vi.fn<typeof globalThis.fetch>(async () => new Response(bytes, { headers: { "content-type": "video/mp4" } })));
        const response = await value.client.request(request({
            path: "/v1/videos/video-1/content",
            method: "GET",
            timeoutClass: "video",
            body: undefined,
        }));
        expect(response.body).toMatchObject({ kind: "temporary-file", size: bytes.byteLength });
        const id = response.body.kind === "temporary-file" ? response.body.id : "";
        expect(await readFile(join(value.temporaryDirectory, `${id}.media`))).toHaveLength(bytes.byteLength);
        await value.client.dispose();
        await expect(readFile(join(value.temporaryDirectory, `${id}.media`))).rejects.toMatchObject({ code: "ENOENT" });
    }, 20_000);

    test("maps caller aborts to a stable error", async () => {
        const value = await harness(vi.fn<typeof globalThis.fetch>((_url, init) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        })) as FetchMock);
        const controller = new AbortController();
        const pending = value.client.request(request(), controller.signal);
        controller.abort();
        await expect(pending).rejects.toEqual(new ManagedModelClientError("managed_request_aborted"));
    });

    test("allows video requests for thirty minutes and then aborts", async () => {
        vi.useFakeTimers();
        try {
            let signal: AbortSignal | undefined;
            const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => new Promise((_resolve, reject) => {
                signal = init?.signal ?? undefined;
                signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
            })) as FetchMock;
            const value = await harness(fetch);
            const pending = value.client.request(request({ timeoutClass: "video" }));
            const timedOut = expect(pending).rejects.toMatchObject({ code: "managed_request_timeout" });
            await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
            expect(fetch).toHaveBeenCalledOnce();
            expect(signal?.aborted).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await timedOut;
            expect(signal?.aborted).toBe(true);
            await value.client.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    test("applies the reviewed timeout class and aborts active work on dispose", async () => {
        vi.useFakeTimers();
        try {
            const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => new Promise((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
            })) as FetchMock;
            const value = await harness(fetch);
            const pending = value.client.request(request());
            const timedOut = expect(pending).rejects.toMatchObject({ code: "managed_request_timeout" });
            await vi.advanceTimersByTimeAsync(120_001);
            await timedOut;

            const active = value.client.request(request({ id: "request-2" }));
            const aborted = expect(active).rejects.toMatchObject({ code: "managed_request_aborted" });
            await Promise.resolve();
            await value.client.dispose();
            await aborted;
        } finally {
            vi.useRealTimers();
        }
    });
});

test.each(["image", "video"] as const)("permits only the scoped managed %s task recovery POST through main", async timeoutClass => {
    const value = await harness();
    await value.client.request(request({ path: "/v1/media/tasks/original-task/recover", timeoutClass, body: undefined }));
    expect(String(value.fetch.mock.calls[0][0])).toBe("https://gateway.shotshot.ai/v1/media/tasks/original-task/recover");
    for (const path of ["/v1/media/tasks/../recover", "/v1/media/tasks/original/recover/extra", "/v1/media/tasks/original/recover?other=1"]) {
        await expect(value.client.request(request({ path }))).rejects.toMatchObject({ code: "managed_invalid_request" });
    }
    expect(value.fetch).toHaveBeenCalledOnce();
});
