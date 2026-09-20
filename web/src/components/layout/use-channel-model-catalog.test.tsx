import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { expect, it, vi } from "vitest";
import { createModelChannel } from "@/stores/use-config-store";
import { fetchChannelCatalog } from "@/services/api/channel-model-catalog";
import type { CatalogPage } from "@/lib/models/model-catalog-types";
import { useChannelModelCatalog } from "./use-channel-model-catalog";

vi.mock("@/services/api/channel-model-catalog", () => ({ fetchChannelCatalog: vi.fn() }));

it("isolates channel requests, propagates abort and excludes credentials from cache keys", async () => {
    const client = new QueryClient();
    const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    let finishOld!: (page: CatalogPage) => void;
    const page: CatalogPage = { entries: [], nextCursor: null, hasMore: false, source: "network" };
    vi.mocked(fetchChannelCatalog).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })).mockResolvedValue({ ...page, source: "cache" });
    const a = createModelChannel({ id: "a", provider: "openrouter", apiKey: "private-test-key" });
    const b = { ...a, id: "b", baseUrl: "https://other.test/v1" };
    const { result, rerender } = renderHook(({ channel }) => useChannelModelCatalog(channel, { q: "model", category: "text" }, true), { initialProps: { channel: a }, wrapper });
    await waitFor(() => expect(fetchChannelCatalog).toHaveBeenCalled());
    const signal = vi.mocked(fetchChannelCatalog).mock.calls[0][2];
    rerender({ channel: b });
    await waitFor(() => expect(result.current.data?.pages[0].source).toBe("cache"));
    expect(signal?.aborted).toBe(true);
    await act(async () => finishOld(page));
    expect(result.current.data?.pages[0].source).toBe("cache");
    expect(JSON.stringify(client.getQueryCache().getAll().map(query => query.queryKey))).not.toContain("private-test-key");
});

it("passes pagination cursors and does not fetch while disabled", async () => {
    vi.mocked(fetchChannelCatalog).mockReset().mockResolvedValueOnce({ entries: [], nextCursor: "page-2", hasMore: true, source: "network" }).mockResolvedValueOnce({ entries: [], nextCursor: null, hasMore: false, source: "network" });
    const client = new QueryClient();
    const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const channel = createModelChannel({ provider: "openrouter" });
    const { result, rerender } = renderHook(({ enabled }) => useChannelModelCatalog(channel, { q: "exact" }, enabled), { initialProps: { enabled: false }, wrapper });
    expect(fetchChannelCatalog).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(async () => { await result.current.fetchNextPage(); });
    expect(fetchChannelCatalog).toHaveBeenLastCalledWith(channel, { q: "exact", cursor: "page-2" }, expect.any(AbortSignal));
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
});
