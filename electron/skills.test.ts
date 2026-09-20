import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => unknown>() }));

vi.mock("electron", () => ({
    app: { isPackaged: false, getAppPath: () => "/app" },
    dialog: { showOpenDialog: vi.fn() },
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler) },
}));

vi.mock("./skill-fs", () => ({
    createSkillsFs: () => ({
        root: "/skills",
        scan: vi.fn(),
        read: vi.fn(),
        write: vi.fn(),
        importSkill: vi.fn(),
        remove: vi.fn(),
        seed: vi.fn(),
    }),
}));

import type { SkillRuntime } from "./skill-runtime";
import { registerSkillsHandler } from "./skills";

describe("Skills IPC contract", () => {
    beforeEach(() => handlers.clear());

    it("forwards the explicit manual-refresh force flag to the shared runtime", async () => {
        const snapshotResult = vi.fn(async () => ({ fresh: true as const, snapshot: { revision: 1, skills: [], sources: [], diagnostics: [] } }));
        const runtime = {
            snapshotResult,
            configureResult: vi.fn(),
            detailForUi: vi.fn(),
            readForUi: vi.fn(),
            invalidate: vi.fn(),
        } as unknown as SkillRuntime;
        registerSkillsHandler(() => null, runtime);

        await handlers.get("skills:scan")?.({}, true);

        expect(snapshotResult).toHaveBeenCalledWith(true);
    });
});
