import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from "electron";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

import type { MainFetchError, MainFetchRequest } from "@/lib/agent/pi-agent-types";
import { registerAccountIpc } from "./account-ipc";
import { FETCH_CHANNEL, FETCH_ABORT_CHANNEL, registerAgentHost } from "./agent-host";
import { AGENT_SESSIONS_DIR, APP_SKILLS_DIR } from "./app-data-paths";
import { createAppReleaseController } from "./app-release-controller";
import { registerAppReleaseIpc } from "./app-release-ipc";
import { DesktopAuthCallbackRouter, registerDesktopAuthDeepLinks } from "./auth-deep-link";
import { AuthController } from "./auth-controller";
import { createAuthSessionStore } from "./auth-session-store";
import { loadShotshotCloudConfig } from "./cloud-config";
import { createFetchRequestRegistry } from "./fetch-proxy";
import { ManagedModelClient } from "./managed-model-client";
import { registerManagedModelIpc } from "./managed-model-ipc";
import { registerProjectAssetIpc } from "./project-asset-ipc";
import { createProjectAssetStore, type ProjectAssetStore } from "./project-asset-store";
import { registerLibraryAssetIpc } from "./library-asset-ipc";
import { createLibraryAssetStore, type LibraryAssetStore } from "./library-asset-store";
import { registerProjectWorkspaceIpc } from "./project-workspace";
import { ShotshotCloudClient } from "./shotshot-cloud-client";
import { createSkillRuntime } from "./skill-runtime";
import { initializeAppSkills } from "./skill-startup";
import { createAppSkillsFs, registerSkillsHandler } from "./skills";
import { createTaskActiveCountRegistry, createTaskCloseCoordinator, createTaskCloseGuard, createTaskCountOwnerLifecycle, isTrustedTaskCountSender } from "./task-close-guard";
import { isAllowedExternalUrl, isTrustedRendererNavigation } from "./window-security";

const isDev = !app.isPackaged;
const devRendererUrl = process.env.SHOTSHOT_RENDERER_URL || "http://localhost:3000";
const cloudConfig = loadShotshotCloudConfig(process.env, { development: isDev });
const productionRendererEntry = resolve(__dirname, "../../web/dist/index.html");
const productionRendererUrl = pathToFileURL(productionRendererEntry).toString();
const externalOrigins = new Set([cloudConfig.webOrigin, "https://github.com"]);

let mainWindow: BrowserWindow | null = null;
let authController: AuthController | null = null;
let disposeAccountIpc: (() => void) | null = null;
let disposeManagedModelIpc: (() => void) | null = null;
let disposeProjectAssetIpc: (() => void) | null = null;
let disposeAppReleaseIpc: (() => void) | null = null;
let appReleaseController: ReturnType<typeof createAppReleaseController> | null = null;
let disposeManagedAuthSubscription: (() => void) | null = null;
let managedModelClient: ManagedModelClient | null = null;
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
        message: `当前有 ${count} 个生成任务仍在进行。退出会停止本地任务跟踪，远端任务可能继续运行；重新打开 shotshot.ai 后会自动恢复查询。`,
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

function focusMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
}

function startPrimaryInstance() {
    app.whenReady().then(async () => {
        // 仅放行 fullscreen：原生 <video> 全屏按钮依赖该权限，其余权限继续拒绝。
        session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === "fullscreen");
        session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(permission === "fullscreen"));
        if (app.isPackaged) app.setAsDefaultProtocolClient("ai.shotshot.desktop");

        const authSessionStore = createAuthSessionStore(
            join(app.getPath("userData"), "shotshot-auth-session.json"),
            safeStorage,
        );
        const cloud = new ShotshotCloudClient({ baseUrl: cloudConfig.cloudOrigin, sessionStore: authSessionStore });
        managedModelClient = cloudConfig.gatewayOrigin ? new ManagedModelClient({
            gatewayOrigin: cloudConfig.gatewayOrigin,
            cloud,
            temporaryDirectory: join(app.getPath("userData"), "managed-media"),
            allowLocalHttp: isDev,
        }) : null;
        authController = new AuthController({
            cloud,
            callbacks: desktopAuthCallbacks,
            openExternal: async (url) => {
                if (!isAllowedExternalUrl(url, new Set([cloudConfig.webOrigin]), { allowLocalHttp: isDev })) {
                    throw new Error("untrusted_external_url");
                }
                await shell.openExternal(url);
            },
            device: { name: os.hostname(), platform: process.platform },
            webOrigin: cloudConfig.webOrigin,
        });
        disposeAccountIpc = registerAccountIpc({
            ipcMain,
            controller: authController,
            isTrustedSender: (sender) => isTrustedTaskCountSender(sender, appWindows),
            recipients: () => [...appWindows.values()].map((win) => win.webContents),
            referralInfo: async () => {
                const info = await cloud.getReferralInfo();
                return { ...info, shareUrl: new URL(`/i/${info.code}`, cloudConfig.webOrigin).toString() };
            },
        });
        disposeManagedModelIpc = registerManagedModelIpc({
            ipcMain,
            client: managedModelClient,
            isTrustedSender: (sender) => isTrustedTaskCountSender(sender, appWindows),
        });
        disposeManagedAuthSubscription = authController.subscribe((state) => {
            if (state.state === "signed-out") void managedModelClient?.dispose();
        });
        if (cloudConfig.accountEnabled) await authController.restore();

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
            managedModelClient && cloudConfig.gatewayOrigin
                ? {
                    baseUrl: cloudConfig.gatewayOrigin,
                    resolveApiKey: (model) => managedModelClient!.resolveApiKeyForTextModel(model),
                    resolveTextModelDescriptor: (model) => managedModelClient!.resolveTextModelDescriptor(model),
                }
                : undefined,
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

        appReleaseController = createAppReleaseController({
            baseUrl: cloudConfig.cloudOrigin,
            localVersion: app.getVersion(),
            packaged: app.isPackaged,
            openExternal: (url) => shell.openExternal(url),
        });
        disposeAppReleaseIpc = registerAppReleaseIpc({
            ipcMain,
            controller: appReleaseController,
            isTrustedSender: (sender) => isTrustedTaskCountSender(sender, appWindows),
            recipients: () => [...appWindows.values()].map((win) => win.webContents),
        });
        void appReleaseController.start();

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
        disposeManagedAuthSubscription?.();
        disposeManagedAuthSubscription = null;
        disposeManagedModelIpc?.();
        disposeManagedModelIpc = null;
        void managedModelClient?.dispose();
        managedModelClient = null;
        disposeAccountIpc?.();
        disposeAccountIpc = null;
        disposeProjectAssetIpc?.();
        disposeProjectAssetIpc = null;
        disposeLibraryAssetIpc?.();
        disposeLibraryAssetIpc = null;
        void libraryAssetStore?.close();
        disposeAppReleaseIpc?.();
        disposeAppReleaseIpc = null;
        appReleaseController?.dispose();
        appReleaseController = null;
        void projectAssetStore?.close();
        projectAssetStore = null;
        authController?.dispose();
        authController = null;
    });
}

const desktopAuthCallbacks = new DesktopAuthCallbackRouter();
const isPrimaryInstance = registerDesktopAuthDeepLinks(app, desktopAuthCallbacks, process.argv, focusMainWindow);
if (isPrimaryInstance) {
    startPrimaryInstance();
}
