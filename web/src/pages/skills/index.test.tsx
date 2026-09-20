import { App } from "antd";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, test, vi } from "vitest";

import i18n from "@/i18n";
import {
    DEFAULT_SKILL_SOURCE_PREFERENCES,
    type LocalSkillDetail,
    type LocalSkillSummary,
    type SkillRuntimeSnapshot,
    type SkillsBridge,
    type SkillSourceStatus,
} from "@/lib/skills/skill-types";
import { SkillDetailModal } from "@/components/skills/skill-detail-modal";
import { SkillDraftCapture } from "@/components/skills/skill-draft-capture";
import SkillsPage from "@/pages/skills";
import { useAgentStore } from "@/stores/use-agent-store";
import { useLocalSkillStore } from "@/stores/use-local-skill-store";
import { usePiHistoryStore } from "@/stores/use-pi-history-store";
import { useProjectStore } from "@/stores/canvas/use-project-store";

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", () => ({ useNavigate: () => navigateMock }));

const appSkill: LocalSkillSummary = {
    name: "brand-guide",
    displayName: "品牌指南",
    description: "维护品牌语言和视觉规则",
    shortDescription: "品牌语言与视觉规则",
    path: "/Users/test/.shotshot/skills/brand-guide",
    source: "app",
    manualOnly: false,
    readonly: false,
    valid: true,
};

const photoSkill: LocalSkillSummary = {
    name: "photo-workflow",
    displayName: "摄影工作流",
    description: "组织产品摄影的准备、拍摄与交付",
    path: "/Users/test/.shotshot/skills/photo-workflow",
    source: "app",
    manualOnly: true,
    readonly: false,
    valid: true,
};

const externalSkill: LocalSkillSummary = {
    name: "external-review",
    displayName: "外部审查",
    description: "从 Pi 全局目录读取的审查流程",
    path: "/Users/test/.pi/agent/skills/external-review",
    source: "piGlobal",
    manualOnly: false,
    readonly: true,
    valid: true,
};

const baseSources: SkillSourceStatus[] = [
    { key: "app", enabled: true, readonly: false, paths: ["/Users/test/.shotshot/skills"], exists: true, skillCount: 2, diagnostics: [] },
    { key: "piGlobal", enabled: false, readonly: true, paths: ["/Users/test/.pi/agent/skills"], exists: true, skillCount: 0, diagnostics: [] },
    { key: "agentsGlobal", enabled: false, readonly: true, paths: ["/Users/test/.agents/skills"], exists: false, skillCount: 0, diagnostics: [] },
    { key: "piProject", enabled: false, readonly: true, paths: ["/project/.pi/skills"], exists: false, skillCount: 0, diagnostics: [] },
    { key: "agentsProject", enabled: false, readonly: true, paths: ["/project/.agents/skills"], exists: false, skillCount: 0, diagnostics: [] },
];

function detail(skill: LocalSkillSummary, instructions: string, files: string[]): LocalSkillDetail {
    return {
        name: skill.name,
        description: skill.description,
        displayName: skill.displayName,
        shortDescription: skill.shortDescription,
        path: skill.path,
        instructions,
        files,
    };
}

const details: Record<string, LocalSkillDetail> = {
    "brand-guide": detail(appSkill, "Keep the system coherent.", ["SKILL.md", "assets/logo.svg"]),
    "photo-workflow": detail(photoSkill, "Prepare the set, then capture the product.", ["SKILL.md", "references/guide.md", "scripts/check.mjs"]),
    "external-review": detail(externalSkill, "Review the work without editing it.", ["SKILL.md", "references/checklist.md"]),
};

const emptySnapshot: SkillRuntimeSnapshot = { revision: 1, skills: [], sources: baseSources, diagnostics: [] };
const scanSkills = vi.fn(async (): Promise<{ ok: true } | { ok: false; error: string }> => ({ ok: true }));
const setSourceEnabled = vi.fn(async () => {});
const readSkill = vi.fn(async (name: string): Promise<LocalSkillDetail | null> => details[name] ?? null);
const removeSkill = vi.fn(async () => ({ ok: true }));
const writeSkill = vi.fn(async () => ({ ok: true }));
const submitPendingPromptMock = vi.fn(() => ({ projectId: "__uncategorized__", canvasId: "canvas-1" }));
const originalUseSkill = useLocalSkillStore.getState().useSkill;

