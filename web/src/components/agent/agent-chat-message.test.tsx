import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { canvasThemes } from "@/lib/canvas-theme";
import i18n from "@/i18n";
import { AgentApprovalCard, AgentChatMessage, AgentToolCard, type AgentChatAttachment } from "./agent-chat-message";

describe("AgentToolCard", () => {
    it("keeps canvas icons unified and other common tools distinct even with translated titles", () => {
        const icons = ["canvas_get_state", "canvas_move_nodes", "view_image", "read", "generate_chatgpt_image", "local_file_read", "local_folder_list", "assets_list", "assets_add"].map((name) => {
            const { container, unmount } = render(<AgentToolCard title="工具" text="" detail={{ kind: "tool", status: "completed", toolName: name }} theme={canvasThemes.light} />);
            const icon = container.querySelector(".aicss-processIcon svg")!.getAttribute("class");
            unmount();
            return icon;
        });
        expect(icons[0]).toBe(icons[1]);
        expect(icons[0]).toBe(icons[2]);
        expect(new Set([icons[0], ...icons.slice(3)]).size).toBe(7);
    });

    it("uses the same readable tool label for restored raw tool names", () => {
        render(<AgentToolCard title="canvas_get_state" text="" detail={{ kind: "tool", status: "completed" }} theme={canvasThemes.light} />);
        expect(screen.getByText("读取画布")).toBeInTheDocument();
    });

    it("keeps tool output inside the expandable row while streaming updates arrive", () => {
        const { container, rerender } = render(<AgentToolCard title="读取文件" text="正在读取内容" detail={{ kind: "tool", status: "running", output: "first chunk" }} theme={canvasThemes.light} />);
        const summary = container.querySelector("summary")!;
        expect(summary.textContent).not.toContain("正在读取内容");
        expect(summary.querySelector("svg:last-child")).toBeInTheDocument();
        const details = container.querySelector("details")!;
        details.open = true;
        rerender(<AgentToolCard title="读取文件" text="读取完成" detail={{ kind: "tool", status: "completed", output: "first chunk plus second chunk" }} theme={canvasThemes.light} />);
        expect(details.open).toBe(true);
        expect(screen.getByText("first chunk plus second chunk")).toBeInTheDocument();
    });

    it("keeps thinking collapsed by default, even while it is still running", () => {
        const { container } = render(<AgentToolCard title="思考摘要" text="先读取节点，再核对连接。" detail={{ kind: "reasoning", status: "running" }} theme={canvasThemes.light} />);
        expect(screen.getByText("正在思考")).toBeInTheDocument();
        expect(screen.queryByText("先读取节点，再核对连接。")).not.toBeInTheDocument();
        expect(container.querySelector(".aicss-thinkingBody")).not.toBeInTheDocument();
        expect(container.querySelector(".aicss-processChevron")).toBeInTheDocument();
    });

    it("expands a running thought on demand with a capped viewport, and collapses again", () => {
        const { container } = render(<AgentToolCard title="思考摘要" text="先读取节点，再核对连接。" detail={{ kind: "reasoning", status: "running" }} theme={canvasThemes.light} />);
        fireEvent.click(screen.getByRole("button", { name: "正在思考" }));
        expect(screen.getByText("先读取节点，再核对连接。")).toBeInTheDocument();
        const body = container.querySelector(".aicss-thinkingBody")!;
        expect((body as HTMLElement).style.maxHeight).toBe("180px");
        expect((body as HTMLElement).style.overflowY).toBe("auto");
        fireEvent.click(screen.getByRole("button", { name: "正在思考" }));
        expect(screen.queryByText("先读取节点，再核对连接。")).not.toBeInTheDocument();
    });

    it("keeps tool input and output available in the expandable detail", () => {
        render(
            <AgentToolCard
                title="读取画布"
                text="已读取当前画布内容"
                detail={{ kind: "tool", status: "completed", input: '{"nodeId":"node-1"}', output: '{"nodes":[]}' }}
                theme={canvasThemes.light}
            />,
        );

        expect(screen.getByText('{"nodeId":"node-1"}')).toBeInTheDocument();
        expect(screen.getByText('{"nodes":[]}')).toBeInTheDocument();
    });

    it("caps long tool output text in a fading viewport like the thinking summary", () => {
        const { container } = render(
            <AgentToolCard title="读取文件" text={"const value = 1;\n".repeat(80)} detail={{ kind: "tool", status: "completed", toolName: "local_file_read" }} theme={canvasThemes.light} />,
        );
        const body = container.querySelector(".aicss-processBody .mt-1") as HTMLElement;
        expect(body).toBeInTheDocument();
        expect(body.style.maxHeight).toBe("180px");
        expect(body.style.overflowY).toBe("auto");
        // 遮罩按实际 overflow 计算，不得乐观置位（jsdom 无几何 → 无遮罩）。
        expect(body.style.maskImage).toBe("");
    });

    it("caps the tool detail output viewport instead of a hard max-height scroll", () => {
        render(
            <AgentToolCard title="读取文件" text="" detail={{ kind: "tool", status: "completed", input: '{"path":"a.ts"}', output: "x".repeat(400) }} theme={canvasThemes.light} />,
        );
        const output = screen.getByText("x".repeat(400)) as HTMLElement;
        expect(output.style.maxHeight).toBe("180px");
        expect(output.style.overflowY).toBe("auto");
        expect(output.className).not.toContain("max-h-56");
    });

    it("renders completed thinking as a distinct collapsed thought", () => {
        render(
            <AgentToolCard
                title="思考摘要"
                text="先读取节点，再核对连接。"
                detail={{ kind: "reasoning", status: "completed", durationMs: 2_400 }}
                theme={canvasThemes.light}
            />,
        );

        const toggle = screen.getByRole("button", { name: "思考 · 2s" });
        expect(screen.queryByText("先读取节点，再核对连接。")).not.toBeInTheDocument();
        fireEvent.click(toggle);
        expect(screen.getByText("先读取节点，再核对连接。")).toBeInTheDocument();
    });
});

