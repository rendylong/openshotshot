import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

import type { MainFetchError, MainFetchRequest } from "@/lib/agent/pi-agent-types";
import { FETCH_CHANNEL, FETCH_ABORT_CHANNEL, registerAgentHost } from "./agent-host";
import { AGENT_SESSIONS_DIR, APP_SKILLS_DIR } from "./app-data-paths";
import { createFetchRequestRegistry } from "./fetch-proxy";
import { registerProjectAssetIpc } from "./project-asset-ipc";
import { createProjectAssetStore, type ProjectAssetStore } from "./project-asset-store";
import { registerLibraryAssetIpc } from "./library-asset-ipc";
import { createLibraryAssetStore, type LibraryAssetStore } from "./library-asset-store";
import { registerProjectWorkspaceIpc } from "./project-workspace";
import { createSkillRuntime } from "./skill-runtime";
import { initializeAppSkills } from "./skill-startup";
import { createAppSkillsFs, registerSkillsHandler } from "./skills";
import { createTaskActiveCountRegistry, createTaskCloseCoordinator, createTaskCloseGuard, createTaskCountOwnerLifecycle, isTrustedTaskCountSender } from "./task-close-guard";
import { isAllowedExternalUrl, isTrustedRendererNavigation } from "./window-security";

const isDev = !app.isPackaged;
const devRendererUrl = process.env.SHOTSHOT_RENDERER_URL || "http://localhost:3000";
const productionRendererEntry = resolve(__dirname, "../../web/dist/index.html");
const productionRendererUrl = pathToFileURL(productionRendererEntry).toString();
const externalOrigins = new Set(["https://github.com"]);

let mainWindow: BrowserWindow | null = null;
let disposeProjectAssetIpc: (() => void) | null = null;
let projectAssetStore: ProjectAssetStore | null = null;
let libraryAssetStore: LibraryAssetStore | null = null;
let disposeLibraryAssetIpc: (() => void) | null = null;
const skillRuntime = createSkillRuntime({
    home: os.homedir(),
    cwd: process.cwd(),
    appSkillsRoot: APP_SKILLS_DIR,
});
const taskCloseGuard = createTaskCloseGuard(async (count) => {
    const options = {
        type: "warning" as const,
        buttons: ["取消", "仍然退出"],
        defaultId: 0,
        cancelId: 0,
        title: "生成任务仍在进行",
        message: `当前有 ${count} 个生成任务仍在进行。退出会停止本地任务跟踪，远端任务可能继续运行；重新打开 ShotShot 后会自动恢复查询。`,
    };
    const result = mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
    return result.response === 1;
});
const taskActiveCounts = createTaskActiveCountRegistry(taskCloseGuard.setActiveCount);
const taskCloseCoordinator = createTaskCloseCoordinator(
    taskCloseGuard.requestClose,
    () => app.quit(),
    (error) => console.error("[remote-media-task] close confirmation failed", error),
);
const appWindows = new Map<number, BrowserWindow>();
const fetchRequests = createFetchRequestRegistry();

function registerTaskWindow(win: BrowserWindow) {
    const ownerId = win.webContents.id;
    appWindows.set(ownerId, win);
    const lifecycle = createTaskCountOwnerLifecycle(ownerId, taskActiveCounts, () => appWindows.delete(ownerId));
    win.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
        lifecycle.didStartNavigation(isInPlace, isMainFrame);
        if (!isInPlace && isMainFrame) fetchRequests.abortOwner(ownerId);
    });
    win.webContents.on("render-process-gone", () => { lifecycle.renderProcessGone(); fetchRequests.abortOwner(ownerId); });
    win.webContents.on("destroyed", () => { lifecycle.destroyed(); fetchRequests.abortOwner(ownerId); });
    win.on("closed", lifecycle.closed);
}

function createWindow() {
    taskCloseCoordinator.resetForNewWindow();
    const win = new BrowserWindow({
        width: 1440,
        height: 900,
        title: "",
        ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 18 } } : {}),
        webPreferences: {
            preload: join(__dirname, "../preload/index.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
        },
    });
    mainWindow = win;
    registerTaskWindow(win);
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (isAllowedExternalUrl(url, externalOrigins)) void shell.openExternal(url);
        return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, url) => {
        if (!isTrustedRendererNavigation(url, {
            development: isDev,
            devRendererUrl,
            productionEntryUrl: productionRendererUrl,
        })) event.preventDefault();
    });

    if (isDev && devRendererUrl) {
        void win.loadURL(devRendererUrl);
    } else {
        void win.loadFile(productionRendererEntry);
    }

    win.on("closed", () => {
        if (mainWindow === win) mainWindow = null;
    });
    win.on("close", (event) => {
        if (taskCloseCoordinator.isForceClosing()) return;
        event.preventDefault();
        void taskCloseCoordinator.requestWindowClose(() => {
            if (!win.isDestroyed()) win.close();
        });
    });
    return win;
}

