import { CHATGPT_CHANNELS as CHATGPT_CH, type ChatGptBridge } from "@/lib/agent/ai-source-types";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { AgentBridge, AgentCanvasImageReadRequest, AgentFileInput, AgentMemoryBridge, AgentUserInputResponse, PiAgentEvent, PiAgentPromptInput, PiAgentPromptOptions, PiSessionEnvelope } from "@/lib/agent/pi-agent-types";
import type { SkillsBridge } from "@/lib/skills/skill-types";
import type { TaskLifecycleBridge } from "@/lib/desktop/task-lifecycle-types";
import { PROJECT_ASSET_CHANNELS, type ProjectAssetChangedEvent, type ProjectAssetsBridge } from "@/lib/project-assets/project-asset-types";
import { LIBRARY_ASSET_CHANNELS, type LibraryAssetChangedEvent, type LibraryAssetsBridge } from "@/lib/library-assets/library-asset-types";
import { createAppReleaseBridge, type AppReleaseBridge } from "@/lib/desktop/app-release-bridge";
import { createCanvasImageReaderSlot } from "./agent-canvas-image";

const CH = {
    listSessions: "agent:list-sessions",
    createSession: "agent:create-session",
    openSession: "agent:open-session",
    closeSession: "agent:close-session",
    readSessionEntries: "agent:read-session-entries",
    prompt: "agent:prompt",
    abort: "agent:abort",
    compact: "agent:compact",
    respondToUserInput: "agent:respond-to-user-input",
    opsReceipt: "agent:ops-receipt",
    setCanvasSnapshot: "agent:set-canvas-snapshot",
    setProjects: "agent:set-projects",
    setGenerationStatus: "agent:set-generation-status",
    setModels: "agent:set-models",
    setScriptEntities: "agent:set-script-entities",
    importLegacySessions: "agent:import-legacy-sessions",
    setModelConfig: "agent:set-model-config",
    event: "agent:event",
    waitForIdle: "agent:wait-for-idle",
    registerFiles: "agent:register-files",
    readFile: "agent:read-file",
    listFolder: "agent:list-folder",
    setApprovalMode: "agent:set-approval-mode",
    respondToApproval: "agent:respond-to-approval",
    projectEnsureWorkspace: "project:ensure-workspace",
    canvasImageRequest: "agent:canvas-image-request",
    fetch: "fetch:request",
    abortFetch: "fetch:abort",
    skillsConfigure: "skills:configure",
    skillsScan: "skills:scan",
    skillsRead: "skills:read",
    skillsReadFile: "skills:read-file",
    skillsWrite: "skills:write",
    skillsImport: "skills:import",
    skillsRemove: "skills:remove",
    skillsSeed: "skills:seed",
    memoryRead: "agent:memory-read",
    memoryWrite: "agent:memory-write",
    skillsPickFolder: "skills:pick-folder",
    tasksSetActiveCount: "tasks:set-active-count",
} as const;

const canvasImageReader = createCanvasImageReaderSlot();
ipcRenderer.on(CH.canvasImageRequest, async (event, raw: unknown) => {
    const port = event.ports[0];
    if (!port) return;
    let result;
    try {
        result = await canvasImageReader.read(raw as AgentCanvasImageReadRequest);
    } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
        port.postMessage(result);
    } finally {
        port.close();
    }
});


type PromptArgs = [sessionId: string, input: PiAgentPromptInput | string, options?: PiAgentPromptOptions];
type RegisterFileArgs = [sessionId: string, files: AgentFileInput[]];
type ReadFileArgs = [sessionId: string, handle: string];
type ListFolderArgs = [sessionId: string, sourcePath: string, recursive: boolean];
type RespondToUserInputArgs = [sessionId: string, requestId: string, response: AgentUserInputResponse];

function toLegacyEvent(envelope: PiSessionEnvelope): PiAgentEvent | null {
    if (envelope.kind === "agent") return envelope.payload as PiAgentEvent;
    if (envelope.kind === "ops" || envelope.kind === "attachment_import" || envelope.kind === "error") {
        return envelope.payload as PiAgentEvent;
    }
    return null;
}

