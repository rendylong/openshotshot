import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

import i18n from "@/i18n";
import { HOME_RECOMMENDATIONS, HOME_SCENES, type HomeSceneId } from "@/pages/home/home-inspirations";
import { HomeCreationGuide } from "@/pages/home/home-creation-guide";

function GuideHarness({ onChoose }: { onChoose: (text: string) => void }) {
    const [selectedScene, setScene] = useState<HomeSceneId | null>("model");
    const [draft, setDraft] = useState("");

    const handleChoose = (text: string) => {
        setDraft(text);
        onChoose(text);
    };

    return (
        <>
            <output aria-label="draft">{draft}</output>
            <HomeCreationGuide selectedScene={selectedScene} onSceneChange={setScene} onChoose={handleChoose} />
        </>
    );
}

function renderGuide(onChoose = vi.fn()) {
    return render(
        <I18nextProvider i18n={i18n}>
            <GuideHarness onChoose={onChoose} />
        </I18nextProvider>,
    );
}

describe("HomeCreationGuide", () => {
    beforeEach(async () => {
        await i18n.changeLanguage("zh-CN");
    });

    it("changes scenes without using an inspiration", () => {
        const onChoose = vi.fn();
        renderGuide(onChoose);

        fireEvent.click(screen.getByRole("button", { name: "设计海报" }));

        expect(onChoose).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "设计海报" })).toHaveAttribute("aria-pressed", "true");

        fireEvent.click(screen.getByRole("button", { name: i18n.t("composer.inspiration.prompts.poster.0") }));
        expect(onChoose).toHaveBeenCalledWith(i18n.t("composer.inspiration.prompts.poster.0"));
    });

    it("uses the fixed cross-scene recommendations after deselecting", () => {
        renderGuide();

        fireEvent.click(screen.getByRole("button", { name: "3D 产品出图" }));

        expect(screen.getByRole("button", { name: i18n.t("composer.inspiration.prompts.model.0") })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: i18n.t("composer.inspiration.prompts.poster.0") })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: i18n.t("composer.inspiration.prompts.video.1") })).toBeInTheDocument();
        expect(HOME_RECOMMENDATIONS.map((item) => item.id)).toEqual(["model-0", "poster-0", "video-1"]);
    });

    it("keeps suggestions visible without the legacy scene heading or restore button", () => {
        renderGuide();

        fireEvent.click(screen.getByRole("button", { name: i18n.t("composer.inspiration.prompts.model.0") }));

        expect(screen.getByRole("button", { name: i18n.t("composer.inspiration.prompts.model.0") })).toBeInTheDocument();
        expect(screen.queryByText("试试这样描述 · 3D 产品出图")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "更多灵感" })).not.toBeInTheDocument();
    });

    it("keeps scene chips on one scrollable row", () => {
        renderGuide();

        const row = screen.getByRole("button", { name: "3D 产品出图" }).parentElement!;
        expect(row).toHaveClass("flex-nowrap", "overflow-x-auto");
        for (const scene of HOME_SCENES) {
            expect(screen.getByRole("button", { name: i18n.t(scene.labelKey) })).toHaveClass("shrink-0");
        }
    });

    it("keeps all eighteen prompt keys translated in both locales", async () => {
        for (const locale of ["zh-CN", "en-US"] as const) {
            await i18n.changeLanguage(locale);
            for (const scene of HOME_SCENES) {
                for (const example of scene.examples) {
                    const value = i18n.t(example.promptKey);
                    expect(value).not.toBe(example.promptKey);
                    expect(value).not.toMatch(/^composer\.inspiration\.prompts\./);
                    expect(value.length).toBeLessThanOrEqual(locale === "zh-CN" ? 32 : 88);
                }
            }
        }
    });

    it("preserves an existing Chinese draft while updating unused copy on locale change", async () => {
        const onChoose = vi.fn();
        renderGuide(onChoose);

        const chinesePrompt = i18n.t("composer.inspiration.prompts.model.0");
        fireEvent.click(screen.getByRole("button", { name: chinesePrompt }));
        expect(screen.getByRole("status", { name: "draft" })).toHaveTextContent(chinesePrompt);
        expect(onChoose).toHaveBeenCalledTimes(1);

        await i18n.changeLanguage("en-US");

        expect(screen.getByRole("button", { name: "Posters" })).toBeInTheDocument();
        expect(screen.getByRole("status", { name: "draft" })).toHaveTextContent(chinesePrompt);
        expect(onChoose).toHaveBeenCalledTimes(1);
    });
});
