import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { HOME_RECOMMENDATIONS, HOME_SCENES, type HomeSceneId } from "@/pages/home/home-inspirations";

export function HomeCreationGuide(props: { selectedScene: HomeSceneId | null; onSceneChange(scene: HomeSceneId | null): void; onChoose(prompt: string): void }): ReactNode {
    const { selectedScene, onSceneChange, onChoose } = props;
    const { t } = useTranslation();
    // 首页底是点阵 background-image，chip 底与 hover 必须不透明（暗色 accent 是半透明薄纱，会透点）
    const scene = HOME_SCENES.find((item) => item.id === selectedScene);
    const examples = scene?.examples ?? HOME_RECOMMENDATIONS;

    return (
        <section aria-label={t("composer.inspiration.label")} className="mt-6 w-full">
            <div className="flex justify-center">
                <div className="flex max-w-full flex-nowrap gap-2 overflow-x-auto pb-1">
                    {HOME_SCENES.map((item) => (
                        <button
                            key={item.id}
                            type="button"
                            aria-pressed={selectedScene === item.id}
                            className={cn(
                                "flex h-9 shrink-0 items-center gap-2 rounded-full border px-2 text-xs focus-visible:outline-2 focus-visible:outline-ring",
                                selectedScene === item.id ? "border-foreground bg-foreground text-background" : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
                            )}
                            onClick={() => {
                                onSceneChange(selectedScene === item.id ? null : item.id);
                            }}
                        >
                            <item.icon size={16} />
                            {t(item.labelKey)}
                        </button>
                    ))}
                </div>
            </div>
            <div className="mt-6">
                {examples.map((example, index) => (
                    <button
                        key={example.id}
                        type="button"
                        aria-label={t(example.promptKey)}
                        className="flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left text-sm leading-6 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={() => onChoose(t(example.promptKey))}
                    >
                        <span aria-hidden="true" className="text-micro text-muted-foreground">
                            {String(index + 1).padStart(2, "0")}
                        </span>
                        <span className="min-w-0 flex-1">{t(example.promptKey)}</span>
                        <ArrowUpRight size={16} aria-hidden="true" />
                    </button>
                ))}
            </div>
        </section>
    );
}
