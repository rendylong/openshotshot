import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AppSidebar } from "@/components/layout/app-sidebar";
import { UNCATEGORIZED_PROJECT_ID } from "@/lib/canvas/category";
import type { AccountBridge } from "@/lib/desktop/account-bridge";
import { addCanvasToProject, createProjectWithCanvas, renameCanvasInProject, updateCanvasInProject } from "@/lib/canvas/project-model";
import type { PiSessionStatus, PiSessionSummary } from "@/lib/agent/pi-agent-types";
import i18n from "@/i18n";
import { useAgentSessionStore } from "@/stores/use-agent-session-store";
import { useProjectStore } from "@/stores/canvas/use-project-store";

const { messageSuccess, modalConfirm } = vi.hoisted(() => ({ messageSuccess: vi.fn(), modalConfirm: vi.fn() }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DropdownProps = { children: React.ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void; menu?: any };

vi.mock("antd", () => ({
    App: { useApp: () => ({ message: { success: messageSuccess }, modal: { confirm: modalConfirm } }) },
    Dropdown: ({ children, open, onOpenChange, menu }: DropdownProps) => (
        <span onClick={() => onOpenChange?.(!open)}>
            {children}
            {open && menu ? (
                <div data-testid="row-actions-menu">
                    {(menu.items ?? []).flatMap((item: { key?: string; label?: React.ReactNode; danger?: boolean; children?: { key: string; label: React.ReactNode }[] }) => {
                        if (!item?.key) return [];
                        if (item.children) {
                            return item.children.map((child) => (
                                <button key={child.key} type="button" data-menu-key={child.key} onClick={() => menu.onClick?.({ key: child.key })}>
                                    {child.label}
                                </button>
                            ));
                        }
                        return [
                            <button key={item.key} type="button" data-menu-key={item.key} data-danger={item.danger ? "true" : undefined} onClick={() => menu.onClick?.({ key: item.key })}>
                                {item.label}
                            </button>,
                        ];
                    })}
                </div>
            ) : null}
        </span>
    ),
    // 底栏 VersionReleaseModal 依赖的 antd 组件最小桩，仅保证测试渲染不炸
    Modal: ({ open, title, footer, onCancel, children }: { open?: boolean; title?: React.ReactNode; footer?: React.ReactNode; onCancel?: () => void; children?: React.ReactNode }) =>
        open ? (
            <div data-testid="version-release-modal">
                {title}
                {children}
                {footer}
                <button type="button" onClick={() => onCancel?.()} />
            </div>
        ) : null,
    Tag: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
    Timeline: ({ items }: { items?: { content: React.ReactNode }[] }) => <div>{(items ?? []).map((item, index) => <div key={index}>{item.content}</div>)}</div>,
}));

vi.mock("@/components/layout/settings-popover", () => ({
    SettingsPopover: ({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) => (
        <button type="button" aria-haspopup="menu" aria-label="设置" onClick={() => onOpenChange?.(true)}>
            设置
        </button>
    ),
}));

vi.mock("@/components/layout/user-menu-button", () => ({
    UserMenuButton: ({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) => (
        <button type="button" aria-haspopup="menu" aria-label="账户" onClick={() => onOpenChange?.(true)}>账户</button>
    ),
}));

const LocationProbe = () => {
    const { pathname } = useLocation();
    return <span data-testid="pathname">{pathname}</span>;
};

const renderSidebar = (initialEntry = "/") =>
    render(
        <I18nextProvider i18n={i18n}>
            <MemoryRouter initialEntries={[initialEntry]}>
                <AppSidebar />
                <LocationProbe />
            </MemoryRouter>
        </I18nextProvider>,
    );

beforeEach(() => {
    messageSuccess.mockClear();
    modalConfirm.mockClear();
    useProjectStore.setState({ projects: [] });
    useAgentSessionStore.setState({ sessions: [], activeSessionId: null, unreadableSessions: [], pendingUserInputs: {}, pendingApprovals: {} });
});

afterEach(() => {
    delete window.shotshot;
});

const sidebarElement = (container: HTMLElement) => container.querySelector("aside") as HTMLElement;

const sessionFor = (canvasId: string, status: PiSessionStatus, sessionId = "session-1"): PiSessionSummary => ({
    sessionId,
    title: sessionId,
    scope: { projectId: "project-1", canvasId },
    createdAt: 0,
    updatedAt: 0,
    status,
    hasUnfinishedOperation: false,
});

const expectFollowedBy = (earlier: HTMLElement, later: HTMLElement) => {
    // compareDocumentPosition 返回「参数节点位于主语之后」的位掩码
    expect(Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
};

describe("AppSidebar", () => {
    test("shows the shotshot logo above the start link", () => {
        renderSidebar();
        const brand = screen.getByRole("link", { name: i18n.t("meta.title") });
        const start = screen.getByRole("link", { name: "开始创作" });
        expect(brand.querySelector("span")).toHaveAttribute("aria-hidden", "true");
        expect(brand.querySelector("span")?.getAttribute("style")).toContain("url(./shotshot.png)");
        expect(Boolean(brand.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    });

    test("renders the primary start and skills links", () => {
        renderSidebar("/");
        expect(screen.getByRole("link", { name: "开始创作" })).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "技能" })).toBeInTheDocument();
    });

    test("labels the nav landmark", () => {
        renderSidebar("/");
        expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
    });

    test("marks only the active top-level route with aria-current", () => {
        renderSidebar("/");
        expect(screen.getByRole("link", { name: "开始创作" })).toHaveAttribute("aria-current", "page");
        expect(screen.getByRole("link", { name: "技能" })).not.toHaveAttribute("aria-current");
    });

    test("marks the active skills route with aria-current", () => {
        renderSidebar("/skills");
        const skills = screen.getByRole("link", { name: "技能" });
        expect(skills).toHaveAttribute("aria-current", "page");
        expect(skills).toHaveAttribute("data-selected", "true");
        expect(skills).toHaveClass("!bg-sidebar-accent");
        expect(skills).toHaveClass("font-normal");
        expect(screen.getByRole("link", { name: "开始创作" })).not.toHaveAttribute("aria-current");
    });

    test("keeps skills selected on a nested skills route", () => {
        renderSidebar("/skills/example");
        const skills = screen.getByRole("link", { name: "技能" });
        expect(skills).toHaveAttribute("aria-current", "page");
        expect(skills).toHaveAttribute("data-selected", "true");
        expect(skills).toHaveClass("!bg-sidebar-accent");
    });

    test("uses the Codex selected treatment for the projects route", () => {
        renderSidebar("/projects");
        const projects = screen.getByRole("link", { name: "项目列表" });
        expect(projects).toHaveAttribute("aria-current", "page");
        expect(projects).toHaveAttribute("data-selected", "true");
        expect(projects).toHaveClass("!bg-sidebar-accent");
        expect(projects).toHaveClass("font-normal");
        // antd <App> 的 unlayered 锚点重置会压过 @layer utilities，锚点行文字色必须带 !。
        expect(projects).toHaveClass("!text-stone-950", "dark:!text-stone-50");
    });

    test("keeps projects selected in project detail", () => {
        renderSidebar("/projects/project-1");
        const projects = screen.getByRole("link", { name: "项目列表" });
        expect(projects).toHaveAttribute("aria-current", "page");
        expect(projects).toHaveAttribute("data-selected", "true");
        expect(projects).toHaveClass("!bg-sidebar-accent");
    });

    test("renders project canvases indented under the project", () => {
        const { projectId } = useProjectStore.getState().createProject("P1");
        useProjectStore.getState().createCanvas(projectId, "C2");
        const { container } = renderSidebar();
        // 折叠/钉住按钮只在展开态渲染：先悬停展开再钉住（同真实交互）
        fireEvent.mouseEnter(sidebarElement(container));
        fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
        fireEvent.click(screen.getByRole("button", { name: "P1" }));
        expect(screen.getAllByText("P1").length).toBeGreaterThan(0);
        expect(screen.getByText("C2")).toBeTruthy();
    });

    test("does not collapse while the settings menu is active", () => {
        const { container } = renderSidebar();
        const aside = sidebarElement(container);
        fireEvent.mouseEnter(aside);
        expect(aside).toHaveClass("w-[240px]");

        fireEvent.click(screen.getByRole("button", { name: "设置" }));
        fireEvent.mouseLeave(aside);
        expect(aside).toHaveClass("w-[240px]");
    });

    test("does not collapse while an uncategorized canvas row actions menu is active", () => {
        const project = createProjectWithCanvas("Inbox");
        project.id = UNCATEGORIZED_PROJECT_ID;
        const target = useProjectStore.getState().createProject("P1");
        useProjectStore.setState({ projects: [project, useProjectStore.getState().projects.find((item) => item.id === target.projectId)!] });

        const { container } = renderSidebar();
        const aside = sidebarElement(container);
        fireEvent.mouseEnter(aside);
        expect(aside).toHaveClass("w-[240px]");

        fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
        fireEvent.mouseLeave(aside);
        expect(aside).toHaveClass("w-[240px]");
    });

    test("renders uncategorized rows with a neutral canvas badge and reserved action gutter", () => {
        const project = createProjectWithCanvas("Inbox");
        project.id = UNCATEGORIZED_PROJECT_ID;
        useProjectStore.setState({ projects: [project] });
        useProjectStore.getState().createProject("P1");

        const { container } = renderSidebar();
        fireEvent.mouseEnter(sidebarElement(container));

        const link = screen.getByRole("link", { name: "Inbox" });
        // 右侧 36px 恒定预留「移动到项目」按钮位，截断标题不得延伸进按钮区
        expect(link).toHaveClass("pl-3", "pr-9");
        expect(link).not.toHaveClass("px-3");
        const badge = link.querySelector("span[aria-hidden='true']");
        expect(badge).toHaveClass("bg-foreground/5");
        expect(badge).toHaveClass("text-muted-foreground");
        expect(badge?.querySelector("svg")).toBeTruthy();

        // 项目行「新建画布」按钮同款预留
        expect(screen.getByRole("button", { name: "P1" })).toHaveClass("pr-9");
    });

    test("row actions menu moves the canvas via the project submenu", () => {
        const project = createProjectWithCanvas("Inbox");
        project.id = UNCATEGORIZED_PROJECT_ID;
        const target = useProjectStore.getState().createProject("P1");
        useProjectStore.setState({ projects: [project, useProjectStore.getState().projects.find((item) => item.id === target.projectId)!] });

        const { container } = renderSidebar();
        fireEvent.mouseEnter(sidebarElement(container));
        fireEvent.click(screen.getByRole("button", { name: "更多操作" }));

        const menu = screen.getByTestId("row-actions-menu");
        expect(within(menu).getByText("删除")).toHaveAttribute("data-danger", "true");
        fireEvent.click(within(menu).getByText("P1"));

        expect(screen.getByTestId("pathname").textContent).toBe(`/canvas/${target.projectId}/${project.canvases[0].id}`);
        expect(useProjectStore.getState().projects.find((item) => item.id === UNCATEGORIZED_PROJECT_ID)!.canvases).toHaveLength(0);
        expect(useProjectStore.getState().projects.find((item) => item.id === target.projectId)!.canvases.map((c) => c.id)).toContain(project.canvases[0].id);
    });

    test("row actions menu deletes a background canvas after confirmation", () => {
        const project = createProjectWithCanvas("Inbox");
        project.id = UNCATEGORIZED_PROJECT_ID;
        useProjectStore.setState({ projects: [project] });

        const { container } = renderSidebar();
        fireEvent.mouseEnter(sidebarElement(container));
        fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
        fireEvent.click(within(screen.getByTestId("row-actions-menu")).getByText("删除"));

        // 先弹确认，未确认前不删
        expect(modalConfirm).toHaveBeenCalledTimes(1);
        const config = modalConfirm.mock.calls[0][0] as { title: string; okButtonProps?: { danger?: boolean }; onOk: () => void };
        expect(config.title).toBe("删除画布「Inbox」？");
        expect(config.okButtonProps).toMatchObject({ danger: true });
        expect(useProjectStore.getState().projects.find((item) => item.id === UNCATEGORIZED_PROJECT_ID)!.canvases).toHaveLength(1);

        config.onOk();
        expect(messageSuccess).toHaveBeenCalledWith("画布已删除");
        expect(useProjectStore.getState().projects.find((item) => item.id === UNCATEGORIZED_PROJECT_ID)!.canvases).toHaveLength(0);
        // 非当前打开画布，不跳转
        expect(screen.getByTestId("pathname").textContent).toBe("/");
    });

    test("navigates home after confirming deletion of the currently open uncategorized canvas", () => {
        const project = createProjectWithCanvas("Inbox");
        project.id = UNCATEGORIZED_PROJECT_ID;
        useProjectStore.setState({ projects: [project] });

        const { container } = renderSidebar(`/canvas/${UNCATEGORIZED_PROJECT_ID}/${project.canvases[0].id}`);
        fireEvent.mouseEnter(sidebarElement(container));
        fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
        fireEvent.click(within(screen.getByTestId("row-actions-menu")).getByText("删除"));
        act(() => (modalConfirm.mock.calls[0][0] as { onOk: () => void }).onOk());

        expect(messageSuccess).toHaveBeenCalledWith("画布已删除");
        expect(screen.getByTestId("pathname").textContent).toBe("/");
    });

    test("highlights the active canvas in-tree", () => {
        const { projectId } = useProjectStore.getState().createProject("P1");
        const c2Id = useProjectStore.getState().createCanvas(projectId, "C2");
        const { container } = renderSidebar(`/canvas/${projectId}/${c2Id}`);
        fireEvent.mouseEnter(sidebarElement(container));
        fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
        expect(screen.getByRole("link", { name: "开始创作" })).not.toHaveAttribute("aria-current");
        expect(screen.getByRole("link", { name: "技能" })).not.toHaveAttribute("aria-current");
        // The top-level "项目列表" link stays unselected on canvas routes —
        // only the matching canvas inside the project tree gets the highlight.
        const projects = screen.getByRole("link", { name: "项目列表" });
        expect(projects).not.toHaveAttribute("aria-current");
        expect(projects).not.toHaveAttribute("data-selected");
        expect(projects).toHaveClass("!text-stone-600", "hover:!text-stone-950", "dark:!text-stone-400", "dark:hover:!text-stone-100");
        expect(screen.getByRole("button", { name: "P1" })).not.toHaveClass("bg-black/[0.055]");
        expect(screen.getByRole("link", { name: "C2" })).toHaveAttribute("aria-current", "page");
        expect(screen.getByRole("link", { name: "C2" })).toHaveClass("!bg-sidebar-accent");
        expect(screen.getByRole("link", { name: "C2" })).toHaveClass("!text-stone-950", "dark:!text-stone-50");
    });

    test("renders the user entry instead of settings on desktop", () => {
        window.shotshot = { account: {} as AccountBridge, agent: {} as never, skills: {} as never, platform: "darwin" };
        const { container } = renderSidebar();
        // footer 入口只在展开态渲染，先展开侧栏（同「does not collapse while the settings menu is active」）
        fireEvent.mouseEnter(sidebarElement(container));
        expect(screen.getByRole("button", { name: "账户" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
    });

    test("keeps the settings entry on the web without the bridge", () => {
        const { container } = renderSidebar();
        fireEvent.mouseEnter(sidebarElement(container));
        expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "账户" })).not.toBeInTheDocument();
    });

    test("sorts uncategorized canvases by last activity instead of creation time", () => {
        // C1 创建更早但后来被编辑/对话触碰 → 跳到最新创建的 C2 前面
        let project = createProjectWithCanvas("Inbox", "2026-09-01T00:00:00.000Z");
        project = renameCanvasInProject(project, project.canvases[0].id, "C1");
        project = addCanvasToProject(project, "C2", "2026-09-05T00:00:00.000Z");
        project = updateCanvasInProject(project, project.canvases[0].id, {}, "2026-09-09T00:00:00.000Z");
        project.id = UNCATEGORIZED_PROJECT_ID;
        useProjectStore.setState({ projects: [project] });

        const { container } = renderSidebar();
        fireEvent.mouseEnter(sidebarElement(container));
        expectFollowedBy(screen.getByRole("link", { name: "C1" }), screen.getByRole("link", { name: "C2" }));
    });

    test("sorts project canvases by last activity in the tree", () => {
        let project = createProjectWithCanvas("P1", "2026-09-01T00:00:00.000Z");
        project = renameCanvasInProject(project, project.canvases[0].id, "C1");
        project = addCanvasToProject(project, "C2", "2026-09-05T00:00:00.000Z");
        project = updateCanvasInProject(project, project.canvases[0].id, {}, "2026-09-09T00:00:00.000Z");
        useProjectStore.setState({ projects: [project] });

        const { container } = renderSidebar();
        fireEvent.mouseEnter(sidebarElement(container));
        fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
        fireEvent.click(screen.getByRole("button", { name: "P1" }));
        expectFollowedBy(screen.getByRole("link", { name: "C1" }), screen.getByRole("link", { name: "C2" }));
    });

    test("shows a loading icon while the agent runs on a canvas and restores the frame icon when idle", () => {
        const project = createProjectWithCanvas("Inbox");
        project.id = UNCATEGORIZED_PROJECT_ID;
        useProjectStore.setState({ projects: [project] });
        const canvasId = project.canvases[0].id;
        useAgentSessionStore.setState({ sessions: [sessionFor(canvasId, "running")], activeSessionId: "session-1", unreadableSessions: [], pendingUserInputs: {}, pendingApprovals: {} });

        const { container } = renderSidebar();
        fireEvent.mouseEnter(sidebarElement(container));
        const link = screen.getByRole("link", { name: "Inbox" });
        // 运行中：Frame 被 loader 取代
        expect(link.querySelector("svg.lucide-loader-circle")).toBeTruthy();
        expect(link.querySelector("svg.lucide-frame")).toBeNull();

        // idle 恢复 Frame
        act(() => useAgentSessionStore.setState({ sessions: [sessionFor(canvasId, "idle")], activeSessionId: "session-1" }));
        expect(link.querySelector("svg.lucide-frame")).toBeTruthy();
        expect(link.querySelector("svg.lucide-loader-circle")).toBeNull();
    });

    test("marks the running canvas inside the project tree with a spinner without an icon when idle", () => {
        const project = createProjectWithCanvas("P1");
        useProjectStore.setState({ projects: [project] });
        const runningId = project.canvases[0].id;
        useProjectStore.getState().createCanvas(project.id, "C2");
        useAgentSessionStore.setState({ sessions: [sessionFor(runningId, "waiting_input")], activeSessionId: "session-1", unreadableSessions: [], pendingUserInputs: {}, pendingApprovals: {} });

        const { container } = renderSidebar();
        fireEvent.mouseEnter(sidebarElement(container));
        fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
        fireEvent.click(screen.getByRole("button", { name: "P1" }));
        // waiting_input 也在运行中口径内；无会话的画布保持无图标
        expect(screen.getByRole("link", { name: "P1" }).querySelector("svg.lucide-loader-circle")).toBeTruthy();
        expect(screen.getByRole("link", { name: "C2" }).querySelector("svg.lucide-loader-circle")).toBeNull();
    });

    test("renders the collapse toggle in the drawer top-right only while expanded", () => {
        const { container } = renderSidebar();
        const aside = sidebarElement(container);
        // 折叠态：右上角整体（按钮 + 版本提醒容器）不渲染
        expect(screen.queryByRole("button", { name: "折叠侧栏" })).not.toBeInTheDocument();

        // 悬停展开后按钮出现在右上角容器，点击钉住；取消钉住立即回到折叠态且按钮消失
        fireEvent.mouseEnter(aside);
        fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
        fireEvent.mouseLeave(aside);
        expect(aside).toHaveClass("w-[240px]");
        fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
        expect(aside).toHaveClass("w-14");
        expect(screen.queryByRole("button", { name: "折叠侧栏" })).not.toBeInTheDocument();
    });

    test("grace period: hover leave collapses only after the delay", () => {
        // 桌面端标题栏拖拽条吞事件：指针穿过去点钉住按钮会先触发 mouseleave，不能立刻收起
        vi.useFakeTimers();
        try {
            const { container } = renderSidebar();
            const aside = sidebarElement(container);
            fireEvent.mouseEnter(aside);
            expect(aside).toHaveClass("w-[240px]");

            fireEvent.mouseLeave(aside);
            expect(aside).toHaveClass("w-[240px]");

            act(() => vi.advanceTimersByTime(300));
            expect(aside).toHaveClass("w-14");
        } finally {
            vi.useRealTimers();
        }
    });

    test("re-entering during the grace period cancels the pending collapse", () => {
        vi.useFakeTimers();
        try {
            const { container } = renderSidebar();
            const aside = sidebarElement(container);
            fireEvent.mouseEnter(aside);
            fireEvent.mouseLeave(aside);
            fireEvent.mouseEnter(aside);

            act(() => vi.advanceTimersByTime(300));
            expect(aside).toHaveClass("w-[240px]");
        } finally {
            vi.useRealTimers();
        }
    });

    test("keeps the account/settings entry in the footer while collapsed", () => {
        renderSidebar();
        // 底栏不再有折叠按钮，账号/设置入口是唯一内容（折叠态由各自组件收成图标）
        expect(screen.queryByRole("button", { name: "折叠侧栏" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
    });
});