const bridge: AgentBridge = {
    listSessions: (scope) => ipcRenderer.invoke(CH.listSessions, scope),
    createSession: (input) => ipcRenderer.invoke(CH.createSession, input),
    openSession: (sessionId) => ipcRenderer.invoke(CH.openSession, sessionId),
    closeSession: (sessionId) => ipcRenderer.invoke(CH.closeSession, sessionId),
    readSessionEntries: (sessionId, range) => ipcRenderer.invoke(CH.readSessionEntries, sessionId, range),
    abort: (sessionId) => ipcRenderer.invoke(CH.abort, sessionId),
    compact: (sessionId) => ipcRenderer.invoke(CH.compact, sessionId),
    respondToUserInput: (...args: RespondToUserInputArgs) => ipcRenderer.invoke(CH.respondToUserInput, ...args),
    setApprovalMode: (sessionId, mode) => ipcRenderer.invoke(CH.setApprovalMode, sessionId, mode),
    respondToApproval: (sessionId, requestId, decision) => ipcRenderer.invoke(CH.respondToApproval, sessionId, requestId, decision),
    ensureProjectWorkspace: (projectId, projectTitle) => ipcRenderer.invoke(CH.projectEnsureWorkspace, projectId, projectTitle),
    setCanvasSnapshot: (scope, snapshot) => {
        void ipcRenderer.invoke(CH.setCanvasSnapshot, scope, snapshot);
    },
    setProjects: (projects) => {
        void ipcRenderer.invoke(CH.setProjects, projects);
    },
    setGenerationStatus: (tasks) => {
        void ipcRenderer.invoke(CH.setGenerationStatus, tasks);
    },
    setModels: (models) => {
        void ipcRenderer.invoke(CH.setModels, models);
    },
    setScriptEntities: (entities) => {
        void ipcRenderer.invoke(CH.setScriptEntities, entities);
    },
    sendOpsReceipts: (sessionId, requestId, receipts) => ipcRenderer.invoke(CH.opsReceipt, sessionId, requestId, receipts),
    setCanvasImageReader: (handler) => canvasImageReader.set(handler),
    importLegacySessions: (sessions) => ipcRenderer.invoke(CH.importLegacySessions, sessions),
    prompt: (...args: PromptArgs) => {
        const [sessionId, input, options] = args;
        return ipcRenderer.invoke(CH.prompt, sessionId, input, options);
    },
    setModelConfig: (config) => {
        return ipcRenderer.invoke(CH.setModelConfig, config);
    },
    onEvent: (cb) => {
        const listener = (_event: IpcRendererEvent, raw: unknown) => {
            // Main validates every outgoing envelope through pi-session-contract before send.
            const event = toLegacyEvent(raw as PiSessionEnvelope);
            if (event) cb(event);
        };
        ipcRenderer.on(CH.event, listener);
        return () => ipcRenderer.removeListener(CH.event, listener);
    },
    onSessionEvent: (cb) => {
        const listener = (_event: IpcRendererEvent, raw: unknown) => {
            // Main validates every outgoing envelope through pi-session-contract before send.
            cb(raw as PiSessionEnvelope);
        };
        ipcRenderer.on(CH.event, listener);
        return () => ipcRenderer.removeListener(CH.event, listener);
    },
    waitForIdle: (sessionId) => ipcRenderer.invoke(CH.waitForIdle, sessionId),
    registerFiles: (...args: RegisterFileArgs) => {
        const [sessionId, files] = args;
        return ipcRenderer.invoke(CH.registerFiles, sessionId, files);
    },
    readFile: (...args: ReadFileArgs) => {
        const [sessionId, handle] = args;
        return ipcRenderer.invoke(CH.readFile, sessionId, handle);
    },
    listFolder: (...args: ListFolderArgs) => {
        const [sessionId, sourcePath, recursive] = args;
        return ipcRenderer.invoke(CH.listFolder, sessionId, sourcePath, recursive);
    },
    fetch: (req) => ipcRenderer.invoke(CH.fetch, req),
    abortFetch: (id) => ipcRenderer.invoke(CH.abortFetch, id),
};

const skillsBridge: SkillsBridge = {
    configure: (preferences): ReturnType<SkillsBridge["configure"]> => ipcRenderer.invoke(CH.skillsConfigure, preferences),
    scan: (force): ReturnType<SkillsBridge["scan"]> => ipcRenderer.invoke(CH.skillsScan, force),
    read: (name) => ipcRenderer.invoke(CH.skillsRead, name),
    readFile: (name, relativePath) => ipcRenderer.invoke(CH.skillsReadFile, name, relativePath),
    write: (name, input) => ipcRenderer.invoke(CH.skillsWrite, name, input),
    importSkill: (sourcePath) => ipcRenderer.invoke(CH.skillsImport, sourcePath),
    remove: (name) => ipcRenderer.invoke(CH.skillsRemove, name),
    seed: () => ipcRenderer.invoke(CH.skillsSeed),
    pickFolder: () => ipcRenderer.invoke(CH.skillsPickFolder),
};

