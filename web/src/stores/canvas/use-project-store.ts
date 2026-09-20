import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { localForageStorage } from "@/lib/localforage-storage";
import { canonicalCategory, UNCATEGORIZED, UNCATEGORIZED_PROJECT_ID } from "@/lib/canvas/category";
import { pendingPromptReducer } from "@/lib/canvas/pending-prompt";
import {
    addCanvasToProject, createProjectWithCanvas, findCanvas, findProject,
    migrateLegacyProject, migrateLegacyProjects, removeCanvasFromProject, renameCanvasInProject, updateCanvasInProject,
} from "@/lib/canvas/project-model";
import type { Canvas, Project } from "@/types/project";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";


export type { Canvas, Project } from "@/types/project";
export type CanvasAssetMigrationPatch = { canvasId: string; nodeId: string; metadata: CanvasNodeMetadata };
export type CanvasNodesTransactionOutcome = { applied: true } | { applied: false; reason: "missing_target" | "unchanged" };
export type ProjectHydrationStatus = "pending" | "success" | "degraded" | "error";
export type HomeCanvasTarget = { projectId: string; canvasId?: string } | null;
export type HomeCanvasResult =
    | { ok: true; projectId: string; canvasId: string }
    | { ok: false; reason: "not-ready" | "project-missing" };

type CanvasStore = {
    hydrated: boolean;
    hydrationStatus: ProjectHydrationStatus;
    projects: Project[];
    pendingPrompt: string | null;
    pendingProjectId: string | null;
    pendingCanvasId: string | null;
    createProject: (title?: string, appearance?: { icon?: string; color?: string }) => { projectId: string; canvasId: string };
    createCanvas: (projectId: string, title?: string) => string;
    createHomeCanvas: (target?: HomeCanvasTarget) => HomeCanvasResult;
    moveCanvasToProject: (fromProjectId: string, canvasId: string, toProjectId: string) => void;
    renameCanvas: (projectId: string, canvasId: string, title: string) => void;
    deleteCanvas: (projectId: string, canvasId: string, options?: { allowLast?: boolean }) => void;
    updateCanvas: (projectId: string, canvasId: string, patch: Parameters<typeof updateCanvasInProject>[2]) => void;
    /** 仅触碰「最后活跃」时间（updatedAt），供 Agent 对话受理等非编辑行为置顶画布列表；目标不存在时 no-op。 */
    touchCanvas: (projectId: string, canvasId: string) => void;
    updateCanvasNodes: (projectId: string, canvasId: string, updater: (nodes: CanvasNodeData[]) => CanvasNodeData[]) => boolean;
    /** 资产迁移专用：跨画布批量替换节点 metadata，单次 set 提交；无命中时不动状态并返回 false。 */
    applyCanvasAssetMigration: (projectId: string, patches: CanvasAssetMigrationPatch[]) => boolean;
    transactCanvasNodes: (
        projectId: string,
        canvasId: string,
        updater: (nodes: CanvasNodeData[]) => CanvasNodeData[],
        options?: { context?: CanvasPersistenceContext; onCommitted?: () => void; isTargetPresent?: (nodes: CanvasNodeData[]) => boolean },
    ) => Promise<CanvasNodesTransactionOutcome>;
    flush: (context?: { signal: AbortSignal; isActive: () => boolean }) => Promise<void>;
    findCanvas: (canvasId: string) => { project: Project; canvas: Canvas } | null;
    renameProject: (id: string, title: string) => void;
    updateProjectAppearance: (id: string, appearance: { title: string; icon: string; color: string }) => void;
    setProjectWorkspacePath: (id: string, path: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: Project[]) => void;
    setProjectCategory: (id: string, category: string) => void;
    importProject: (project: Partial<Project> & { nodes?: unknown }) => string;
    submitPendingPrompt: (prompt: string, title?: string, target?: { projectId: string; canvasId?: string }) => { projectId: string; canvasId: string } | null;
    consumePendingPrompt: () => void;
    /** Agent 后台 store 级 ops 的应用代数（运行时态，不持久化）：画布页据此 re-sync（spec 2026-09-18 D4）。 */
    agentOpsRevisions: Record<string, number>;
    bumpAgentOpsRevision: (canvasId: string) => number;
};

