import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentUserInputCard } from "./agent-user-input-card";

describe("AgentUserInputCard", () => {
    it("submits the selected option only after the user continues", () => {
        const onRespond = vi.fn();
        render(
            <AgentUserInputCard
                request={{ requestId: "r1", method: "select", title: "Which direction?", options: ["Minimal", "Detailed"] }}
                onRespond={onRespond}
            />,
        );

        fireEvent.click(screen.getByRole("radio", { name: "Minimal" }));
        expect(onRespond).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "agent.userInput.continue" }));
        expect(onRespond).toHaveBeenCalledWith({ value: "Minimal" });
    });

    it("allows blank free-form input and can cancel", () => {
        const onRespond = vi.fn();
        const { rerender } = render(
            <AgentUserInputCard
                request={{ requestId: "r2", method: "input", title: "Anything else?", placeholder: "Optional" }}
                onRespond={onRespond}
            />,
        );

        fireEvent.click(screen.getByRole("button", { name: "agent.userInput.continue" }));
        expect(onRespond).toHaveBeenCalledWith({ value: "" });

        rerender(
            <AgentUserInputCard
                request={{ requestId: "r3", method: "select", title: "Choose", options: ["A"] }}
                onRespond={onRespond}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "agent.userInput.skip" }));
        expect(onRespond).toHaveBeenLastCalledWith({ cancelled: true });
    });

    const formRequest = {
        requestId: "f1",
        method: "form" as const,
        title: "Setup",
        questions: [
            {
                id: "style",
                type: "radio" as const,
                prompt: "Which style?",
                label: "Style",
                options: [
                    { value: "minimal", label: "Minimal" },
                    { value: "detailed", label: "Detailed" },
                ],
                allowOther: false,
                allowComment: false,
                required: true,
            },
            {
                id: "tags",
                type: "checkbox" as const,
                prompt: "Which tags?",
                label: "Tags",
                options: [
                    { value: "alpha", label: "Alpha" },
                    { value: "beta", label: "Beta" },
                ],
                allowOther: true,
                allowComment: true,
                required: true,
            },
        ],
    };

    it("multi-selects checkbox options and submits them together", () => {
        const onRespond = vi.fn();
        render(<AgentUserInputCard request={formRequest} onRespond={onRespond} />);

        const continueButton = screen.getByRole("button", { name: "agent.userInput.continue" });
        expect(continueButton).toBeDisabled();

        fireEvent.click(screen.getByRole("radio", { name: "Minimal" }));
        expect(continueButton).toBeDisabled();

        fireEvent.click(screen.getByRole("checkbox", { name: "Alpha" }));
        fireEvent.click(screen.getByRole("checkbox", { name: "Beta" }));
        expect(continueButton).not.toBeDisabled();
        fireEvent.click(continueButton);

        expect(onRespond).toHaveBeenCalledWith({
            answers: [
                { questionId: "style", values: ["minimal"] },
                { questionId: "tags", values: ["alpha", "beta"] },
            ],
        });
    });

    it("re-toggles a checkbox option off and keeps the required gate", () => {
        const onRespond = vi.fn();
        render(<AgentUserInputCard request={formRequest} onRespond={onRespond} />);

        const alpha = screen.getByRole("checkbox", { name: "Alpha" });
        fireEvent.click(alpha);
        fireEvent.click(alpha);
        fireEvent.click(screen.getByRole("radio", { name: "Minimal" }));

        const continueButton = screen.getByRole("button", { name: "agent.userInput.continue" });
        expect(continueButton).toBeDisabled();

        fireEvent.click(screen.getByRole("checkbox", { name: "agent.userInput.other" }));
        fireEvent.click(continueButton);
        expect(onRespond).toHaveBeenCalledWith({
            answers: [
                { questionId: "style", values: ["minimal"] },
                { questionId: "tags", values: [], customText: "" },
            ],
        });
    });

    it("collects the Other custom answer and an optional comment", () => {
        const onRespond = vi.fn();
        render(<AgentUserInputCard request={formRequest} onRespond={onRespond} />);

        fireEvent.click(screen.getByRole("radio", { name: "Minimal" }));
        fireEvent.click(screen.getByRole("checkbox", { name: "agent.userInput.other" }));
        fireEvent.change(screen.getByPlaceholderText("agent.userInput.otherPlaceholder"), { target: { value: "Custom tag" } });
        fireEvent.change(screen.getByPlaceholderText("agent.userInput.commentPlaceholder"), { target: { value: "  Note  " } });
        fireEvent.click(screen.getByRole("button", { name: "agent.userInput.continue" }));

        expect(onRespond).toHaveBeenCalledWith({
            answers: [
                { questionId: "style", values: ["minimal"] },
                { questionId: "tags", values: [], customText: "Custom tag", comment: "Note" },
            ],
        });
    });

    it("skipping a form cancels the whole request", () => {
        const onRespond = vi.fn();
        render(<AgentUserInputCard request={formRequest} onRespond={onRespond} />);

        fireEvent.click(screen.getByRole("button", { name: "agent.userInput.skip" }));
        expect(onRespond).toHaveBeenCalledWith({ cancelled: true });
    });

    it("seeds defaults and treats a text question as blank-able when optional", () => {
        const onRespond = vi.fn();
        render(
            <AgentUserInputCard
                request={{
                    requestId: "f2",
                    method: "form",
                    questions: [{
                        id: "name",
                        type: "text",
                        prompt: "Project name?",
                        label: "Name",
                        options: [],
                        allowOther: false,
                        allowComment: false,
                        required: false,
                        placeholder: "Optional name",
                        default: "Draft",
                    }],
                }}
                onRespond={onRespond}
            />,
        );

        expect(screen.getByPlaceholderText("Optional name")).toHaveValue("Draft");
        fireEvent.click(screen.getByRole("button", { name: "agent.userInput.continue" }));
        expect(onRespond).toHaveBeenCalledWith({ answers: [{ questionId: "name", values: ["Draft"] }] });
    });
});
