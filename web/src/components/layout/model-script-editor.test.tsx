import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, test, vi } from "vitest";

import { ModelScriptEditor } from "@/components/layout/model-script-editor";
import i18n from "@/i18n";

vi.mock("@uiw/react-codemirror", () => ({
    default: ({ value }: { value: string }) => <textarea value={value} readOnly />,
}));

describe("ModelScriptEditor", () => {
    test("does not advertise remote taskId in the direct script editor", () => {
        render(
            <I18nextProvider i18n={i18n}>
                <ModelScriptEditor open capability="image" modelName="model-x" value="" onSave={vi.fn()} onClose={vi.fn()} />
            </I18nextProvider>,
        );

        expect(screen.queryByText("taskId")).not.toBeInTheDocument();
        expect(screen.getByText("prompt")).toBeInTheDocument();
    });
});
