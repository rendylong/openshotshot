// web/src/lib/desktop/managed-catalog-cache.test.ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ensureManagedCatalog, invalidateManagedCatalog, managedCatalogSnapshot, resetManagedCatalogForTests, resetManagedCatalogRuntime } from "./managed-catalog-cache";
import { useUserStore } from "@/stores/use-user-store";

const catalogStore = vi.hoisted(() => ({
    read: vi.fn<() => Promise<unknown>>(async () => null),
    write: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
}));
vi.mock("./managed-catalog-store", () => ({
    readManagedCatalogRecord: catalogStore.read,
    writeManagedCatalogRecord: catalogStore.write,
    clearManagedCatalogRecord: catalogStore.clear,
}));

const model = (id: string, capability: "text" | "image" | "video" | "audio" = "text") => ({ id, name: id, capability, execution: "direct" as const });

const signedIn = (subjectId = "user-1") => {
    useUserStore.setState({
        initialized: true,
        account: {
            state: "ready",
            snapshot: {
                account: { subjectId, email: null, displayName: null, avatarUrl: null },
                subscription: { plan: "free", status: "active", currentPeriodEndsAt: null, cancelAtPeriodEnd: false },
                usage: { balance: 0, usedUnits: 0, periodStart: "", periodEnd: "" },
                entitlements: [],
                fetchedAt: "2026-01-01T00:00:00Z",
            },
        },
    });
};

const diskRecord = (subjectId = "user-1", ageMs = 1_000) => ({ version: 1, subjectId, fetchedAt: Date.now() - ageMs, models: [model("m-disk")] });

function mockBridge(listModels: ReturnType<typeof vi.fn>) {
    window.shotshot = { agent: {} as never, skills: {} as never, platform: "darwin", managedModels: { listModels, fetch: vi.fn(), abort: vi.fn() } as never };
}

afterEach(() => {
    delete window.shotshot;
    resetManagedCatalogForTests();
    useUserStore.setState({ account: { state: "signed-out" }, initialized: false });
});

describe("managed catalog cache", () => {
    test("fetches once within the TTL window", async () => {
        const listModels = vi.fn(async () => [model("m-text")]);
        mockBridge(listModels);
        await expect(ensureManagedCatalog()).resolves.toMatchObject([{ id: "m-text" }]);
        await expect(ensureManagedCatalog()).resolves.toMatchObject([{ id: "m-text" }]);
        expect(listModels).toHaveBeenCalledOnce();
        expect(managedCatalogSnapshot()).toMatchObject({ status: "ready" });
    });

    test("keeps previous models and marks them stale when a refresh fails", async () => {
        const listModels = vi.fn()
            .mockResolvedValueOnce([model("m-text")])
            .mockRejectedValueOnce(new Error("signed_out"));
        mockBridge(listModels);
        await ensureManagedCatalog();
        invalidateManagedCatalog();
        await expect(ensureManagedCatalog()).rejects.toThrow("signed_out");
        expect(managedCatalogSnapshot()).toMatchObject({ status: "stale" });
        expect(managedCatalogSnapshot()?.models).toHaveLength(1);
    });

    test("reports an error snapshot when the first fetch fails", async () => {
        mockBridge(vi.fn(async () => { throw new Error("managed_desktop_required"); }));
        await expect(ensureManagedCatalog()).rejects.toThrow("managed_desktop_required");
        expect(managedCatalogSnapshot()).toMatchObject({ status: "error", models: [] });
    });

    test("deduplicates concurrent refreshes", async () => {
        const listModels = vi.fn(async () => [model("m-text")]);
        mockBridge(listModels);
        invalidateManagedCatalog();
        await Promise.all([ensureManagedCatalog(), ensureManagedCatalog()]);
        expect(listModels).toHaveBeenCalledOnce();
    });

    test("refetches after invalidation even inside the TTL window", async () => {
        const listModels = vi.fn(async () => [model("m-text")]);
        mockBridge(listModels);
        await ensureManagedCatalog();
        invalidateManagedCatalog();
        await ensureManagedCatalog();
        expect(listModels).toHaveBeenCalledTimes(2);
    });
});

