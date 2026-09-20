// 组件侧项目资产 URL 订阅：挂载/ref revision 变化时解析，changed 事件后重解析，
// missing 事件后暴露显式缺失态。URL 的创建与撤销全部经由集中缓存，组件不自行 revoke。
import { useEffect, useRef, useState } from "react";

import type { CanvasAssetRef } from "@/lib/project-assets/project-asset-types";
import { isCanvasAssetMissing, onCanvasAssetChanged, resolveCanvasAssetUrl } from "@/services/project-asset-storage";

export type ProjectAssetUrlStatus = "loading" | "ready" | "missing";
export type ProjectAssetUrlState = { url: string; status: ProjectAssetUrlStatus };

const assetKeyOf = (assetRef: CanvasAssetRef) => (assetRef.backend === "project-file" ? `p:${assetRef.projectId}:${assetRef.assetId}:${assetRef.revision}` : `i:${assetRef.storageKey}`);

export function useProjectAssetUrl(assetRef: CanvasAssetRef | undefined, fallback = ""): ProjectAssetUrlState {
    const [state, setState] = useState<ProjectAssetUrlState>(() => ({ url: fallback, status: assetRef ? "loading" : "ready" }));
    const latestAssetRef = useRef(assetRef);
    latestAssetRef.current = assetRef;
    const assetKey = assetRef ? assetKeyOf(assetRef) : "";

    useEffect(() => {
        const ref = latestAssetRef.current;
        if (!ref) {
            setState({ url: fallback, status: "ready" });
            return;
        }
        let cancelled = false;
        // 只有最新一次解析请求允许提交结果：事件触发的重解析或显式 missing 都会作废仍在途的旧请求，
        // 防止旧 resolve 晚于新结果落定，用旧 revision 的 URL 或 ready+fallback 覆盖新状态。
        let requestSeq = 0;
        setState({ url: fallback, status: "loading" });
        const resolveLatest = async () => {
            requestSeq += 1;
            const requestId = requestSeq;
            const current = latestAssetRef.current;
            if (!current || isCanvasAssetMissing(current)) {
                if (!cancelled && requestId === requestSeq) setState({ url: fallback, status: current ? "missing" : "ready" });
                return;
            }
            const url = await resolveCanvasAssetUrl(current, fallback);
            if (!cancelled && requestId === requestSeq) setState({ url, status: "ready" });
        };
        void resolveLatest();
        if (ref.backend !== "project-file") return () => { cancelled = true; };
        const unsubscribe = onCanvasAssetChanged(ref.projectId, ref.assetId, (event) => {
            if (cancelled) return;
            if (event.type === "missing") {
                requestSeq += 1;
                setState({ url: fallback, status: "missing" });
                return;
            }
            void resolveLatest();
        });
        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, [assetKey, fallback]);

    return state;
}