const CANVAS_STORE_KEY = "shotshot:canvas_store";
const CANVAS_REPAIR_KEY = `${CANVAS_STORE_KEY}:repair`;
type PersistedCanvasState = Pick<CanvasStore, "projects">;
type PersistedCanvasValue = StorageValue<CanvasStore> & { persistenceRevision?: number };
type CanvasPersistenceContext = { signal: AbortSignal; isActive: () => boolean };
type ProjectSnapshot = { projects: Project[]; projectRevision: number };
type CanvasRepairJournal = { version: 1; revision: number; projects: Project[] };
type RepairResolution = ProjectSnapshot & { retainCandidate: boolean; outcome: "retained" | "tombstone" };
export type CanvasRepairMediaDisposition = "retain" | "discard";
type PendingCanvasRepair = {
    journal: CanvasRepairJournal;
    committed: boolean;
    resolve: () => RepairResolution;
    commit: (projects: Project[]) => void;
    settleMediaDisposition?: (disposition: CanvasRepairMediaDisposition) => void;
};
export type CanvasPersistenceDiagnostic = { source: "main" | "repair"; message: string };
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersist: { name: string; value: StorageValue<CanvasStore> } | null = null;
let writeQueue = Promise.resolve();
let canvasTransactionQueue = Promise.resolve();
let projectsRevision = 0;
let persistenceRevision = 0;
let skipAutosaveProjects: Project[] | null = null;
let pendingRepair: PendingCanvasRepair | null = null;
let currentProjects = () => pendingRepair?.journal.projects || [];
let hydrationInProgress = false;
let projectHydrationStatus: ProjectHydrationStatus = "pending";
let observedProjects: Project[] | null = null;
const persistenceDiagnostics: Partial<Record<CanvasPersistenceDiagnostic["source"], CanvasPersistenceDiagnostic>> = {};

export function getCanvasPersistenceDiagnostics() {
    return Object.values(persistenceDiagnostics);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isCanvasNode(value: unknown) {
    return isRecord(value) && typeof value.id === "string" && typeof value.type === "string";
}

function isCanvas(value: unknown) {
    return isRecord(value) && typeof value.id === "string" && Array.isArray(value.nodes) && value.nodes.every(isCanvasNode);
}

function isProject(value: unknown) {
    if (!isRecord(value) || typeof value.id !== "string") return false;
    if (Array.isArray(value.canvases)) return value.canvases.every(isCanvas);
    return Array.isArray(value.nodes) && value.nodes.every(isCanvasNode);
}

function validRevision(value: unknown, optional = false): value is number | undefined {
    return (optional && value === undefined) || (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0);
}

function invalidPersistence(source: CanvasPersistenceDiagnostic["source"], message: string) {
    persistenceDiagnostics[source] = { source, message };
    return null;
}

function parsePersistenceJson(raw: string, source: CanvasPersistenceDiagnostic["source"]) {
    try {
        return JSON.parse(raw) as unknown;
    } catch (error) {
        return invalidPersistence(source, `Invalid JSON: ${errorMessage(error)}`);
    }
}

function parsePersistedCanvasValue(raw: string | null): PersistedCanvasValue | null {
    if (!raw) return null;
    const value = parsePersistenceJson(raw, "main");
    if (!isRecord(value) || value.version !== 0 || !isRecord(value.state) || !Array.isArray(value.state.projects) || !value.state.projects.every(isProject) || !validRevision(value.persistenceRevision, true)) {
        return invalidPersistence("main", "Invalid canvas-store snapshot schema");
    }
    return value as PersistedCanvasValue;
}

function parseCanvasRepairJournal(raw: string | null): CanvasRepairJournal | null {
    if (!raw) return null;
    const value = parsePersistenceJson(raw, "repair");
    if (!isRecord(value) || value.version !== 1 || !validRevision(value.revision) || !Array.isArray(value.projects) || !value.projects.every(isProject)) {
        return invalidPersistence("repair", "Invalid canvas repair journal schema");
    }
    return value as CanvasRepairJournal;
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

export class CanvasPersistenceTransactionError extends Error {
    constructor(
        public originalError: unknown,
        public rollbackError: unknown,
        public repairError?: unknown,
        public preserveMedia = true,
        public pendingMediaDisposition?: Promise<CanvasRepairMediaDisposition>,
    ) {
        super(`${errorMessage(originalError)}; durable rollback failed: ${errorMessage(rollbackError)}${repairError ? `; repair journal failed: ${errorMessage(repairError)}` : ""}`);
        this.name = "CanvasPersistenceTransactionError";
    }
}

function persistedValue(projects: Project[], revision: number): PersistedCanvasValue {
    return { state: { projects } as StorageValue<CanvasStore>["state"], version: 0, persistenceRevision: revision };
}

function nextPersistenceRevision() {
    persistenceRevision += 1;
    return persistenceRevision;
}

function persistenceAbort(context: CanvasPersistenceContext) {
    return context.signal.reason instanceof Error ? context.signal.reason : new DOMException("Remote media task stopped", "AbortError");
}

function requirePersistenceActive(context?: CanvasPersistenceContext) {
    if (context && (context.signal.aborted || !context.isActive())) throw persistenceAbort(context);
}

function armPendingPersist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        void flushCanvasPersistence().catch(() => undefined);
    }, 400);
}