function startPrimaryInstance() {
    app.whenReady().then(async () => {
        // 仅放行 fullscreen：原生 <video> 全屏按钮依赖该权限，其余权限继续拒绝。
        session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === "fullscreen");
        session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(permission === "fullscreen"));

        const appSkills = createAppSkillsFs(skillRuntime);
        const initialized = await initializeAppSkills(appSkills, skillRuntime);
        if (!initialized.ok) {
            console.error("[skills]", initialized.error);
            dialog.showErrorBox("Skill 初始化失败", `${initialized.error}\n\n应用仍会继续启动，请检查应用数据目录权限后重启应用。`);
        }
        try {
            await mkdir(AGENT_SESSIONS_DIR, { recursive: true });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("[agent] session directory initialization failed:", message);
            dialog.showErrorBox("Agent 会话目录初始化失败", `${message}\n\n应用仍会继续启动，请检查应用数据目录权限后重启应用。`);
        }
        libraryAssetStore = createLibraryAssetStore();
        registerAgentHost(
            () => mainWindow,
            skillRuntime,
            isDev ? devRendererUrl : pathToFileURL(resolve(__dirname, "../../web/dist/index.html")).href,
            libraryAssetStore ?? undefined,
        );
        registerSkillsHandler(() => mainWindow, skillRuntime, appSkills);
        registerProjectWorkspaceIpc({ isTrustedSender: (sender) => isTrustedTaskCountSender(sender, appWindows) });
        projectAssetStore = createProjectAssetStore();
        disposeProjectAssetIpc = registerProjectAssetIpc({
            ipcMain,
            store: projectAssetStore,
            isTrustedSender: (sender) => isTrustedTaskCountSender(sender, appWindows),
            recipients: () => [...appWindows.values()].map((win) => win.webContents),
        });
        disposeLibraryAssetIpc = registerLibraryAssetIpc({
            ipcMain,
            store: libraryAssetStore,
            isTrustedSender: (sender) => isTrustedTaskCountSender(sender, appWindows),
            recipients: () => [...appWindows.values()].map((win) => win.webContents),
        });

        ipcMain.handle(FETCH_CHANNEL, async (event, req: MainFetchRequest) => {
            if (!isTrustedTaskCountSender(event.sender, appWindows)) {
                return { id: req?.id ?? "", error: "untrusted_ipc_sender" } satisfies MainFetchError;
            }
            try {
                return await fetchRequests.fetch(event.sender.id, req);
            } catch (error) {
                return { id: req?.id ?? "", error: req?.responseType === "bytes" ? "remote_media_download_failed" : error instanceof Error ? error.message : String(error) } satisfies MainFetchError;
            }
        });
        ipcMain.handle(FETCH_ABORT_CHANNEL, (event, id: string) => {
            if (!isTrustedTaskCountSender(event.sender, appWindows) || typeof id !== "string") return;
            fetchRequests.abort(event.sender.id, id);
        });
        ipcMain.on("tasks:set-active-count", (event, count: number) => {
            if (!isTrustedTaskCountSender(event.sender, appWindows)) return;
            taskActiveCounts.setActiveCount(event.sender.id, count);
        });

        createWindow();

        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });

    app.on("before-quit", (event) => {
        if (taskCloseCoordinator.isForceClosing()) return;
        event.preventDefault();
        void taskCloseCoordinator.requestAppQuit();
    });

    app.on("window-all-closed", () => {
        if (process.platform !== "darwin") app.quit();
    });
    app.on("will-quit", () => {
        ipcMain.removeHandler(FETCH_CHANNEL);
        ipcMain.removeHandler(FETCH_ABORT_CHANNEL);
        fetchRequests.dispose();
        disposeProjectAssetIpc?.();
        disposeProjectAssetIpc = null;
        disposeLibraryAssetIpc?.();
        disposeLibraryAssetIpc = null;
        void libraryAssetStore?.close();
        void projectAssetStore?.close();
        projectAssetStore = null;
    });
}

startPrimaryInstance();