function installBridge() {
    const skills: SkillsBridge = {
        configure: async () => ({ fresh: true, snapshot: emptySnapshot }),
        scan: async () => ({ fresh: true, snapshot: emptySnapshot }),
        read: readSkill,
        readFile: async () => ({ ok: false, error: "not found" }),
        write: writeSkill,
        importSkill: async () => null,
        remove: removeSkill,
        seed: async () => ({ ok: true }),
        pickFolder: async () => null,
    };
    (window as { shotshot?: { skills: SkillsBridge } }).shotshot = { skills };
}

function setPageState(skills: LocalSkillSummary[] = [appSkill, photoSkill], preferences = DEFAULT_SKILL_SOURCE_PREFERENCES) {
    useLocalSkillStore.setState({
        skills,
        desktop: true,
        loading: false,
        loaded: true,
        errors: [],
        selectedSkill: null,
        sources: baseSources,
        sourcePreferences: { ...preferences },
        scanSkills,
        setSourceEnabled,
        useSkill: originalUseSkill,
    });
}

function renderPage() {
    return render(
        <App>
            <I18nextProvider i18n={i18n}>
                <SkillsPage />
            </I18nextProvider>
        </App>,
    );
}

function renderCapture(onSaved = vi.fn()) {
    return {
        onSaved,
        ...render(
            <App>
                <I18nextProvider i18n={i18n}>
                    <SkillDraftCapture onSaved={onSaved} />
                </I18nextProvider>
            </App>,
        ),
    };
}

async function chooseOption(selectName: string, optionName: string) {
    fireEvent.mouseDown(screen.getByRole("combobox", { name: selectName }));
    const labels = await screen.findAllByText(optionName);
    const option = labels.find((item) => item.closest('[role="option"]')) || labels.at(-1);
    if (!option) throw new Error(`Missing option: ${optionName}`);
    fireEvent.click(option);
}

function modalView(skill: LocalSkillSummary) {
    return (
        <App>
            <I18nextProvider i18n={i18n}>
                <SkillDetailModal skill={skill} open onClose={() => {}} />
            </I18nextProvider>
        </App>
    );
}

beforeEach(() => {
    i18n.changeLanguage("zh-CN");
    scanSkills.mockClear();
    setSourceEnabled.mockClear();
    readSkill.mockReset();
    readSkill.mockImplementation(async (name) => details[name] ?? null);
    removeSkill.mockReset();
    removeSkill.mockResolvedValue({ ok: true });
    writeSkill.mockReset();
    writeSkill.mockResolvedValue({ ok: true });
    scanSkills.mockReset();
    scanSkills.mockResolvedValue({ ok: true });
    submitPendingPromptMock.mockClear();
    navigateMock.mockClear();
    installBridge();
    useProjectStore.setState({ hydrated: false, hydrationStatus: "pending", projects: [], submitPendingPrompt: submitPendingPromptMock });
    useAgentStore.setState({ canvasContext: null });
    useAgentStore.getState().setAgentState({
        prompt: "",
        panelOpen: false,
        submitRequest: null,
        messages: [],
        piLifecycle: { completedAssistantKey: "", historyRestoreRevision: 0 },
    });
    usePiHistoryStore.setState({ activeSessionId: null, sessions: [] });
    setPageState();
});