function takePendingPersist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    const pending = pendingPersist;
    pendingPersist = null;
    return pending;
}

function restorePendingPersist(pending: typeof pendingPersist) {
    if (!pending || pendingPersist) return;
    pendingPersist = pending;
    armPendingPersist();
}

function flushPendingPersist(context?: CanvasPersistenceContext) {
    if (pendingPersist) {
        const write = writeQueue.catch(() => undefined).then(async () => {
            requirePersistenceActive(context);
            const pending = takePendingPersist();
            if (!pending) return;
            let written = false;
            try {
                const projects = (pending.value.state as PersistedCanvasState).projects;
                await localForageStorage.setItem(pending.name, JSON.stringify(persistedValue(projects, nextPersistenceRevision())));
                written = true;
                requirePersistenceActive(context);
            } catch (error) {
                if (!written) restorePendingPersist(pending);
                throw error;
            }
        });
        writeQueue = write;
        void write.catch(() => undefined);
    }
    return writeQueue;
}

async function writeRepairJournal(repair: PendingCanvasRepair) {
    while (true) {
        const resolution = repair.committed
            ? { projects: currentProjects(), projectRevision: projectsRevision, retainCandidate: false, outcome: "retained" as const }
            : repair.resolve();
        const journal = { version: 1 as const, revision: nextPersistenceRevision(), projects: resolution.projects };
        repair.journal = journal;
        await localForageStorage.setItem(CANVAS_REPAIR_KEY, JSON.stringify(journal));
        const revisionBeforeCommit = resolution.retainCandidate ? resolution.projectRevision - 1 : resolution.projectRevision;
        if (projectsRevision !== revisionBeforeCommit) continue;
        if (!repair.committed) {
            if (resolution.retainCandidate) repair.commit(resolution.projects);
            repair.committed = true;
            if (projectsRevision !== resolution.projectRevision) continue;
        }
        repair.settleMediaDisposition?.(resolution.outcome === "retained" ? "retain" : "discard");
        repair.settleMediaDisposition = undefined;
        return { ...resolution, journal };
    }
}

function flushCanvasRepair(context?: CanvasPersistenceContext) {
    const repair = pendingRepair;
    if (!repair) return writeQueue.catch(() => undefined);
    const write = writeQueue.catch(() => undefined).then(async () => {
        requirePersistenceActive(context);
        const displacedPending = takePendingPersist();
        try {
            while (pendingRepair === repair) {
                const resolved = await writeRepairJournal(repair);
                await localForageStorage.setItem(CANVAS_STORE_KEY, JSON.stringify(persistedValue(resolved.projects, resolved.journal.revision)));
                if (projectsRevision !== resolved.projectRevision) continue;
                await localForageStorage.removeItem(CANVAS_REPAIR_KEY);
                pendingRepair = null;
            }
        } catch (error) {
            restorePendingPersist(displacedPending);
            throw error;
        }
    });
    writeQueue = write.then(() => undefined);
    void writeQueue.catch(() => undefined);
    return write;
}