const agentMemoryBridge: AgentMemoryBridge = {
    readUser: () => ipcRenderer.invoke(CH.memoryRead, "user"),
    writeUser: (content) => ipcRenderer.invoke(CH.memoryWrite, { scope: "user", mode: "replace", content }),
    readProject: (workspacePath) => ipcRenderer.invoke(CH.memoryRead, "project", workspacePath),
    writeProject: (workspacePath, content) => ipcRenderer.invoke(CH.memoryWrite, { scope: "project", workspacePath, mode: "replace", content }),
};

const taskLifecycleBridge: TaskLifecycleBridge = {
    setActiveCount: (count) => ipcRenderer.send(CH.tasksSetActiveCount, count),
};

const projectAssetsBridge: ProjectAssetsBridge = {
    write: (input) => ipcRenderer.invoke(PROJECT_ASSET_CHANNELS.write, input),
    importPath: (input) => ipcRenderer.invoke(PROJECT_ASSET_CHANNELS.importPath, input),
    read: (input) => ipcRenderer.invoke(PROJECT_ASSET_CHANNELS.read, input),
    stat: (input) => ipcRenderer.invoke(PROJECT_ASSET_CHANNELS.stat, input),
    restore: (input) => ipcRenderer.invoke(PROJECT_ASSET_CHANNELS.restore, input),
    watch: (projectId, workspacePath) => ipcRenderer.invoke(PROJECT_ASSET_CHANNELS.watch, projectId, workspacePath),
    unwatch: (projectId) => ipcRenderer.invoke(PROJECT_ASSET_CHANNELS.unwatch, projectId),
    relocateWorkspace: (input) => ipcRenderer.invoke(PROJECT_ASSET_CHANNELS.relocateWorkspace, input),
    onChanged(listener) {
        const handler = (_event: IpcRendererEvent, event: ProjectAssetChangedEvent) => listener(event);
        ipcRenderer.on(PROJECT_ASSET_CHANNELS.changed, handler);
        return () => ipcRenderer.removeListener(PROJECT_ASSET_CHANNELS.changed, handler);
    },
};

const libraryAssetsBridge: LibraryAssetsBridge = {
    list: () => ipcRenderer.invoke(LIBRARY_ASSET_CHANNELS.list),
    write: (input) => ipcRenderer.invoke(LIBRARY_ASSET_CHANNELS.write, input),
    importPath: (input) => ipcRenderer.invoke(LIBRARY_ASSET_CHANNELS.importPath, input),
    read: (input) => ipcRenderer.invoke(LIBRARY_ASSET_CHANNELS.read, input),
    stat: (input) => ipcRenderer.invoke(LIBRARY_ASSET_CHANNELS.stat, input),
    remove: (assetId) => ipcRenderer.invoke(LIBRARY_ASSET_CHANNELS.remove, assetId),
    markLegacyMigrated: () => ipcRenderer.invoke(LIBRARY_ASSET_CHANNELS.markLegacyMigrated),
    onChanged(listener) {
        const handler = (_event: IpcRendererEvent, event: LibraryAssetChangedEvent) => listener(event);
        ipcRenderer.on(LIBRARY_ASSET_CHANNELS.changed, handler);
        return () => ipcRenderer.removeListener(LIBRARY_ASSET_CHANNELS.changed, handler);
    },
};

const chatgpt: ChatGptBridge = {
    getStatus: () => ipcRenderer.invoke(CHATGPT_CH.status),
    signIn: () => ipcRenderer.invoke(CHATGPT_CH.signIn),
    cancelSignIn: () => ipcRenderer.invoke(CHATGPT_CH.cancel),
    respond: (id, value) => ipcRenderer.invoke(CHATGPT_CH.respond, id, value),
    signOut: () => ipcRenderer.invoke(CHATGPT_CH.signOut),
    getModels: () => ipcRenderer.invoke(CHATGPT_CH.models),
    onStatusChanged(listener) {
        const handler = (_event: IpcRendererEvent, status: Parameters<typeof listener>[0]) => listener(status);
        ipcRenderer.on(CHATGPT_CH.changed, handler);
        return () => ipcRenderer.removeListener(CHATGPT_CH.changed, handler);
    },
};

const appRelease: AppReleaseBridge = createAppReleaseBridge(ipcRenderer);
contextBridge.exposeInMainWorld("shotshot", {
    appRelease,
    chatgpt, agent: bridge, skills: skillsBridge, agentMemory: agentMemoryBridge, tasks: taskLifecycleBridge, projectAssets: projectAssetsBridge, libraryAssets: libraryAssetsBridge, platform: process.platform });
