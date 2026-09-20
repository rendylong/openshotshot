// web/src/lib/desktop/managed-catalog-cache.ts
import type { ManagedModelDescriptor } from "./managed-model-types";
import { clearManagedCatalogRecord, readManagedCatalogRecord, writeManagedCatalogRecord } from "./managed-catalog-store";
import { useUserStore } from "@/stores/use-user-store";

// 套餐目录的渲染层快照：请求时解析的唯一数据源。60s TTL（与 scheduleUsageRefresh
// 同先例），失败保留上一份快照并标记 stale——配置偏好只是缓存，真值在云端目录。
// 快照另有本地持久化：启动先把上次目录注入内存（stale-while-revalidate），再由
// ensure 触发后台重验证；本地记录只服务展示，执行侧真值仍由主进程逐请求校验。
export type ManagedCatalogStatus = "ready" | "stale" | "error";
export type ManagedCatalogSnapshot = {
    status: ManagedCatalogStatus;
    models: ManagedModelDescriptor[];
    fetchedAt: number;
};

const TTL_MS = 60_000;

let snapshot: ManagedCatalogSnapshot | null = null;
let inFlight: Promise<ManagedModelDescriptor[]> | null = null;
let forceRefresh = false;
let diskHydration: Promise<void> | null = null;
// 重置（登出/测试）递增；ensure 跨越一次重置时不得继续取数，也不得让后来的
// 调用方误加入旧调用创建的 in-flight（旧调用的 bridge/账号上下文可能已失效）。
let fetchEpoch = 0;
const listeners = new Set<() => void>();

function publish(next: ManagedCatalogSnapshot | null) {
    snapshot = next;
    for (const listener of listeners) listener();
}

function bridge() {
    const value = typeof window === "undefined" ? undefined : window.shotshot?.managedModels;
    if (!value) throw new Error("managed_desktop_required");
    return value;
}

export function managedCatalogSnapshot(): ManagedCatalogSnapshot | null {
    return snapshot;
}

export function subscribeManagedCatalog(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function invalidateManagedCatalog(): void {
    forceRefresh = true;
}

// 启动注入：只在内存还没有快照时生效。60s 内的磁盘记录视同 ready（重启免网络），
// 更旧的标 stale，由随后的 ensure 走正常刷新。账号已知且不匹配时丢弃并清记录。
function hydrateFromDisk(): Promise<void> {
    diskHydration ??= readManagedCatalogRecord()
        .then(async (record) => {
            if (!record || snapshot) return;
            const account = useUserStore.getState().account;
            if ((account.state === "ready" || account.state === "stale") && account.snapshot.account.subjectId !== record.subjectId) {
                await clearManagedCatalogRecord().catch(() => undefined);
                return;
            }
            const fresh = Date.now() - record.fetchedAt < TTL_MS;
            publish({ status: fresh ? "ready" : "stale", models: record.models, fetchedAt: record.fetchedAt });
        })
        .catch(() => undefined);
    return diskHydration;
}

// 写盘尽力而为：等不到已登录账号（未登录/恢复失败）就跳过，失败静默。
async function persistToDisk(models: ManagedModelDescriptor[], fetchedAt: number): Promise<void> {
    try {
        await useUserStore.getState().initialize().catch(() => undefined);
        const account = useUserStore.getState().account;
        if (account.state !== "ready" && account.state !== "stale") return;
        await writeManagedCatalogRecord({ version: 1, subjectId: account.snapshot.account.subjectId, fetchedAt, models });
    } catch { /* 缓存写盘失败不影响内存快照 */ }
}

export async function ensureManagedCatalog(): Promise<ManagedModelDescriptor[]> {
    const epoch = fetchEpoch;
    await hydrateFromDisk();
    if (epoch !== fetchEpoch) return managedCatalogSnapshot()?.models ?? [];
    if (!forceRefresh && snapshot && snapshot.status === "ready" && Date.now() - snapshot.fetchedAt < TTL_MS) return snapshot.models;
    if (inFlight) return inFlight;
    forceRefresh = false;
    const task = (async () => {
        try {
            const models = await bridge().listModels();
            const fetchedAt = Date.now();
            publish({ status: "ready", models, fetchedAt });
            void persistToDisk(models, fetchedAt);
            return models;
        } catch (error) {
            if (snapshot && snapshot.models.length) publish({ ...snapshot, status: "stale" });
            else publish({ status: "error", models: [], fetchedAt: Date.now() });
            throw error;
        }
    })();
    inFlight = task;
    // 任务可能同步失败（无 bridge 即抛）；finally 必须按身份清位，防止外层
    // 赋值把已拒绝的 task 留在 inFlight 里毒化后续调用方。
    task.finally(() => { if (inFlight === task) inFlight = null; }).catch(() => undefined);
    return task;
}

// 登出时清空内存快照与注水记忆；下次 ensure 重新读盘、重新拉取。
export function resetManagedCatalogRuntime(): void {
    fetchEpoch += 1;
    diskHydration = null;
    if (snapshot) publish(null);
}

export function resetManagedCatalogForTests(): void {
    fetchEpoch += 1;
    snapshot = null;
    inFlight = null;
    forceRefresh = false;
    diskHydration = null;
    listeners.clear();
}
