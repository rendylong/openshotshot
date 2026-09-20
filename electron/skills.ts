import { app, dialog, ipcMain } from "electron";
import { join } from "node:path";

import { createSkillsFs, type SkillsFs } from "./skill-fs";
import { APP_SKILLS_DIR } from "./app-data-paths";
import type { SkillSourcePreferences, SkillWriteInput } from "@/lib/skills/skill-types";
import type { SkillRuntime } from "./skill-runtime";

function bundledSkills(): Record<string, string> {
    const base = app.isPackaged
        ? process.resourcesPath
        : join(app.getAppPath(), "electron", "resources");
    return {
        "skill-creator": join(base, "skill-creator"),
        "shotshot-director": join(base, "shotshot-director"),
        "character-four-view": join(base, "character-four-view"),
    };
}

export function createAppSkillsFs(runtime: SkillRuntime): SkillsFs {
    return createSkillsFs(APP_SKILLS_DIR, bundledSkills(), { onChanged: () => runtime.invalidate() });
}

export function registerSkillsHandler(_getWindow: () => unknown, runtime: SkillRuntime, skills = createAppSkillsFs(runtime)): void {
    ipcMain.handle("skills:configure", (_e, preferences: SkillSourcePreferences) => runtime.configureResult(preferences));
    ipcMain.handle("skills:scan", (_e, force?: boolean) => runtime.snapshotResult(force));
    ipcMain.handle("skills:read", (_e, name: string) => runtime.detailForUi(name));
    ipcMain.handle("skills:read-file", async (_e, name: string, relativePath?: string) => {
        try {
            return { ok: true as const, content: await runtime.readForUi(name, relativePath) };
        } catch (error) {
            return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
        }
    });
    ipcMain.handle("skills:write", (_e, name: string, input: SkillWriteInput) => skills.write(name, input));
    ipcMain.handle("skills:import", (_e, sourcePath: string) => skills.importSkill(sourcePath));
    ipcMain.handle("skills:remove", (_e, name: string) => skills.remove(name));
    ipcMain.handle("skills:seed", () => skills.seed());
    ipcMain.handle("skills:pick-folder", async () => {
        const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
        return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    });
}