describe("SkillsPage gallery", () => {
    test("forces only the explicit toolbar refresh", () => {
        renderPage();

        fireEvent.click(screen.getByRole("button", { name: "刷新" }));

        expect(scanSkills).toHaveBeenCalledWith(true);
    });

    test("创建 Skill 走 handoff：安装 pendingPrompt 并导航到未分类画布", () => {
        renderPage();

        fireEvent.click(screen.getByRole("button", { name: "创建 Skill" }));

        expect(submitPendingPromptMock).toHaveBeenCalledWith("/skill-creator", expect.any(String));
        expect(navigateMock).toHaveBeenCalledWith("/canvas/__uncategorized__/canvas-1");
    });

    test("双击只提交一次（eng review P1 守卫）", () => {
        renderPage();
        const button = screen.getByRole("button", { name: "创建 Skill" });
        fireEvent.click(button);
        fireEvent.click(button);

        expect(submitPendingPromptMock).toHaveBeenCalledTimes(1);
    });

    test("挂载不再设置 Agent 画布上下文", () => {
        renderPage();

        expect(useAgentStore.getState().canvasContext).toBeNull();
    });

    test("keeps the app source always on and every optional source off by default", () => {
        renderPage();

        expect(screen.getAllByText("应用内置").every((item) => !item.closest(".ant-popover") || !item.closest(".ant-popover")?.classList.contains("ant-popover-open"))).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Skill 来源设置" }));

        expect(screen.getAllByText("应用内置").some((item) => item.closest(".ant-popover"))).toBe(true);
        expect(screen.queryByRole("checkbox", { name: "应用内置" })).not.toBeInTheDocument();
        expect(screen.getByRole("checkbox", { name: "Pi 全局" })).not.toBeChecked();
        expect(screen.getByRole("checkbox", { name: "Agents 全局" })).not.toBeChecked();
        expect(screen.getByRole("checkbox", { name: "项目 Pi" })).not.toBeChecked();
        expect(screen.getByRole("checkbox", { name: "项目 Agents" })).not.toBeChecked();
        expect(within(screen.getByRole("region", { name: "Pi 全局" })).getByText("未启用 · 就绪 · 0 个 Skill")).toBeInTheDocument();
        expect(within(screen.getByRole("region", { name: "Agents 全局" })).getByText("未启用 · 未找到 · 0 个 Skill")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("checkbox", { name: "Pi 全局" }));
        expect(setSourceEnabled).toHaveBeenCalledWith("piGlobal", true);
    });

    test("displays every resolved project candidate even when none exists", () => {
        const paths = ["/repo/packages/canvas/.pi/skills", "/repo/packages/.pi/skills", "/repo/.pi/skills"];
        useLocalSkillStore.setState({
            sources: baseSources.map((source) => source.key === "piProject" ? { ...source, paths, exists: false } : source),
        });

        renderPage();
        fireEvent.click(screen.getByRole("button", { name: "Skill 来源设置" }));

        const source = screen.getByRole("region", { name: "项目 Pi" });
        for (const path of paths) expect(within(source).getByText(path)).toBeInTheDocument();
        expect(within(source).getByText("未启用 · 未找到 · 0 个 Skill")).toBeInTheDocument();
    });

    test("expands benign source diagnostics as notes without turning the source into an error", () => {
        const diagnostic = "Skill 同名冲突：保留应用目录版本";
        useLocalSkillStore.setState({
            sources: baseSources.map((source) => {
                if (source.key === "piGlobal") return { ...source, diagnostics: [diagnostic] };
                if (source.key === "agentsGlobal") return { ...source, error: "EACCES: permission denied" };
                return source;
            }),
        });
        renderPage();
        fireEvent.click(screen.getByRole("button", { name: "Skill 来源设置" }));

        const source = screen.getByRole("region", { name: "Pi 全局" });
        expect(within(source).getByText("未启用 · 就绪 · 0 个 Skill")).toBeInTheDocument();
        expect(within(source).queryByText("异常")).not.toBeInTheDocument();
        const summary = within(source).getByText("1 条诊断");
        const notes = summary.closest("details");
        expect(notes).not.toHaveAttribute("open");
        fireEvent.click(summary);
        expect(notes).toHaveAttribute("open");
        expect(within(source).getByText(diagnostic)).toBeInTheDocument();
        const failedSource = screen.getByRole("region", { name: "Agents 全局" });
        expect(within(failedSource).getByText("未启用 · 异常 · 0 个 Skill")).toBeInTheDocument();
        expect(within(failedSource).getByText("EACCES: permission denied")).toBeInTheDocument();
    });

    test("filters the gallery by source and status", async () => {
        setPageState([appSkill, photoSkill, externalSkill], { ...DEFAULT_SKILL_SOURCE_PREFERENCES, piGlobal: true });
        useLocalSkillStore.setState({
            sources: baseSources.map((source) => source.key === "piGlobal" ? { ...source, enabled: true, skillCount: 1 } : source),
        });
        renderPage();

        await chooseOption("按来源筛选", "Pi 全局");
        expect(screen.getByRole("button", { name: "查看 外部审查 详情" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "查看 品牌指南 详情" })).not.toBeInTheDocument();

        await chooseOption("按来源筛选", "全部来源");
        await chooseOption("按状态筛选", "仅手动");
        expect(screen.getByRole("button", { name: "查看 摄影工作流 详情" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "查看 品牌指南 详情" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "查看 外部审查 详情" })).not.toBeInTheDocument();
    });

    test("filters compact cards, opens the detail Popup, and starts a canvas handoff on use", async () => {
        renderPage();
        fireEvent.change(screen.getByRole("textbox", { name: "搜索名称或用途" }), { target: { value: "摄影" } });

        expect(screen.queryByRole("button", { name: "查看 品牌指南 详情" })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "查看 摄影工作流 详情" }));

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(screen.getByText("/Users/test/.shotshot/skills/photo-workflow")).toBeInTheDocument();
        expect(screen.getByText("/photo-workflow")).toBeInTheDocument();
        expect(await screen.findByText("references")).toBeInTheDocument();
        expect(screen.getByText("guide.md")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "使用此 Skill" }));
        expect(submitPendingPromptMock).toHaveBeenCalledWith("/photo-workflow", expect.any(String));
        expect(navigateMock).toHaveBeenCalledWith("/canvas/__uncategorized__/canvas-1");
        expect(screen.getByRole("dialog")).toHaveClass("ant-zoom-leave");
    });

    test("offers delete only for writable app-source Skills", async () => {
        setPageState([appSkill, externalSkill], { ...DEFAULT_SKILL_SOURCE_PREFERENCES, piGlobal: true });
        useLocalSkillStore.setState({
            sources: baseSources.map((source) => source.key === "piGlobal" ? { ...source, enabled: true, skillCount: 1 } : source),
        });
        renderPage();

        fireEvent.click(screen.getByRole("button", { name: "查看 外部审查 详情" }));
        expect(await screen.findByText("checklist.md")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "删除 Skill" })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: /取\s*消/ }));
        expect(screen.getByRole("dialog")).toHaveClass("ant-zoom-leave");

        fireEvent.click(screen.getByRole("button", { name: "查看 品牌指南 详情" }));
        expect(await screen.findByText("logo.svg")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "删除 Skill" })).toBeInTheDocument();
    });

    test("ignores a stale detail response after switching Skills rapidly", async () => {
        let resolveBrand!: (value: LocalSkillDetail | null) => void;
        let resolvePhoto!: (value: LocalSkillDetail | null) => void;
        const brandRequest = new Promise<LocalSkillDetail | null>((resolve) => { resolveBrand = resolve; });
        const photoRequest = new Promise<LocalSkillDetail | null>((resolve) => { resolvePhoto = resolve; });
        readSkill.mockImplementation((name) => name === appSkill.name ? brandRequest : photoRequest);

        const view = render(modalView(appSkill));
        view.rerender(modalView(photoSkill));
        await act(async () => { resolvePhoto(details[photoSkill.name]); });
        expect(await screen.findByText("guide.md")).toBeInTheDocument();

        await act(async () => { resolveBrand(details[appSkill.name]); });
        expect(screen.getByText("/photo-workflow")).toBeInTheDocument();
        expect(screen.getByText("guide.md")).toBeInTheDocument();
        expect(screen.queryByText("logo.svg")).not.toBeInTheDocument();
    });

    test("keeps the target detail Popup open when deletion fails", async () => {
        removeSkill.mockResolvedValue({ ok: false });
        setPageState([appSkill]);
        renderPage();

        fireEvent.click(screen.getByRole("button", { name: "查看 品牌指南 详情" }));
        expect(await screen.findByText("logo.svg")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "删除 Skill" }));
        expect(screen.getAllByRole("dialog")).toHaveLength(2);
        const confirm = screen.getAllByRole("dialog").at(-1)!;
        fireEvent.click(within(confirm).getByRole("button", { name: /删\s*除/ }));

        await waitFor(() => expect(removeSkill).toHaveBeenCalledWith("brand-guide"));
        await waitFor(() => expect(confirm).toHaveClass("ant-zoom-leave"));
        expect(screen.getByText("/brand-guide")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "删除 Skill" })).toBeInTheDocument();
        expect(await screen.findByText("Skill 删除失败")).toBeInTheDocument();
    });
});

