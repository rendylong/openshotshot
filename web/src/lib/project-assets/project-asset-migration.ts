// 旧 IndexedDB 媒体 → 项目工作区资产的安全迁移（仅桌面）。copy-verify-commit：
// 逐候选读取旧 Blob，经项目资产门面以 source.type="legacy-migration" 写入并校验返回字节数；
// 全部可读候选写成功后，才在渲染层一次性提交 Project 与 Script 实体两个 store 并 flush 落盘。
// 任一写入失败即整体失败（回滚 = 不提交内存补丁）；缺失的旧 Blob 记入 missing 且原状保留。
// 提交成功后删除已迁移的 IndexedDB 源键（move 语义，失败不回滚）。规划器为纯枚举，不产生副作用。

import {
    classifyProjectAsset,
    type CanvasAssetRef,
    type ProjectAssetKind,
    type ProjectAssetSource,
} from "@/lib/project-assets/project-asset-types";
import { serializeProjectAssetToken } from "@/lib/canvas/asset-ref-token";
import { ensureProjectAssetWorkspace, getCanvasAssetBlob, storeCanvasImage, storeCanvasMedia } from "@/services/project-asset-storage";
import { deleteStoredMediaKeys } from "@/services/stored-media-delete";
import { useProjectStore } from "@/stores/canvas/use-project-store";
import { useScriptEntityStore, type EntityAssetMigrationPatch, type ScriptEntity } from "@/stores/use-script-entity-store";
import type { CanvasNodeMetadata } from "@/types/canvas";
import type { Project } from "@/types/project";

/** 画布元数据内一个可挂 assetRef 的位置。 */
export type LegacyCanvasAssetTarget =
    | { part: "metadata" }
    | { part: "image"; imageId: string }
    | { part: "model3d" }
    | { part: "model3d-view"; viewId: string }
    | { part: "shot-audio"; shotId: string; slot: "sfx" | "dialogue" }
    | { part: "reference"; index: number };

/** 补丁归属：画布节点内位置，或 Script 实体参考槽。 */
export type LegacyAssetPatchLocation =
    | { store: "canvas"; canvasId: string; nodeId: string; target: LegacyCanvasAssetTarget }
    | { store: "script-entity"; entityId: string; refId: string };

/** 迁移候选：同一 storageKey 去重为一条，但保留全部所有者补丁位置。 */
export type LegacyAssetCandidate = {
    storageKey: string;
    originalName: string;
    kind: ProjectAssetKind;
    source: ProjectAssetSource;
    locations: LegacyAssetPatchLocation[];
};

export type LegacyAssetMigrationResult = { migrated: number; missing: string[] };

const LEGACY_PREFIXES = ["image:", "video:", "audio:", "file:", "glb:"] as const;