describe("managed catalog persistence", () => {
    beforeEach(() => {
        catalogStore.read.mockReset();
        catalogStore.read.mockResolvedValue(null);
        catalogStore.write.mockReset();
        catalogStore.write.mockResolvedValue(undefined);
        catalogStore.clear.mockReset();
        catalogStore.clear.mockResolvedValue(undefined);
    });

    test("serves a fresh disk record without hitting the network", async () => {
        catalogStore.read.mockResolvedValueOnce(diskRecord("user-1", 1_000));
        const listModels = vi.fn(async () => [model("m-net")]);
        mockBridge(listModels);
        await expect(ensureManagedCatalog()).resolves.toMatchObject([{ id: "m-disk" }]);
        expect(listModels).not.toHaveBeenCalled();
        expect(managedCatalogSnapshot()).toMatchObject({ status: "ready" });
    });

    test("injects a stale disk snapshot and keeps it when offline", async () => {
        catalogStore.read.mockResolvedValueOnce(diskRecord("user-1", 10 * 60_000));
        mockBridge(vi.fn(async () => { throw new Error("gateway_unreachable"); }));
        await expect(ensureManagedCatalog()).rejects.toThrow("gateway_unreachable");
        expect(managedCatalogSnapshot()).toMatchObject({ status: "stale" });
        expect(managedCatalogSnapshot()?.models).toMatchObject([{ id: "m-disk" }]);
    });

    test("drops a disk record that belongs to another signed-in account", async () => {
        signedIn("user-2");
        catalogStore.read.mockResolvedValueOnce(diskRecord("user-1"));
        const listModels = vi.fn(async () => [model("m-net")]);
        mockBridge(listModels);
        await ensureManagedCatalog();
        expect(catalogStore.clear).toHaveBeenCalled();
        expect(listModels).toHaveBeenCalledOnce();
        expect(managedCatalogSnapshot()?.models).toMatchObject([{ id: "m-net" }]);
    });

    test("persists the fetched catalog for the signed-in account", async () => {
        signedIn("user-1");
        const listModels = vi.fn(async () => [model("m-net")]);
        mockBridge(listModels);
        await ensureManagedCatalog();
        await vi.waitFor(() => expect(catalogStore.write).toHaveBeenCalled());
        expect(catalogStore.write).toHaveBeenCalledWith(expect.objectContaining({ version: 1, subjectId: "user-1", models: [model("m-net")] }));
    });

    test("skips persisting when no account session is available", async () => {
        mockBridge(vi.fn(async () => [model("m-net")]));
        await ensureManagedCatalog();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(catalogStore.write).not.toHaveBeenCalled();
    });

    test("an ensure call spanning a reset does not poison later callers", async () => {
        let releaseRead!: () => void;
        const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
        catalogStore.read.mockReturnValueOnce(gate);
        const staleCall = ensureManagedCatalog().catch(() => "rejected");
        resetManagedCatalogForTests();
        const listModels = vi.fn(async () => [model("m-net")]);
        mockBridge(listModels);
        catalogStore.read.mockResolvedValueOnce(null);
        await expect(ensureManagedCatalog()).resolves.toMatchObject([{ id: "m-net" }]);
        releaseRead();
        await expect(staleCall).resolves.toBeDefined();
        expect(listModels).toHaveBeenCalledOnce();
    });

    test("re-reads the disk and refetches after a runtime reset", async () => {
        signedIn("user-1");
        const listModels = vi.fn(async () => [model("m-net")]);
        mockBridge(listModels);
        await ensureManagedCatalog();
        resetManagedCatalogRuntime();
        expect(managedCatalogSnapshot()).toBeNull();
        catalogStore.read.mockResolvedValueOnce(diskRecord("user-1", 10 * 60_000));
        invalidateManagedCatalog();
        await expect(ensureManagedCatalog()).resolves.toMatchObject([{ id: "m-net" }]);
        expect(listModels).toHaveBeenCalledTimes(2);
        expect(managedCatalogSnapshot()).toMatchObject({ status: "ready" });
    });
});
