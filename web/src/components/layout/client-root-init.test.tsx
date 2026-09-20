// web/src/components/layout/client-root-init.test.tsx
import { act, render } from "@testing-library/react";
import { App } from "antd";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

const catalogStore = vi.hoisted(() => ({ clear: vi.fn(async () => undefined) }));
vi.mock("@/lib/desktop/managed-catalog-store", () => ({ clearManagedCatalogRecord: catalogStore.clear }));
const catalogRuntime = vi.hoisted(() => ({ reset: vi.fn() }));
// 注意：cache 模块在本文件的导入图里还被 model-transport（经 RemoteMediaTaskRuntime）
// 引用，mock 必须提供完整导出面，否则具名导入缺项会在加载期报错。
vi.mock("@/lib/desktop/managed-catalog-cache", () => ({
    resetManagedCatalogRuntime: catalogRuntime.reset,
    ensureManagedCatalog: vi.fn(async () => []),
    managedCatalogSnapshot: vi.fn(() => null),
    subscribeManagedCatalog: vi.fn(() => () => undefined),
    invalidateManagedCatalog: vi.fn(),
    resetManagedCatalogForTests: vi.fn(),
}));

import i18n from "@/i18n";
import { useUserStore } from "@/stores/use-user-store";
import { ClientRootInit } from "./client-root-init";

const accountSnapshot = {
    account: { subjectId: "user-1", email: null, displayName: null, avatarUrl: null },
    subscription: { plan: "free" as const, status: "active", currentPeriodEndsAt: null, cancelAtPeriodEnd: false },
    usage: { balance: 0, usedUnits: 0, periodStart: "", periodEnd: "" },
    entitlements: [],
    fetchedAt: "2026-01-01T00:00:00Z",
};

function renderInit() {
    return render(<App><I18nextProvider i18n={i18n}><ClientRootInit>plain</ClientRootInit></I18nextProvider></App>);
}

describe("client root init", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useUserStore.setState({ account: { state: "signed-out" }, initialized: false });
    });

    it("clears the persisted catalog when the account signs out", () => {
        useUserStore.setState({ account: { state: "ready", snapshot: accountSnapshot }, initialized: true });
        renderInit();
        act(() => useUserStore.setState({ account: { state: "signed-out" }, initialized: false }));
        expect(catalogRuntime.reset).toHaveBeenCalled();
        expect(catalogStore.clear).toHaveBeenCalled();
    });

    it("does not clear on unrelated account transitions", () => {
        renderInit();
        act(() => useUserStore.setState({ account: { state: "signing-in" }, initialized: true }));
        act(() => useUserStore.setState({ account: { state: "ready", snapshot: accountSnapshot }, initialized: true }));
        expect(catalogRuntime.reset).not.toHaveBeenCalled();
        expect(catalogStore.clear).not.toHaveBeenCalled();
    });
});