async function flushCanvasPersistence(context?: CanvasPersistenceContext) {
    await flushCanvasRepair(context);
    return flushPendingPersist(context);
}

function serializeCanvasTransaction<T>(operation: () => Promise<T>) {
    const result = canvasTransactionQueue.catch(() => undefined).then(operation);
    canvasTransactionQueue = result.then(() => undefined, () => undefined);
    return result;
}

function persistProjectsSnapshot(snapshot: ProjectSnapshot | (() => ProjectSnapshot), context?: CanvasPersistenceContext, onWritten?: () => void) {
    const write = writeQueue.catch(() => undefined).then(async () => {
        requirePersistenceActive(context);
        const displacedPending = takePendingPersist();
        let written = false;
        try {
            const resolved = typeof snapshot === "function" ? snapshot() : snapshot;
            await localForageStorage.setItem(CANVAS_STORE_KEY, JSON.stringify(persistedValue(resolved.projects, nextPersistenceRevision())));
            written = true;
            onWritten?.();
            requirePersistenceActive(context);
            return resolved;
        } catch (error) {
            if (!written) restorePendingPersist(displacedPending);
            throw error;
        }
    });
    writeQueue = write.then(() => undefined);
    void writeQueue.catch(() => undefined);
    return write;
}

function stageCanvasRepair(resolve: () => RepairResolution, commit: (projects: Project[]) => void) {
    let settleMediaDisposition!: (disposition: CanvasRepairMediaDisposition) => void;
    const mediaDisposition = new Promise<CanvasRepairMediaDisposition>((settle) => { settleMediaDisposition = settle; });
    const repair: PendingCanvasRepair = {
        journal: { version: 1, revision: persistenceRevision, projects: [] },
        committed: false,
        resolve,
        commit,
        settleMediaDisposition,
    };
    pendingRepair = repair;
    const write = writeQueue.catch(() => undefined).then(async () => {
        const displacedPending = takePendingPersist();
        try {
            const resolved = await writeRepairJournal(repair);
            armPendingPersist();
            return resolved;
        } catch (error) {
            restorePendingPersist(displacedPending);
            if (!pendingPersist) armPendingPersist();
            throw error;
        }
    });
    writeQueue = write.then(() => undefined);
    void writeQueue.catch(() => undefined);
    return { write, mediaDisposition };
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        hydrationInProgress = true;
        projectHydrationStatus = "pending";
        const [mainResult, repairResult] = await Promise.allSettled([localForageStorage.getItem(name), localForageStorage.getItem(CANVAS_REPAIR_KEY)]);
        const mainReadFailed = mainResult.status === "rejected";
        const repairReadFailed = repairResult.status === "rejected";
        const value = mainResult.status === "fulfilled" ? mainResult.value : invalidPersistence("main", `Canvas-store read failed: ${errorMessage(mainResult.reason)}`);
        const repairValue = repairResult.status === "fulfilled" ? repairResult.value : invalidPersistence("repair", `Canvas repair read failed: ${errorMessage(repairResult.reason)}`);
        const parsed = parsePersistedCanvasValue(value);
        const journal = parseCanvasRepairJournal(repairValue);
        persistenceRevision = Math.max(persistenceRevision, parsed?.persistenceRevision || 0, journal?.revision || 0);
        if (repairReadFailed || (Boolean(repairValue) && !journal)) {
            projectHydrationStatus = repairReadFailed ? "error" : "degraded";
            return parsed;
        }
        if (!journal || journal.version !== 1 || journal.revision < (parsed?.persistenceRevision || 0)) {
            projectHydrationStatus = parsed || (!value && !mainReadFailed) ? "success" : mainReadFailed ? "error" : "degraded";
            return parsed;
        }
        projectHydrationStatus = "success";
        const recovered = persistedValue(journal.projects, journal.revision);
        try {
            await localForageStorage.setItem(name, JSON.stringify(recovered));
            await localForageStorage.removeItem(CANVAS_REPAIR_KEY);
            pendingRepair = null;
        } catch {
            pendingRepair = {
                journal,
                committed: true,
                resolve: () => ({ projects: currentProjects(), projectRevision: projectsRevision, retainCandidate: false, outcome: "retained" }),
                commit: () => undefined,
            };
        }
        return recovered;
    },
    setItem: (name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (hydrationInProgress || observedProjects === nextState.projects) return;
        observedProjects = nextState.projects;
        if (skipAutosaveProjects === nextState.projects) {
            skipAutosaveProjects = null;
            return;
        }
        pendingPersist = { name, value };
        armPendingPersist();
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useProjectStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            hydrationStatus: "pending",
            projects: [],
            agentOpsRevisions: {},
            pendingPrompt: null,
            pendingProjectId: null,
            pendingCanvasId: null,
            createProject: (title = i18n.t("canvas.project.untitled"), appearance) => {
                const project = createProjectWithCanvas(title, new Date().toISOString(), appearance);
                set((state) => ({ projects: [project, ...state.projects] }));
                // 创建即确保 Agent 工作区目录：fire-and-forget，浏览器端无 bridge 时整链 no-op，失败静默。
                void window.shotshot?.agent.ensureProjectWorkspace(project.id, project.title)
                    .then((result) => { if (result.ok) useProjectStore.getState().setProjectWorkspacePath(project.id, result.path); })
                    .catch(() => undefined);
                return { projectId: project.id, canvasId: project.canvases[0].id };
            },
            createCanvas: (projectId, title = i18n.t("canvas.canvas.untitled")) => {
                const project = findProject(get().projects, projectId);
                if (!project) return "";
                const next = addCanvasToProject(project, title);
                set((state) => ({ projects: state.projects.map((p) => (p.id === projectId ? next : p)) }));
                return next.canvases[next.canvases.length - 1].id;
            },
            createHomeCanvas: (target = null) => {
                const state = get();
                if (!state.hydrated || state.hydrationStatus !== "success") return { ok: false, reason: "not-ready" };
                const projectId = target?.projectId ?? UNCATEGORIZED_PROJECT_ID;
                const project = findProject(state.projects, projectId);
                if (target && !project) return { ok: false, reason: "project-missing" };
                const initial = target?.canvasId ? project?.canvases.find(c => c.id === target.canvasId) : undefined;
                if (initial && initial.nodes.length === 0 && initial.connections.length === 0) {
                    return { ok: true, projectId, canvasId: initial.id };
                }
                const title = i18n.t("canvas.canvas.untitled");
                if (project) {
                    const canvasId = get().createCanvas(projectId, title);
                    if (!canvasId) return { ok: false, reason: "project-missing" };
                    return { ok: true, projectId, canvasId };
                }
                const created = createProjectWithCanvas(title);
                created.id = UNCATEGORIZED_PROJECT_ID;
                created.category = UNCATEGORIZED;
                set(s => ({ projects: [created, ...s.projects] }));
                return { ok: true, projectId: created.id, canvasId: created.canvases[0].id };
            },
            moveCanvasToProject: (fromProjectId, canvasId, toProjectId) => {
                if (fromProjectId === toProjectId) return;
                const source = findProject(get().projects, fromProjectId);
                const target = findProject(get().projects, toProjectId);
                if (!source || !target) return;
                const canvas = source.canvases.find((c) => c.id === canvasId);
                if (!canvas) return;
                const now = new Date().toISOString();
                set((state) => ({
                    projects: state.projects.map((p) => {
                        if (p.id === fromProjectId) return { ...p, updatedAt: now, canvases: p.canvases.filter((c) => c.id !== canvasId) };
                        if (p.id === toProjectId) return { ...p, updatedAt: now, canvases: [...p.canvases, canvas] };
                        return p;
                    }),
                }));
            },
            renameCanvas: (projectId, canvasId, title) =>
                set((state) => ({ projects: state.projects.map((p) => (p.id === projectId ? renameCanvasInProject(p, canvasId, title.trim() || i18n.t("canvas.canvas.untitled")) : p)) })),
            deleteCanvas: (projectId, canvasId, options) =>
                set((state) => ({ projects: state.projects.map((p) => (p.id === projectId ? removeCanvasFromProject(p, canvasId, undefined, options) : p)) })),
            updateCanvas: (projectId, canvasId, patch) =>
                set((state) => ({ projects: state.projects.map((p) => (p.id === projectId ? updateCanvasInProject(p, canvasId, patch) : p)) })),
            // 仅刷新「最后活跃」时间（canvas + project 的 updatedAt），不改内容；
            // 目标画布不存在（已删 / 空 scope）时不触碰，避免把项目顶到 /projects 列表前面。
            touchCanvas: (projectId, canvasId) =>
                set((state) => ({
                    projects: state.projects.map((p) => (p.id === projectId && p.canvases.some((c) => c.id === canvasId) ? updateCanvasInProject(p, canvasId, {}) : p)),
                })),
            updateCanvasNodes: (projectId, canvasId, updater) => {
                let applied = false;
                set((state) => {
                    const projects = state.projects.map((project) => {
                        if (project.id !== projectId) return project;
                        const canvas = project.canvases.find((item) => item.id === canvasId);
                        if (!canvas) return project;
                        const nodes = updater(canvas.nodes);
                        if (nodes === canvas.nodes) return project;
                        applied = true;
                        return updateCanvasInProject(project, canvasId, { nodes });
                    });
                    return applied ? { projects } : state;
                });
                return applied;
            },
            applyCanvasAssetMigration: (projectId, patches) => {
                if (patches.length === 0) return false;
                let applied = false;
                set((state) => {
                    const now = new Date().toISOString();
                    const projects = state.projects.map((project) => {
                        if (project.id !== projectId) return project;
                        const byCanvas = new Map<string, Map<string, CanvasNodeMetadata>>();
                        for (const patch of patches) {
                            const nodePatches = byCanvas.get(patch.canvasId) ?? new Map<string, CanvasNodeMetadata>();
                            nodePatches.set(patch.nodeId, patch.metadata);
                            byCanvas.set(patch.canvasId, nodePatches);
                        }
                        let projectChanged = false;
                        const canvases = project.canvases.map((canvas) => {
                            const nodePatches = byCanvas.get(canvas.id);
                            if (!nodePatches) return canvas;
                            let canvasChanged = false;
                            const nodes = canvas.nodes.map((node) => {
                                const metadata = nodePatches.get(node.id);
                                if (!metadata) return node;
                                canvasChanged = true;
                                return { ...node, metadata };
                            });
                            if (!canvasChanged) return canvas;
                            projectChanged = true;
                            return { ...canvas, nodes };
                        });
                        if (!projectChanged) return project;
                        applied = true;
                        return { ...project, canvases, updatedAt: now };
                    });
                    return applied ? { projects } : state;
                });
                return applied;
            },
            transactCanvasNodes: (projectId, canvasId, updater, options) => serializeCanvasTransaction(async () => {
                await flushCanvasRepair(options?.context);
                // Concurrent project edits rebase by rerunning this updater, so callers must keep it pure.
                const candidateFor = (projects: Project[]) => {
                    const project = projects.find((item) => item.id === projectId);
                    const canvas = project?.canvases.find((item) => item.id === canvasId);
                    if (!project || !canvas) return null;
                    const nodes = updater(canvas.nodes);
                    if (nodes === canvas.nodes) return projects;
                    return projects.map((item) => item.id === projectId ? updateCanvasInProject(item, canvasId, { nodes }) : item);
                };
                const resolveRepair = (): RepairResolution => {
                    const latestProjects = get().projects;
                    const canvas = latestProjects.find((item) => item.id === projectId)?.canvases.find((item) => item.id === canvasId);
                    const targetPresent = Boolean(canvas && (options?.isTargetPresent?.(canvas.nodes) ?? true));
                    const retainedProjects = candidateFor(latestProjects);
                    return retainedProjects && retainedProjects !== latestProjects
                        ? { projects: retainedProjects, projectRevision: projectsRevision + 1, retainCandidate: true, outcome: "retained" }
                        : { projects: latestProjects, projectRevision: projectsRevision, retainCandidate: false, outcome: targetPresent ? "retained" : "tombstone" };
                };
                const commitRepair = (projects: Project[]) => {
                    set({ projects });
                    options?.onCommitted?.();
                };
                const failWithRepair = async (originalError: unknown, rollbackError: unknown): Promise<never> => {
                    let repair: RepairResolution;
                    const staged = stageCanvasRepair(resolveRepair, commitRepair);
                    try {
                        repair = await staged.write;
                    } catch (repairError) {
                        throw new CanvasPersistenceTransactionError(originalError, rollbackError, repairError, true, staged.mediaDisposition);
                    }
                    throw new CanvasPersistenceTransactionError(originalError, rollbackError, undefined, repair.outcome === "retained");
                };
                const persistLatestUntilStable = async () => {
                    while (true) {
                        const persisted = await persistProjectsSnapshot(() => ({ projects: get().projects, projectRevision: projectsRevision }));
                        if (projectsRevision === persisted.projectRevision) return;
                    }
                };
                const rollbackWrittenCandidate = async (originalError: unknown) => {
                    try {
                        await persistLatestUntilStable();
                    } catch (rollbackError) {
                        return failWithRepair(originalError, rollbackError);
                    }
                    throw originalError;
                };
                let candidateWritten = false;
                while (true) {
                    try {
                        requirePersistenceActive(options?.context);
                    } catch (error) {
                        if (candidateWritten) return rollbackWrittenCandidate(error);
                        throw error;
                    }
                    const baseProjects = get().projects;
                    const baseRevision = projectsRevision;
                    const candidateProjects = candidateFor(baseProjects);
                    if (!candidateProjects || candidateProjects === baseProjects) {
                        if (candidateWritten) {
                            try {
                                await persistLatestUntilStable();
                            } catch (rollbackError) {
                                return failWithRepair(new Error(candidateProjects ? "Remote canvas task produced no change during rebase" : "Remote canvas task target missing during rebase"), rollbackError);
                            }
                        }
                        return { applied: false, reason: candidateProjects ? "unchanged" : "missing_target" };
                    }
                    let written = false;
                    try {
                        await persistProjectsSnapshot({ projects: candidateProjects, projectRevision: baseRevision }, options?.context, () => { written = true; });
                        requirePersistenceActive(options?.context);
                    } catch (error) {
                        if (written || candidateWritten) return rollbackWrittenCandidate(error);
                        throw error;
                    }
                    candidateWritten = true;
                    if (projectsRevision !== baseRevision) continue;
                    skipAutosaveProjects = candidateProjects;
                    set({ projects: candidateProjects });
                    options?.onCommitted?.();
                    return { applied: true };
                }
            }),
            flush: flushCanvasPersistence,
            findCanvas: (canvasId) => findCanvas(get().projects, canvasId),
            renameProject: (id, title) =>
                set((state) => ({ projects: state.projects.map((p) => (p.id === id ? { ...p, title: title.trim() || p.title, updatedAt: new Date().toISOString() } : p)) })),
            updateProjectAppearance: (id, appearance) =>
                set((state) => ({ projects: state.projects.map((p) => (p.id === id ? { ...p, title: appearance.title.trim() || p.title, icon: appearance.icon || p.icon, color: appearance.color || p.color, updatedAt: new Date().toISOString() } : p)) })),
            // 记录 Agent 项目工作区目录；只在首次创建或迁移复制校验通过（relocateWorkspace 成功）后调用，
            // 不作为绕过校验的直接绑定入口。与其它项目编辑一致，touch updatedAt。
            setProjectWorkspacePath: (id, path) =>
                set((state) => ({ projects: state.projects.map((p) => (p.id === id ? { ...p, workspacePath: path, updatedAt: new Date().toISOString() } : p)) })),
            deleteProjects: (ids) => set((state) => ({ projects: state.projects.filter((p) => !ids.includes(p.id)) })),
            replaceProjects: (projects) => set({ projects }),
            setProjectCategory: (id, category) =>
                set((state) => ({ projects: state.projects.map((p) => (p.id === id ? { ...p, category: canonicalCategory(category), updatedAt: new Date().toISOString() } : p)) })),
            importProject: (source) => {
                const migrated = migrateLegacyProject(source);
                const project = migrated
                    ? { ...migrated, id: nanoid(), canvases: migrated.canvases.map((c) => ({ ...c, id: nanoid() })) }
                    : createProjectWithCanvas(source.title || i18n.t("canvas.project.imported"));
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            submitPendingPrompt: (prompt, title, target) => {
                const text = prompt.trim();
                if (!text) return null;
                let projectId: string;
                let canvasId: string;
                const canvasTitle = title || i18n.t("canvas.project.untitled");
                const selectedProject = target ? findProject(get().projects, target.projectId) : null;
                const selectedCanvas = target?.canvasId ? selectedProject?.canvases.find((canvas) => canvas.id === target.canvasId) : null;
                if (selectedProject) {
                    projectId = selectedProject.id;
                    if (selectedCanvas) {
                        const next = renameCanvasInProject(selectedProject, selectedCanvas.id, canvasTitle);
                        set((state) => ({ projects: state.projects.map((project) => (project.id === projectId ? next : project)) }));
                        canvasId = selectedCanvas.id;
                    } else {
                        const next = addCanvasToProject(selectedProject, canvasTitle);
                        set((state) => ({ projects: state.projects.map((project) => (project.id === projectId ? next : project)) }));
                        canvasId = next.canvases[next.canvases.length - 1].id;
                    }
                } else {
                    // Homepage prompts without an explicit project share one hidden
                    // container so each prompt remains a canvas, not a fake project.
                    const existing = get().projects.find((project) => project.id === UNCATEGORIZED_PROJECT_ID);
                    if (existing) {
                        projectId = existing.id;
                        const next = addCanvasToProject(existing, canvasTitle);
                        set((state) => ({ projects: state.projects.map((project) => (project.id === projectId ? next : project)) }));
                        canvasId = next.canvases[next.canvases.length - 1].id;
                    } else {
                        const project = createProjectWithCanvas(canvasTitle);
                        project.id = UNCATEGORIZED_PROJECT_ID;
                        project.category = UNCATEGORIZED;
                        set((state) => ({ projects: [project, ...state.projects] }));
                        projectId = project.id;
                        canvasId = project.canvases[0].id;
                    }
                }
                const next = pendingPromptReducer(
                    { pendingPrompt: get().pendingPrompt, pendingProjectId: get().pendingProjectId },
                    { type: "SUBMIT", prompt: text, projectId },
                );
                set({ pendingPrompt: next.pendingPrompt, pendingProjectId: next.pendingProjectId, pendingCanvasId: canvasId });
                return { projectId, canvasId };
            },
            consumePendingPrompt: () => {
                const next = pendingPromptReducer(
                    { pendingPrompt: get().pendingPrompt, pendingProjectId: get().pendingProjectId },
                    { type: "CONSUME" },
                );
                set({ pendingPrompt: next.pendingPrompt, pendingProjectId: next.pendingProjectId, pendingCanvasId: null });
            },
            bumpAgentOpsRevision: (canvasId) => {
                const next = (get().agentOpsRevisions[canvasId] ?? 0) + 1;
                set((state) => ({ agentOpsRevisions: { ...state.agentOpsRevisions, [canvasId]: next } }));
                return next;
            },
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) => ({ projects: state.projects }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => (state, error) => {
                // Migrate legacy persisted projects (top-level nodes, no canvases) into 1 canvas each.
                if (state) {
                    const migrated = migrateLegacyProjects(state.projects);
                    if (migrated) state.projects = migrated;
                }
                useProjectStore.setState({ hydrated: true, hydrationStatus: error ? "error" : projectHydrationStatus });
                observedProjects = useProjectStore.getState().projects;
                hydrationInProgress = false;
            },
        },
    ),
);

useProjectStore.persist.onHydrate(() => useProjectStore.setState({ hydrated: false, hydrationStatus: "pending" }));

useProjectStore.subscribe((state, previous) => {
    if (state.projects !== previous.projects) projectsRevision += 1;
});
currentProjects = () => useProjectStore.getState().projects;