describe("SkillDraftCapture", () => {
    const command = { id: "user-1", itemId: "user-1", threadId: "thread-1", turnId: "turn-1", role: "user" as const, text: "/skill-creator make a useful Skill" };
    const draft = { id: "assistant-1", itemId: "assistant-1", threadId: "thread-1", turnId: "turn-1", role: "assistant" as const, text: "```markdown\n---\nname: useful-skill\ndescription: useful\n---\n\nDo the work.\n```" };
    const draftKey = "thread-1\0turn-1\0assistant-1";

    test("does not reopen for restored historical assistant responses", () => {
        useAgentStore.getState().setAgentState({ messages: [command, draft] });
        renderCapture();

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

        act(() => {
            useAgentStore.getState().setAgentState({
                messages: [
                    { ...command, id: "restored-user", itemId: "restored-user", threadId: "thread-2", turnId: "turn-2" },
                    { ...draft, id: "restored-assistant", itemId: "restored-assistant", threadId: "thread-2", turnId: "turn-2" },
                ],
                piLifecycle: { completedAssistantKey: "", historyRestoreRevision: 1 },
            });
        });

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(writeSkill).not.toHaveBeenCalled();
    });

    test("waits for agent_end completion and writes only on confirmation", async () => {
        const { onSaved } = renderCapture();
        act(() => {
            useAgentStore.getState().setAgentState({ messages: [command] });
        });
        act(() => {
            useAgentStore.getState().setAgentState({ messages: [command, { ...draft, streamId: "stream-1" }] });
        });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

        act(() => {
            useAgentStore.getState().setAgentState({ messages: [command, draft] });
        });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

        act(() => {
            useAgentStore.getState().setAgentState({ piLifecycle: { completedAssistantKey: draftKey, historyRestoreRevision: 0 } });
        });
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(writeSkill).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "创建 Skill" }));

        await waitFor(() => expect(writeSkill).toHaveBeenCalledWith("useful-skill", {
            description: "useful",
            instructions: "Do the work.",
            displayName: null,
            shortDescription: null,
        }));
        await waitFor(() => expect(scanSkills).toHaveBeenCalled());
        await waitFor(() => expect(onSaved).toHaveBeenCalledWith("useful-skill"));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(useLocalSkillStore.getState().selectedSkill).toBeNull();
        expect(useAgentStore.getState().submitRequest).toBeNull();
    });

    test("ignores a valid draft whose nearest owned user message is not skill-creator", () => {
        renderCapture();
        act(() => {
            useAgentStore.getState().setAgentState({
                messages: [
                    command,
                    { id: "user-2", itemId: "user-2", threadId: "thread-1", turnId: "turn-2", role: "user", text: "ordinary request" },
                    { ...draft, id: "assistant-2", itemId: "assistant-2", turnId: "turn-2" },
                ],
                piLifecycle: { completedAssistantKey: "thread-1\0turn-2\0assistant-2", historyRestoreRevision: 0 },
            });
        });

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(writeSkill).not.toHaveBeenCalled();
    });

    test("partitions reused message IDs by session ownership", async () => {
        renderCapture();
        const sessionACommand = { ...command, id: "user", itemId: "user", threadId: "session-a" };
        const sessionADraft = { ...draft, id: "assistant", itemId: "assistant", threadId: "session-a" };
        act(() => {
            useAgentStore.getState().setAgentState({
                messages: [sessionACommand, sessionADraft],
                piLifecycle: { completedAssistantKey: "session-a\0turn-1\0assistant", historyRestoreRevision: 0 },
            });
        });
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: /取\s*消/ }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 3_000 });

        const sessionBCommand = { ...sessionACommand, threadId: "session-b" };
        const sessionBDraft = { ...sessionADraft, threadId: "session-b" };
        act(() => {
            usePiHistoryStore.getState().setActiveSessionId("session-b");
            useAgentStore.getState().setAgentState({
                messages: [sessionBCommand, sessionBDraft],
                piLifecycle: { completedAssistantKey: "session-b\0turn-1\0assistant", historyRestoreRevision: 0 },
            });
        });

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });

    test("does not suppress a fast response after creating a fresh session", async () => {
        renderCapture();
        act(() => {
            usePiHistoryStore.getState().setActiveSessionId("fresh-session");
            useAgentStore.getState().setAgentState({
                messages: [
                    { ...command, threadId: "fresh-session" },
                    { ...draft, threadId: "fresh-session" },
                ],
                piLifecycle: { completedAssistantKey: "fresh-session\0turn-1\0assistant-1", historyRestoreRevision: 0 },
            });
        });

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });

    test("suppresses a delayed explicit history restoration", () => {
        renderCapture();
        act(() => {
            usePiHistoryStore.getState().setActiveSessionId("restored-session");
        });
        act(() => {
            useAgentStore.getState().setAgentState({
                messages: [
                    { ...command, threadId: "restored-session" },
                    { ...draft, threadId: "restored-session" },
                ],
                piLifecycle: { completedAssistantKey: "", historyRestoreRevision: 1 },
            });
        });

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    test("keeps the dialog open when the runtime refresh fails", async () => {
        scanSkills.mockResolvedValueOnce({ ok: false, error: "refresh failed" });
        const { onSaved } = renderCapture();
        act(() => {
            useAgentStore.getState().setAgentState({
                messages: [command, draft],
                piLifecycle: { completedAssistantKey: draftKey, historyRestoreRevision: 0 },
            });
        });
        expect(await screen.findByRole("dialog")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "创建 Skill" }));

        expect(await screen.findByText("refresh failed")).toBeInTheDocument();
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(screen.getByLabelText("Skill 标识")).toBeDisabled();
        expect(screen.getByLabelText("何时使用")).toBeDisabled();
        expect(screen.getByText("Skill 已写入，只需重试刷新。表单已锁定以避免修改被忽略。")).toBeInTheDocument();
        expect(onSaved).not.toHaveBeenCalled();

        scanSkills.mockResolvedValueOnce({ ok: true });
        fireEvent.click(screen.getByRole("button", { name: "创建 Skill" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalledWith("useful-skill"));
        expect(writeSkill).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    test("keeps the dialog open and reports a rejected write IPC", async () => {
        writeSkill.mockRejectedValueOnce(new Error("IPC unavailable"));
        const { onSaved } = renderCapture();
        act(() => {
            useAgentStore.getState().setAgentState({
                messages: [command, draft],
                piLifecycle: { completedAssistantKey: draftKey, historyRestoreRevision: 0 },
            });
        });
        expect(await screen.findByRole("dialog")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "创建 Skill" }));

        expect(await screen.findByText("IPC unavailable")).toBeInTheDocument();
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(scanSkills).not.toHaveBeenCalled();
        expect(onSaved).not.toHaveBeenCalled();
    });
});
