// web/src/lib/desktop/managed-catalog-store.test.ts
import { beforeEach, describe, expect, test } from "vitest";
import {
    MANAGED_CATALOG_KEY,
    clearManagedCatalogRecord,
    managedCatalogStorage,
    parseManagedCatalogRecord,
    readManagedCatalogRecord,
    writeManagedCatalogRecord,
    type ManagedCatalogRecord,
} from "./managed-catalog-store";

const record = (overrides: Partial<ManagedCatalogRecord> = {}): ManagedCatalogRecord => ({
    version: 1,
    subjectId: "user-1",
    fetchedAt: Date.now() - 5_000,
    models: [{ id: "m-text", name: "M", capability: "text", execution: "direct" }],
    ...overrides,
});

beforeEach(async () => { await clearManagedCatalogRecord(); });

describe("managed catalog store", () => {
    test("round-trips a valid record", async () => {
        const valid = record();
        await writeManagedCatalogRecord(valid);
        await expect(readManagedCatalogRecord()).resolves.toEqual(valid);
    });

    test("treats a missing record as no cache", async () => {
        await expect(readManagedCatalogRecord()).resolves.toBeNull();
    });

    test("returns null and clears the key for corrupt payloads", async () => {
        await managedCatalogStorage.setItem(MANAGED_CATALOG_KEY, { version: 1 });
        await expect(readManagedCatalogRecord()).resolves.toBeNull();
        await expect(managedCatalogStorage.getItem(MANAGED_CATALOG_KEY)).resolves.toBeNull();
    });

    test("rejects unknown versions", () => {
        expect(parseManagedCatalogRecord({ ...record(), version: 2 })).toBeNull();
    });

    test("rejects records without a usable subjectId or timestamp", () => {
        expect(parseManagedCatalogRecord({ ...record(), subjectId: "" })).toBeNull();
        expect(parseManagedCatalogRecord({ ...record(), subjectId: "  " })).toBeNull();
        expect(parseManagedCatalogRecord({ ...record(), fetchedAt: 0 })).toBeNull();
        expect(parseManagedCatalogRecord({ ...record(), fetchedAt: Number.NaN })).toBeNull();
    });

    test("rejects records with malformed model entries", () => {
        expect(parseManagedCatalogRecord({ ...record(), models: "nope" })).toBeNull();
        expect(parseManagedCatalogRecord({ ...record(), models: [{ id: "x" }] })).toBeNull();
        expect(parseManagedCatalogRecord({ ...record(), models: [{ ...record().models[0], capability: "other" }] })).toBeNull();
        expect(parseManagedCatalogRecord({ ...record(), models: [{ ...record().models[0], execution: "magic" }] })).toBeNull();
    });

    test("round-trips canonical input modalities on text models", async () => {
        const valid = record({ models: [{ id: "minimax-m3", name: "M3", capability: "text", execution: "direct", input_modalities: ["text", "image"] }] });
        await writeManagedCatalogRecord(valid);
        await expect(readManagedCatalogRecord()).resolves.toEqual(valid);
    });

    test("drops records with non-canonical or misplaced input modalities", () => {
        expect(parseManagedCatalogRecord(record({ models: [{ id: "m", name: "M", capability: "text", execution: "direct", input_modalities: ["image"] }] }))).toBeNull();
        expect(parseManagedCatalogRecord(record({ models: [{ id: "m", name: "M", capability: "text", execution: "direct", input_modalities: ["text", "image", "text"] }] }))).toBeNull();
        expect(parseManagedCatalogRecord(record({ models: [{ id: "m", name: "M", capability: "image", execution: "direct", input_modalities: ["text"] }] }))).toBeNull();
    });
});