function isLegacyStorageKey(value: unknown): value is string {
    return typeof value === "string" && LEGACY_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function isProjectFileRef(ref: CanvasAssetRef | undefined) {
    return ref?.backend === "project-file";
}

function mimeSubtype(mimeType: string | undefined): string {
    return mimeType?.split(";")[0]?.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "";
}

function legacyAssetName(storageKey: string, mimeType: string | undefined, explicit?: string): string {
    const name = explicit?.trim();
    if (name) return name;
    const tail = storageKey.slice(storageKey.indexOf(":") + 1) || storageKey;
    if (tail.includes(".")) return tail;
    const subtype = mimeSubtype(mimeType);
    return subtype ? `${tail}.${subtype}` : tail;
}

function legacyAssetKind(storageKey: string, name: string, mimeType?: string): ProjectAssetKind {
    if (storageKey.startsWith("image:")) return "image";
    if (storageKey.startsWith("video:")) return "video";
    if (storageKey.startsWith("audio:")) return "audio";
    return classifyProjectAsset(name, mimeType ?? "");
}

function sourceForLocation(location: LegacyAssetPatchLocation): ProjectAssetSource {
    if (location.store === "script-entity") return { type: "legacy-migration", role: "entity-reference" };
    const base: ProjectAssetSource = { type: "legacy-migration", canvasId: location.canvasId, nodeId: location.nodeId };
    if (location.target.part !== "shot-audio") return base;
    return { ...base, scriptNodeId: location.nodeId, shotId: location.target.shotId, role: location.target.slot };
}

/** 剥离持久化位置的旧 storageKey 字段（destructure-omit：字段从对象中消失，而非显式 undefined）。 */
function withoutStorageKey<T extends { storageKey?: string }>(value: T): Omit<T, "storageKey"> {
    const { storageKey: _stripped, ...rest } = value;
    return rest;
}

function planNodeMetadata(
    metadata: CanvasNodeMetadata,
    canvasId: string,
    nodeId: string,
    add: (storageKey: string, location: LegacyAssetPatchLocation, mimeType?: string, explicitName?: string) => void,
) {
    if (isLegacyStorageKey(metadata.storageKey) && !isProjectFileRef(metadata.assetRef)) {
        add(metadata.storageKey, { store: "canvas", canvasId, nodeId, target: { part: "metadata" } }, metadata.mimeType);
    }
    for (const image of metadata.images ?? []) {
        if (isLegacyStorageKey(image.storageKey) && !isProjectFileRef(image.assetRef)) {
            add(image.storageKey, { store: "canvas", canvasId, nodeId, target: { part: "image", imageId: image.id } }, image.mimeType);
        }
    }
    const model3d = metadata.model3d;
    if (model3d) {
        if (isLegacyStorageKey(model3d.storageKey) && !isProjectFileRef(model3d.assetRef)) {
            add(model3d.storageKey, { store: "canvas", canvasId, nodeId, target: { part: "model3d" } }, model3d.mimeType, model3d.name);
        }
        for (const view of model3d.views ?? []) {
            if (isLegacyStorageKey(view.storageKey) && !isProjectFileRef(view.assetRef)) {
                add(view.storageKey, { store: "canvas", canvasId, nodeId, target: { part: "model3d-view", viewId: view.id } });
            }
        }
        // snapshot 预览保持旧链路（plan Ruling T6-B）：属可再生缓存，不迁正式资产。
    }
    for (const shotOf of metadata.script?.output.shots ?? []) {
        const dialogue = shotOf.dialogueAudio;
        if (dialogue && isLegacyStorageKey(dialogue.storageKey) && !isProjectFileRef(dialogue.assetRef)) {
            add(dialogue.storageKey, { store: "canvas", canvasId, nodeId, target: { part: "shot-audio", shotId: shotOf.shotId, slot: "dialogue" } }, dialogue.mimeType, dialogue.name);
        }
        const sfx = shotOf.sfxAudio;
        if (sfx && isLegacyStorageKey(sfx.storageKey) && !isProjectFileRef(sfx.assetRef)) {
            add(sfx.storageKey, { store: "canvas", canvasId, nodeId, target: { part: "shot-audio", shotId: shotOf.shotId, slot: "sfx" } }, sfx.mimeType, sfx.name);
        }
    }
    for (const [index, url] of (metadata.references ?? []).entries()) {
        if (isLegacyStorageKey(url)) {
            add(url, { store: "canvas", canvasId, nodeId, target: { part: "reference", index } });
        }
    }
}

/** 纯枚举：遍历画布节点元数据（顶层/多图/model3d 资产与视图/镜头音频）与 Script 实体参考槽。
    已是 project-file 引用的位置不产生候选（幂等）；对象 URL 与远程 URL 不在 storageKey 字段，天然忽略。 */
export function planLegacyAssetMigration(project: Project, entities: Pick<ScriptEntity, "id" | "refs">[] = []): LegacyAssetCandidate[] {
    const byKey = new Map<string, LegacyAssetCandidate>();
    const add = (storageKey: string, location: LegacyAssetPatchLocation, mimeType?: string, explicitName?: string) => {
        const existing = byKey.get(storageKey);
        if (existing) {
            existing.locations.push(location);
            return;
        }
        const originalName = legacyAssetName(storageKey, mimeType, explicitName);
        byKey.set(storageKey, {
            storageKey,
            originalName,
            kind: legacyAssetKind(storageKey, originalName, mimeType),
            source: sourceForLocation(location),
            locations: [location],
        });
    };
    for (const canvasOf of project.canvases) {
        for (const nodeOf of canvasOf.nodes) {
            if (nodeOf.metadata) planNodeMetadata(nodeOf.metadata, canvasOf.id, nodeOf.id, add);
        }
    }
    for (const entity of entities) {
        for (const ref of entity.refs ?? []) {
            if (isLegacyStorageKey(ref.storageKey) && !isProjectFileRef(ref.assetRef)) {
                add(ref.storageKey, { store: "script-entity", entityId: entity.id, refId: ref.id });
            }
        }
    }
    return [...byKey.values()];
}

/** commit 前的错位竞态守卫（终审 I1）：copy-verify 窗口内用户重生成会整体替换目标位置的 storageKey。
    仅当该位置当前键仍等于 plan 时记录的旧键才允许剥离挂 ref；已变的目标必须丢弃（新键是合法旧前缀，
    下次打开自然重试），否则补丁会盲目剥离新键挂旧 ref，静默替换用户的新内容。 */
export function legacyTargetStillMatches(metadata: CanvasNodeMetadata, target: LegacyCanvasAssetTarget, expectedKey: string): boolean {
    if (target.part === "metadata") return metadata.storageKey === expectedKey;
    if (target.part === "image") return metadata.images?.find((image) => image.id === target.imageId)?.storageKey === expectedKey;
    if (target.part === "model3d") return metadata.model3d?.storageKey === expectedKey;
    if (target.part === "model3d-view") return metadata.model3d?.views?.find((view) => view.id === target.viewId)?.storageKey === expectedKey;
    if (target.part === "reference") return metadata.references?.[target.index] === expectedKey;
    const shot = metadata.script?.output.shots.find((item) => item.shotId === target.shotId);
    const audio = target.slot === "dialogue" ? shot?.dialogueAudio : shot?.sfxAudio;
    return audio?.storageKey === expectedKey;
}

/** 把一组迁移目标位置折入节点元数据（不可变，返回新对象）。挂 assetRef 的同时剥离该位置旧 storageKey；
    model3d.snapshot.storageKey 保持不动（plan Ruling T6-B：可再生缓存）。 */
export function applyLegacyAssetRefToMetadata(metadata: CanvasNodeMetadata, targets: LegacyCanvasAssetTarget[], assetRef: CanvasAssetRef): CanvasNodeMetadata {
    let next = metadata;
    for (const target of targets) {
        if (target.part === "metadata") {
            next = { ...withoutStorageKey(next), assetRef };
            continue;
        }
        if (target.part === "image") {
            next = { ...next, images: next.images?.map((image) => (image.id === target.imageId ? { ...withoutStorageKey(image), assetRef } : image)) };
            continue;
        }
        if (target.part === "model3d") {
            next = next.model3d ? { ...next, model3d: { ...withoutStorageKey(next.model3d), assetRef } } : next;
            continue;
        }
        if (target.part === "model3d-view") {
            next = next.model3d
                ? { ...next, model3d: { ...next.model3d, views: next.model3d.views?.map((view) => (view.id === target.viewId ? { ...withoutStorageKey(view), assetRef } : view)) } }
                : next;
            continue;
        }
        if (target.part === "reference") {
            // 迁移主入口保证 assetRef 为 project-file；references 字符串改写为可移植 token。
            const token = assetRef.backend === "project-file" ? serializeProjectAssetToken(assetRef) : undefined;
            if (!token) continue;
            next = { ...next, references: next.references?.map((item, index) => (index === target.index ? token : item)) };
            continue;
        }
        if (!next.script) continue;
        next = {
            ...next,
            script: {
                ...next.script,
                output: {
                    ...next.script.output,
                    shots: next.script.output.shots.map((shotOf) => {
                        if (shotOf.shotId !== target.shotId) return shotOf;
                        const audio = target.slot === "dialogue" ? shotOf.dialogueAudio : shotOf.sfxAudio;
                        if (!audio) return shotOf;
                        return target.slot === "dialogue" ? { ...shotOf, dialogueAudio: { ...withoutStorageKey(audio), assetRef } } : { ...shotOf, sfxAudio: { ...withoutStorageKey(audio), assetRef } };
                    }),
                },
            },
        };
    }
    return next;
}

/** 旧 IndexedDB 资产迁移主入口。无桌面桥/工作区时显式失败，不做半程迁移。 */
export async function migrateProjectAssets(projectId: string): Promise<LegacyAssetMigrationResult> {
    const project = useProjectStore.getState().projects.find((item) => item.id === projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    if (!window.shotshot?.projectAssets) throw new Error("Legacy asset migration requires the desktop project workspace");
    const entities = useScriptEntityStore.getState().entities.filter((entity) => entity.projectId === projectId);
    const candidates = planLegacyAssetMigration(project, entities);
    const missing: string[] = [];
    if (candidates.length === 0) return { migrated: 0, missing };

    // 复用门面的工作区解析：显式路径直用，缺失时幂等 ensure（会写回项目 store）。
    const ensured = await ensureProjectAssetWorkspace({
        projectId,
        projectTitle: project.title,
        workspacePath: project.workspacePath,
        canvasId: project.canvases[0]?.id ?? "",
        source: { type: "legacy-migration" },
    });
    if (!ensured.ok) throw new Error(ensured.error || "Legacy asset migration requires the desktop project workspace");

    // copy-verify：逐候选读旧 Blob → 项目资产写入 → 校验返回字节数与引用后端。顺序执行，任一失败即整体失败。
    const refsByKey = new Map<string, CanvasAssetRef>();
    for (const candidate of candidates) {
        const blob = await getCanvasAssetBlob({ backend: "indexeddb", storageKey: candidate.storageKey });
        if (!blob) {
            missing.push(candidate.storageKey);
            continue;
        }
        // 实体槽等位置无 mimeType 元数据：规划名无扩展名时按真实 Blob 类型补齐，避免落盘 .bin。
        const subtype = mimeSubtype(blob.type);
        const name = candidate.originalName.includes(".") || !subtype ? candidate.originalName : `${candidate.originalName}.${subtype}`;
        const context = {
            projectId,
            workspacePath: ensured.path,
            canvasId: candidate.source.canvasId ?? project.canvases[0]?.id ?? "",
            name,
            source: candidate.source,
        };
        const written = candidate.storageKey.startsWith("image:")
            ? await storeCanvasImage(blob, context)
            : await storeCanvasMedia(blob, context);
        if (written.assetRef?.backend !== "project-file") {
            throw new Error(`Migration write for ${candidate.storageKey} did not produce a project asset`);
        }
        if (written.bytes !== blob.size) {
            throw new Error(`Migration copy verification failed for ${candidate.storageKey}`);
        }
        refsByKey.set(candidate.storageKey, written.assetRef);
    }
    if (refsByKey.size === 0) return { migrated: 0, missing };

    // commit：全部可读候选写成功后，按最新 store 状态计算补丁并一次性提交。
    // 同一节点可能收到多个候选（不同 storageKey）的写入：按候选分组记录 expectedKey，
    // 应用时逐候选校验目标位置当前键未变（防 copy-verify 窗口内重生成导致的错位剥离，终审 I1）。
    const canvasGroups = new Map<string, { canvasId: string; nodeId: string; writes: Array<{ targets: LegacyCanvasAssetTarget[]; expectedKey: string; assetRef: CanvasAssetRef }> }>();
    const entityPatches: EntityAssetMigrationPatch[] = [];
    for (const candidate of candidates) {
        const assetRef = refsByKey.get(candidate.storageKey);
        if (!assetRef) continue; // missing 键：所有者位置保持原状
        for (const location of candidate.locations) {
            if (location.store === "script-entity") {
                entityPatches.push({ entityId: location.entityId, refId: location.refId, assetRef, clearStorageKey: true });
                continue;
            }
            const groupKey = `${location.canvasId}\u0000${location.nodeId}`;
            const group = canvasGroups.get(groupKey);
            if (group) {
                const last = group.writes[group.writes.length - 1];
                if (last && last.assetRef === assetRef) last.targets.push(location.target);
                else group.writes.push({ targets: [location.target], expectedKey: candidate.storageKey, assetRef });
            } else {
                canvasGroups.set(groupKey, { canvasId: location.canvasId, nodeId: location.nodeId, writes: [{ targets: [location.target], expectedKey: candidate.storageKey, assetRef }] });
            }
        }
    }
    const latest = useProjectStore.getState().projects.find((item) => item.id === projectId);
    const patches = [...canvasGroups.values()].flatMap((group) => {
        const node = latest?.canvases.find((canvas) => canvas.id === group.canvasId)?.nodes.find((item) => item.id === group.nodeId);
        if (!node?.metadata) return []; // 迁移期间节点被删：副本仍在但无处挂引用，跳过该补丁
        let metadata = node.metadata;
        for (const write of group.writes) {
            const targets = write.targets.filter((target) => legacyTargetStillMatches(metadata, target, write.expectedKey));
            if (targets.length) metadata = applyLegacyAssetRefToMetadata(metadata, targets, write.assetRef);
        }
        if (metadata === node.metadata) return []; // 目标位置已全部被用户替换：无可提交补丁（新键下次打开自然重试）
        return [{ canvasId: group.canvasId, nodeId: group.nodeId, metadata }];
    });
    useProjectStore.getState().applyCanvasAssetMigration(projectId, patches);
    if (entityPatches.length > 0) useScriptEntityStore.getState().applyEntityAssetMigration(entityPatches);
    await useProjectStore.getState().flush();
    // move 语义（spec §1）：提交成功后删除已迁移 IDB 源键。失败不回滚——引用已指向工作区文件，
    // 残留键身份已剥离（Task 8），由 pendingCleanup 与 cleanupUnused* 兜底回收。
    const deleteFailures = await deleteStoredMediaKeys([...refsByKey.keys()]);
    if (deleteFailures.length) console.warn(`[legacy-asset-migration] ${deleteFailures.length} source keys failed to delete; they will be reclaimed by cleanup`);
    return { migrated: refsByKey.size, missing };
}
