import { useInfiniteQuery } from "@tanstack/react-query";
import type { CatalogQuery } from "@/lib/models/model-catalog-types";
import { fetchChannelCatalog } from "@/services/api/channel-model-catalog";
import type { ModelChannel } from "@/stores/use-config-store";

export function useChannelModelCatalog(channel: ModelChannel | null, query: CatalogQuery, enabled: boolean) {
    return useInfiniteQuery({
        queryKey: ["channel-catalog", channel?.id, channel?.provider, channel?.baseUrl, query.q, query.category],
        initialPageParam: undefined as string | undefined,
        enabled: enabled && Boolean(channel),
        queryFn: ({ pageParam, signal }) => fetchChannelCatalog(channel!, { ...query, cursor: pageParam }, signal),
        getNextPageParam: page => page.hasMore ? page.nextCursor ?? undefined : undefined,
        retry: false,
        refetchOnWindowFocus: false,
    });
}
