import { useMemo } from "react";

import { assetMentionResolverFrom, buildAssetMentionCandidates, type AssetMentionCandidate, type AssetMentionResolver } from "@/lib/canvas/asset-mentions";
import { useAssetStore } from "@/stores/use-asset-store";

export function useAssetMentionCandidates(): AssetMentionCandidate[] {
    const assets = useAssetStore((state) => state.assets);
    return useMemo(() => buildAssetMentionCandidates(assets), [assets]);
}

export function useAssetMentionResolver(): AssetMentionResolver {
    const assets = useAssetStore((state) => state.assets);
    return useMemo(() => assetMentionResolverFrom(assets), [assets]);
}