describe("AgentApprovalCard", () => {
    it("renders the command cwd as a separate muted line for command approvals", () => {
        render(
            <AgentApprovalCard
                approval={{ requestId: "r1", method: "exec/command/requestApproval", command: "ls", cwd: "/Users/me/project" }}
                theme={canvasThemes.light}
                onDecision={vi.fn()}
            />,
        );

        expect(screen.getByText("ls")).toBeInTheDocument();
        // command 恒非空，cwd 不会通过 `|| cwd` 回退进 target，必须以次行渲染。
        expect(screen.getByText("工作目录：/Users/me/project")).toBeInTheDocument();
    });

    it("omits the cwd line when the command approval has no cwd", () => {
        render(
            <AgentApprovalCard
                approval={{ requestId: "r2", method: "exec/command/requestApproval", command: "ls" }}
                theme={canvasThemes.light}
                onDecision={vi.fn()}
            />,
        );

        expect(screen.getByText("ls")).toBeInTheDocument();
        expect(screen.queryByText(/工作目录/)).not.toBeInTheDocument();
    });
});

describe("AgentChatMessage attachment rendering", () => {
    function renderMessage(attachment: AgentChatAttachment) {
        return render(
            <AgentChatMessage item={{ id: "m", role: "user", text: "", attachments: [attachment] }} theme={canvasThemes.light} />,
        );
    }

    it.each(["video", "audio", "pdf", "presentation", "spreadsheet", "glb", "text", "file"] as const)("renders %s attachments as a typed file card without an image fallback", (kind) => {
        const { container, unmount } = renderMessage({ id: "a", name: `asset-${kind}`, url: "", kind });
        expect(container.querySelector("img")).toBeNull();
        expect(screen.getByTitle(`asset-${kind}`)).toBeInTheDocument();
        expect(screen.getByText(i18n.t(`agent.message.attachmentKind.${kind === "glb" ? "model3d" : kind}`))).toBeInTheDocument();
        unmount();
    });

    it("renders a missing or unknown kind as a generic file card instead of an image", () => {
        const { container, unmount } = renderMessage({ id: "a", name: "legacy-attachment", url: "" });
        expect(container.querySelector("img")).toBeNull();
        expect(screen.getByTitle("legacy-attachment")).toBeInTheDocument();
        expect(screen.getByText(i18n.t("agent.message.attachmentKind.file"))).toBeInTheDocument();

        const { unmount: unmountUnknown } = renderMessage({ id: "b", name: "mystery-blob", url: "blob:mystery", kind: "hologram" as never });
        expect(document.body.querySelector("img[alt='mystery-blob']")).toBeNull();
        expect(screen.getByTitle("mystery-blob")).toBeInTheDocument();
        unmountUnknown();
        unmount();
    });

    it("renders image attachments as thumbnails", () => {
        const { container, unmount } = renderMessage({ id: "a", name: "photo.png", url: "data:image/png;base64,AA==", kind: "image" });
        const image = container.querySelector("img");
        expect(image).not.toBeNull();
        expect(image).toHaveAttribute("src", "data:image/png;base64,AA==");
        expect(image).toHaveAttribute("alt", "photo.png");
        unmount();
    });
});
