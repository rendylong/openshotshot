import { fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp } from "antd";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, test, vi } from "vitest";

import { RemoteTaskScriptEditor } from "@/components/layout/remote-task-script-editor";
import i18n from "@/i18n";
import type { RemoteTaskConfig } from "@/stores/use-config-store";

vi.mock("@uiw/react-codemirror", () => ({
    default: ({ value, onChange, "aria-label": ariaLabel }: { value: string; onChange: (value: string) => void; "aria-label"?: string }) => <textarea aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)} />,
}));

const remoteConfig = (patch: Partial<RemoteTaskConfig> = {}): RemoteTaskConfig => ({ timeoutMinutes: 5, submitScript: "return { taskId: 'custom' }", queryScript: "return { status: 'pending' }", ...patch });

function renderEditor(capability: "image" | "video" | "audio", value = remoteConfig(), onSave = vi.fn()) {
    render(
        <I18nextProvider i18n={i18n}>
            <AntApp>
                <RemoteTaskScriptEditor open capability={capability} modelName="model-x" value={value} onSave={onSave} onClose={vi.fn()} />
            </AntApp>
        </I18nextProvider>,
    );
    return onSave;
}

afterEach(() => {
    vi.restoreAllMocks();
    void i18n.changeLanguage("zh-CN");
});

describe("RemoteTaskScriptEditor", () => {
    test("shows submit and query tabs for audio", () => {
        renderEditor("audio");
        expect(screen.getByRole("tab", { name: "提交任务" })).toBeInTheDocument();
        expect(screen.getByRole("tab", { name: "查询任务" })).toBeInTheDocument();

        fireEvent.click(screen.getByRole("tab", { name: "查询任务" }));
        const queryPanel = screen.getByRole("tabpanel", { name: "查询任务" });
        expect(within(queryPanel).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["taskId", "model", "baseUrl", "apiKey", "http", "request", "signal"]);
        expect(within(queryPanel).queryByRole("button", { name: "prompt" })).not.toBeInTheDocument();
        expect(within(queryPanel).queryByRole("button", { name: "images" })).not.toBeInTheDocument();
        expect(within(queryPanel).queryByRole("button", { name: "params" })).not.toBeInTheDocument();
        expect(within(queryPanel).getByText(/status: "succeeded"/)).toBeInTheDocument();
    });

    test("confirms before replacing non-empty scripts with HiAPI and cancel preserves both strings", () => {
        const onSave = renderEditor("image");

        fireEvent.mouseDown(screen.getByRole("combobox", { name: "任务预设" }));
        fireEvent.click(screen.getByText("HiAPI GPT Image 2"));
        const confirmDialog = screen.getAllByRole("dialog").at(-1)!;
        expect(within(confirmDialog).getAllByText("替换任务预设")).not.toHaveLength(0);
        fireEvent.click(within(confirmDialog).getByRole("button", { name: /取\s*消/ }));
        fireEvent.click(screen.getByRole("button", { name: "保存" }));

        expect(onSave).toHaveBeenCalledWith(remoteConfig());
    });

    test.each(["video", "audio"] as const)("%s only offers custom scripts", (capability) => {
        renderEditor(capability, remoteConfig({ submitScript: "", queryScript: "" }));
        expect(screen.getByText("自定义")).toBeInTheDocument();
        expect(screen.queryByText(/HiAPI/)).not.toBeInTheDocument();
    });

    test("applies both HiAPI phases after confirmation", () => {
        const onSave = renderEditor("image");

        fireEvent.mouseDown(screen.getByRole("combobox", { name: "任务预设" }));
        fireEvent.click(screen.getByText("HiAPI GPT Image 2"));
        const confirmDialog = screen.getAllByRole("dialog").at(-1)!;
        fireEvent.click(within(confirmDialog).getByRole("button", { name: /替\s*换/ }));
        fireEvent.click(screen.getByRole("button", { name: "保存" }));

        expect(onSave.mock.calls[0][0].submitScript).toContain("POST /v1/tasks");
        expect(onSave.mock.calls[0][0].queryScript).toContain("GET /v1/tasks/{taskId}");
    });

    test("uses localized English confirmation copy", async () => {
        await i18n.changeLanguage("en-US");
        renderEditor("image");

        fireEvent.mouseDown(screen.getByRole("combobox", { name: "Task preset" }));
        fireEvent.click(screen.getByText("HiAPI GPT Image 2"));
        const confirmDialog = screen.getAllByRole("dialog").at(-1)!;
        expect(within(confirmDialog).getAllByText("Replace task preset")).not.toHaveLength(0);
        expect(within(confirmDialog).getByText("Applying this preset replaces both current scripts. Continue?")).toBeInTheDocument();
        expect(within(confirmDialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
        expect(within(confirmDialog).getByRole("button", { name: "Replace" })).toBeInTheDocument();
    });
});
